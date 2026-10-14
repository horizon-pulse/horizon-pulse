import { NextRequest, NextResponse } from "next/server";
import { TX_STATUS_PRICE_ATOMIC, TX_STATUS_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { TX_STATUS_METHODOLOGY, defaultDeps, parseTxInput, txStatus, type Deps } from "@/lib/tx-status";

export const paymentOpts = {
  maxAmountRequired: TX_STATUS_PRICE_ATOMIC,
  resource: "/api/tx-status",
  description: ROUTE_METADATA["/api/tx-status"].description,
} as const;

/**
 * Bad input (400) and every public RPC down (502) return >= 400, so no rail
 * settles (not charged). Any 200 answer is billed, including status
 * not_found: that is the answer a polling agent pays for.
 */
export async function txStatusHandler(req: NextRequest, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseTxInput({ tx: q.get("tx") ?? undefined, network: q.get("network") ?? undefined });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: parsed.status });
  }
  const result = await txStatus(parsed.input, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, methodology: TX_STATUS_METHODOLOGY }, { status });
  }
  return NextResponse.json({
    source: "tx-status",
    priced: pricedBlock(TX_STATUS_PRICE_USD, TX_STATUS_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
