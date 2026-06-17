import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseLendMessage } from "../../utils/parser";
import Decimal from "decimal.js";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";


export const LendAction: Action = {
    name : 'KAMINO_LEND',
    similes: [
        'LEND_ON_KAMINO',
        'DEPOSIT_LEND',
        'EARN_YIELD',
    ],
    description: 'Lend (pure supply) tokens into Kamino Lend to earn supply APY. This does NOT use the tokens as collateral for borrowing. Use when the user wants to earn passive yield, supply liquidity, or lend assets without borrowing against them. Or if the user wants to deposit to lending pool.',
    validate: async (runtime:IAgentRuntime,memory:Memory):Promise<boolean> =>{
        const service = runtime.getService<KaminoService>('kamino-service');
        const isInitialized = service?.isInitialized() ??  false;
        const isMarketAvailable = service?.getAllMarkets().size! > 0 ? true: false;
        const reserves = await service?.getAllReserves();
        const areReservesAvailable = reserves!.length>0?true:false;
        const isRpc = service?.getRpc() ? true : false;

        const text = memory?.content?.text!.toLowerCase();
        const hasLendingIntent = ['lend','earn yield', 'put', 'deposit to lend pool', 'supply'].some((w)=>text.includes(w));
        
        return isInitialized && isMarketAvailable && areReservesAvailable && isRpc && hasLendingIntent;
    },
    handler: async (runtime:IAgentRuntime,memory:Memory, state?:State, options?:any, callback?:HandlerCallback) => {
        const service = runtime.getService<KaminoService>('kamino-service');
        
        try {
            const params = await parseLendMessage(runtime,memory,state);
            if(!params){
                callback!({
                    text:'I need to know what token and how much you want to lend. For example: "Lend 100 USDC" Or "Supply 50 SOL for yield".' ,
                    action: 'KAMINO_LEND',
                });
                return;
            }
            const {token,amount, marketName} = params;
            const market = marketName ? service?.getMarket(marketName): service?.getDefaultMarket();
            if(!market){
                callback!({
                    text:`Market "${marketName}" not found.`,
                    action: 'KAMINO_LEND',
                });
                return;
            }

            const reserve = market.getFloatRateReserveBySymbol(token);
            if(!reserve){
                callback!({
                    text: `Reserve for ${token} not found in market ${market.getName()}.`,
                    action: 'KAMINO_LEND',
                })
                return;
            }

            const tokenMint = reserve.getLiquidityMint();
            const amountDecimal = new Decimal(amount);

            const action = await service?.buildLendTxns(
                marketName || 'default',
                tokenMint,
                amountDecimal
            );
            const signatures = await service?.sendActionTransaction(action!);

            service?.invalidateObligationCache(marketName || 'default', ObligationTypeTag.Lending);

            callback!({
                text:`Lending successful! **${amount} ${token}** deposited into Kamino Lend.\n\nTransaction: ${signatures!.join(', ')}`,
                action: 'KAMINO_LEND',
                data: {token,amount,signatures},
            })
        } catch (error) {
            callback!({
                text:`Lending failed: ${error}`,
                action:'KAMINO_LEND',
                data: { error: String(error)}
            });
        }
    },
    examples: [
    [
      { name: '{{user1}}', content: { text: 'Lend 100 USDC' } },
      { name: '{{agentName}}', content: { text: 'Successfully lent 100 USDC into Kamino Lend...', action: 'KAMINO_LEND' } },
    ],
    [
      { name: '{{user1}}', content: { text: 'Supply 50 SOL for yield' } },
      { name: '{{agentName}}', content: { text: 'Successfully supplied 50 SOL...', action: 'KAMINO_LEND' } },
    ],
  ],
        
}