import { Action, HandlerCallback, IAgentRuntime, Memory, MemoryRetrievalOptions, State } from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { boolean } from "zod";


export const ReserveAction: Action = {
    name: 'KAMINO_RESERVES',
    similes: [
        'LIST_KAMINO_RESERVES',
        'SHOW_KAMINO_RESERVES',
        'KAMINO_APYS',
        'WHAT_ARE_THE_RATES',
        'LENDING_RATES'
    ],
    description: 'List all available Kamino Lend reserves with current supply APY, borrow APY, LTV, and available liquidity. Use when the user asks about lending rates, borrowing rates, or wants to see what assets are available.',

    validate: async ( runtime:IAgentRuntime, message:Memory):Promise<boolean> => {
        const service = runtime.getService<KaminoService>('kamino-service');
        return service?.isInitialized() ?? false;
    },

    handler: async (runtime:IAgentRuntime, message: Memory, state?: State, options?: any, callback?: HandlerCallback) => {
        const service = runtime.getService<KaminoService>('kamino-service');
        
        try {
            const reserves = await service?.getAllReserves();

            if(reserves?.length===0){
                callback!({
                    text: 'No reserves are currently available.',
                    action: 'KAMINO_RESERVES',
                    data: {reserves: []},
                });
                return;
            }

            const lines = reserves?.map((r)=>{
                const type = r.depositEnabled && r.borrowEnabled
                 ? 'deposit + borrow'
                 : r.depositEnabled
                    ? 'deposit only'
                    : 'borrow only';
                return `- **${r.symbol}** (${r.marketName}): Supply ${r.supplyAPY}% | Borrow ${r.borrowAPY}% | LTV ${r.ltv} | Available ${r.availableLiquidity} ${r.symbol} | ${type}`;
            });
            callback!({
                text: `Here are the current Kamino Lend reserves: ${lines?.join('\n')}`,
                action: 'KAMINO_RESERVES',
                data: {reserves}
            });
        } catch (error) {
            callback!({
                text: `Failed to fetch reserves: ${error}`,
                action: 'KAMINO_RESERVES',
                data: { error: String(error)},
            });
        }
    },

    examples: [
        [
            {name: '{{user1}}', content: {text: "Show me available reserves"} },
            {name: '{{agentName}}', content: {text: 'Here are the current Kamino Lend reserves...', action: 'KAMINO_RESERVES'}},
        ],
        [
            {name: '{{user1}}', content: {text: "List all the available reserves"}},
            {name: '{{agentName}}', content:{text: 'Here are the current Kamino Lend reserves with their APYs...', action: 'KAMINO_RESERVES'}},
        ],
    ],
};

