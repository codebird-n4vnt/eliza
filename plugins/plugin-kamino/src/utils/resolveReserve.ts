import { FixedRateReserveKind, KaminoMarket, KaminoReserve } from "@kamino-finance/klend-sdk";
import { BorrowParams } from "./parser";


export function resolveReserve(
    market: KaminoMarket,
    params: BorrowParams
) : KaminoReserve | null {
    const {token, rateKind, termDays} = params;
    if(rateKind === 'fixed'){
        const fixedReserves = market.getFixedRateReservesBySymbol(token);
        if(fixedReserves.length === 0) return null;

        if(termDays !== null){
            const termSeconds = termDays*24*60*60;
            const match = fixedReserves.find((r)=>{
                const kind = r.getKind() as FixedRateReserveKind;
                return kind.debtTermSeconds.eqn(termSeconds);
            });
            return match ?? null;
        }

        return fixedReserves.sort(
            (a,b) => a.totalBorrowAPYFixedRate() - b.totalBorrowAPYFixedRate()
        )[0];
    }

    return market.getFloatRateReserveBySymbol(token) ?? null;
}