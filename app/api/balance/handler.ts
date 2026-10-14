import { NextRequest, NextResponse } from "next/server";
import { BALANCE_PRICE_ATOMIC, BALANCE_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { BALANCE_METHODOLOGY, balance, defaultDeps, parseBalanceInput, type Deps } from "@/lib/balance";

export const paymentOpts = {
  maxAmountRequired: BALANCE_PRICE_ATOMIC,
  resource: "/api/balance",
  description: ROUTE_METADATA["/api/balance"].description,
} as const;

/** 400 bad input and 502 (every requested rail's RPCs down) never settle: not charged. Any 200 is billed. */
export async function balanceHandler(req: NextRequest, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseBalanceInput({ evm: q.get("evm"), solana: q.get("solana"), xrpl: q.get("xrpl") });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: parsed.status });
  }
  const result = await balance(parsed.input, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, methodology: BALANCE_METHODOLOGY }, { status });
  }
  return NextResponse.json({
    source: "balance",
    priced: pricedBlock(BALANCE_PRICE_USD, BALANCE_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
