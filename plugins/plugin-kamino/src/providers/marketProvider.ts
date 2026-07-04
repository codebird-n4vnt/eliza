/**
 * KAMINO_MARKET provider — injects live Kamino reserve data (APYs, liquidity,
 * LTV) into every LLM context so the agent can answer market questions without
 * an explicit action trigger.
 */
import {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
  logger,
} from "@elizaos/core";
import { KaminoService } from "../services/kamino";


export const marketProvider: Provider = {
  name: "KAMINO_MARKET",
  description:
    "Current Kamino Lend reserve APYs, liquidity, and borrowing conditions",

  dynamic: true,

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> {
    const service = runtime.getService<KaminoService>("kamino-service");

    if (!service || !service.isInitialized()) {
      return {
        text: "Kamino market data is currently unavailable.",
        data: { available: false },
        values: {},
      };
    }

    try {
      const reserves = await service.getAllReserves();
      if (reserves.length === 0) {
        return {
          text: "No Kamino Reserves are currently loaded.",
          data: { available: false, reserves: [] },
          values: {},
        };
      }

      const formattedReserves = reserves.map((r) => ({
        symbol: r.symbol,
        market: r.marketName,
        supplyAPY: `${r.supplyAPY}%`,
        borrowAPY: `${r.borrowAPY}%`,
        available: `${r.availableLiquidity} ${r.symbol}`,
        ltv: `${r.ltv}`,
        canDeposit: r.depositEnabled,
        canBorrow: r.borrowEnabled,
      }));

      const topSupply = [...reserves]
        .filter((r) => r.depositEnabled)
        .sort((a, b) => parseFloat(b.supplyAPY) - parseFloat(a.supplyAPY))
        .slice(0, 3);

      const topBorrow = [...reserves]
        .filter((r) => r.borrowEnabled)
        .sort((a, b) => parseFloat(a.borrowAPY) - parseFloat(b.supplyAPY))
        .slice(0, 3);

      const text = `
                === KAMINO LEND MARKET DATA ===

                Available Reserves (${reserves.length}):
                ${formattedReserves
                  .map(
                    (r) =>
                      `- ${r.symbol} (${r.market}): Supply ${r.supplyAPY}, Borrow ${r.borrowAPY}, LTV ${r.ltv}, Available ${r.available}`,
                  )
                  .join("\n")}

                Top Supply Opportunities:
                ${
                  topSupply
                    .map((r) => `- ${r.symbol}: ${r.supplyAPY}% APY`)
                    .join("\n") || "- None available"
                }

                Cheapest Borrow Rates:
                ${
                  topBorrow
                    .map((r) => `- ${r.symbol}: ${r.borrowAPY}% APY`)
                    .join("\n") || "- None available"
                }

                === END MARKET DATA ===
            `.trim();

      return {
        text,
        data: {
          available: true,
          reserves: formattedReserves,
          topSupply: topSupply.map((r) => ({
            symbol: r.symbol,
            apy: r.supplyAPY,
            market: r.marketName,
          })),
          topBorrow: topBorrow.map((r) => ({
            symbol: r.symbol,
            apy: r.borrowAPY,
            market: r.marketName,
          })),
        },
        values: {
          reserveCount: String(reserves.length),
          topSupplyAPY: topSupply[0]?.supplyAPY || "0",
          topBorrowAPY: topBorrow[0]?.borrowAPY || "0",
        },
      };
    } catch (error) {
      // error-policy:J4 explicit user-facing degrade — provider errors render
      // as a designed "unavailable" state rather than crashing the LLM context.
      logger.error(`[MarketProvider] Failed to fetch reserves: ${error}`);
      return {
        text: "Kamino market data is temporarily unavailable.",
        data: { available: false, error: String(error) },
        values: {},
      };
    }
  },
};
