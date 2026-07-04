/** KAMINO_WITHDRAW action — withdraws collateral from a Kamino lending market. */
import {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  logger,
} from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseWithdrawMessage } from "../../utils/parser";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import { resolveMax } from "../../utils/resolveMax";

export const WithdrawAction: Action = {
  name: "KAMINO_WITHDRAW",
  similes: [
    "WITHDRAW_COLLATERAL",
    "WTIHDRAW",
    "REMOVE_COLLATERAL",
    "WITHDRAW_FROM_KAMINO",
  ],
  description:
    "Withdraw a lending deposit from Kamino. Use when the user wants to exit their " +
    "lending/supply position and reclaim their deposited tokens. Also detects if the " +
    "position was liquidated and notifies the user.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    try {
      const service = runtime.getService<KaminoService>("kamino-service");
      if (!service?.isInitialized()) return false;
      const params = await parseWithdrawMessage(runtime, message, state);
      if (!params?.amount || !params?.token) return false;
      const obligation = await service.getUserObligation(
        params.marketName ?? "main",
        ObligationTypeTag.Vanilla,
      );
      return obligation !== null;
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<KaminoService>("kamino-service");
      if (!service) {
        throw new Error("KaminoService is not available");
      }

      const currentState = state ?? (await runtime.composeState(message));
      const params = await parseWithdrawMessage(runtime, message, currentState);
      if (!params) {
        await callback?.({
          text: "Couldn't parse your withdrawal request. Please specify token and amount, e.g. 'withdraw 100 USDC'",
          actions: ["KAMINO_WITHDRAW"],
        });
        return { success: false, text: "Token and amount not provided." };
      }

      const market = params.marketName
        ? service.getMarket(params.marketName)
        : service.getDefaultMarket();

      if (!market) {
        await callback?.({
          text: `Market not found: ${params.marketName ?? "main"}`,
          actions: ["KAMINO_WITHDRAW"],
        });
        return { success: false, text: "Market not found." };
      }

      const reserve = market.getFloatRateReserveBySymbol(params.token);
      if (!reserve) {
        await callback?.({
          text: `Token reserve cannot be found for ${params.marketName ?? "main"} market. Please provide a valid token reserve.`,
          actions: ["KAMINO_WITHDRAW"],
        });
        return { success: false, text: "Reserve not found" };
      }

      const marketName = market.getName();
      if (!marketName) {
        throw new Error("Market has no name — cannot build withdrawal transaction");
      }

      const obligation = await service.getUserObligation(
        params.marketName ?? marketName,
        ObligationTypeTag.Vanilla,
      );

      if (obligation && obligation.borrows.size > 0) {
        const currentLtv = obligation.loanToValue();
        const liquidationLtv = obligation.liquidationLtv();
        const healthFactor = currentLtv.gt(0)
          ? liquidationLtv.div(currentLtv)
          : new Decimal("999");

        if (healthFactor.lt(1.2)) {
          await callback?.({
            text: `Warning: Your health factor is already low (${healthFactor.toFixed(2)}). Withdrawing collateral may put you at a risk of liquidation. Considering repaying debt first.`,
            actions: ["KAMINO_WITHDRAW"],
          });
          return {
            success: false,
            text: `Your health factor is already low ${healthFactor.toFixed(2)}`,
          };
        }
      }

      const deposit = obligation?.deposits.get(reserve.address);

      // If amount is "max" we need an active obligation to resolve the balance.
      if (params.amount === "max" && !obligation) {
        await callback?.({
          text: `No active position found for ${params.token} — nothing to withdraw.`,
          actions: ["KAMINO_WITHDRAW"],
        });
        return { success: false, text: "No active position to withdraw from." };
      }

      // resolveMax requires a non-null obligation only when amount === "max";
      // the guard above ensures obligation is defined in that branch.
      const decimalAmount = resolveMax(params.amount, obligation!, reserve);

      if (deposit && deposit.amount.lt(decimalAmount)) {
        await callback?.({
          text: `You don't have enough deposits of ${params.token}`,
          actions: ["KAMINO_WITHDRAW"],
        });
        return { success: false, text: `You don't have enough deposits.` };
      }

      const tokenMint = reserve.getLiquidityMint();
      const action = await service.buildWithdrawTxns(
        marketName,
        tokenMint,
        decimalAmount,
      );

      const tx = await service.sendActionTransaction(action);

      const { amount, token } = params;
      await callback?.({
        text: `Succesfully withdrawn **${amount === "max" ? "all" : amount} ${token}** collateral to your wallet. Transaction: ${tx.join(", ")}`,
        actions: ["KAMINO_WITHDRAW"],
        data: { amount, token, tx },
      });
      return {
        success: true,
        text: `Withdraw successful: ${tx}`,
        data: { amount, token, tx },
      };
    } catch (error) {
      logger.error(`[KAMINO_WITHDRAW] Handler failed: ${error}`);
      await callback?.({
        text: `Withdraw failed: ${error}`,
        actions: ["KAMINO_WITHDRAW"],
        data: { error: String(error) },
      });
      return { success: false, text: `Withdraw failed: ${error}` };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Withdraw 100 USDC of my collateral" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Withdraw of 100 USDC successfull...",
          actions: ["KAMINO_WITHDRAW"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Take out 20 SOL from my collateral" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "20 SOL successfully taken out from your collaterals",
          actions: ["KAMINO_WITHDRAW"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Take out all of my SOL from collaterals" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Succesfully taken out all SOL collateral",
          actions: ["KAMINO_WITHDRAW"],
        },
      },
    ],
  ],
};
