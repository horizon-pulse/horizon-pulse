import { NextRequest, NextResponse } from "next/server";
import { MARKET_METHODOLOGY, quoteOffer } from "@/lib/market/engine";
import { defaultDeps } from "@/lib/bazaar-check";
import { requestArrivedAt } from "@/lib/request-arrival";
import { MARKET_QUOTE_PRICE_ATOMIC, MARKET_QUOTE_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: MARKET_QUOTE_PRICE_ATOMIC,
  resource: "/api/market/quote",
  description: ROUTE_METADATA["/api/market/quote"].description,
} as const;

/**
 * Bad/http-only input or a blocked host (400), unreachable (502), timeout
 * (504) or too little time left (502) skip settlement (not charged). Any
 * https answer from the target is a billed quote (a non-402 is verdict avoid).
 */
export async function marketQuoteHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const result = await quoteOffer({ url: q.get("url") ?? undefined, method: q.get("method") ?? undefined }, defaultDeps(), {
    arrivedAt: requestArrivedAt(),
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: MARKET_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "market-quote",
    priced: pricedBlock(MARKET_QUOTE_PRICE_USD, MARKET_QUOTE_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
