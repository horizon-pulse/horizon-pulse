import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { defaultFedDeps, type FedDeps } from "@/lib/fed-derived-inputs";
import { parseRepoQuery, repoPressure, REPO_PRESSURE_DISCLAIMER } from "@/lib/repo-pressure";

/**
 * DARK (HP_REPO_PRESSURE_ENABLED). GET only. base ($0.01): latest or one date; range ($0.02): last 2-10 or a <=31-day range.
 * A 200 is billed; 400 (bad input, tier mismatch, no publication) and 503 (inputs unavailable) are not.
 * No raw NY Fed value in any body (Counsel P1/P2). Nothing from the request is stored or logged.
 */
export async function repoPressureHandler(req: NextRequest, tier: Tier, receiptId: string, deps: FedDeps = defaultFedDeps()): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const refuse = (status: number, code: string, error: string) =>
    NextResponse.json({ ok: false, code, error, charged: false, receiptId, disclaimer: REPO_PRESSURE_DISCLAIMER }, { status });
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(400, "bad_input", "GET only");
  const p = parseRepoQuery(req.nextUrl.searchParams);
  if (!p.ok) return refuse(400, "bad_input", p.error);
  if (p.range !== (tier.id === "range")) return refuse(400, "bad_tier", p.range ? "Multi-date queries need tier=range ($0.02)." : "tier=range is for last 2-10 or startDate+endDate; single dates use the base tier ($0.01).");
  const r = await repoPressure(p.q, deps);
  if (!r.ok) return refuse(r.status, r.code, r.error);
  return NextResponse.json({
    source: "repo-pressure",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/repo-pressure", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date(deps.now()).toISOString() },
    ...r.body,
    disclaimer: REPO_PRESSURE_DISCLAIMER,
  });
}
