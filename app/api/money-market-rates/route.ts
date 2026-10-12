import { NextRequest, NextResponse } from "next/server";
import { defaultMmrDeps, moneyMarketRates, parseQuery } from "@/lib/money-market-rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** FREE route (Markets spec v2): no x402, no 402, no payment header. 200 or 400 only. */
export async function GET(req: NextRequest) {
  const p = parseQuery(req.nextUrl.searchParams);
  if (!p.ok) return NextResponse.json({ ok: false, code: "bad_request", error: p.error }, { status: 400 });
  console.log(JSON.stringify({ evt: "free_call", route: "/api/money-market-rates", paid: false, kind: p.query.kind }));
  const body = await moneyMarketRates(p.query, defaultMmrDeps());
  return NextResponse.json(body, { status: 200, headers: { "cache-control": "public, max-age=60" } });
}
