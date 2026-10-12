import { NextRequest, NextResponse } from "next/server";
import { MARKET_METHODOLOGY, searchMarket } from "@/lib/market/engine";
import { defaultDeps } from "@/lib/bazaar-check";
import { requestArrivedAt } from "@/lib/request-arrival";
import { MARKET_SEARCH_PRICE_ATOMIC, MARKET_SEARCH_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: MARKET_SEARCH_PRICE_ATOMIC,
  resource: "/api/market/search",
  description: ROUTE_METADATA["/api/market/search"].description,
} as const;

/**
 * Bad input (400), no results (404), CDP discovery down / too slow or too
 * little time left (502) return >=400 so settlement is skipped (not charged).
 * A non-empty ranked result is billed.
 */
export async function marketSearchHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const get = (k: string) => q.get(k) ?? undefined;
  const result = await searchMarket(
    { q: get("q"), n: get("n"), kind: get("kind"), rail: get("rail"), network: get("network"), max_price: get("max_price"), min_health: get("min_health") },
    defaultDeps(),
    { arrivedAt: requestArrivedAt() },
  );
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: MARKET_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "market-search",
    priced: pricedBlock(MARKET_SEARCH_PRICE_USD, MARKET_SEARCH_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
