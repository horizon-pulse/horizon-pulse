import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { premiumStore } from "@/lib/premium/store";
import { ddKeys } from "@/lib/seller-dd/caps";
import { DAILY_CAP_USD, LIFETIME_CAP_USD, SETTLE_FAIL_LIMIT, sellerDdEnabled } from "@/lib/seller-dd/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let nowForTests: (() => number) | null = null;
export function setSellerDdCountersClockForTests(f: (() => number) | null) { nowForTests = f; }

/**
 * Read-only seller-dd counter read (flag-on plan C3b option (b)): today's settle-failure count vs the 3/day limit, the
 * closed latch, and today's / lifetime test-pay spend. No writes, no RPC, no tester key, no alerts.
 * Flag off -> 204 before any env secret or store access. CRON_SECRET bearer (>= 16 chars, constant-time) else 401.
 * Store missing or unreadable -> 503 with readable:false (callers must treat as NOT zero).
 */
export async function GET(req: NextRequest) {
  if (!sellerDdEnabled()) return new NextResponse(null, { status: 204 });
  const secret = process.env.CRON_SECRET ?? "";
  const got = /^Bearer\s+(.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const ok = secret.length >= 16 && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const h = { "Cache-Control": "no-store" };
  const store = premiumStore();
  if (!store) return NextResponse.json({ readable: false, error: "store_unavailable" }, { status: 503, headers: h });
  const now = nowForTests?.() ?? Date.now();
  const num = (v: string | null) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : NaN; };
  try {
    const [fail, closed, spendDay, spendLife] = await Promise.all([
      store.get(ddKeys.settleFail(now)), store.get(ddKeys.settleClosed(now)), store.get(ddKeys.day(now)), store.get(ddKeys.life()),
    ]);
    const settleFail = num(fail);
    if ([settleFail, num(spendDay), num(spendLife)].some(Number.isNaN)) return NextResponse.json({ readable: false, error: "counter_unparseable" }, { status: 503, headers: h });
    return NextResponse.json({
      readable: true,
      utc_day: new Date(now).toISOString().slice(0, 10),
      settle_fail: settleFail,
      settle_fail_limit: SETTLE_FAIL_LIMIT,
      settle_closed: Boolean(closed) || settleFail >= SETTLE_FAIL_LIMIT,
      spend_day_usd: num(spendDay),
      daily_cap_usd: DAILY_CAP_USD,
      spend_lifetime_usd: num(spendLife),
      lifetime_cap_usd: LIFETIME_CAP_USD,
    }, { headers: h });
  } catch {
    return NextResponse.json({ readable: false, error: "store_unavailable" }, { status: 503, headers: h });
  }
}
