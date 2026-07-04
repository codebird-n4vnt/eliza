/**
 * End-to-end tests for @elizaos/plugin-kamino.
 *
 * These tests run against a live RPC endpoint and a funded wallet.
 * They are skipped by default in CI unless SOLANA_RPC_URL and
 * SOLANA_PRIVATE_KEY are present in the environment.
 *
 * Run manually with a Surfpool local validator:
 *   surfpool start
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 \
 *   SOLANA_PRIVATE_KEY=<base58_key> \
 *   bun test src/__tests__/e2e/kamino.e2e.ts
 */
import { describe, it, expect } from "bun:test";

const LIVE_RPC = process.env.SOLANA_RPC_URL;
const LIVE_KEY = process.env.SOLANA_PRIVATE_KEY;
const skipLive = !LIVE_RPC || !LIVE_KEY;

describe("KaminoService end-to-end", () => {
  it.skipIf(skipLive)(
    "loads reserves from a live market",
    async () => {
      // Dynamically import so the module is only loaded when env vars are set
      const { KaminoService } = await import("../../services/kamino");
      const { createRuntime } = await import("@elizaos/core");

      const runtime = createRuntime({
        settings: {
          SOLANA_RPC_URL: LIVE_RPC!,
          SOLANA_PRIVATE_KEY: LIVE_KEY!,
        },
      } as never);

      const service = await KaminoService.start(runtime);
      expect(service.isInitialized()).toBe(true);

      const reserves = await service.getAllReserves();
      expect(reserves.length).toBeGreaterThan(0);
      expect(reserves[0].symbol).toBeDefined();
      expect(Number(reserves[0].supplyAPY)).toBeGreaterThanOrEqual(0);

      await service.stop();
    },
    60_000,
  );

  it.skipIf(skipLive)(
    "returns health check with no positions for a fresh wallet",
    async () => {
      const { KaminoService } = await import("../../services/kamino");
      const { createRuntime } = await import("@elizaos/core");

      const runtime = createRuntime({
        settings: {
          SOLANA_RPC_URL: LIVE_RPC!,
          SOLANA_PRIVATE_KEY: LIVE_KEY!,
        },
      } as never);

      const service = await KaminoService.start(runtime);
      const health = await service.getHealthCheck();

      // Either no positions (fresh wallet) or valid positions
      expect(["safe", "caution", "danger", "critical"]).toContain(
        health.overallRisk,
      );
      expect(Array.isArray(health.positions)).toBe(true);

      await service.stop();
    },
    60_000,
  );
});
