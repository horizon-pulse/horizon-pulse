/**
 * Shared inputs for the NY Fed-derived paid reads (/api/repo-pressure, /api/cash-benchmark). Both are DARK.
 * NY Fed rule (reply 10/23 4:01 PM ET): "Horizon Pulse may charge for its analysis; not for the Content."
 * So raw NY Fed values are read here and used ONLY to compute derived fields; they never leave a paid body.
 * The raw values stay free at /api/money-market-rates and at the NY Fed source_url.
 *
 * IORB and ON RRP come from the Federal Reserve BOARD (public domain, cite the Board), from the FOMC
 * implementation notes listed below (each read on federalreserve.gov 10/24/2026). The Board's live
 * IORB file (PRATES.json, the table on /monetarypolicy/reserve-balances.htm) is read as a cross-check:
 * if it disagrees with this table (e.g. a new FOMC decision not yet committed here), IORB is UNVERIFIED
 * and every IORB/ON RRP-dependent field is null (fail closed). A new decision = one table row by commit.
 * No LLM, no FRED or other vendor, no interpolation.
 */
import { vendorFetch } from "@/lib/no-brotli";

export type PolicyRow = { effective: string; iorb: number; on_rrp: number; source_url: string };
/** Board implementation notes. Never applied before `effective` (no retroactive use). */
export const BOARD_POLICY_RATES: readonly PolicyRow[] = [
  { effective: "2025-09-18", iorb: 4.15, on_rrp: 4.0, source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20250917a1.htm" },
  { effective: "2025-10-30", iorb: 3.9, on_rrp: 3.75, source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20251029a1.htm" },
  { effective: "2025-12-11", iorb: 3.65, on_rrp: 3.5, source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20251210a1.htm" },
  { effective: "2026-09-17", iorb: 3.9, on_rrp: 3.75, source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a1.htm" },
] as const;
export const BOARD_PRATES_URL = "https://www.federalreserve.gov/monetarypolicy/prates/PRATES.json";
export const BOARD_IORB_PAGE = "https://www.federalreserve.gov/monetarypolicy/reserve-balances.htm";

export function policyOn(date: string, rows: readonly PolicyRow[] = BOARD_POLICY_RATES): PolicyRow | null {
  let hit: PolicyRow | null = null;
  for (const r of rows) if (r.effective <= date) hit = r;
  return hit;
}

export type NyObs = { date: string; rate: number; p1: number | null; p25: number | null; p75: number | null; p99: number | null; volume: number | null; revised: boolean };
export type Series = { obs: NyObs[]; source_url: string; status: "fresh" | "stale" | "unavailable"; at: number };
export type BoardCheck = { status: "ok" | "UNVERIFIED"; effective_from: string | null; checked_at: number | null };

export type FedDeps = {
  fetchJson: (url: string, ms: number) => Promise<unknown>;
  now: () => number;
};
export const defaultFedDeps = (): FedDeps => ({
  fetchJson: async (url, ms) => {
    const res = await vendorFetch(url, { signal: AbortSignal.timeout(ms), headers: { "user-agent": "HorizonPulse/1.0 (+https://horizonpulse.dev)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  now: () => Date.now(),
});

export const NY_SERIES = { SOFR: "secured/sofr", TGCR: "secured/tgcr", EFFR: "unsecured/effr" } as const;
export type NySeries = keyof typeof NY_SERIES;
/** Trailing window read per series: one upstream call covers a 1-year percentile plus a 31-day range. */
export const HISTORY_DAYS = 400;
export const SERIES_TTL_MS = 30 * 60_000;
export const SERIES_STALE_MAX_MS = 3 * 86_400_000;
export const BOARD_TTL_MS = 6 * 3600_000;
const FETCH_MS = 15_000;

const seriesCache = new Map<NySeries, Series>();
const inflight = new Map<NySeries, Promise<Series>>();
let boardCache: BoardCheck | null = null;
export function resetFedCachesForTests() { seriesCache.clear(); inflight.clear(); boardCache = null; }

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseSeries(payload: unknown, type: string): NyObs[] | null {
  const rr = (payload as { refRates?: unknown } | null)?.refRates;
  if (!Array.isArray(rr)) return null;
  const out: NyObs[] = [];
  for (const r of rr as Record<string, unknown>[]) {
    if (!r || r.type !== type || typeof r.effectiveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.effectiveDate)) continue;
    const rate = num(r.percentRate);
    if (rate === null) continue;
    out.push({ date: r.effectiveDate, rate, p1: num(r.percentPercentile1), p25: num(r.percentPercentile25), p75: num(r.percentPercentile75), p99: num(r.percentPercentile99), volume: num(r.volumeInBillions), revised: typeof r.revisionIndicator === "string" && r.revisionIndicator.trim() !== "" });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export async function readSeries(s: NySeries, deps: FedDeps): Promise<Series> {
  const now = deps.now();
  const c = seriesCache.get(s);
  if (c && now - c.at < SERIES_TTL_MS) return c;
  if (inflight.has(s)) return inflight.get(s)!;
  const url = `https://markets.newyorkfed.org/api/rates/${NY_SERIES[s]}/search.json?startDate=${ymd(now - HISTORY_DAYS * 86_400_000)}&endDate=${ymd(now)}`;
  const p = (async (): Promise<Series> => {
    try {
      const obs = parseSeries(await deps.fetchJson(url, FETCH_MS), s);
      if (obs && obs.length) {
        const v: Series = { obs, source_url: url, status: "fresh", at: now };
        seriesCache.set(s, v);
        return v;
      }
    } catch { /* fall through to last good */ }
    if (c && now - c.at < SERIES_STALE_MAX_MS) return { ...c, status: "stale" };
    return { obs: [], source_url: url, status: "unavailable", at: now };
  })().finally(() => inflight.delete(s));
  inflight.set(s, p);
  return p;
}

/** Cross-check the committed table against the Board's live IORB file. Fail closed on any doubt. */
export async function checkBoard(deps: FedDeps, rows: readonly PolicyRow[] = BOARD_POLICY_RATES): Promise<BoardCheck> {
  const now = deps.now();
  if (boardCache && boardCache.checked_at !== null && now - boardCache.checked_at < BOARD_TTL_MS) return boardCache;
  let out: BoardCheck = { status: "UNVERIFIED", effective_from: null, checked_at: null };
  try {
    const j = (await deps.fetchJson(BOARD_PRATES_URL, FETCH_MS)) as { Value?: unknown; EffectiveDate?: unknown };
    const v = typeof j?.Value === "string" ? Number(j.Value) : NaN;
    const m = typeof j?.EffectiveDate === "string" ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(j.EffectiveDate) : null;
    if (Number.isFinite(v) && m) {
      const eff = `${m[3]}-${m[1]}-${m[2]}`;
      const latest = rows[rows.length - 1];
      const ok = !!latest && latest.effective === eff && Math.abs(latest.iorb - v) < 1e-9;
      out = { status: ok ? "ok" : "UNVERIFIED", effective_from: ok ? eff : null, checked_at: now };
    }
  } catch { /* UNVERIFIED */ }
  if (out.status === "ok") boardCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// Small math helpers (bp from percent, no float drift beyond 1e-9)
// ---------------------------------------------------------------------------
export const bp = (a: number, b: number) => Math.round((a - b) * 100 * 1e6) / 1e6;
/** Round to a step in bp (1 = whole bp, 5 = Counsel's cash-benchmark fallback). */
export const roundBp = (v: number, step: number) => { const r = Math.round(v / step) * step; return r === 0 ? 0 : r; };
/** Share of `hist` strictly below v plus half the ties, in [0,1], 2 dp. null if hist is empty. */
export function pctile(v: number, hist: number[]): number | null {
  if (!hist.length) return null;
  let below = 0, eq = 0;
  for (const h of hist) { if (h < v - 1e-9) below++; else if (Math.abs(h - v) <= 1e-9) eq++; }
  return Math.round(((below + eq / 2) / hist.length) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Terms (Counsel strings, 10/23 markets-routes filing + cash-benchmark ruling). Paid bodies carry these.
// ---------------------------------------------------------------------------
export const DTCC_NOTICE_TEXT =
  'The Secured Overnight Financing Rate (SOFR) Data and Broad General Collateral Rate (BGCR) Data are calculated using data provided under a license granted to the New York Fed by DTCC Solutions LLC ("Solutions"), an affiliate of The Depository Trust & Clearing Corporation. Solutions, its affiliates, and third parties from which they obtained data have no liability for the content of this material.';
export function derivedTerms(year: number, sourceUrl: string, opts: { modifiedNote?: string } = {}) {
  return {
    derived_label: `Derived by Horizon Pulse from NY Fed data; not the NY Fed's; modified${opts.modifiedNote ? ` (${opts.modifiedNote})` : ""}. Calculations are Horizon Pulse's own and are not attributed to the New York Fed.`,
    credit: `Inputs: © ${year} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org. Original published values are free at ${sourceUrl} and at /api/money-market-rates.`,
    board_credit: "Source: Board of Governors of the Federal Reserve System (federalreserve.gov); public domain unless otherwise indicated.",
    not_affiliated: "Horizon Pulse is not affiliated with the New York Fed. The New York Fed does not sanction, endorse, or recommend any products or services offered by Horizon Pulse.",
    not_affiliated_board: "Horizon Pulse is not affiliated with the Federal Reserve Board, which does not endorse this product.",
    fee_line: "The fee is for Horizon Pulse's analysis only; NY Fed Content is free at the source.",
    pass_through: "Horizon Pulse adds no restrictions on NY Fed Content.",
    dtcc_notice: DTCC_NOTICE_TEXT,
    no_warranty: "Provided as is; no warranty. May not be current; see status.",
    not_advice: "Not investment advice.",
  };
}

/** Test helper: every raw NY Fed number (as printed by the NY Fed) that must never appear in a paid body. */
export function rawValueStrings(obs: NyObs[]): string[] {
  const out = new Set<string>();
  for (const o of obs) for (const v of [o.rate, o.p1, o.p25, o.p75, o.p99]) if (v !== null) { out.add(v.toFixed(2)); out.add(String(v)); }
  return [...out];
}
