import { NextRequest, NextResponse } from "next/server";
import { callerIp } from "@/lib/caller-ip";
import { darkEnabled, rateLimitHit } from "@/lib/dark-routes";
import { isOptedOut, normalizeOptOutQuery, OPT_OUT_CHECK_GLOBAL_PER_MIN, OPT_OUT_CHECK_PER_IP_PER_MIN, upstashLimiter, type SharedLimiter } from "@/lib/dark-checks-shared";

/**
 * GET /web-checks/opt-out?domain=example.com -> { domain, optedOut: true | false }.
 * Dark exactly when /web-checks is (404 unless the audit route flag is on). Exact
 * domain only; never returns or reveals the list. See lib/dark-checks-shared.ts.
 */
const H = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
export async function optOutHandler(req: NextRequest, limiter: SharedLimiter = upstashLimiter()): Promise<NextResponse> {
  if (!darkEnabled("audit")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const domain = normalizeOptOutQuery(req.nextUrl.searchParams.get("domain"));
  if (!domain) return NextResponse.json({ ok: false, code: "bad_domain", error: "domain must be one exact host name, e.g. example.com (no wildcards, paths or IP addresses)" }, { status: 400, headers: H });
  const wait = rateLimitHit(`optout:ip:${callerIp(req.headers) ?? "unknown"}`, OPT_OUT_CHECK_PER_IP_PER_MIN);
  if (wait) return NextResponse.json({ ok: false, code: "rate_limited", error: "Too many lookups; retry later." }, { status: 429, headers: { ...H, "Retry-After": String(wait) } });
  const g = await limiter("optout:global", OPT_OUT_CHECK_GLOBAL_PER_MIN);
  if (!g.ok) return NextResponse.json({ ok: false, code: "unavailable", error: "Lookup temporarily unavailable; retry later." }, { status: 503, headers: H });
  if (g.retryAfter) return NextResponse.json({ ok: false, code: "rate_limited", error: "Too many lookups; retry later." }, { status: 429, headers: { ...H, "Retry-After": String(g.retryAfter) } });
  return NextResponse.json({ domain, optedOut: isOptedOut(domain) }, { headers: H });
}
