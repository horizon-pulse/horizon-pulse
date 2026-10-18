import { NextRequest, NextResponse } from "next/server";
import { callerIp } from "@/lib/caller-ip";
import { defaultMmrDeps, moneyMarketRates, MmrUpstreamLimited, parseQuery } from "@/lib/money-market-rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** FREE route (Markets spec v2): no x402, no 402, no payment header. 200, 400, or 429 when the upstream fetch budget is spent and nothing is cached. */
export async function GET(req: NextRequest) {
  const p = parseQuery(req.nextUrl.searchParams);
  if (!p.ok) return NextResponse.json({ ok: false, code: "bad_request", error: p.error }, { status: 400 });
  console.log(JSON.stringify({ evt: "free_call", route: "/api/money-market-rates", paid: false, kind: p.query.kind }));
  // Shared caller-IP helper (lib/caller-ip.ts: Vercel ipAddress() source, x-real-ip; XFF never read).
  // No usable IP -> the shared "unknown" bucket, as before.
  const ip = callerIp(req) ?? undefined;
  try {
    // Spec v2 §6: `public, max-age=60` only. No s-maxage: a shared/CDN copy would
    // pin served_at to the first request's time (live-check 10/13).
    const body = await moneyMarketRates(p.query, { ...defaultMmrDeps(), clientIp: ip });
    return NextResponse.json(body, { status: 200, headers: { "cache-control": "public, max-age=60" } });
  } catch (e) {
    if (!(e instanceof MmrUpstreamLimited)) throw e;
    return NextResponse.json(
      { ok: false, code: "rate_limited", error: "Upstream NY Fed fetch limit reached and no cached values for this request; retry in about a minute. The same values are free at markets.newyorkfed.org." },
      { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } },
    );
  }
}
