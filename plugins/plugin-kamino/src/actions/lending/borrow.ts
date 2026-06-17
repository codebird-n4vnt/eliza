import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseBorrowMessage } from "../../utils/parser";
import { resolveReserve } from "../../utils/resolveReserve";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";

export const BorrowAction: Action = {
    name:'KAMINO_BORROW',
    similes: [
        'TAKE_LOAN',
        'BORROW_FUNDS',
        'GET_LOAN',
        'KAMINO_LOAN',
        'BORROW',
        'BORROW_FROM_KAMINO',

    ],
    description:'Borrow tokens from Kamino Lend against existing deposited collateral. Use when the user wants to take a loan, borrow an asset, or leverage their deposits. Supports both variable(float) and fixed rate borrows.',
    validate: async(runtime: IAgentRuntime, message:Memory, state?:State):Promise<boolean>=>{
        try {
            const service = runtime.getService<KaminoService>('kamino-service');
            if(!service?.isInitialized()) return false;

            const params = await parseBorrowMessage(runtime,message,state);
            if(!params?.amount || !params?.token) return false;
            const market = service.getMarket(params.marketName!);
            const reserve = resolveReserve(market!,params);
            if(!reserve) return false;

            return true;
        } catch (error) {
            return false;
        }
    },

    handler: async(runtime: IAgentRuntime, message: Memory, state?:State, _options?:any, callback?:HandlerCallback) =>{
        const service = runtime.getService<KaminoService>('kamino-service');

        const currentState = state ?? (await runtime.composeState(message));
        const params = await parseBorrowMessage(runtime,message,currentState);
        if(!params){
            await callback?.(
                {
                    text: "Couldn't parse your borrow request. Please specify the token and amount, e.g. 'Borrow 100 USDC'.",
                    error: true,
                }
            );
            return {success:false, text:'Parse failed'};
        }

        const {token,amount,rateKind,termDays,marketName} = params;
        const market = service?.getMarket(marketName!);
        const reserve = resolveReserve(market!,params);

        if(!reserve){
            const hint = 
                rateKind === 'fixed' && termDays 
                    ? `No fixed-rate reserve found for ${token} with a ${termDays}-day term.`
                    : `No ${rateKind} rate reserve found for ${token} in the ${marketName} market.`;
            await callback?.({ text: hint, error:true});
            return {success: false, text: 'Reserve not found'};
        }

        const obligation = await service?.getUserObligation(marketName!,ObligationTypeTag.Vanilla);
        if(!obligation || obligation.deposits.size === 0){
            await callback?.(
                {
                    text: 'You need to deposit collateral before borrowing. Use the deposit action first.',
                    error: true,
                }
            );
            return {success:false,text:'No collateral obligation found.'};
        }
        const tokenMint = reserve.getLiquidityMint();
        const amountDecimal = new Decimal(amount);
        try {
            const action = await service?.buildBorrowTxns(
                marketName!,
                tokenMint,
                amountDecimal
            );
            const tx = await service?.sendActionTransaction(action!);
            const apyLabel = rateKind === 'fixed' 
                ? `${(reserve.totalBorrowAPYFixedRate()*100).toFixed(2)}% fixed`
                : `${(reserve.totalBorrowAPY((await service?.getCurrentSlot())!)).toFixed(2)}% variable`;
            
            await callback!({
                text:`Borrowed ${amount} ${token} at ${apyLabel}. Transaction: ${tx}`,
                action:'KAMINO_BORROW',
                data: {token,amount,tx}
            });

        } catch (error) {
            await callback!({
                text:`Deposit failed: ${error}`,
                action:'KAMINO_BORROW',
                data:{error: String(error)}
            });
        }
    },
    examples:[
        [
            {name:'{{user}}',content:{text:'I want to take a 30 day fixed loan of 50 SOL'}},
            {name:'{{agentName}}', content:{text:'Borrowed 50 SOl at 5.10% fixed (30-day term)', action:'KAMINO_BORROW'}},
        ],
        [
            {name:'{{user}}', content:{text:'borrow 100 USDC'}},
            {name:'{{agentName}}', content:{text:'Borrowed 100 USDC at 8.23% variable.', action:'KAMINO_BORROW'}}
        ],
        [
            {name: '{{user}}', content:{text:'borrow 200 USDT at the cheapest rate'}},
            {name: '{{agentName}}', content:{text:'Borrowed 200 USDT at 7.40% variable.', action:'KAMINO_BORROW'}}
        ]
    ]

}