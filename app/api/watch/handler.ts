import { NextRequest, NextResponse } from "next/server";
import { WATCH_PRICE_ATOMIC, WATCH_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { WATCH_METHODOLOGY, defaultDeps, parseWatchInput, watch, type Deps } from "@/lib/watch";

export const paymentOpts = {
  maxAmountRequired: WATCH_PRICE_ATOMIC,
  resource: "/api/watch",
  description: ROUTE_METADATA["/api/watch"].description,
} as const;

/** 4xx/5xx (bad input, blocked, since mismatch, upstream down/timeout) never settle: not charged. Any 200 is billed. */
export async function watchHandler(req: NextRequest, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseWatchInput({ url: q.get("url"), since: q.get("since") });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: parsed.status });
  }
  const result = await watch(parsed.url, parsed.since, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, methodology: WATCH_METHODOLOGY }, { status });
  }
  return NextResponse.json({
    source: "watch",
    priced: pricedBlock(WATCH_PRICE_USD, WATCH_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
