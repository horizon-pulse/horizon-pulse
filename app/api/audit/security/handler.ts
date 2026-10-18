import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { defaultAuditDeps, parseTarget, runAudit, type AuditDeps, type AuditTier } from "@/lib/audit-security";

/** DARK (HP_AUDIT_SECURITY_ENABLED). 400 bad target, 502 unreachable, 503 CT source down (history/deep): never settle, not charged. */
export async function auditHandler(req: NextRequest, tier: Tier, receiptId: string, deps: AuditDeps = defaultAuditDeps()): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const target = await parseTarget(req.nextUrl.searchParams.get("target") ?? req.nextUrl.searchParams.get("url"));
  if (!target.ok) return NextResponse.json({ ok: false, code: target.code, error: target.error, charged: false, receiptId }, { status: 400 });
  const r = await runAudit(target.host, tier.id as AuditTier, deps);
  if (!r.ok) return NextResponse.json({ ok: false, code: r.code, error: r.error, charged: false, receiptId }, { status: r.status });
  return NextResponse.json({
    source: "audit-security",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/audit/security", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date().toISOString() },
    asOf: new Date().toISOString(),
    ...r.report,
  });
}
