import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { checkPackage, defaultDeps, PACKAGE_METHOD, parsePkgInput, type Deps } from "@/lib/package-safety";
import { DISCLAIMER, PACKAGE_DISCLAIMER_ADDENDUM } from "@/lib/dark-checks-shared";

/** DARK (HP_PACKAGE_CHECK_ENABLED). exists:false is a billed answer; 400 bad input, 502 registry down, 503 OSV down on deep: not charged. Every body carries the disclaimer. */
export async function packageCheckHandler(req: NextRequest, tier: Tier, receiptId: string, deps: Deps = defaultDeps()): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const refuse = (status: number, code: string, error: string) =>
    NextResponse.json({ ok: false, code, error, charged: false, receiptId, disclaimer: DISCLAIMER, dataNote: PACKAGE_DISCLAIMER_ADDENDUM }, { status });
  const q = req.nextUrl.searchParams;
  const parsed = parsePkgInput({ ecosystem: q.get("ecosystem"), name: q.get("name"), version: q.get("version") });
  if (!parsed.ok) return refuse(400, "bad_input", parsed.error);
  const r = await checkPackage(parsed.input, tier.id === "deep" ? "deep" : "base", deps);
  if (!r.ok) return refuse(r.status, r.code, r.error);
  return NextResponse.json({
    source: "package-check",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/package/check", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date().toISOString() },
    asOf: new Date().toISOString(),
    tier: tier.id,
    ...r.report,
    note: "Informational signals from public registries and OSV.dev at the time of the check; not a clearance of the package.",
    method: PACKAGE_METHOD,
    disclaimer: DISCLAIMER,
    dataNote: PACKAGE_DISCLAIMER_ADDENDUM,
  });
}
