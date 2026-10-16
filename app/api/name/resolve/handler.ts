import { NextRequest, NextResponse } from "next/server";
import { NAME_RESOLVE_PRICE_ATOMIC, NAME_RESOLVE_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { defaultRpcDeps, type RpcDeps } from "@/lib/chain-rpc";
import { NAME_RESOLVE_METHODOLOGY, nameResolve, parseNameInput } from "@/lib/name-resolve";

export const paymentOpts = {
  maxAmountRequired: NAME_RESOLVE_PRICE_ATOMIC,
  resource: "/api/name/resolve",
  description: ROUTE_METADATA["/api/name/resolve"].description,
} as const;

/** 400 bad input and 502 (RPCs down) never settle: not charged. Any 200 is billed. */
export async function nameResolveHandler(req: NextRequest, deps: RpcDeps = defaultRpcDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseNameInput({ name: q.get("name"), address: q.get("address") });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: parsed.status });
  }
  const result = await nameResolve(parsed.input, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, methodology: NAME_RESOLVE_METHODOLOGY }, { status });
  }
  return NextResponse.json({
    source: "name-resolve",
    priced: pricedBlock(NAME_RESOLVE_PRICE_USD, NAME_RESOLVE_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
