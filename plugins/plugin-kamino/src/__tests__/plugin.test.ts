/**
 * Unit tests for @elizaos/plugin-kamino.
 *
 * Tests KaminoPlugin metadata, init validation, and per-action validate()
 * behaviour against a mock runtime — no live RPC calls are made here.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { KaminoPlugin } from "../index";
import type { Action } from "@elizaos/core";
import { createMockRuntime, createTestMemory } from "./test-utils";

// ─── Plugin metadata ─────────────────────────────────────────────────────────

describe("KaminoPlugin metadata", () => {
  it("exports a plugin with the correct name", () => {
    expect(KaminoPlugin.name).toBe("plugin-kamino");
  });

  it("has a non-empty description", () => {
    expect(KaminoPlugin.description.length).toBeGreaterThan(0);
  });

  it("registers exactly 8 actions", () => {
    expect(KaminoPlugin.actions).toBeDefined();
    expect(KaminoPlugin.actions?.length).toBe(8);
  });

  it("registers the KAMINO_MARKET provider", () => {
    const names = KaminoPlugin.providers?.map((p) => p.name) ?? [];
    expect(names).toContain("KAMINO_MARKET");
  });

  it("registers the KaminoService", () => {
    expect(KaminoPlugin.services).toBeDefined();
    expect(KaminoPlugin.services?.length).toBeGreaterThan(0);
  });

  it("registers a /api/kamino/status route", () => {
    const paths = KaminoPlugin.routes?.map((r) => r.path) ?? [];
    expect(paths).toContain("/api/kamino/status");
  });
});

// ─── Plugin init validation ───────────────────────────────────────────────────

describe("KaminoPlugin.init config validation", () => {
  it("resolves without throwing when required vars are present", async () => {
    await expect(
      KaminoPlugin.init!(
        {
          SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
          SOLANA_PRIVATE_KEY: "11111111111111111111111111111111",
        },
        createMockRuntime(),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws when SOLANA_RPC_URL is missing", async () => {
    await expect(
      KaminoPlugin.init!(
        { SOLANA_PRIVATE_KEY: "somekey" },
        createMockRuntime(),
      ),
    ).rejects.toThrow(/Invalid plugin-kamino configuration/);
  });

  it("throws when SOLANA_PRIVATE_KEY is missing", async () => {
    await expect(
      KaminoPlugin.init!(
        { SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" },
        createMockRuntime(),
      ),
    ).rejects.toThrow(/Invalid plugin-kamino configuration/);
  });

  it("throws when either var is an empty string", async () => {
    await expect(
      KaminoPlugin.init!(
        { SOLANA_RPC_URL: "", SOLANA_PRIVATE_KEY: "" },
        createMockRuntime(),
      ),
    ).rejects.toThrow(/Invalid plugin-kamino configuration/);
  });

  it("does not mutate process.env during init", async () => {
    const before = process.env.SOLANA_RPC_URL;
    await KaminoPlugin.init!(
      {
        SOLANA_RPC_URL: "https://test-rpc.example.com",
        SOLANA_PRIVATE_KEY: "somekey",
      },
      createMockRuntime(),
    );
    // init must not write back to process.env
    expect(process.env.SOLANA_RPC_URL).toBe(before);
  });
});

// ─── Action names ─────────────────────────────────────────────────────────────

describe("KaminoPlugin action names", () => {
  const expectedActions = [
    "KAMINO_LEND",
    "KAMINO_LEND_WITHDRAW",
    "KAMINO_DEPOSIT",
    "KAMINO_WITHDRAW",
    "KAMINO_BORROW",
    "KAMINO_REPAY",
    "KAMINO_RESERVES",
    "KAMINO_HEALTH",
  ];

  for (const name of expectedActions) {
    it(`registers action ${name}`, () => {
      const action = KaminoPlugin.actions?.find((a) => a.name === name);
      expect(action).toBeDefined();
    });
  }
});

// ─── Action validate() — service not initialised ─────────────────────────────

describe("Action validate() with uninitialised service", () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    // getService returns null → KaminoService not yet started
    runtime = createMockRuntime({ getService: () => null });
  });

  const actionNames = [
    "KAMINO_LEND",
    "KAMINO_DEPOSIT",
    "KAMINO_BORROW",
    "KAMINO_REPAY",
    "KAMINO_LEND_WITHDRAW",
    "KAMINO_WITHDRAW",
  ];

  for (const name of actionNames) {
    it(`${name}.validate() returns false when service is not ready`, async () => {
      const action = KaminoPlugin.actions?.find(
        (a) => a.name === name,
      ) as Action;
      expect(action).toBeDefined();
      const message = createTestMemory({
        content: { text: `test ${name.toLowerCase()}`, source: "test" },
      });
      const result = await action.validate(runtime, message);
      expect(result).toBe(false);
    });
  }
});

// ─── /api/kamino/status route ─────────────────────────────────────────────────

describe("KaminoPlugin status route", () => {
  it("returns status:ok with plugin name and timestamp", async () => {
    const route = KaminoPlugin.routes?.find(
      (r) => r.path === "/api/kamino/status",
    );
    expect(route?.handler).toBeDefined();

    let captured: Record<string, unknown> = {};
    const mockRes = { json: (data: Record<string, unknown>) => { captured = data; } };

    await route!.handler({} as never, mockRes as never, createMockRuntime());

    expect(captured.status).toBe("ok");
    expect(captured.plugin).toBe("plugin-kamino");
    expect(typeof captured.timestamp).toBe("string");
  });
});
