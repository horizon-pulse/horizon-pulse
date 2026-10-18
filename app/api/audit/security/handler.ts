import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import { AUDIT_TARGET_PER_MINUTE, auditTierEnabled, type Tier } from "@/lib/dark-routes";
import { auditMethod, defaultAuditDeps, parseTarget, runAudit, type AuditDeps, type AuditTier } from "@/lib/audit-security";
import { DISCLAIMER, isOptedOut, upstashLimiter, type SharedLimiter } from "@/lib/dark-checks-shared";

/** Rate-limit key: parseTarget already lowercased, dropped scheme/port/path/trailing dot; www. and apex count as one site (Odin LOW). */
export function targetKey(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export type AuditCtx = { limiter: SharedLimiter; optedOut: (host: string) => boolean; safeCheck?: Parameters<typeof parseTarget>[2] };
export const defaultAuditCtx = (): AuditCtx => ({ limiter: upstashLimiter(), optedOut: (h) => isOptedOut(h) });

/**
 * DARK (HP_AUDIT_SECURITY_ENABLED). Web readiness checks.
 * Order (each refusal is before any request to the target, never settles, not charged):
 *   400 bad target -> 403 opted-out domain (checked before the DNS lookup) -> 429 shared per-target
 *   limit (Upstash, all instances) / 503 limit store unavailable (fail closed) -> checks.
 * 403 redirect_target_opted_out: a redirect hop led to an opted-out host; that hop was never requested and the check stops.
 * 502 unreachable, 503 CT source down (history/deep): not charged. Every body carries the disclaimer.
 */
export async function auditHandler(req: NextRequest, tier: Tier, receiptId: string, deps: AuditDeps = defaultAuditDeps(), ctx: AuditCtx = defaultAuditCtx()): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const refuse = (status: number, code: string, error: string, headers?: Record<string, string>) =>
    NextResponse.json({ ok: false, code, error, charged: false, receiptId, disclaimer: DISCLAIMER }, { status, headers });
  // Defense in depth: the runtime already 404s disabled tiers before payment.
  if (!auditTierEnabled(tier)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const target = await parseTarget(req.nextUrl.searchParams.get("target") ?? req.nextUrl.searchParams.get("url"), ctx.optedOut, ctx.safeCheck);
  if (!target.ok) return refuse(target.status ?? 400, target.code, target.error);
  const lim = await ctx.limiter(`target:${targetKey(target.host)}`, AUDIT_TARGET_PER_MINUTE);
  if (!lim.ok) return refuse(503, "rate_limit_unavailable", "The shared per-target rate limit could not be checked, so no request was sent. Not charged. Retry later.");
  if (lim.retryAfter) return refuse(429, "target_rate_limited", `This host was checked ${AUDIT_TARGET_PER_MINUTE} times in the last minute; retry later. Not charged.`, { "Retry-After": String(lim.retryAfter) });
  const r = await runAudit(target.host, tier.id as AuditTier, deps, ctx.optedOut);
  if (!r.ok) return refuse(r.status, r.code, r.error);
  return NextResponse.json({
    source: "web-readiness-checks",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/audit/security", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date().toISOString() },
    asOf: new Date().toISOString(),
    ...r.report,
    method: auditMethod(),
    disclaimer: DISCLAIMER,
  });
}
