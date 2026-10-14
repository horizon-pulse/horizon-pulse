import { NextRequest, NextResponse } from "next/server";
import { TOKENIZED_STOCK_PRICE_ATOMIC, TOKENIZED_STOCK_PRICE_USD } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { NOT_ADVICE, TOKENIZED_STOCK_METHODOLOGY, defaultDeps, parseStockInput, tokenizedStock, type Deps } from "@/lib/tokenized-stock";

export const paymentOpts = {
  maxAmountRequired: TOKENIZED_STOCK_PRICE_ATOMIC,
  resource: "/api/tokenized-stock",
  description: ROUTE_METADATA["/api/tokenized-stock"].description,
} as const;

/** 400 bad input, 404 unknown token, 502 RPCs down: >= 400, never settled (not charged). Any 200 is billed. */
export async function tokenizedStockHandler(req: NextRequest, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const parsed = parseStockInput({ symbol: req.nextUrl.searchParams.get("symbol") });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false, notAdvice: NOT_ADVICE }, { status: parsed.status });
  }
  const result = await tokenizedStock(parsed.tickers, deps);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json({ ...body, charged: false, methodology: TOKENIZED_STOCK_METHODOLOGY }, { status });
  }
  return NextResponse.json({
    source: "tokenized-stock",
    priced: pricedBlock(TOKENIZED_STOCK_PRICE_USD, TOKENIZED_STOCK_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    ...result,
  });
}
