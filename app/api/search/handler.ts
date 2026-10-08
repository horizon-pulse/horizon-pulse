import { NextRequest, NextResponse } from "next/server";
import { SEARCH_METHODOLOGY, searchAndFetch } from "@/lib/search";
import { SEARCH_PRICE_ATOMIC, SEARCH_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: SEARCH_PRICE_ATOMIC,
  resource: "/api/search",
  description: ROUTE_METADATA["/api/search"].description,
} as const;

/** Failures return >=400 so settlement is skipped (caller not charged). */
export async function searchHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const result = await searchAndFetch({ q: q.get("q") ?? undefined, n: q.get("n") ?? undefined });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: SEARCH_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "search",
    priced: pricedBlock(SEARCH_PRICE_USD, SEARCH_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
