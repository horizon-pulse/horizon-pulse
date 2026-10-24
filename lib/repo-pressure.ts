/**
 * /api/repo-pressure (DARK, HP_REPO_PRESSURE_ENABLED, default off). Scope v2: to-odin/2026-10-23-pulse-repo-stress-scope.md
 * (method §3 and failure handling §7 of to-odin/2026-10-12-pulse-funding-stress-route-scope.md).
 * Derived descriptive read of published overnight funding rates: spreads in bp, percentile ranks, a calm/firm/stressed band.
 * Counsel P1/P2 (10/23): NO raw NY Fed value anywhere in the paid body (fields, note, errors); inputs are linked, free.
 * Thresholds fs-v1 are PROPOSALS pending Odin's review of a 2018-now calibration report (not yet filed). Arithmetic only, no LLM.
 */
import { BOARD_IORB_PAGE, bp, checkBoard, defaultFedDeps, derivedTerms, pctile, policyOn, readSeries, roundBp, type FedDeps, type NyObs } from "@/lib/fed-derived-inputs";

export const REPO_PRESSURE_SCOPE = "Derived descriptive read of published overnight funding rates; not a forecast, not investment advice.";
export const THRESHOLDS_VERSION = "fs-v1";
/** Spread rounding step in bp. 1 = whole bp per the repo-pressure scope (Counsel: COVERED with edits). Open Counsel question:
 * the later cash-benchmark ruling calls exact back-solvable spreads UNCLEAR; sofr_minus_iorb_bp + public IORB recovers SOFR. */
export const REPO_PRESSURE_SPREAD_STEP_BP = 1;
export const FS_V1 = {
  calm: { sofr_iorb_max: -3, p99_iorb_max: 5, iqr_max: 5 },
  stressed: { sofr_iorb_over: 2, p99_iorb_over: 15, iqr_over: 10 },
} as const;
export const WINDOW_1Y = 252;
export const MAX_RANGE_DAYS = 31;

export type Band = "calm" | "firm" | "stressed";
type Driver = "sofr_minus_iorb" | "p99_minus_iorb" | "iqr" | "none";
const RANK: Record<Band, number> = { calm: 0, firm: 1, stressed: 2 };

export type Query = { kind: "latest" } | { kind: "date"; date: string } | { kind: "last"; n: number } | { kind: "range"; start: string; end: string };
export type ParsedQ = { ok: true; q: Query; range: boolean } | { ok: false; error: string };
const ALLOWED = ["date", "last", "startDate", "endDate", "tier"];
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export function parseRepoQuery(p: URLSearchParams): ParsedQ {
  for (const k of p.keys()) if (!ALLOWED.includes(k)) return { ok: false, error: `Unknown param "${k}". Allowed: date, last (1-10), startDate+endDate (<= ${MAX_RANGE_DAYS} days), tier.` };
  const d = p.get("date"), l = p.get("last"), s = p.get("startDate"), e = p.get("endDate");
  if ([d !== null, l !== null, s !== null || e !== null].filter(Boolean).length > 1) return { ok: false, error: "date, last and startDate/endDate are mutually exclusive." };
  if (d !== null) return validDate(d) ? { ok: true, q: { kind: "date", date: d }, range: false } : { ok: false, error: "date must be YYYY-MM-DD." };
  if (l !== null) {
    if (!/^\d+$/.test(l) || +l < 1 || +l > 10) return { ok: false, error: "last must be an integer 1-10." };
    return +l === 1 ? { ok: true, q: { kind: "latest" }, range: false } : { ok: true, q: { kind: "last", n: +l }, range: true };
  }
  if (s !== null || e !== null) {
    if (s === null || e === null) return { ok: false, error: "startDate and endDate are required together." };
    if (!validDate(s) || !validDate(e)) return { ok: false, error: "Dates must be YYYY-MM-DD." };
    if (e < s) return { ok: false, error: "endDate must be >= startDate." };
    if ((Date.parse(e) - Date.parse(s)) / 86_400_000 + 1 > MAX_RANGE_DAYS) return { ok: false, error: `Date span must be <= ${MAX_RANGE_DAYS} calendar days.` };
    return { ok: true, q: { kind: "range", start: s, end: e }, range: true };
  }
  return { ok: true, q: { kind: "latest" }, range: false };
}

export type Comp = { sofr_minus_iorb_bp: number | null; sofr_p99_minus_iorb_bp: number | null; sofr_iqr_bp: number | null };
export function bandOf(c: Comp): { band: Band | "unavailable"; driver: Driver; partial: boolean } {
  const { sofr_minus_iorb_bp: a, sofr_p99_minus_iorb_bp: b, sofr_iqr_bp: q } = c;
  if (q === null) return { band: "unavailable", driver: "none", partial: false };
  const partial = a === null || b === null;
  const legs: [Driver, Band][] = [];
  if (a !== null) legs.push(["sofr_minus_iorb", a > FS_V1.stressed.sofr_iorb_over ? "stressed" : a > FS_V1.calm.sofr_iorb_max ? "firm" : "calm"]);
  if (b !== null) legs.push(["p99_minus_iorb", b > FS_V1.stressed.p99_iorb_over ? "stressed" : b > FS_V1.calm.p99_iorb_max ? "firm" : "calm"]);
  legs.push(["iqr", q > FS_V1.stressed.iqr_over ? "stressed" : q > FS_V1.calm.iqr_max ? "firm" : "calm"]);
  let best: [Driver, Band] = ["none", "calm"];
  for (const l of legs) if (RANK[l[1]] > RANK[best[1]]) best = l;
  return { band: best[1], driver: best[1] === "calm" ? "none" : best[0], partial };
}

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => { const w = dow(d); return w !== 0 && w !== 6; };
/** Calendar annotation only (never changes the band). Month/quarter end = last weekday of the month; tax date = the 15th of
 * Apr/Jun/Sep/Dec (US corporate estimated tax dates), or the next weekday when the 15th is a weekend. Holidays not modelled. */
export function seasonalFlag(d: string): "quarter_end" | "month_end" | "tax_date" | null {
  let n = addDays(d, 1);
  while (!weekday(n)) n = addDays(n, 1);
  const m = +d.slice(5, 7);
  if (n.slice(5, 7) !== d.slice(5, 7)) return [3, 6, 9, 12].includes(m) ? "quarter_end" : "month_end";
  if ([4, 6, 9, 12].includes(m)) {
    let t = `${d.slice(0, 8)}15`;
    while (!weekday(t)) t = addDays(t, 1);
    if (t === d) return "tax_date";
  }
  return null;
}

type Row = { date: string; comp: Comp; tgcr_bp: number | null; volume_pctile_1y: number | null; iorb_pctile_1y: number | null; band: Band | "unavailable"; driver: Driver; partial: boolean; revised: boolean; iorb_from: string | null; iorb_url: string | null };

export function computeRows(sofr: NyObs[], tgcr: NyObs[], iorbOk: boolean): Row[] {
  const asc = [...sofr].sort((a, b) => a.date.localeCompare(b.date));
  const tg = new Map(tgcr.map((o) => [o.date, o]));
  const spreadHist: (number | null)[] = [];
  const rows: Row[] = [];
  asc.forEach((o, i) => {
    const pol = iorbOk ? policyOn(o.date) : null;
    const a = pol ? bp(o.rate, pol.iorb) : null;
    const b = pol && o.p99 !== null ? bp(o.p99, pol.iorb) : null;
    const q = o.p25 !== null && o.p75 !== null ? bp(o.p75, o.p25) : null;
    spreadHist.push(a);
    const comp: Comp = { sofr_minus_iorb_bp: a, sofr_p99_minus_iorb_bp: b, sofr_iqr_bp: q };
    const t = tg.get(o.date);
    const from = Math.max(0, i - WINDOW_1Y + 1);
    const vols = asc.slice(from, i + 1).map((x) => x.volume).filter((v): v is number => v !== null);
    const spr = spreadHist.slice(from, i + 1).filter((v): v is number => v !== null);
    rows.push({
      date: o.date, comp, tgcr_bp: t ? bp(o.rate, t.rate) : null,
      volume_pctile_1y: o.volume !== null && i + 1 >= WINDOW_1Y ? pctile(o.volume, vols) : null,
      iorb_pctile_1y: a !== null && spr.length >= WINDOW_1Y ? pctile(a, spr) : null,
      ...bandOf(comp), revised: o.revised, iorb_from: pol?.effective ?? null, iorb_url: pol?.source_url ?? null,
    });
  });
  return rows;
}
export function persistence(rows: Row[], idx: number): number {
  const b = rows[idx]!.band;
  if (b === "unavailable") return 0;
  let n = 0;
  for (let i = idx; i >= 0; i--) { const x = rows[i]!.band; if (x === "unavailable" || RANK[x] < RANK[b]) break; n++; }
  return n;
}

const r1 = (v: number | null) => (v === null ? null : roundBp(v, REPO_PRESSURE_SPREAD_STEP_BP));
export function noteFor(r: Row): string {
  if (r.band === "unavailable") return "Not enough published inputs on this date for a read.";
  const a = r1(r.comp.sofr_minus_iorb_bp);
  const lead = a === null ? "IORB not verified, so the read uses SOFR dispersion only" : a === 0 ? "SOFR printed at IORB" : `SOFR printed ${Math.abs(a)} bp ${a < 0 ? "under" : "over"} IORB`;
  return `${lead}; band ${r.band}${r.driver !== "none" ? ` on the ${r.driver.replace(/_/g, " ")} leg` : ""}${r.partial ? " (partial)" : ""}.`;
}

export type RepoOk = { ok: true; body: Record<string, unknown> };
export type RepoErr = { ok: false; status: 400 | 503; code: string; error: string };
export async function repoPressure(q: Query, deps: FedDeps = defaultFedDeps()): Promise<RepoOk | RepoErr> {
  const [sofr, tgcr, board] = await Promise.all([readSeries("SOFR", deps), readSeries("TGCR", deps), checkBoard(deps)]);
  if (sofr.status === "unavailable" || !sofr.obs.length) return { ok: false, status: 503, code: "inputs_unavailable", error: "Published inputs unavailable; not charged. Retry later. The raw values are free at /api/money-market-rates." };
  const rows = computeRows(sofr.obs, tgcr.obs, board.status === "ok");
  let pick: number[];
  if (q.kind === "latest") pick = [rows.length - 1];
  else if (q.kind === "last") pick = rows.map((_, i) => i).slice(-q.n).reverse();
  else if (q.kind === "date") { const i = rows.findIndex((r) => r.date === q.date); if (i < 0) return { ok: false, status: 400, code: "no_publication", error: "No published SOFR for that date in the trailing window (weekend, holiday, future or too old); not charged." }; pick = [i]; }
  else pick = rows.map((r, i) => (r.date >= q.start && r.date <= q.end ? i : -1)).filter((i) => i >= 0).reverse();
  const servedMs = deps.now();
  const one = (i: number) => {
    const r = rows[i]!;
    return {
      as_of_effective_date: r.date,
      band: r.band, band_driver: r.driver, partial: r.partial, stale: sofr.status === "stale",
      persistence_days: persistence(rows, i),
      seasonal_flag: seasonalFlag(r.date),
      derived: {
        sofr_minus_iorb_bp: r1(r.comp.sofr_minus_iorb_bp), sofr_p99_minus_iorb_bp: r1(r.comp.sofr_p99_minus_iorb_bp), sofr_iqr_bp: r1(r.comp.sofr_iqr_bp),
        sofr_minus_tgcr_bp: r1(r.tgcr_bp), sofr_volume_pctile_1y: r.volume_pctile_1y, sofr_minus_iorb_bp_pctile_1y: r.iorb_pctile_1y,
      },
      revision_indicator_present: r.revised,
      iorb: { effective_from: r.iorb_from, source_url: r.iorb_url },
      note: noteFor(r),
    };
  };
  const latest = rows[rows.length - 1]!.date;
  const inputs = {
    nyfed: { free_at: `/api/money-market-rates?rates=SOFR,TGCR`, source_urls: [sofr.source_url, tgcr.source_url], status: sofr.status === "stale" ? `STALE as-of ${latest}` : sofr.status, tgcr_status: tgcr.status },
    iorb: { source: "Board of Governors of the Federal Reserve System, FOMC implementation note", source_url: BOARD_IORB_PAGE, status: board.status },
  };
  const base = { route: "repo-pressure", scope: REPO_PRESSURE_SCOPE, served_at: new Date(servedMs).toISOString(), thresholds_version: THRESHOLDS_VERSION, method_url: "/docs#repo-pressure-method" };
  const terms = derivedTerms(new Date(servedMs).getUTCFullYear(), "https://markets.newyorkfed.org/api/rates/secured/sofr/");
  if (q.kind === "latest" || q.kind === "date") return { ok: true, body: { ...base, ...one(pick[0]!), inputs, terms } };
  return { ok: true, body: { ...base, series: pick.map(one), ...(pick.length ? {} : { note: "No publications in range." }), inputs, terms } };
}

export const REPO_PRESSURE_DISCLAIMER =
  "Derived by Horizon Pulse from published data; not a forecast and not investment advice. Horizon Pulse is not affiliated with the New York Fed or the Federal Reserve System; neither sanctions or endorses this product. Raw published values are free at /api/money-market-rates and at the source.";
/** Route/listing description (DARK; Counsel review pending). No raw values, no NY Fed name as a selling point, no caller instructions. */
export const REPO_PRESSURE_DESCRIPTION =
  "Derived overnight funding-pressure read: SOFR spreads to the interest rate on reserve balances in bp, SOFR dispersion, SOFR minus TGCR, 1-year percentile ranks, persistence and a calm/firm/stressed band (method fs-v1). Raw published rates are free at /api/money-market-rates. Params: date, last (1-10) or startDate+endDate (<= 31 days, tier=range). Arithmetic only. Not affiliated with the New York Fed or the Federal Reserve System. Not investment advice.";
