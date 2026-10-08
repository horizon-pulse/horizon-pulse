import { NextRequest, NextResponse } from "next/server";
import { checkX402Endpoint, X402_CHECK_METHODOLOGY } from "@/lib/x402-check";
import {
  X402_CHECK_PRICE_ATOMIC,
  X402_CHECK_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: X402_CHECK_PRICE_ATOMIC,
  resource: "/api/x402-check",
  description: ROUTE_METADATA["/api/x402-check"].description,
} as const;

/**
 * Unreachable targets / bad input return >=400 so settlement is skipped
 * (caller not charged). Any HTTP answer from the target is a billable report.
 */
export async function x402CheckHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const result = await checkX402Endpoint({
    url: q.get("url") ?? undefined,
    method: q.get("method") ?? undefined,
    body: q.get("body") ?? undefined,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code, charged: false, methodology: X402_CHECK_METHODOLOGY },
      { status: result.status },
    );
  }
  return NextResponse.json({
    source: "x402-check",
    priced: pricedBlock(X402_CHECK_PRICE_USD, X402_CHECK_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
