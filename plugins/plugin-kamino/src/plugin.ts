/**
 * KaminoPlugin — plugin registration for @elizaos/plugin-kamino.
 *
 * Validates required env vars at init time and wires the KaminoService,
 * eight lending actions, the KAMINO_MARKET provider, and a /api/status
 * health-check route into the elizaOS agent runtime.
 */
import type { Plugin } from "@elizaos/core";
import { type RouteRequest, type RouteResponse, logger } from "@elizaos/core";
import { z } from "zod";
import { KaminoService } from "./services/kamino";
import { LendAction } from "./actions/lending/lendAction";
import { LendWithdraw } from "./actions/lending/lendWithdraw";
import { depositAction } from "./actions/lending/deposit";
import { WithdrawAction } from "./actions/lending/withdraw";
import { BorrowAction } from "./actions/lending/borrow";
import { RepayAction } from "./actions/lending/repay";
import { ReserveAction } from "./actions/lending/reservesAction";
import { HealthAction } from "./actions/lending/health";
import { marketProvider } from "./providers/marketProvider";

const configSchema = z.object({
  SOLANA_RPC_URL: z.string().min(1, "SOLANA_RPC_URL is required"),
  SOLANA_PRIVATE_KEY: z.string().min(1, "SOLANA_PRIVATE_KEY is required"),
});

export const KaminoPlugin: Plugin = {
  name: "plugin-kamino",
  description:
    "Kamino Finance integration for elizaOS — lending, borrowing, collateral management, and market data on Solana.",

  config: {
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  },

  async init(config: Record<string, string>) {
    logger.info("[KaminoPlugin] Initializing plugin-kamino");
    try {
      // Validate required config; validated values are read by KaminoService
      // through runtime.getSetting() — not re-injected into process.env.
      await configSchema.parseAsync(config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const messages =
          error.issues?.map((e) => e.message)?.join(", ") ??
          "Unknown validation error";
        throw new Error(`Invalid plugin-kamino configuration: ${messages}`);
      }
      throw new Error(
        `Invalid plugin-kamino configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  routes: [
    {
      name: "kamino-status",
      path: "/api/kamino/status",
      type: "GET",
      handler: async (_req: RouteRequest, res: RouteResponse) => {
        res.json({
          status: "ok",
          plugin: "plugin-kamino",
          timestamp: new Date().toISOString(),
        });
      },
    },
  ],

  services: [KaminoService],
  actions: [
    LendAction,
    depositAction,
    BorrowAction,
    LendWithdraw,
    WithdrawAction,
    RepayAction,
    ReserveAction,
    HealthAction,
  ],
  providers: [marketProvider],
};

export default KaminoPlugin;
