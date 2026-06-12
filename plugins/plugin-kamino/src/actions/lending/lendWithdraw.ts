import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseLendWithdrawMessage } from "../../utils/parser";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";

export const LendWithdraw: Action = {

    name: 'KAMINO_LEND_WITHDRAW',
    similes: [
        'LEND_WITHDRAW',
        'WITHDRAW_LEND_DEPOSITS',
        'WITHDRAW_FROM_KAMINO_LEND',
        'WITHDRAW_SUPPLY',
    ],
    description: 'Withdraw deposits from a lending position in Kamino. Use when the user wants to exit their lending/supply position and reclaim their tokens plus earned interest.',
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        try {
            const service = runtime.getService<KaminoService>('kamino-service');
            if (!service?.isInitialized()) return false;

            const params = await parseLendWithdrawMessage(message.content.text);
            if (!params) return false;

            let { marketName } = params;
            if (!marketName) marketName = 'main';

            const userObligation = await service.getUserObligation(marketName, ObligationTypeTag.Lending);
            return !!userObligation && userObligation.deposits.values.length > 0;
        } catch {
            return false;
        }
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, options?: any, callback?: HandlerCallback) => {
        const service = runtime.getService<KaminoService>('kamino-service');

        try {
            const params = await parseLendWithdrawMessage(message.content.text);
            if (!params) {
                callback!({
                    text: 'I need to know what token and how much you want to withdraw. For example: "Withdraw 100 USDC from lending" or "Redeem all my SOL supply"',
                    action: 'KAMINO_LEND_WITHDRAW',
                });
                return;
            }
            const { token, amount, marketName } = params;
            const market = marketName ? service?.getMarket(marketName) : service?.getDefaultMarket();
            if (!market) {
                callback!({
                    text: `Market ${marketName} not found.`,
                    action: 'KAMINO_LEND_WITHDRAW',
                });
                return
            }
            const reserve = market?.getFloatRateReserveByMint(token);
            if (!reserve) {
                callback!({
                    text: `Reserve for ${token} not found`,
                    action: 'KAMINO_LEND_WITHDRAW',
                });
                return;
            }

            const tokenMint = reserve.getLiquidityMint();
            let amountDecimal;
            if (amount === 'max') {
                const userObligation = await service?.getUserObligation(market.getName(), ObligationTypeTag.Lending);
                if (!userObligation) {
                    callback!({
                        text: `Can't find you lending obligation for ${marketName}`,
                        action: 'KAMINO_LEND_WITHDRAW',
                    })
                }
                const userReserveValue = userObligation?.getDepositByReserve(reserve.address)?.amount;
                if (!userReserveValue) {
                    callback!({
                        text: `You don't have deposits in this reserve. `,
                        action: 'KAMINO_LEND_WITHDRAW'
                    });
                }
                amountDecimal = userReserveValue;
            } else {
                amountDecimal = new Decimal(amount);
            }

            const action = await service?.buildLendWithdrawTxns(market.getName(), tokenMint, amountDecimal!);

            const signatures = await service?.sendActionTransaction(action!);
            service?.invalidateObligationCache(market.getName(), ObligationTypeTag.Lending);

            callback!({
                text: `Withdraw of **${amount == 'max' ? 'all' : amount} ${token}** from Kamino lending is successful.\n\nTransaction: ${signatures?.join(', ')}`,
                action: 'KAMINO_LEND_WITHDRAW',
                data: { token, amount, signatures }
            });
        } catch (error) {
            callback!({
                text: `Withdraw failed: ${error}`,
                action: 'KAMINO_LEND_WITHDRAW',
                data: {error: String(error)},
            });
        }
    },
    examples:[
        [
            {name: '{{user1}}', content:{text: 'Withdraw 50 USDC from lending'}},
            {name: '{{agentName}}', content:{text: 'Withdraw of 50 USDC from Kamino lending is successful...', action:'KAMINO_LEND_WITHDRAW'}},
        ],
        [
            {name: '{{user1}}', content:{text: 'Redeem all my SOL supply'}},
            {name: '{{agentName}}', content:{text: 'Successfully redeemed all SOL...', action:'KAMINO_LEND_WITHDRAW'}},
        ]
    ]
}