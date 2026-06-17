import {
    composePromptFromState,
    IAgentRuntime,
    JSONSchema,
    Memory,
    ModelType,
    State,
} from '@elizaos/core';
import type {
    DepositParams,
    BorrowParams,
    RepayParams,
    WithdrawParams,
} from '../types/index';

// ─── Extended Borrow type (adds rateKind + termDays on top of types/index.ts) ─

export type BorrowParamsExtended = BorrowParams & {
    rateKind: 'float' | 'fixed';
    termDays: number | null;
};

// ─── LendParams (mirror of DepositParams, kept separate for clarity) ──────────

export type LendParams = DepositParams;

// ─── Shared internal factory ──────────────────────────────────────────────────
// All parsers go through this — avoids repeating composePromptFromState boilerplate.

async function runObjectModel(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    template: string,
    schema: JSONSchema,
): Promise<Record<string, unknown> | null> {
    try {
        const currentState = state ?? (await runtime.composeState(message));

        const prompt = composePromptFromState({
            state: currentState,
            template,
        });

        const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
            prompt,
            schema,
        }) as Record<string, unknown>;

        if (!result?.token || !result?.amount) return null;
        return result;
    } catch {
        return null;
    }
}

// ─── Base schema (token + amount + marketName) ────────────────────────────────

const BASE_SCHEMA = {
    type: 'object',
    properties: {
        token:      { type: 'string' },
        amount:     { type: 'string' },        // kept as string — Decimal() in action
        marketName: { type: 'string' },
    },
    required: ['token', 'amount'],
};

// Same but amount also accepts the literal "max"
const MAX_SCHEMA = {
    type: 'object',
    properties: {
        token:      { type: 'string' },
        amount:     { type: 'string' },        // "max" or a numeric string
        marketName: { type: 'string' },
    },
    required: ['token', 'amount'],
};

// ─── parseLendMessage ─────────────────────────────────────────────────────────
// Used by: buildLendTxns (KaminoAction.buildDepositReserveLiquidityTxns)
// Supplies tokens into the reserve to earn interest — pure lending, no collateral.

const LEND_TEMPLATE = `
{{providers}}

Extract lending/supply parameters from the user message below.
The user wants to supply or lend tokens into Kamino to earn interest.
If the market is not specified, default to "main".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "USDC", "SOL", "USDT")
- amount: string (numeric string, e.g. "100", "0.5")
- marketName: string (default "main")
`.trim();

export async function parseLendMessage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
): Promise<LendParams | null> {
    const result = await runObjectModel(
        runtime, message, state, LEND_TEMPLATE, BASE_SCHEMA
    );
    if (!result) return null;

    return {
        token:      String(result.token).toUpperCase(),
        amount:     String(result.amount),
        marketName: String(result.marketName ?? 'main'),
    };
}

// ─── parseLendWithdrawMessage ─────────────────────────────────────────────────
// Used by: buildLendWithdrawTxns (KaminoAction.buildRedeemReserveCollateralTxns)
// Redeems cTokens from a lending position to get the underlying back.

const LEND_WITHDRAW_TEMPLATE = `
{{providers}}

Extract lend-withdrawal parameters from the user message below.
The user wants to withdraw tokens they previously supplied/lent to Kamino.
If the market is not specified, default to "main".
If the user says "all", "everything", or "max", set amount to "max".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "USDC", "SOL")
- amount: string ("max" or a numeric string like "100")
- marketName: string (default "main")
`.trim();

export async function parseLendWithdrawMessage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
): Promise<WithdrawParams | null> {
    const result = await runObjectModel(
        runtime, message, state, LEND_WITHDRAW_TEMPLATE, MAX_SCHEMA
    );
    if (!result) return null;

    return {
        token:      String(result.token).toUpperCase(),
        amount:     String(result.amount),       // may be "max"
        marketName: String(result.marketName ?? 'main'),
    };
}

// ─── parseDepositMessage ──────────────────────────────────────────────────────
// Used by: buildDepositTxns (KaminoAction.buildDepositTxns / VanillaObligation)
// Deposits collateral into a vanilla obligation to enable borrowing.

const DEPOSIT_TEMPLATE = `
{{providers}}

Extract collateral deposit parameters from the user message below.
The user wants to deposit tokens as collateral into Kamino to borrow against them.
If the market is not specified, default to "main".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "SOL", "USDC")
- amount: string (numeric string, e.g. "5", "100")
- marketName: string (default "main")
`.trim();

export async function parseDepositMessage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
): Promise<DepositParams | null> {
    const result = await runObjectModel(
        runtime, message, state, DEPOSIT_TEMPLATE, BASE_SCHEMA
    );
    if (!result) return null;

    return {
        token:      String(result.token).toUpperCase(),
        amount:     String(result.amount),
        marketName: String(result.marketName ?? 'main'),
    };
}

// ─── parseBorrowMessage ───────────────────────────────────────────────────────
// Used by: buildBorrowTxns (KaminoAction.buildBorrowTxns / VanillaObligation)
// Borrows tokens from the market against existing collateral.

const BORROW_SCHEMA = {
    type: 'object',
    properties: {
        token:      { type: 'string' },
        amount:     { type: 'string' },
        rateKind:   { type: 'string', enum: ['float', 'fixed'] },
        termDays:   { type: 'number' },        // number, not string — avoids Number() cast issues
        marketName: { type: 'string' },
    },
    required: ['token', 'amount'],
};

const BORROW_TEMPLATE = `
{{providers}}

Extract borrow parameters from the user message below.
The user wants to take a loan from Kamino against their deposited collateral.
If the rate type is not specified, default to "float" (variable rate).
If the market is not specified, default to "main".
Only set termDays if rateKind is "fixed" and the user mentioned a duration (e.g. 30 days, 90 days).

User message: "{{recentMessages}}"

Return JSON with:
- token: string      (e.g. "USDC", "SOL")
- amount: string     (numeric string)
- rateKind: string   ("float" or "fixed", default "float")
- termDays: number   (only for fixed rate; omit or null otherwise)
- marketName: string (default "main")
`.trim();

export async function parseBorrowMessage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
): Promise<BorrowParamsExtended | null> {
    const result = await runObjectModel(
        runtime, message, state, BORROW_TEMPLATE, BORROW_SCHEMA
    );
    if (!result) return null;

    return {
        token:      String(result.token).toUpperCase(),
        amount:     String(result.amount),
        rateKind:   (result.rateKind as 'float' | 'fixed') ?? 'float',
        termDays:   result.termDays != null ? Number(result.termDays) : null,
        marketName: String(result.marketName ?? 'main'),
    };
}

// ─── parseRepayMessage ────────────────────────────────────────────────────────
// Used by: buildRepayTxns (KaminoAction.buildRepayTxns / VanillaObligation)
// Repays borrowed tokens back to the market.

const REPAY_TEMPLATE = `
{{providers}}

Extract repay parameters from the user message below.
The user wants to repay a loan or debt on Kamino.
If the market is not specified, default to "main".
If the user says "all", "everything", "full", or "max", set amount to "max".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "USDC", "SOL")
- amount: string ("max" or a numeric string like "100")
- marketName: string (default "main")
`.trim();

export async function parseRepayMessage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
): Promise<RepayParams | null> {
    const result = await runObjectModel(
        runtime, message, state, REPAY_TEMPLATE, MAX_SCHEMA
    );
    if (!result) return null;

    return {
        token:      String(result.token).toUpperCase(),
        amount:     String(result.amount),       // may be "max"
        marketName: String(result.marketName ?? 'main'),
    };
}

// ─── parseWithdrawMessage ─────────────────────────────────────────────────────
// Used by: buildWithdrawTxns (KaminoAction.buildWithdrawTxns / VanillaObligation)
// Withdraws deposited collateral from a vanilla obligation.

const WITHDRAW_TEMPLATE = `
{{providers}}

Extract collateral withdrawal parameters from the user message below.
The user wants to withdraw collateral they previously deposited into Kamino.
If the market is not specified, default to "main".
If the user says "all", "everything", or "max", set amount to "max".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "SOL", "USDC")
- amount: string ("max" or a numeric string like "5")
- marketName: string (default "main")
`.trim();

export async function parseWithdrawMessage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
): Promise<WithdrawParams | null> {
    const result = await runObjectModel(
        runtime, message, state, WITHDRAW_TEMPLATE, MAX_SCHEMA
    );
    if (!result) return null;

    return {
        token:      String(result.token).toUpperCase(),
        amount:     String(result.amount),       // may be "max"
        marketName: String(result.marketName ?? 'main'),
    };
}