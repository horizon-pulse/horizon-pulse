import { NextRequest, NextResponse } from "next/server";
import { checkX402Deep, defaultDeepDeps, X402_CHECK_DEEP_METHODOLOGY, type DeepDeps } from "@/lib/x402-check-deep";
import { X402_CHECK_DEEP_PRICE_ATOMIC, X402_CHECK_DEEP_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: X402_CHECK_DEEP_PRICE_ATOMIC,
  resource: "/api/x402-check/deep",
  description: ROUTE_METADATA["/api/x402-check/deep"].description,
} as const;

/**
 * Same billing as /api/x402-check: unreachable targets / bad input return
 * >=400 so settlement is skipped (caller not charged). Any HTTP answer from
 * the target is a billable report; extra checks that fail are reported as
 * unavailable inside it.
 */
export async function x402CheckDeepHandler(req: NextRequest, deps: DeepDeps = defaultDeepDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const result = await checkX402Deep(
    { url: q.get("url") ?? undefined, method: q.get("method") ?? undefined, body: q.get("body") ?? undefined },
    deps,
  );
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: X402_CHECK_DEEP_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "x402-check-deep",
    priced: pricedBlock(X402_CHECK_DEEP_PRICE_USD, X402_CHECK_DEEP_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
