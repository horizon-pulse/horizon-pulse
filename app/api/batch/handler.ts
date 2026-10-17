import { NextRequest, NextResponse } from "next/server";
import { BATCH_PRICE_ATOMIC, BATCH_PRICE_USD, PUBLIC_BASE_URL } from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { parseBatchBody, runBatch } from "@/lib/batch";
import { balanceHandler } from "../balance/handler";
import { gasHandler } from "../gas/handler";
import { txStatusHandler } from "../tx-status/handler";
import { tokenMetaHandler } from "../token/meta/handler";
import { chainHeadHandler } from "../chain/head/handler";
import { nameResolveHandler } from "../name/resolve/handler";

export const paymentOpts = {
  maxAmountRequired: BATCH_PRICE_ATOMIC,
  resource: "/api/batch",
  description: ROUTE_METADATA["/api/batch"].description,
} as const;

type H = (req: NextRequest) => Promise<Response>;
const HANDLERS: Record<string, H> = {
  balance: (r) => balanceHandler(r),
  gas: (r) => gasHandler(r),
  "tx-status": (r) => txStatusHandler(r),
  "token/meta": (r) => tokenMetaHandler(r),
  "chain/head": (r) => chainHeadHandler(r),
  "name/resolve": (r) => nameResolveHandler(r),
};

/** 400 bad input and 502 (every item failed) never settle: not charged. Any 200 is one charge for the whole batch. */
export async function batchHandler(req: NextRequest, handlers: Record<string, H> = HANDLERS): Promise<NextResponse> {
  // POST: JSON body {items}. GET: ?items=<JSON array> (same shape), for GET-only clients.
  let raw: unknown;
  try {
    raw = req.method === "GET" ? { items: JSON.parse(req.nextUrl.searchParams.get("items") ?? "null") } : await req.json();
  } catch {
    raw = null;
  }
  const parsed = parseBatchBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error, code: parsed.code, charged: false }, { status: 400 });
  }
  const results = await runBatch(parsed.items, (route, query) =>
    handlers[route](new NextRequest(`${PUBLIC_BASE_URL}/api/${route}?${query.toString()}`, { method: "GET" })),
  );
  const okCount = results.filter((r) => r.ok).length;
  if (okCount === 0) {
    return NextResponse.json({ ok: false, error: "Every item failed.", code: "all_items_failed", charged: false, results }, { status: 502 });
  }
  return NextResponse.json({
    source: "batch",
    priced: pricedBlock(BATCH_PRICE_USD, BATCH_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    count: results.length,
    okCount,
    results,
  });
}
