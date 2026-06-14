import { composePromptFromState, IAgentRuntime, Memory, ModelType, State } from "@elizaos/core"
import z, { string } from "zod"

export const parseLendMessage(): {token:string,amount:string,marketName:string} =>{
    
}

export const parseLendWithdrawMessage(): {token:string,amount:string,marketName:string} =>{
    
}

export const parseDepositMessage(): {token:string,amount:string,marketName:string} =>{
    
}


const BorrowParamsSchema = z.object({
    token: z
        .string()
        .describe('Token symbol to borrow, e.g. USDC, SOL, USDT'),
    amount: z
        .string()
        .describe('Amount to borrow'),
    rateKind: z
        .enum(['float', 'fixed'])
        .default('float')
        .describe('float = variable rate(default), fixed = fixed-term loan'),
    termDays: z
        .number()
        .nullable()
        .default(null)
        .describe('Loan duration in days, only relevant when ratekind is fixed. e.g. 30, 90'),
    marketName: z
        .string()
        .default('main')
        .describe('Kamino market name, defaults to main'),    
});
export type BorrowParams = z.infer<typeof BorrowParamsSchema>;
const borrowParserTemplate = `
{{providers}}

Extract the borrow parameters from the user message below.
If the user does not specify a rate type, default to float.
If the user does not specify a market, default to "main",
Only populate termDays if rateKind is fixed and the user mentioned a duration.

User message: "{{recentMessage}}"
`
export async function parseBorrowMessage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
): Promise<BorrowParams | null>{
    try {
        const currentState = state ?? (await runtime.composeState(message));

        const prompt = composePromptFromState({
            state: currentState,
            template: borrowParserTemplate,
        });
        const result = await runtime.useModel(ModelType.OBJECT_SMALL,{
            prompt,
            schema: {
                type: 'object',
                properties: {
                    token: {type:'string'},
                    amount: {type:'number'},
                    rateKind: {type:'string', enum:['float','fixed']},
                    termDays: {type:'string'},
                    marketName: {type:'string'}
                },
                required:['token','amount']
            },

        }) as Record<string,unknown>;

        if(!result?.token || !result?.amount) return null;

        return{
            token: String(result.token).toUpperCase(),
            amount: String(result.amount),
            rateKind: (result.rateKind as 'float' | 'fixed') ?? 'float',
            termDays: result.termDays != null ? Number(result.termDays) : null,
            marketName: String(result.marketName??'main'),
        };
    } catch (error) {
        return null;
    }
}