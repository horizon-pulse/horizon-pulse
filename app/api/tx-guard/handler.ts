import { NextRequest, NextResponse } from "next/server";
import { TX_GUARD_PRICE_ATOMIC, TX_GUARD_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { defaultDeps, parseTxGuardInput, txGuard, type Deps } from "@/lib/tx-guard";

export const paymentOpts = {
  maxAmountRequired: TX_GUARD_PRICE_ATOMIC,
  resource: "/api/tx-guard",
  description: ROUTE_METADATA["/api/tx-guard"].description,
} as const;

/** 400 bad input never settles: not charged. Any 200 is billed (a check whose source did not answer is reported as unavailable). */
export async function txGuardHandler(req: NextRequest, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseTxGuardInput({ chain: q.get("chain"), to: q.get("to"), expected: q.get("expected"), token: q.get("token") });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: parsed.status });
  }
  const result = await txGuard(parsed.input, deps);
  return NextResponse.json({
    source: "tx-guard",
    priced: pricedBlock(TX_GUARD_PRICE_USD, TX_GUARD_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
