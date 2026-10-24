import { BOARD_IORB_PAGE, checkBoard, defaultFedDeps, derivedTerms, pctile, policyOn, readSeries, roundBp, bp, type FedDeps, type NyObs } from "./fed-derived-inputs";

/**
 * /api/cash-benchmark (DARK, HP_CASH_BENCHMARK_ENABLED). Counsel ruling 10/23 option (1):
 * - every spread (my_apy - benchmark and benchmark - benchmark) rounded to the nearest 5 bp;
 * - corridor position, SOFR 1-year percentile, SOFR 30-day change (also 5 bp);
 * - my_apy = 0 or within 0.05 of 0 is a 400 before payment; idle_cost dropped;
 * - IORB / ON RRP only from the Board table (FOMC implementation notes), never NY Fed RRP op results.
 * No raw NY Fed value in any body, note or error.
 */
export const CASH_BENCHMARK_STEP_BP = 5;
export const CASH_BENCHMARK_SCOPE = "Derived comparison of a caller-supplied yield against published overnight benchmarks; information only, not advice.";
export const WINDOW_1Y = 252;
export const MY_APY_MIN_ABS = 0.05;

export type CbQuery = { my_apy: number | null };
export function parseCashQuery(p: URLSearchParams): { ok: true; q: CbQuery } | { ok: false; error: string } {
  for (const k of p.keys()) if (k !== "my_apy" && k !== "tier") return { ok: false, error: `Unknown parameter: ${k.slice(0, 40)}` };
  const raw = p.get("my_apy");
  if (raw === null || raw === "") return { ok: true, q: { my_apy: null } };
  if (!/^-?\d{1,3}(\.\d{1,4})?$/.test(raw)) return { ok: false, error: "my_apy must be a percent like 4.10 (0 < my_apy <= 100, up to 4 decimals)." };
  const v = Number(raw);
  if (v < 0 || v > 100) return { ok: false, error: "my_apy must be between 0 and 100 (percent)." };
  if (Math.abs(v) <= MY_APY_MIN_ABS) return { ok: false, error: "my_apy must be above 0.05 (percent); near-zero values are not accepted." };
  return { ok: true, q: { my_apy: v } };
}

const s5 = (v: number | null) => (v === null ? null : roundBp(v, CASH_BENCHMARK_STEP_BP));
export type Corridor = "below_floor" | "inside_corridor" | "above_iorb";
export const corridorOf = (apy: number, onRrp: number, iorb: number): Corridor => (apy < onRrp ? "below_floor" : apy > iorb ? "above_iorb" : "inside_corridor");

export type CbOk = { ok: true; body: Record<string, unknown> };
export type CbErr = { ok: false; status: 503; code: string; error: string };
export async function cashBenchmark(q: CbQuery, deps: FedDeps = defaultFedDeps()): Promise<CbOk | CbErr> {
  const [sofr, effr, board] = await Promise.all([readSeries("SOFR", deps), readSeries("EFFR", deps), checkBoard(deps)]);
  if (sofr.status === "unavailable" || !sofr.obs.length) return { ok: false, status: 503, code: "inputs_unavailable", error: "Published inputs unavailable; not charged. Retry later. The raw values are free at /api/money-market-rates." };
  const obs: NyObs[] = [...sofr.obs].sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = obs[obs.length - 1]!;
  const pol = board.status === "ok" ? policyOn(last.date) : null;
  const effrLast = effr.status !== "unavailable" ? effr.obs.find((o) => o.date === last.date) ?? null : null;
  const hist = obs.slice(-WINDOW_1Y).map((o) => o.rate);
  const target = Date.parse(`${last.date}T00:00:00Z`) - 30 * 86_400_000;
  const prior = [...obs].reverse().find((o) => Date.parse(`${o.date}T00:00:00Z`) <= target) ?? null;
  const apy = q.my_apy;
  const derived = {
    my_apy_minus_sofr_bp: apy === null ? null : s5(bp(apy, last.rate)),
    my_apy_minus_effr_bp: apy === null || !effrLast ? null : s5(bp(apy, effrLast.rate)),
    my_apy_minus_iorb_bp: apy === null || !pol ? null : s5(bp(apy, pol.iorb)),
    my_apy_minus_on_rrp_bp: apy === null || !pol ? null : s5(bp(apy, pol.on_rrp)),
    my_apy_vs_corridor: apy === null || !pol ? null : corridorOf(apy, pol.on_rrp, pol.iorb),
    sofr_vs_corridor: pol ? corridorOf(last.rate, pol.on_rrp, pol.iorb) : null,
    sofr_minus_effr_bp: effrLast ? s5(bp(last.rate, effrLast.rate)) : null,
    sofr_minus_iorb_bp: pol ? s5(bp(last.rate, pol.iorb)) : null,
    effr_minus_iorb_bp: effrLast && pol ? s5(bp(effrLast.rate, pol.iorb)) : null,
    sofr_change_30d_bp: prior ? s5(bp(last.rate, prior.rate)) : null,
    sofr_level_pctile_1y: pctile(last.rate, hist),
  };
  const served = deps.now();
  const year = new Date(served).getUTCFullYear();
  const corr = derived.my_apy_vs_corridor ?? derived.sofr_vs_corridor;
  const note = corr === null ? "Board policy rates not verified, so corridor fields are omitted; spreads to SOFR and EFFR only." : `${apy === null ? "SOFR" : "The supplied yield"} sits ${corr === "below_floor" ? "below the ON RRP rate" : corr === "above_iorb" ? "above IORB" : "inside the ON RRP to IORB corridor"}; spreads are rounded to 5 bp.`;
  return {
    ok: true,
    body: {
      route: "cash-benchmark", scope: CASH_BENCHMARK_SCOPE, served_at: new Date(served).toISOString(),
      as_of: { nyfed_effective_date: last.date, iorb_effective_from: pol?.effective ?? null, on_rrp_effective_from: pol?.effective ?? null },
      input: { my_apy_pct: apy },
      derived, rounding_bp: CASH_BENCHMARK_STEP_BP,
      status: { nyfed: sofr.status === "stale" ? `STALE as-of ${last.date}` : sofr.status, effr: effr.status, board: board.status },
      raw_free_at: "/api/money-market-rates",
      source_urls: [sofr.source_url, effr.source_url, BOARD_IORB_PAGE, ...(pol ? [pol.source_url] : [])],
      note,
      terms: { ...derivedTerms(year, "https://markets.newyorkfed.org/api/rates/secured/sofr/", { modifiedNote: "rounded to 5 bp" }), not_advice: "Information only; not investment advice and not a recommendation of any product." },
    },
  };
}

export const CASH_BENCHMARK_DISCLAIMER =
  "Derived by Horizon Pulse from published data; information only, not investment advice and not a recommendation of any product. Horizon Pulse is not affiliated with the New York Fed or the Federal Reserve System; neither sanctions or endorses this product. Raw published values are free at /api/money-market-rates and at the source.";
/** DARK; Counsel copy review pending. */
export const CASH_BENCHMARK_DESCRIPTION =
  "Derived comparison of a caller-supplied yield (my_apy, percent) against published overnight benchmarks: spreads to SOFR, EFFR, IORB and the ON RRP rate rounded to 5 bp, corridor position, SOFR 30-day change and 1-year percentile. Raw published rates are free at /api/money-market-rates. Arithmetic only. Not affiliated with the New York Fed or the Federal Reserve System. Not investment advice.";
