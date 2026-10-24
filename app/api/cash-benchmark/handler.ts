import { NextRequest, NextResponse } from "next/server";
import { pricedBlock } from "@/lib/paid-rail";
import type { Tier } from "@/lib/dark-routes";
import { defaultFedDeps, type FedDeps } from "@/lib/fed-derived-inputs";
import { cashBenchmark, parseCashQuery, CASH_BENCHMARK_DISCLAIMER } from "@/lib/cash-benchmark";

/**
 * DARK (HP_CASH_BENCHMARK_ENABLED). GET only, base $0.005. A 200 is billed; 400/503 are not.
 * my_apy is the caller's own number; it is echoed, never stored or logged.
 */
export async function cashBenchmarkHandler(req: NextRequest, tier: Tier, receiptId: string, deps: FedDeps = defaultFedDeps()): Promise<NextResponse> {
  const TIER_PRICE_USD = tier.usd;
  const TIER_PRICE_ATOMIC = tier.atomicStr;
  const refuse = (status: number, code: string, error: string) =>
    NextResponse.json({ ok: false, code, error, charged: false, receiptId, disclaimer: CASH_BENCHMARK_DISCLAIMER }, { status });
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(400, "bad_input", "GET only");
  const p = parseCashQuery(req.nextUrl.searchParams);
  if (!p.ok) return refuse(400, "bad_input", p.error);
  const r = await cashBenchmark(p.q, deps);
  if (!r.ok) return refuse(r.status, r.code, r.error);
  return NextResponse.json({
    source: "cash-benchmark",
    priced: pricedBlock(TIER_PRICE_USD, TIER_PRICE_ATOMIC),
    receipt: { id: receiptId, route: "/api/cash-benchmark", tier: tier.id, amountAtomic: tier.atomicStr, issuedAt: new Date(deps.now()).toISOString() },
    ...r.body,
    disclaimer: CASH_BENCHMARK_DISCLAIMER,
  });
}
