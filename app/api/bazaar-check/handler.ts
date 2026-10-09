import { NextRequest, NextResponse } from "next/server";
import { BAZAAR_CHECK_METHODOLOGY, checkBazaar, defaultDeps } from "@/lib/bazaar-check";
import { requestArrivedAt } from "@/lib/request-arrival";
import { BAZAAR_CHECK_PRICE_ATOMIC, BAZAAR_CHECK_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: BAZAAR_CHECK_PRICE_ATOMIC,
  resource: "/api/bazaar-check",
  description: ROUTE_METADATA["/api/bazaar-check"].description,
} as const;

/**
 * Bad input, blocked hosts, an unreachable host or CDP discovery being down
 * return >=400 so settlement is skipped (caller not charged). A completed
 * index + lint report is billed.
 */
export async function bazaarCheckHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  // Budget from request arrival (stamped in route.ts / app/mcp/route.ts before verify).
  const result = await checkBazaar({ url: q.get("url") ?? q.get("host") ?? undefined }, defaultDeps(), { arrivedAt: requestArrivedAt() });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: BAZAAR_CHECK_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "bazaar-check",
    priced: pricedBlock(BAZAAR_CHECK_PRICE_USD, BAZAAR_CHECK_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
