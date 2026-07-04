/**
 * KaminoService — elizaOS service wrapping the @kamino-finance/klend-sdk.
 *
 * Manages one or more KaminoMarket instances, exposes typed helpers for every
 * lending action (lend, borrow, deposit collateral, withdraw, repay), and
 * handles transaction confirmation with a WebSocket-first / HTTP-polling
 * fallback strategy so the elizaOS UI never shows a false Error on a confirmed
 * transaction.
 *
 * Private keys are kept in memory only — never written to disk.
 */
import { IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  KaminoPluginSettings,
  MarketConfig,
  ReserveInfo,
  PositionInfo,
  HealthCheckResult,
  CachedObligation,
} from "../types/index";
import {
  KaminoMarket,
  type KaminoReserve,
  KaminoObligation,
  VanillaObligation,
  KaminoAction,
  parseKeypairFile,
  ObligationTypeTag,
  LendingObligation,
} from "@kamino-finance/klend-sdk";
import { setInterval } from "timers";
import { Decimal } from "decimal.js";
import * as path from "path";
import * as os from "os";
import bs58 from "bs58";
import BN from "bn.js";
import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  KeyPairSigner,
  Rpc,
  SolanaRpcApi,
  Address,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  pipe,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  assertIsTransactionWithinSizeLimit,
  createSolanaRpcSubscriptions,
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
} from "@solana/kit";

const DEFAULT_MARKETS: MarketConfig[] = [
  {
    name: "main",
    address: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
    description: "Kamino main lending market with 20+ assets",
  },
];

const DEFAULT_REFRESH_MS = 30000;

/** Shape returned by every KaminoAction.build* helper. */
interface KaminoTxns {
  setupIxs: unknown[];
  lendingIxs: unknown[];
  cleanupIxs: unknown[];
  computeBudgetIxs: unknown[];
}

export class KaminoService extends Service {
  /** Key used by runtime.getService("kamino-service"). */
  static serviceType = "kamino-service";

  private rpc!: Rpc<SolanaRpcApi>;
  private rpcSubscriptions!: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  private signer: KeyPairSigner<string> | null = null;
  private markets: Map<string, KaminoMarket> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;
  private isReady = false;
  private obligationCache: Map<string, CachedObligation> = new Map();
  private readonly OBLIGATION_CACHE_TTL_MS = 10000;

  private reservesCache: ReserveInfo[] = [];
  private reservesCacheUpdatedAt = 0;
  private readonly RESERVES_CACHE_TTL_MS = 30000;

  override capabilityDescription =
    "Provides access to Kamino Protocol — lending, borrowing, liquidity vaults, farms, and limit orders on Solana.";

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  /** elizaOS entry point — creates and initialises the service. */
  static async start(runtime: IAgentRuntime): Promise<KaminoService> {
    const service = new KaminoService(runtime);
    await service.initialize();
    return service;
  }

  override async stop(): Promise<void> {
    this.stopRefreshTimer();
    this.isReady = false;
    logger.info("[KaminoService] Service stopped");
  }

  async initialize(): Promise<void> {
    const settings = this.getSettings();

    this.rpc = createSolanaRpc(settings.rpcUrl);
    this.rpcSubscriptions = createSolanaRpcSubscriptions(settings.wsUrl);
    logger.info(`[KaminoService] RPC: ${settings.rpcUrl}  WS: ${settings.wsUrl}`);

    this.signer = await this.loadSigner(settings);

    if (!this.signer) {
      throw new Error(
        "KaminoService: no signer found. " +
          "Set SOLANA_PRIVATE_KEY (base58) or SOLANA_KEYPAIR_PATH.",
      );
    }

    const marketsToLoad =
      settings.markets.length > 0 ? settings.markets : DEFAULT_MARKETS;

    for (const marketConfig of marketsToLoad) {
      try {
        const market = await KaminoMarket.load(
          this.rpc,
          address(marketConfig.address),
          400,
        );

        if (!market) {
          logger.warn(
            `[KaminoService] Market ${marketConfig.name} returned null from load() — skipping`,
          );
          continue;
        }

        await market.loadReserves();
        this.markets.set(marketConfig.name, market);
        logger.info(`[KaminoService] Loaded market: ${marketConfig.name}`);
      } catch (error) {
        logger.error(
          `[KaminoService] Failed to load market ${marketConfig.name}: ${error}`,
        );
      }
    }

    if (this.markets.size === 0) {
      throw new Error("KaminoService: no markets could be loaded");
    }

    await this.refreshReservesCache();
    this.startRefreshTimer(settings.refreshIntervalMs);
    this.isReady = true;
    logger.info(
      `[KaminoService] Initialized with ${this.markets.size} market(s)`,
    );
  }

  private getSettings(): KaminoPluginSettings {
    const secrets =
      (this.runtime.getSetting("secrets") as unknown as Record<
        string,
        string
      >) || {};

    // getSetting() returns null when not set; String(null) === "null" which is
    // truthy, making all fallbacks unreachable — strip those out.
    const getSafe = (key: string): string | undefined => {
      const raw = this.runtime.getSetting(key);
      if (raw === null || raw === undefined) return undefined;
      const str = String(raw).trim();
      if (str === "null" || str === "undefined" || str === "") return undefined;
      // Dotenvx-encrypted values (AQ. prefix) were not decrypted — warn and
      // treat as missing so the caller surfaces a clear error.
      if (str.startsWith("AQ.")) {
        logger.warn(
          `[KaminoService] ${key} appears to be an undecrypted dotenvx value. ` +
            "Ensure DOTENV_PRIVATE_KEY is set.",
        );
        return undefined;
      }
      return str;
    };

    const rpcUrl =
      getSafe("SOLANA_RPC_URL") ??
      secrets.SOLANA_RPC_URL ??
      "https://api.mainnet-beta.solana.com";

    // SOLANA_WS_URL can be set explicitly (recommended for local validators
    // like Surfpool that expose WS on a different port than RPC).
    const wsUrl =
      getSafe("SOLANA_WS_URL") ??
      secrets.SOLANA_WS_URL ??
      rpcUrl.replace("https://", "wss://").replace("http://", "ws://");

    const privateKey =
      getSafe("SOLANA_PRIVATE_KEY") ?? secrets.SOLANA_PRIVATE_KEY;

    const keypairPath =
      getSafe("SOLANA_KEYPAIR_PATH") ?? secrets.SOLANA_KEYPAIR_PATH;

    const refreshIntervalMs = parseInt(
      getSafe("KAMINO_REFRESH_MS") ||
        secrets.KAMINO_REFRESH_MS ||
        String(DEFAULT_REFRESH_MS),
      10,
    );

    let markets: MarketConfig[] = [];
    const marketsJson = getSafe("KAMINO_MARKETS") || secrets.KAMINO_MARKETS;

    if (marketsJson) {
      try {
        markets = JSON.parse(marketsJson);
      } catch {
        // error-policy:J3 KAMINO_MARKETS is untrusted operator input; a parse
        // failure produces the explicit "markets=[]" signal that falls through
        // to DEFAULT_MARKETS — no fabricated data, no silent continue.
        logger.warn(
          "[KaminoService] KAMINO_MARKETS is not valid JSON — falling back to default market",
        );
      }
    }

    return { rpcUrl, wsUrl, markets, privateKey, keypairPath, refreshIntervalMs };
  }

  /**
   * Builds a KeyPairSigner from the configured credentials.
   * The base58 private key is decoded in memory — never written to disk.
   */
  private async loadSigner(
    settings: KaminoPluginSettings,
  ): Promise<KeyPairSigner<string> | null> {
    if (settings.keypairPath) {
      const resolvedPath = path.resolve(
        settings.keypairPath.startsWith("~")
          ? settings.keypairPath.replace("~", os.homedir())
          : settings.keypairPath,
      );
      // error-policy:J2 context-adding rethrow — file read failures propagate
      // with path context so the operator can diagnose quickly.
      return await parseKeypairFile(resolvedPath);
    }

    if (settings.privateKey) {
      const secretKey = bs58.decode(settings.privateKey);
      // Keep the secret in memory only — no temp files.
      return await createKeyPairSignerFromBytes(secretKey);
    }

    return null;
  }

  private startRefreshTimer(intervalMs: number): void {
    this.refreshTimer = setInterval(async () => {
      for (const [name, market] of this.markets) {
        try {
          await market.loadReserves();
          logger.info(`[KaminoService] Refreshed reserves for market: ${name}`);
        } catch (error) {
          // error-policy:J7 diagnostics-must-not-kill-the-loop — refresh is
          // best-effort; warn and continue so other markets still refresh.
          logger.warn(
            `[KaminoService] Reserve refresh failed for ${name}: ${error}`,
          );
        }
      }
      try {
        await this.refreshReservesCache();
      } catch (error) {
        // error-policy:J7 same as above.
        logger.warn(`[KaminoService] Reserves cache refresh failed: ${error}`);
      }
    }, intervalMs);
  }

  private async refreshReservesCache(): Promise<void> {
    this.reservesCache = await this.computeAllReserves();
    this.reservesCacheUpdatedAt = Date.now();
  }

  stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  getRpcSubscriptions(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
    return this.rpcSubscriptions;
  }

  getSigner(): KeyPairSigner<string> {
    if (!this.signer) throw new Error("[KaminoService] Signer not loaded");
    return this.signer;
  }

  getWalletAddress(): Address {
    return this.getSigner().address;
  }

  getMarket(name: string): KaminoMarket | undefined {
    return this.markets.get(name);
  }

  getAllMarkets(): Map<string, KaminoMarket> {
    return this.markets;
  }

  getDefaultMarket(): KaminoMarket {
    const first = this.markets.values().next().value;
    if (!first) throw new Error("KaminoService: no markets loaded");
    return first;
  }

  isInitialized(): boolean {
    return this.isReady;
  }

  async getCurrentSlot(): Promise<bigint> {
    // Throws on RPC failure — callers that need a slot must handle the error;
    // returning BigInt(0) would silently corrupt APY/health math.
    return BigInt(await this.rpc.getSlot().send());
  }

  async getBoilerplate(
    marketName: string,
    tokenMint: Address,
    amount: Decimal,
  ): Promise<{
    currentSlot: bigint;
    market: KaminoMarket;
    reserve: KaminoReserve;
    amountBN: InstanceType<typeof BN>;
  }> {
    const currentSlot = await this.getCurrentSlot();
    const market = this.getMarket(marketName) || this.getDefaultMarket();
    const reserve = market.getFloatRateReserveByMint(tokenMint);

    if (!reserve) {
      throw new Error(`[KaminoService] Reserve not found for mint: ${tokenMint}`);
    }

    const decimals = reserve.getMintDecimals();
    const amountBN = new BN(
      amount.mul(new Decimal(10).pow(decimals)).toFixed(0),
    );

    return { currentSlot, market, reserve, amountBN };
  }

  async getAllReserves(forceRefresh = false): Promise<ReserveInfo[]> {
    const isStale =
      Date.now() - this.reservesCacheUpdatedAt > this.RESERVES_CACHE_TTL_MS;
    if (forceRefresh || this.reservesCacheUpdatedAt === 0 || isStale) {
      await this.refreshReservesCache();
    }
    return this.reservesCache;
  }

  async computeAllReserves(): Promise<ReserveInfo[]> {
    const results: ReserveInfo[] = [];
    // Throws on RPC failure so a dead chain doesn't silently produce
    // APY = 0% for all reserves (which would look like correct empty data).
    const currentSlot = await this.getCurrentSlot();

    for (const [marketName, market] of this.markets) {
      const reserves = market.getReserves
        ? market.getReserves()
        : [...market.reserves.values()];

      for (const reserve of reserves) {
        const stats = reserve.stats;
        const supplyAPY = reserve.totalSupplyAPY(currentSlot);
        const borrowAPY = reserve.totalBorrowAPY(currentSlot);
        const mintFactor = reserve.getMintFactor();
        const config = reserve.state.config;

        results.push({
          symbol: stats.symbol || reserve.getTokenSymbol(),
          mint: reserve.getLiquidityMint().toString(),
          marketName,
          supplyAPY: supplyAPY.toFixed(4),
          borrowAPY: borrowAPY.toFixed(4),
          totalDeposits: reserve.getTotalSupply().div(mintFactor).toFixed(6),
          totalBorrows: reserve.getBorrowedAmount().div(mintFactor).toFixed(6),
          availableLiquidity: reserve
            .getLiquidityAvailableAmount()
            .div(mintFactor)
            .toFixed(6),
          ltv: stats.loanToValue.toString() || "0",
          liquidationThreshold: stats.liquidationThreshold?.toString() || "0",
          depositEnabled: !config.depositLimit.isZero(),
          borrowEnabled: !config.borrowLimit.isZero(),
        });
      }
    }

    return results;
  }

  getReservesBySymbol(
    symbol: string,
    marketName?: string,
  ): KaminoReserve | undefined {
    const targetMarket = marketName
      ? this.markets.get(marketName)
      : this.getDefaultMarket();
    if (!targetMarket) return undefined;
    return targetMarket.getFloatRateReserveBySymbol(symbol);
  }

  async getUserObligation(
    marketName: string,
    obligationTypeTag: ObligationTypeTag = ObligationTypeTag.Vanilla,
    forceRefresh = false,
  ): Promise<KaminoObligation | null> {
    const cacheKey = `${marketName}:${obligationTypeTag}`;
    const cached = this.obligationCache.get(cacheKey);

    if (
      !forceRefresh &&
      cached &&
      Date.now() - cached.fetchedAt < this.OBLIGATION_CACHE_TTL_MS
    ) {
      return cached.obligation;
    }

    const market = this.markets.get(marketName);
    if (!market) return null;

    let obligation: KaminoObligation | null;
    if (obligationTypeTag === ObligationTypeTag.Vanilla) {
      obligation = await market.getUserVanillaObligation(
        this.getWalletAddress(),
      );
    } else {
      obligation = await market.getObligationByWallet(
        this.getWalletAddress(),
        new LendingObligation(this.getWalletAddress(), market.programId),
      );
    }

    this.obligationCache.set(cacheKey, {
      obligation: obligation!,
      fetchedAt: Date.now(),
    });

    return obligation;
  }

  invalidateObligationCache(
    marketName: string,
    obligationTypeTag: ObligationTypeTag,
  ): void {
    const cacheKey = `${marketName}:${obligationTypeTag}`;
    this.obligationCache.delete(cacheKey);

    for (const key of this.obligationCache.keys()) {
      if (key.startsWith(`${marketName}:`)) {
        this.obligationCache.delete(key);
      }
    }
    logger.info(
      `[KaminoService] Invalidated obligation cache for ${marketName}`,
    );
  }

  async getAllUserObligations(
    forceRefresh = false,
  ): Promise<Map<string, KaminoObligation>> {
    const results = new Map<string, KaminoObligation>();

    for (const name of this.markets.keys()) {
      const obligation = await this.getUserObligation(
        name,
        ObligationTypeTag.Vanilla,
        forceRefresh,
      );
      if (obligation) results.set(name, obligation);
    }

    return results;
  }

  async getHealthCheck(forceRefresh = false): Promise<HealthCheckResult> {
    const obligations = await this.getAllUserObligations(forceRefresh);
    // Throws on RPC failure — a fabricated slot of 0 would corrupt all APY math.
    const currentSlot = await this.getCurrentSlot();

    if (obligations.size === 0) {
      return {
        positions: [],
        hasPositions: false,
        overallRisk: "safe",
        worstHealthFactor: "infinite",
      };
    }

    const positions: PositionInfo[] = [];
    let worstHealthFactor = new Decimal("Infinity");
    let overallRisk: HealthCheckResult["overallRisk"] = "safe";

    for (const [marketName, obligation] of obligations) {
      const stats = obligation.refreshedStats;

      const healthFactor = stats.loanToValue.gt(0)
        ? obligation.liquidationLtv().div(stats.loanToValue)
        : new Decimal("999");

      if (healthFactor.lt(worstHealthFactor)) {
        worstHealthFactor = healthFactor;
      }

      const risk: HealthCheckResult["overallRisk"] = healthFactor.lt(1)
        ? "critical"
        : healthFactor.lt(1.1)
          ? "danger"
          : healthFactor.lt(1.5)
            ? "caution"
            : "safe";

      if (risk === "critical") overallRisk = "critical";
      else if (risk === "danger" && overallRisk !== "critical")
        overallRisk = "danger";
      else if (risk === "caution" && overallRisk === "safe")
        overallRisk = "caution";

      const deposits: PositionInfo["deposits"] = [];
      const borrows: PositionInfo["borrows"] = [];
      const market = this.markets.get(marketName);

      for (const [reserveAddress, position] of obligation.deposits.entries()) {
        const reserve = market?.getReserveByAddress(reserveAddress);
        const symbol = reserve?.symbol ?? reserveAddress.toString().slice(0, 8);
        const mintFactor = reserve?.getMintFactor() ?? position.mintFactor;
        deposits.push({
          symbol,
          amount: position.amount.div(mintFactor).toFixed(6),
          valueUsd: position.marketValueRefreshed.toFixed(2),
        });
      }

      for (const [reserveAddress, position] of obligation.borrows.entries()) {
        const reserve = market?.getReserveByAddress(reserveAddress);
        const symbol = reserve?.symbol ?? reserveAddress.toString().slice(0, 8);
        const mintFactor = reserve?.getMintFactor() ?? position.mintFactor;
        const borrowAPY = reserve
          ? reserve.totalBorrowAPY(currentSlot)
          : new Decimal(0);
        borrows.push({
          symbol,
          amount: position.amount.div(mintFactor).toFixed(6),
          valueUsd: position.marketValueRefreshed.toFixed(2),
          borrowAPY: borrowAPY.toFixed(4),
        });
      }

      positions.push({
        marketName,
        deposits,
        borrows,
        healthFactor: healthFactor.toFixed(4),
        borrowLimit: stats.borrowLimit.toFixed(2),
        netValue: stats.netAccountValue.toFixed(2),
        ltv: stats.loanToValue.toFixed(4),
      });
    }

    return {
      positions,
      hasPositions: true,
      overallRisk,
      worstHealthFactor: worstHealthFactor.toFixed(4),
    };
  }

  /**
   * HTTP-polling fallback for transaction confirmation.
   * Used when the WebSocket subscription fails (e.g., port mismatch with local
   * validators like Surfpool that run WS on rpcPort+1).
   */
  private async pollForConfirmation(
    signature: string,
    maxAttempts = 30,
    intervalMs = 1000,
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.rpc
          // biome-ignore lint/suspicious/noExplicitAny: klend-sdk signature type is opaque
          .getSignatureStatuses([signature as any])
          .send();
        const status = result.value[0];
        if (
          status &&
          (status.confirmationStatus === "confirmed" ||
            status.confirmationStatus === "finalized")
        ) {
          return true;
        }
      } catch {
        // error-policy:J5 unhandled-rejection suppression — polling loop
        // observes success via the return value; transient RPC errors just
        // retry until maxAttempts.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  async sendActionTransaction(
    action: KaminoTxns,
    options: {
      skipPreFlight?: boolean;
      commitment?: "confirmed" | "finalized";
      retryOn0x17a3?: boolean;
    } = {},
  ): Promise<string[]> {
    const {
      skipPreFlight = true,
      commitment = "confirmed",
      retryOn0x17a3 = true,
    } = options;

    const signatures: string[] = [];
    const signer = this.getSigner();
    const setupIxs = action.setupIxs ?? [];

    if (setupIxs.length > 0) {
      const { value: setupBlockhash } = await this.rpc
        .getLatestBlockhash({ commitment: "finalized" })
        .send();

      const setupTxMessage = pipe(
        createTransactionMessage({ version: 0 }),
        // biome-ignore lint/suspicious/noExplicitAny: klend-sdk instruction type is opaque
        (tx) => setTransactionMessageFeePayerSigner(signer, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(setupBlockhash, tx),
        // biome-ignore lint/suspicious/noExplicitAny: klend-sdk instruction type is opaque
        (tx) => appendTransactionMessageInstructions(setupIxs as any[], tx),
      );

      const setupSignedTx =
        await signTransactionMessageWithSigners(setupTxMessage);
      assertIsTransactionWithinSizeLimit(setupSignedTx);
      const setupSignature = getSignatureFromTransaction(setupSignedTx);
      signatures.push(setupSignature);

      await sendAndConfirmTransactionFactory({
        rpc: this.rpc,
        rpcSubscriptions: this.rpcSubscriptions,
      })(setupSignedTx, { commitment, skipPreflight: skipPreFlight });

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const lendingInstructions = [
      ...(action.computeBudgetIxs ?? []),
      ...(action.lendingIxs ?? []),
      ...(action.cleanupIxs ?? []),
    ];

    if (!lendingInstructions.length) {
      throw new Error("[KaminoService] No instructions returned by Kamino SDK");
    }

    const sendMainTx = async (): Promise<string> => {
      const { value: latestBlockhash } = await this.rpc
        .getLatestBlockhash({ commitment: "finalized" })
        .send();

      const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayerSigner(signer, tx),
        (tx) =>
          setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
        // biome-ignore lint/suspicious/noExplicitAny: klend-sdk instruction type is opaque
        (tx) => appendTransactionMessageInstructions(lendingInstructions as any[], tx),
      );

      const signedTransaction =
        await signTransactionMessageWithSigners(transactionMessage);
      assertIsTransactionWithinSizeLimit(signedTransaction);
      const signature = getSignatureFromTransaction(signedTransaction);

      try {
        await sendAndConfirmTransactionFactory({
          rpc: this.rpc,
          rpcSubscriptions: this.rpcSubscriptions,
        })(signedTransaction, { commitment, skipPreflight: skipPreFlight });
      } catch (wsError: unknown) {
        // WebSocket confirmation can fail when the WS port doesn't match
        // (e.g., Surfpool uses rpcPort+1). Fall back to HTTP polling so a
        // confirmed transaction still shows "Completed" in the UI.
        const msg = wsError instanceof Error ? wsError.message : String(wsError);
        logger.warn(
          `[KaminoService] WS confirmation failed (${msg}), polling via HTTP…`,
        );
        const confirmed = await this.pollForConfirmation(String(signature));
        if (!confirmed) {
          throw wsError;
        }
        logger.info(
          `[KaminoService] Transaction confirmed via HTTP polling: ${signature}`,
        );
      }

      return signature;
    };

    try {
      const mainSignature = await sendMainTx();
      signatures.push(mainSignature);
    } catch (error: unknown) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      const is0x17a3 =
        retryOn0x17a3 &&
        (errorMsg.includes("0x17a3") ||
          errorMsg.includes("6051") ||
          errorMsg.includes("IncorrectInstructionPosition"));

      if (is0x17a3 && setupIxs.length > 0) {
        logger.info("[KaminoService] Retrying after 0x17a3 error…");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const retrySignature = await sendMainTx();
        signatures.push(retrySignature);
      } else {
        throw error;
      }
    }

    return signatures;
  }

  async buildLendTxns(
    marketName: string,
    tokenMint: Address,
    amount: Decimal,
  ): Promise<KaminoTxns> {
    const { currentSlot, market, reserve, amountBN } =
      await this.getBoilerplate(marketName, tokenMint, amount);
    const obligation = new LendingObligation(tokenMint, market.programId);

    return KaminoAction.buildDepositReserveLiquidityTxns({
      kaminoMarket: market,
      amount: amountBN,
      reserveAddress: reserve.address,
      owner: this.getSigner(),
      obligation,
      scopeRefreshConfig: undefined,
      currentSlot,
    });
  }

  async buildLendWithdrawTxns(
    marketName: string,
    tokenMint: Address,
    amount: Decimal,
  ): Promise<KaminoTxns> {
    const { currentSlot, market, reserve, amountBN } =
      await this.getBoilerplate(marketName, tokenMint, amount);
    const obligation = new LendingObligation(tokenMint, market.programId);

    return KaminoAction.buildRedeemReserveCollateralTxns({
      kaminoMarket: market,
      amount: amountBN,
      reserveAddress: reserve.address,
      owner: this.getSigner(),
      obligation,
      scopeRefreshConfig: undefined,
      currentSlot,
    });
  }

  async buildDepositTxns(
    marketName: string,
    tokenMint: Address,
    amount: Decimal,
  ): Promise<KaminoTxns> {
    const { currentSlot, market, reserve, amountBN } =
      await this.getBoilerplate(marketName, tokenMint, amount);

    return KaminoAction.buildDepositTxns({
      kaminoMarket: market,
      amount: amountBN,
      reserveAddress: reserve.address,
      owner: this.getSigner(),
      obligation: new VanillaObligation(market.programId),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      currentSlot,
    });
  }

  async buildBorrowTxns(
    marketName: string,
    tokenMint: Address,
    amount: Decimal,
  ): Promise<KaminoTxns> {
    const { currentSlot, market, reserve, amountBN } =
      await this.getBoilerplate(marketName, tokenMint, amount);

    return KaminoAction.buildBorrowTxns({
      kaminoMarket: market,
      amount: amountBN,
      reserveAddress: reserve.address,
      owner: this.getSigner(),
      obligation: new VanillaObligation(market.programId),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      currentSlot,
    });
  }

  async buildRepayTxns(
    marketName: string,
    tokenMint: Address,
    amount: Decimal,
  ): Promise<KaminoTxns> {
    const { currentSlot, market, reserve, amountBN } =
      await this.getBoilerplate(marketName, tokenMint, amount);

    return KaminoAction.buildRepayTxns({
      kaminoMarket: market,
      amount: amountBN,
      reserveAddress: reserve.address,
      owner: this.getSigner(),
      obligation: new VanillaObligation(market.programId),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      currentSlot,
      initUserMetadata: { skipInitialization: false, skipLutCreation: false },
    });
  }

  async buildWithdrawTxns(
    marketName: string,
    tokenMint: Address,
    amount: Decimal,
  ): Promise<KaminoTxns> {
    const { currentSlot, market, reserve, amountBN } =
      await this.getBoilerplate(marketName, tokenMint, amount);

    return KaminoAction.buildWithdrawTxns({
      kaminoMarket: market,
      amount: amountBN,
      reserveAddress: reserve.address,
      owner: this.getSigner(),
      obligation: new VanillaObligation(market.programId),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      currentSlot,
    });
  }
}
