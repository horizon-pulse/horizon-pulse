import { NextRequest, NextResponse } from "next/server";
import { DISCOURSE_SPLIT_PRICE_ATOMIC, DISCOURSE_SPLIT_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { DISCOURSE_LABEL, METHOD, defaultDeps, discourseSplit, parseSplitInput, type Deps } from "@/lib/discourse/engine";

export const paymentOpts = {
  maxAmountRequired: DISCOURSE_SPLIT_PRICE_ATOMIC,
  resource: "/api/discourse/split",
  description: ROUTE_METADATA["/api/discourse/split"].description,
} as const;

/**
 * Bad input (400), refusals and insufficient data (422), sources down (502)
 * and no configured classifier (503) return >= 400, so no rail settles
 * (REST wrappers settle only on < 400; MCP only when !isError). A 200 answer is billed.
 */
export async function discourseSplitHandler(req: NextRequest, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseSplitInput({ q: q.get("q") ?? undefined, sides: q.get("sides") ?? undefined, window: q.get("window") ?? undefined });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false, label: DISCOURSE_LABEL }, { status: parsed.status });
  }
  const result = await discourseSplit(parsed.input, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, method: METHOD }, { status });
  }
  return NextResponse.json({
    source: "discourse-split",
    priced: pricedBlock(DISCOURSE_SPLIT_PRICE_USD, DISCOURSE_SPLIT_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
