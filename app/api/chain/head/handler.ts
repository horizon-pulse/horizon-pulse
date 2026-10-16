import { NextRequest, NextResponse } from "next/server";
import { CHAIN_HEAD_PRICE_ATOMIC, CHAIN_HEAD_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { defaultRpcDeps, type RpcDeps } from "@/lib/chain-rpc";
import { CHAIN_HEAD_METHODOLOGY, chainHead, parseHeadInput } from "@/lib/chain-head";

export const paymentOpts = {
  maxAmountRequired: CHAIN_HEAD_PRICE_ATOMIC,
  resource: "/api/chain/head",
  description: ROUTE_METADATA["/api/chain/head"].description,
} as const;

/** 400 bad input and 502 (RPCs down) never settle: not charged. Any 200 is billed. */
export async function chainHeadHandler(req: NextRequest, deps: RpcDeps = defaultRpcDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseHeadInput({ network: q.get("network") });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: parsed.status });
  }
  const result = await chainHead(parsed.input, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, methodology: CHAIN_HEAD_METHODOLOGY }, { status });
  }
  return NextResponse.json({
    source: "chain-head",
    priced: pricedBlock(CHAIN_HEAD_PRICE_USD, CHAIN_HEAD_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
