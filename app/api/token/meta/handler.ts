import { NextRequest, NextResponse } from "next/server";
import { TOKEN_META_PRICE_ATOMIC, TOKEN_META_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { defaultRpcDeps, type RpcDeps } from "@/lib/chain-rpc";
import { TOKEN_META_METHODOLOGY, tokenMeta, parseTokenInput } from "@/lib/token-meta";

export const paymentOpts = {
  maxAmountRequired: TOKEN_META_PRICE_ATOMIC,
  resource: "/api/token/meta",
  description: ROUTE_METADATA["/api/token/meta"].description,
} as const;

/** 400 bad input and 502 (RPCs down) never settle: not charged. Any 200 is billed. */
export async function tokenMetaHandler(req: NextRequest, deps: RpcDeps = defaultRpcDeps()): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const parsed = parseTokenInput({ network: q.get("network"), token: q.get("token") });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: parsed.status });
  }
  const result = await tokenMeta(parsed.input, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, methodology: TOKEN_META_METHODOLOGY }, { status });
  }
  return NextResponse.json({
    source: "token-meta",
    priced: pricedBlock(TOKEN_META_PRICE_USD, TOKEN_META_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
