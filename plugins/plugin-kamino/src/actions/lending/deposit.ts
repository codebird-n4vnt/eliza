// import {
//   createSolanaRpc,
//   createSolanaRpcSubscriptions,
//   address,
//   pipe,
//   createTransactionMessage,
//   setTransactionMessageFeePayerSigner,
//   setTransactionMessageLifetimeUsingBlockhash,
//   appendTransactionMessageInstructions,
//   signTransactionMessageWithSigners,
//   sendAndConfirmTransactionFactory,
//   assertIsTransactionWithinSizeLimit,
//   getSignatureFromTransaction,
//   type Signature,
//   type Rpc,
//   type RpcSubscriptions,
//   type GetEpochInfoApi,
//   type GetSignatureStatusesApi,
//   type SendTransactionApi,
//   type SignatureNotificationsApi,
//   type SlotNotificationsApi,
//   createSolanaRpcFromTransport,
//   ClusterUrl,
//   createKeyPairFromBytes,
//   createKeyPairSignerFromBytes,
//   createKeyPairSignerFromPrivateKeyBytes,
//   signAndSendTransactionMessageWithSigners,
//   appendTransactionMessageInstruction,
// } from '@solana/kit';
// import {
//   KaminoMarket,
//   KaminoAction,
//   LendingObligation,
//   VanillaObligation,
//   PROGRAM_ID,
//   Obligation
// } from '@kamino-finance/klend-sdk';
// import BN from 'bn.js';
// import bs58 from 'bs58';
// import { type ActionResult, type Action, type IAgentRuntime, type Memory, type State, type HandlerCallback, logger } from "@elizaos/core"

import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { Option } from "@solana/kit";
import { parseDepositMessage } from "../../utils/parser";
import Decimal from "decimal.js";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";


// const MAIN_MARKET_ADDRESS = address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
// const SLOT_DURATION_MS = 400;

// const tokens = {
//   'USDC' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
//   'USDT' :'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
//   'SOL' :'So11111111111111111111111111111111111111112',
//   'BONK' :'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
//   'JTO' :'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
//   'JUP' :'JUPyiwrYPRn4PvoxNtMFPTnVpeD7U4w6A7BwEwG4ETh',
//   'mSOL' :'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
//   'jitoSOL':'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
//   'bSOL' :'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piS1',
//   'PYTH' :'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3GBw832JcCgWq',
//   'WIF' :'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYS1d',
//   'USDH' :'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJT53Q',
// }

// function parseDepositMessage(text: string): {token:string; amount:number} | null{
//   const match = text.match(
//     /(\d+(?:\.\d+)?)\s*(USDC|SOL|USDT|BONK|JUP|JTO|mSOL|jitoSOL|bSOL|PYTH|WIF|USDH)/i,
//   );
//   if(!match) return null;
//   return {
//     amount: parseFloat(match[1]),
//     token: match[2].toUpperCase(),
//   };
// }


// export const KamninoLendDepositAction:Action =
// {
//   name: 'KAMINO_LEND_DEPOSIT',
//   similes: [
//     'DEPOSIT_TO_KAMINO_LEND',
//     'LEND_ON_KAMINO',
//     'PUT_INTO_KAMINO'
//   ],        // alternative names the agent recognises
//   description: 'Deposits tokens into the Kamino lending market. Handles setup, lending and cleanup instructions automatically',    // what the action does
//   validate: async (runtime:IAgentRuntime,message:Memory):Promise<boolean> => {
//     const hasRpc = !!runtime.getSetting('SOLANA_RPC_URL');
//     const hasKey = !!runtime.getSetting('SOLANA_PRIVATE_KEY');
    
//     const text = message.content.text?.toLowerCase() ?? '';
//     const hasDepositIntent = ['deposit', 'lend', 'put'].some((w)=> text.includes(w));
//     const mentionsKamino = text.includes('kamino');

//     return hasRpc && hasKey && hasDepositIntent && mentionsKamino;
//   },   // should this action run?
//   handler: async (
//     runtime: IAgentRuntime,
//     message: Memory,
//     _state: State | undefined,
//     _options: Record<string, unknown> = {},
//     callback?:HandlerCallback,
//   ):Promise<ActionResult> => {

//     try {
//       const parsed = parseDepositMessage(message.content.text??'');

//       if(!parsed){
//         const response = 'Please specify the token and amount. Example: "Deposit 100 USDC into Kamino lend"';

//         if(callback) await callback({
//           text: response,
//           actions: ['KAMINO_LEND_DEPOSIT'],
//           source: message.content.source
//         });

//         return { success: false, error: new Error('Could not parse token or amount') };
//       }

//       const {token, amount} = parsed;
//       logger.info(`[KAMINO_LEND_DEPOSIT] Depositing ${amount} ${token}`);

//       const rpcUrl = runtime.getSetting('SOLANA_RPC_URL');
//       const rpcSubscriptionUrl = runtime.getSetting('SOLANA_RPC_SUBSCRIPTION_URL');
//       const privateKeyStr = runtime.getSetting('SOLANA_PRIVATE_KEY');
      
//       const rpc = createSolanaRpc(rpcUrl as ClusterUrl);
//       const rpcSubscriptions = createSolanaRpcSubscriptions(rpcSubscriptionUrl as ClusterUrl)
//       const privateKeyBytes = bs58.decode(privateKeyStr);
//       const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKeyBytes);

//       const market = await KaminoMarket.load(
//         rpc,
//         address(MAIN_MARKET_ADDRESS),
//         SLOT_DURATION_MS,
//       );

//       const reserves = market?.getReservesBySymbol(token) ?? [];
//       const reserve = reserves[0]; // picked the first reserve only.

//       if (!reserve) {
//         const available = Array.from(market!.reserves.values()).map((r) => r.stats.symbol).join(', ')
        
//         const response = `${token} is not avaialable on Kamino. Supported tokens : ${available}`;

//         if(callback)
//           await callback({
//             text: response,
//             actions: ['KAMINO_LEND_DEPOSIT'],
//             source: message.content.source
//           });
        
//         return { success: false, error: new Error(`Reserve not found for ${token}`)};
//       }

//       const decimals = reserve.stats.decimals;
//       const amountBase = new BN(Math.floor(amount*Math.pow(10, decimals)));

//       const tokenAddress = tokens[token as keyof typeof tokens];
//       const obligation = new LendingObligation(address(tokenAddress), market!.programId, 0);

//       const currentSlot = await rpc.getSlot().send()

//       const kaminoAction = await KaminoAction.buildDepositReserveLiquidityTxns({
//         kaminoMarket: market!,
//         amount: amountBase,
//         reserveAddress: address(reserve.address),
//         owner: signer,
//         obligation,
//         scopeRefreshConfig: undefined,
//         currentSlot,
//       })

//       const {value:blockhash} = await rpc.getLatestBlockhash({commitment:'finalized'}).send();
//       const hasSetup = (kaminoAction.setupIxs?.length??0)>0;

//       if(hasSetup){
//         let setupSignature: Signature | undefined;
//         const setupTxMessage = pipe(
//           createTransactionMessage({version:0}),
//           (tx) => setTransactionMessageFeePayerSigner(signer, tx),
//           (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
//           (tx) => appendTransactionMessageInstructions(kaminoAction.setupIxs, tx),
//         )

//         const signedTransaction
//       }

//       const lendingInstructions = [
//         ...(kaminoAction.computeBudgetIxs??[]),
//         ...(kaminoAction.lendingIxs??[]),
//         ...(kaminoAction.cleanupIxs??[]),
//       ];

//       if(!lendingInstructions.length){
//         throw new Error('No instructions returned by Kamino SDK');
//       }

      
      
//       const tx = pipe(
//         createTransactionMessage({version:0}),
//         (t) => setTransactionMessageFeePayerSigner(signer,t),
//         (t) => appendTransactionMessageInstructions(lendingInstructions,t),
//         (t) => setTransactionMessageLifetimeUsingBlockhash(blockhash, t),
//       );

//       const signedTransaction = await signTransactionMessageWithSigners(tx);
//       assertIsTransactionWithinSizeLimit(signedTransaction);
//       const signature = getSignatureFromTransaction(signedTransaction);
//       await sendAndConfirmTransactionFactory({
//         rpc: rpc as Rpc<GetEpochInfoApi & GetSignatureStatusesApi & SendTransactionApi>,
//         rpcSubscriptions: rpcSubscriptions as RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>,
//       })(signedTransaction,{commitment: 'confirmed', skipPreflight:true,});

//       const supplyApy = reserve.totalSupplyAPY(currentSlot)?.toFixed(2)??'N/A';

//       const response =
//       `Deposited ${amount} ${token} into Kamino lending.\n`+
//       `Current supply APY: ${supplyApy}%\n`+
//       `Transaction: https://solscan.io/tx/${signature}`;

//       if(callback)
//         await callback({
//           text:response,
//           actions: ['KAMINO_LEND_DEPOSIT'],
//           source: message.content.source,
//       });

//       return {
//         success:true,
//         text:response,
//         data: {token,amount,signature,supplyApy}
//       };
      

//     } catch (error) {
//       const errMsg = error instanceof Error ? error.message : String(error);
//       logger.error(`[KAMINO_LEND_DEPOSIT] Failed: ${errMsg}`);
      
//       const isSetupError = 
//         errMsg.includes('0x17a3') ||
//         errMsg.includes('6051') ||
//         errMsg.includes('IncorrectInstructionInPosition');

//       const userMessage = isSetupError
//        ? 'Deposit failed : account setup required. Please try again - the setup will complete automatically on retry.'
//        : `Deposit failed : ${errMsg}`;
      
//       if(callback)
//         await callback({
//           text:userMessage,
//           actions:['KAMINO_LEND_DEPOSIT'],
//           source: message.content.source
//       })

//       return {
//         success : false,
//         error: error instanceof Error? error : new Error(errMsg)
//       };
//     }
//   }, // do the actual work
//   examples: [
//     [
//       { name:'{{name1', content: {text:'Deposit 100 USDC into Kamino'}},
//       {
//         name:'{{name2}}',
//         content:{
//           text: 'Deposited 100 USDC into Kamino lending. Current supply APY: 8.24%',
//           actions:['KAMINO_LEND_DEPOSIT'],
//         }
//       }
//     ],
//     [
//       { name: '{{name1}}', content:{text:'Lend 0.5 SOL on Kamino'}},
//       {
//         name: '{{name2}}',
//         content: {
//           text: 'Deposited 0.5 SOL into Kamino lending.',
//           actions: ['KAMINO_LEND_DEPOSIT'],
//         }
//       }
//     ],
//     [
//       { name: '{{name1}}', content:{text:'Put 500 USDT on Kamino lend'}},
//       {
//         name: '{{name2}}',
//         content: {
//           text: 'Deposited 500 USDT into Kamino lending.',
//           actions: ['KAMINO_LEND_DEPOSIT'],
//         }
//       }
//     ],
//   ]       // teaches the LLM when to call this
// }



export const depositAction : Action = {
    name:'KAMINO_DEPOSIT',
    similes:[
        'COLLATERAL_DEPOSIT',
        'DEPOSIT_ON_KAMINO',
        'KAMINO_BORROW_DEPOSIT',
        'SUPPLY_COLLATERAL',
    ],
    description: 'Deposit tokens as collateral into Kamino lend. This enables borrowing against the deposited assets. Use when the user wants to collateral before borrowing , or increase their collateral position.',
    validate: async (runtime: IAgentRuntime, message: Memory):Promise<boolean> =>{
        const service = runtime.getService<KaminoService>('kamino-service');
        const isInitialized = service?.isInitialized();
        return isInitialized ?? false;
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, options?:any, callback?: HandlerCallback) =>{
        const service = runtime.getService<KaminoService>('kamino-service');
        
        try {
            const params = await parseDepositMessage(runtime,message,state);
            if(!params){
                callback!({
                    text: 'I need to know what token and how much you want to deposit as collateral. For example: "Deposit 10 SOL as collateral" or "Add 500 USDC collateral" .',
                    action: 'KAMINO_DEPOSIT',
                });
                return;
            }
            
            const {token, amount, marketName} = params;
            const market = marketName ? service?.getMarket(marketName) : service?.getDefaultMarket();

            if(!market){
                callback!({
                    text: `Market "${marketName || 'default'}" not found`,
                    action: 'KAMINO_DEPOSIT',
                });
                return;
            }

            const reserve = market.getFloatRateReserveBySymbol(token);
            if(!reserve){
                callback!({
                    text: `Reserve for ${token} not found.`,
                    action: 'KAMINO_DEPOSIT',
                });
                return;
            }

            const tokenMint = reserve.getLiquidityMint();
            const amountDecimal = new Decimal(amount);

            const action = await service?.buildDepositTxns(
                market.getName(),
                tokenMint,
                amountDecimal,
            );

            const signatures = await service?.sendActionTransaction(action!);
            service?.invalidateObligationCache(market.getName(), ObligationTypeTag.Vanilla);

            callback!({
                text: `Successfully deposited **${amount} ${token}** as collateral.\n\nTransaction: ${signatures?.join(', ')}`,
                action:'KAMINO_DEPOSIT',
                data: {token, amount, signatures},
            });

        } catch (error) {
            callback!({
                text: `Deposit failed: ${error}`,
                action: 'KAMINO_DEPOSIT',
                data: {error: String(error)},
            });
        }
    },
    examples: [
        [
            {name: '{{user1}}', content:{text:'Deposit 10 SOL as collateral'}},
            {name: '{{agentName}}', content:{text:'Successfully deposited 10 SOL collateral...' ,action:'KAMINO_DEPOSIT'}},
        ],
        [
            {name: '{{user1}}', content:{text:'Add 500 USDC collateral'}},
            {name: '{{agentName}}', content:{text:'Successfully added 500 USDC as collateral...' ,action:'KAMINO_DEPOSIT'}},
        ]
    ]




}