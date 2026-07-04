# @elizaos/plugin-kamino

elizaOS plugin that connects Eliza agents to [Kamino Finance](https://kamino.finance)
on Solana, enabling natural-language lending, borrowing, and collateral management
via the `@kamino-finance/klend-sdk`.

## Layout

```
src/
  plugin.ts               Plugin registration (KaminoPlugin export)
  services/
    kamino.ts             KaminoService — market loading, tx construction, health
  actions/lending/
    lendAction.ts         KAMINO_LEND  — supply tokens for yield
    lendWithdraw.ts       KAMINO_LEND_WITHDRAW
    deposit.ts            KAMINO_DEPOSIT — collateral deposit
    withdraw.ts           KAMINO_WITHDRAW
    borrow.ts             KAMINO_BORROW
    repay.ts              KAMINO_REPAY  — supports "max" repay
    reservesAction.ts     KAMINO_RESERVES — live APY / liquidity query
    health.ts             KAMINO_HEALTH   — health factor + liquidation risk
  providers/
    marketProvider.ts     KAMINO_MARKET — injects reserve data into every LLM ctx
  types/index.ts          Shared interfaces (ReserveInfo, PositionInfo, …)
  utils/
    parser.ts             LLM response → typed action params
    resolveMax.ts         Resolves "max" repay/withdraw amounts
  __tests__/
    plugin.test.ts        Unit tests (no live RPC — mock runtime)
    e2e/                  End-to-end tests (requires live RPC + funded wallet)
```

## Key exports

```ts
import { KaminoPlugin } from "@elizaos/plugin-kamino";      // Plugin object
import { KaminoService } from "@elizaos/plugin-kamino";     // Service class
```

`index.ts` re-exports both; the default export is `KaminoPlugin`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SOLANA_RPC_URL` | ✅ | Solana HTTP RPC endpoint |
| `SOLANA_PRIVATE_KEY` | ✅ | Base58-encoded wallet private key |
| `SOLANA_WS_URL` | optional | WS endpoint (auto-derived from RPC URL if omitted) |
| `KAMINO_MARKETS` | optional | JSON array of `{name,address,description}` market configs |
| `KAMINO_REFRESH_MS` | optional | Market auto-refresh interval in ms (default: 30000) |

See `.env.example` for a complete example.

## Scripts

```bash
bun run build           # compile dist/
bun test                # unit tests
bun run --cwd ../.. verify   # workspace-level typecheck + lint
```

## Key conventions

- **Private key — memory only.** `KaminoService.loadSigner()` decodes base58
  in memory with `createKeyPairSignerFromBytes`. Never write a keypair to disk.
- **Structured logger only.** All server/runtime code uses `logger` from
  `@elizaos/core` with `[ClassName]` prefixes — no `console.*`.
- **Fail fast, no fabricated defaults.** `getCurrentSlot()` throws on RPC
  error — callers must not return `BigInt(0)` as a substitute. See the
  `error-policy:J<N>` annotations in `kamino.ts` for justified catch sites.
- **Transaction confirmation.** `sendActionTransaction` uses WS first, then
  falls back to HTTP polling (`pollForConfirmation`) so confirmed transactions
  are never reported as errors in the elizaOS UI.
- **`workspace:*` deps.** All `@elizaos/*` and `zod` entries in `package.json`
  use `workspace:*` — never pin to external npm ranges.

## Adding a new action

1. Create `src/actions/lending/<name>.ts` following the `Action` interface from
   `@elizaos/core`. Export a named const.
2. Import and add it to the `actions` array in `src/plugin.ts`.
3. Write a unit test in `src/__tests__/plugin.test.ts` covering `validate()`
   and the happy-path `handler()`.
