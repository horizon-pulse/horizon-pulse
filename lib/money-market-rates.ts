/**
 * /api/money-market-rates: published NY Fed reference rates as released.
 * FREE route, no x402. Spec: Markets route spec v2 (2026-10-09, sha 8ef92603…7973).
 * Values and NY Fed field names pass through unchanged; nothing is derived.
 * Holidays are read live from the NY Fed holiday page and Board K.8 (never hard-coded).
 */

export const MMR_SCOPE =
  "Published NY Fed reference rates as released; market data only, not a forecast, not a recommendation.";
import { vendorFetch } from "@/lib/no-brotli";
export const MMR_RATES = ["SOFR", "EFFR", "OBFR", "TGCR", "BGCR"] as const;
export type MmrRate = (typeof MMR_RATES)[number];
const SECURED = new Set<MmrRate>(["SOFR", "TGCR", "BGCR"]);
export const NYFED_BASE = "https://markets.newyorkfed.org/api/rates/";
export const HOLIDAY_SOURCES = [
  "https://www.newyorkfed.org/aboutthefed/holiday_schedule",
  "https://www.federalreserve.gov/aboutthefed/k8.htm",
] as const;
const SOURCE = "Federal Reserve Bank of New York, Markets Data API";
const OBS_FIELDS = [
  "effectiveDate", "percentRate", "percentPercentile1", "percentPercentile25",
  "percentPercentile75", "percentPercentile99", "volumeInBillions", "revisionIndicator",
] as const;
const EFFR_EXTRA = ["targetRateFrom", "targetRateTo"] as const;
export const ATTEMPT_TIMEOUT_MS = 20_000;
export const HOLIDAY_REFRESH_MS = 6 * 3600_000;
export const HOLIDAY_MAX_AGE_MS = 24 * 3600_000;
export const CACHE_TTL_MS = 10 * 60_000;
export const MIN_START = "2018-04-02";

export type MmrQuery =
  | { kind: "latest"; rates: MmrRate[] }
  | { kind: "last"; rates: MmrRate[]; n: number }
  | { kind: "range"; rates: MmrRate[]; startDate: string; endDate: string };

export type ParseResult = { ok: true; query: MmrQuery } | { ok: false; error: string };
const ALLOWED = ["rates", "last", "startDate", "endDate"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseQuery(params: URLSearchParams): ParseResult {
  const bad = (e: string): ParseResult => ({ ok: false, error: `${e} Allowed params: ${ALLOWED.join(", ")}; rates from ${MMR_RATES.join(",")}.` });
  for (const k of params.keys()) if (!ALLOWED.includes(k)) return bad(`Unknown param "${k}".`);
  let rates: MmrRate[] = [...MMR_RATES];
  const r = params.get("rates");
  if (r !== null) {
    const asked = r.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!asked.length) return bad("rates is empty.");
    for (const a of asked) if (!(MMR_RATES as readonly string[]).includes(a)) return bad(`Unknown rate "${a}".`);
    rates = MMR_RATES.filter((x) => asked.includes(x));
  }
  const last = params.get("last");
  const s = params.get("startDate");
  const e = params.get("endDate");
  if (last !== null && (s !== null || e !== null)) return bad("last and startDate/endDate are mutually exclusive.");
  if (s !== null || e !== null) {
    if (s === null || e === null) return bad("startDate and endDate are required together.");
    if (!validDate(s) || !validDate(e)) return bad("Dates must be YYYY-MM-DD.");
    if (s < MIN_START) return bad(`startDate must be >= ${MIN_START}.`);
    if (e < s) return bad("endDate must be >= startDate.");
    const span = (Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000 + 1;
    if (span > 31) return bad("Date span must be <= 31 calendar days.");
    return { ok: true, query: { kind: "range", rates, startDate: s, endDate: e } };
  }
  if (last !== null) {
    if (!/^\d+$/.test(last) || +last < 1 || +last > 10) return bad("last must be an integer 1-10.");
    if (+last > 1) return { ok: true, query: { kind: "last", rates, n: +last } };
  }
  return { ok: true, query: { kind: "latest", rates } };
}

export function rateUrl(rate: MmrRate, q: MmrQuery, forceLast1 = false): string {
  const grp = SECURED.has(rate) ? "secured" : "unsecured";
  const p = `${NYFED_BASE}${grp}/${rate.toLowerCase()}`;
  if (q.kind === "range") return `${p}/search.json?startDate=${q.startDate}&endDate=${q.endDate}`; // no type= (drops volume)
  if (q.kind === "last") return `${p}/last/${q.n}.json`;
  return forceLast1 ? `${p}/last/1.json` : `${NYFED_BASE}all/latest.json`;
}

export function notice(rate: MmrRate): string {
  return `The ${rate} is subject to the Terms of Use posted at newyorkfed.org. The New York Fed is not responsible for publication of the ${rate} by Horizon Pulse, does not sanction or endorse any particular republication, and has no liability for your use.`;
}

export const DTCC_NOTICE =
  'The Secured Overnight Financing Rate (SOFR) Data and Broad General Collateral Rate (BGCR) Data are calculated using data provided under a license granted to the New York Fed by DTCC Solutions LLC ("Solutions"), an affiliate of The Depository Trust & Clearing Corporation. Solutions, its affiliates, and third parties from which they obtained data have no liability for the content of this material.';
export const NOT_AFFILIATED =
  "Horizon Pulse is not affiliated with the New York Fed. The New York Fed does not sanction, endorse, or recommend any products or services offered by Horizon Pulse.";

/** Disclaimer carried on every surface that names the rates (spec v2 §4 item 5, §7 not_affiliated wording + pass-through). */
export const MMR_DISCLAIMER =
  `${NOT_AFFILIATED} Horizon Pulse is also not affiliated with the Federal Reserve System. Data are passed through unchanged from the NY Fed Markets Data API under the New York Fed Terms of Use and may not be current; the same values are free at markets.newyorkfed.org.`;
/** Route/tool description (free route: no x402, no 402). No stress read, no derived values. */
export const MMR_DESCRIPTION =
  `FREE (no x402, no payment). ${MMR_SCOPE} SOFR, EFFR, OBFR, TGCR and BGCR as published, with each rate's NY Fed source URL, terms notices and a holiday-aware status (fresh, PENDING, STALE, no publish, UNVERIFIED holiday status). Params: rates (comma list), last (1-10) or startDate+endDate (YYYY-MM-DD, <=31 days, >=2018-04-02). ${MMR_DISCLAIMER}`;

export function termsBlock(year: number, rates: MmrRate[]) {
  return {
    credit: `© ${year} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org.`,
    terms_url: "https://www.newyorkfed.org/privacy/termsofuse",
    ...(rates.includes("SOFR") || rates.includes("BGCR") ? { dtcc_notice: DTCC_NOTICE } : {}),
    not_affiliated: NOT_AFFILIATED,
    disclaimer: MMR_DISCLAIMER,
    pass_through:
      "NY Fed Content in this response is provided under the New York Fed Terms of Use. Horizon Pulse adds no restrictions on it; the same values are free at the source_url.",
  };
}

// ---------- time (America/New_York) ----------
export function etParts(now: Date): { date: string; minutes: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
export function etIso(now: Date): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const off = (p.timeZoneName || "GMT-05:00").replace("GMT", "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
function addDays(d: string, n: number): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function dow(d: string): number { return new Date(`${d}T12:00:00Z`).getUTCDay(); }

// ---------- holidays ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function strip(s: string): string {
  return s.replace(/<sup[^>]*>.*?<\/sup>/gis, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#\d+;|&\w+;/g, " ").replace(/\s+/g, " ").trim();
}
/** Closed weekdays from a holiday table (rows: name + one date cell per year column). Sunday holidays close the Monday after; Saturday ones close nothing for publication. */
export function parseHolidayPage(html: string): Set<string> { return parseHolidayCoverage(html).closed; }
/** Closed weekdays plus the years the page's table covers (its year header columns). */
export function parseHolidayCoverage(html: string): { closed: Set<string>; years: Set<number> } {
  const out = new Set<string>();
  const covered = new Set<number>();
  let years: number[] = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(strip);
    const ys = cells.filter((c) => /^\d{4}$/.test(c)).map(Number);
    if (ys.length >= 2) { years = ys; ys.forEach((y) => covered.add(y)); continue; }
    if (!years.length || cells.length < years.length) continue;
    const dateCells = cells.slice(cells.length - years.length);
    dateCells.forEach((c, i) => {
      const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(c);
      if (!m) return;
      const mi = MONTHS.indexOf(m[1].toLowerCase());
      if (mi < 0) return;
      let d = `${years[i]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
      if (dow(d) === 0) d = addDays(d, 1);
      if (dow(d) !== 6) out.add(d);
    });
  }
  return { closed: out, years: covered };
}

export type HolidayState = { closedBoth: Set<string>; readAt: number } | null;
export type Deps = {
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>;
  fetchText: (url: string, timeoutMs: number) => Promise<string>;
  now: () => Date;
  /** Caller IP for the per-IP upstream budget (route passes lib/caller-ip.ts callerIp(): canonical x-real-ip, XFF never read). */
  clientIp?: string;
};

let holidayCache: { closedBoth: Set<string>; readAt: number; years: Set<number>; disagree: Set<string> } | null = null;
let lastHolidayAttempt = 0;
/** LRU-capped upstream cache (Map keeps insertion order; a hit re-inserts). Odin Class A 10/12: unbounded keys per date range. */
export const CACHE_MAX_ENTRIES = 200;
export const LAST_GOOD_MAX = MMR_RATES.length;
/** Upstream NY Fed fetch budget per rolling minute (holiday pages included).
 * All caches and limits here are PER SERVERLESS INSTANCE (in-process memory): N warm instances allow up to N x these
 * numbers against the NY Fed, and a cold start resets them. The CDN s-maxage=60 absorbs repeat URLs across instances. */
export const HOLIDAY_LIMITED_RETRY_MS = 60_000;
/** A holiday read that fails (fetch error, timeout, or a page with no parsed closed dates) is retried after 10 min, not 6h. */
export const HOLIDAY_FAILED_RETRY_MS = 10 * 60_000;
export const UPSTREAM_WINDOW_MS = 60_000;
export const UPSTREAM_GLOBAL_PER_WINDOW = 60;
export const UPSTREAM_PER_IP_PER_WINDOW = 15;
const cache = new Map<string, { at: number; payload: { refRates: unknown[] }; url: string }>();
const lastGood = new Map<MmrRate, { obs: Record<string, unknown>[]; url: string; at: number }>();
let globalFetches: number[] = [];
const ipFetches = new Map<string, number[]>();
export const IP_KEYS_MAX = 1000;
let holidayRetryAt = 0;
export function resetMmrCachesForTests() { holidayCache = null; lastHolidayAttempt = 0; cache.clear(); lastGood.clear(); globalFetches = []; ipFetches.clear(); holidayRetryAt = 0; }
export function mmrSpendSlotsForTests(ip: string, n: number, nowMs: number) { takeSlot(ip, nowMs, n); }
export function mmrHolidayForTests() { return holidayCache; }
export function mmrCacheSizesForTests() { return { cache: cache.size, lastGood: lastGood.size, ipKeys: ipFetches.size }; }

function cacheGet(url: string) {
  const c = cache.get(url);
  if (c) { cache.delete(url); cache.set(url, c); }
  return c;
}
function cacheSet(url: string, v: { at: number; payload: { refRates: unknown[] }; url: string }) {
  cache.delete(url);
  cache.set(url, v);
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}
function lastGoodSet(rate: MmrRate, v: { obs: Record<string, unknown>[]; url: string; at: number }) {
  lastGood.delete(rate);
  lastGood.set(rate, v);
  while (lastGood.size > LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value as MmrRate);
}

export class MmrUpstreamLimited extends Error {
  constructor(readonly scope: "global" | "ip") { super(`upstream fetch limit (${scope})`); }
}
/** Takes one upstream fetch slot or throws MmrUpstreamLimited. Per-IP map is pruned and capped too. */
function takeSlot(ip: string | undefined, nowMs: number, n = 1) {
  const cut = nowMs - UPSTREAM_WINDOW_MS;
  globalFetches = globalFetches.filter((t) => t > cut);
  if (globalFetches.length + n > UPSTREAM_GLOBAL_PER_WINDOW) throw new MmrUpstreamLimited("global");
  const key = ip || "unknown";
  const mine = (ipFetches.get(key) ?? []).filter((t) => t > cut);
  if (mine.length + n > UPSTREAM_PER_IP_PER_WINDOW) { ipFetches.set(key, mine); throw new MmrUpstreamLimited("ip"); }
  for (let i = 0; i < n; i++) { mine.push(nowMs); globalFetches.push(nowMs); }
  ipFetches.delete(key);
  ipFetches.set(key, mine);
  if (ipFetches.size > IP_KEYS_MAX) for (const k of ipFetches.keys()) { if (ipFetches.size <= IP_KEYS_MAX) break; if (k !== key) ipFetches.delete(k); }
}

async function readHolidays(deps: Deps): Promise<HolidayState> {
  const nowMs = deps.now().getTime();
  const due = !holidayCache || nowMs - lastHolidayAttempt >= HOLIDAY_REFRESH_MS;
  if (due && nowMs >= holidayRetryAt) {
    let slots = false;
    try { takeSlot(deps.clientIp, nowMs, 2); slots = true; } // both pages or neither
    catch { holidayRetryAt = nowMs + HOLIDAY_LIMITED_RETRY_MS; } // limited: retry in ~1 min, not 6h
    if (slots) {
      const prevAttempt = lastHolidayAttempt;
      lastHolidayAttempt = nowMs;
      let ok = false;
      try {
        const [a, b] = await Promise.all(HOLIDAY_SOURCES.map((u) => deps.fetchText(u, 10_000)));
        const ny = parseHolidayCoverage(a);
        const k8 = parseHolidayCoverage(b);
        if (ny.closed.size && k8.closed.size) {
          const years = new Set([...ny.years].filter((y) => k8.years.has(y)));
          // Closure only if closed on both pages. A disagreement is a date closed on one page only AND in a year both
          // pages cover -> "UNVERIFIED holiday status". Dates in years only one page covers are not verified (see
          // rateStatus), not a conflict.
          holidayCache = {
            closedBoth: new Set([...ny.closed].filter((d) => k8.closed.has(d))),
            readAt: nowMs,
            years,
            disagree: new Set([...ny.closed, ...k8.closed].filter((d) => !(ny.closed.has(d) && k8.closed.has(d)) && years.has(+d.slice(0, 4)))),
          };
          ok = true;
        }
      } catch { /* fetch error or timeout: handled below */ }
      if (!ok) {
        // Failed read (fetch error, timeout, or no parsed closed dates on a page): keep the last good read, roll back
        // lastHolidayAttempt so the read stays due, and retry once now >= holidayRetryAt (10 min).
        lastHolidayAttempt = prevAttempt;
        holidayRetryAt = nowMs + HOLIDAY_FAILED_RETRY_MS;
      }
    }
  }
  if (!holidayCache || nowMs - holidayCache.readAt > HOLIDAY_MAX_AGE_MS) return null;
  return holidayCache;
}
function disagreeSet(): Set<string> { return holidayCache?.disagree ?? new Set(); }
function coveredYears(): Set<number> | undefined { return holidayCache?.years; }

function isPubDay(d: string, closed: Set<string>): boolean { const w = dow(d); return w !== 0 && w !== 6 && !closed.has(d); }
function prevPub(d: string, closed: Set<string>): string { let x = addDays(d, -1); while (!isPubDay(x, closed)) x = addDays(x, -1); return x; }
function nextPub(d: string, closed: Set<string>): string { let x = addDays(d, 1); while (!isPubDay(x, closed)) x = addDays(x, 1); return x; }

export type Status = { status: string; status_note: string };
/** §5 ladder. releaseMin = 480 (secured) or 540 (EFFR/OBFR). */
export function rateStatus(opts: { latest: string | null; today: string; minutes: number; closed: Set<string>; disagree?: Set<string>; coveredYears?: Set<number>; releaseMin: number; sofraiToday?: boolean; secured: boolean }): Status {
  const { latest, today, minutes, closed, releaseMin } = opts;
  const pubToday = isPubDay(today, closed);
  const released = pubToday && minutes >= releaseMin;
  const P = released ? today : prevPub(today, closed);
  const expected = prevPub(P, closed);
  const nextRelease = pubToday && !released ? today : nextPub(today, closed);
  const hhmm = `${String(Math.floor(releaseMin / 60)).padStart(2, "0")}:00`;
  for (const d of [today, expected, P]) if (opts.coveredYears && !opts.coveredYears.has(+d.slice(0, 4))) return { status: "UNVERIFIED holiday status", status_note: `${d.slice(0, 4)} is not covered by both the NY Fed and Board holiday pages; not verified, no holiday or stale call is made.` };
  for (const d of [today, expected, P]) if (opts.disagree?.has(d)) return { status: "UNVERIFIED holiday status", status_note: `The NY Fed and Board holiday pages disagree on ${d}; no holiday or stale call is made.` };
  if (latest === null) return { status: "unavailable", status_note: "No published observation could be read from the NY Fed API." };
  if (latest >= expected) {
    if (pubToday && !released) return { status: "PENDING-not-yet-due", status_note: `Latest effective date ${latest} is published; today's print is due ~${hhmm} ET.` };
    return { status: "fresh", status_note: `Latest expected effective date ${expected} is published.${pubToday ? "" : ` ${today} is closed on the NY Fed and Board holiday pages; next expected publication ${nextRelease} ~${hhmm} ET.`}` };
  }
  if (P === today && minutes < releaseMin + 20) return { status: "PENDING", status_note: `Effective date ${expected} is due at ~${hhmm} ET today and is within the 20-minute grace.` };
  if (opts.secured && opts.sofraiToday) return { status: `no publish ${expected}`, status_note: `The NY Fed publication ran today (SOFRAI dated ${today}) without a ${expected} print.` };
  return { status: `STALE as-of ${latest}`, status_note: `Expected effective date ${expected} is not published yet; latest is ${latest}.` };
}

function pickObs(rate: MmrRate, row: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of OBS_FIELDS) o[f] = f in row ? row[f] : null;
  if (rate === "EFFR") for (const f of EFFR_EXTRA) o[f] = f in row ? row[f] : null;
  return o;
}
function rowsFor(payload: unknown, rate: MmrRate): Record<string, unknown>[] | null {
  const rr = (payload as { refRates?: unknown })?.refRates;
  if (!Array.isArray(rr)) return null;
  const rows = rr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && (r as { type?: unknown }).type === rate);
  if (!rows.length || rows.some((r) => typeof r.effectiveDate !== "string" || typeof r.percentRate !== "number")) return null;
  return rows;
}

/** A payload is cacheable only if every MMR row in it is well-formed; all/latest.json must carry all five rates. */
export function cacheablePayload(url: string, payload: unknown): payload is { refRates: unknown[] } {
  const rr = (payload as { refRates?: unknown })?.refRates;
  if (!Array.isArray(rr)) return false;
  if (!rr.length) return url.includes("/search.json?"); // well-formed empty range (e.g. a weekend): cache it
  const mine = rr.filter((r) => !!r && typeof r === "object" && (MMR_RATES as readonly string[]).includes((r as { type?: string }).type ?? ""));
  if (mine.some((r) => typeof (r as Record<string, unknown>).effectiveDate !== "string" || typeof (r as Record<string, unknown>).percentRate !== "number")) return false;
  if (url.endsWith("all/latest.json")) return MMR_RATES.every((x) => rowsFor(payload, x) !== null);
  return mine.length > 0;
}

type Got = { payload: unknown; at: number; stale?: boolean };
async function getPayload(url: string, deps: Deps): Promise<Got> {
  const nowMs = deps.now().getTime();
  const c = cacheGet(url);
  if (c && nowMs - c.at < CACHE_TTL_MS) return { payload: c.payload, at: c.at };
  try { takeSlot(deps.clientIp, nowMs); } catch (e) {
    if (c) return { payload: c.payload, at: c.at, stale: true };
    throw e;
  }
  const payload = await deps.fetchJson(url, ATTEMPT_TIMEOUT_MS);
  if (cacheablePayload(url, payload)) cacheSet(url, { at: nowMs, payload, url });
  return { payload, at: nowMs };
}

export async function moneyMarketRates(query: MmrQuery, deps: Deps) {
  const served = deps.now();
  const { date: today, minutes } = etParts(served);
  const hol = await readHolidays(deps);
  const closed = hol?.closedBoth ?? new Set<string>();
  const holidayVerified = hol !== null;
  let retrievedAt = 0;
  let sofraiToday = false;
  let limitedErr: MmrUpstreamLimited | null = null;
  const shared = new Map<string, Promise<Got | "limited" | null>>();
  const attempt = (url: string) => {
    if (!shared.has(url)) shared.set(url, getPayload(url, deps).catch((e) => {
      if (e instanceof MmrUpstreamLimited) { limitedErr ??= e; return "limited" as const; }
      cache.delete(url); return null;
    }));
    return shared.get(url)!;
  };
  const rates = await Promise.all(query.rates.map(async (rate) => {
    const urls = [rateUrl(rate, query), rateUrl(rate, query, true)]; // 2 attempts; retry may use the per-rate endpoint
    let rows: Record<string, unknown>[] | null = null;
    let used = urls[0];
    let staleAt = 0;
    let limited = false;
    let empty = false;
    for (const u of urls) {
      const got = await attempt(u);
      if (got === "limited") { limited = true; break; } // budget spent: no second attempt
      const rr = (got?.payload as { refRates?: unknown } | undefined)?.refRates;
      if (got && query.kind === "range" && u.includes("/search.json?") && Array.isArray(rr) && rr.length === 0) {
        rows = []; empty = true; used = u; retrievedAt = Math.max(retrievedAt, got.at); if (got.stale) staleAt = got.at; break; // no retry
      }
      if (got && (rows = rowsFor(got.payload, rate)) !== null) {
        used = u; retrievedAt = Math.max(retrievedAt, got.at);
        if (got.stale) staleAt = got.at;
        if (u.endsWith("all/latest.json")) {
          const sai = (got.payload as { refRates: { type?: string; effectiveDate?: string }[] }).refRates.find((r) => r?.type === "SOFRAI");
          if (sai?.effectiveDate === today) sofraiToday = true;
        }
        break;
      }
      if (u === urls[0]) shared.delete(u); // second attempt on the same URL if both are equal
    }
    const base = { type: rate, source: SOURCE, notice: notice(rate) };
    if (!rows) {
      const lg = lastGood.get(rate);
      if (lg && query.kind === "latest") {
        const latest = String(lg.obs[0]?.effectiveDate ?? "");
        const why = limited ? "Upstream fetch limit reached" : "Two NY Fed fetch attempts failed";
        return { ...base, source_url: lg.url, status: `STALE as-of ${latest}`, status_note: `${why}; serving the last good published values, which may not be current.`, observations: lg.obs };
      }
      if (limited) return { ...base, source_url: urls[0], status: "rate_limited", status_note: "Upstream fetch limit reached and nothing cached for this rate; retry in about a minute. The same values are free at the source_url.", observations: [] };
      return { ...base, source_url: urls[0], status: "unavailable", status_note: "Two NY Fed fetch attempts failed for this rate.", observations: [] };
    }
    const obs = rows.map((r) => pickObs(rate, r)).sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)));
    if (query.kind === "latest" && !staleAt) lastGoodSet(rate, { obs, url: used, at: served.getTime() });
    let st: Status;
    if (empty && staleAt) {
      return { ...base, source_url: used, status: `STALE as-of ${etIso(new Date(staleAt))}`, status_note: `Upstream fetch limit reached; serving a cached empty result (no publications in range) retrieved ${etIso(new Date(staleAt))}, which may not be current.`, observations: obs };
    }
    if (empty) {
      return { ...base, source_url: used, status: holidayVerified ? "fresh" : "UNVERIFIED holiday status", status_note: "no publications in range", observations: obs };
    }
    if (staleAt) {
      return { ...base, source_url: used, status: `STALE as-of ${String(obs[0].effectiveDate)}`, status_note: `Upstream fetch limit reached; serving cached published values retrieved ${etIso(new Date(staleAt))}, which may not be current.`, observations: obs };
    }
    if (!holidayVerified) st = { status: "UNVERIFIED holiday status", status_note: "No good read of both holiday pages in the last 24 hours; no holiday or stale call is made." };
    else if (query.kind === "range") st = { status: "fresh", status_note: `Published observations for ${query.startDate} to ${query.endDate} as released.` };
    else st = rateStatus({ latest: String(obs[0].effectiveDate), today, minutes, closed, disagree: disagreeSet(), coveredYears: coveredYears(), releaseMin: SECURED.has(rate) ? 480 : 540, secured: SECURED.has(rate), sofraiToday: false });
    return { ...base, source_url: used, ...st, observations: obs };
  }));
  // Whole-request 429 only when every requested rate is limited with nothing cached; otherwise per-rate "rate_limited".
  if (limitedErr && rates.every((r) => r.status === "rate_limited")) throw limitedErr;
  // SOFRAI is read only as the "publish ran today" check; re-evaluate secured STALE rows with it.
  if (sofraiToday && holidayVerified && query.kind !== "range") {
    for (const r of rates) if (SECURED.has(r.type) && r.status.startsWith("STALE") && r.observations.length) {
      Object.assign(r, rateStatus({ latest: String(r.observations[0].effectiveDate), today, minutes, closed, disagree: disagreeSet(), coveredYears: coveredYears(), releaseMin: 480, secured: true, sofraiToday: true }));
    }
  }
  // served_at = actual serve time (spec v2 §3): read the clock AFTER the upstream
  // reads, never the request-start instant, and never earlier than retrieved_at.
  const servedAt = new Date(Math.max(deps.now().getTime(), retrievedAt || 0));
  const todayStatus = !holidayVerified || disagreeSet().has(today) || !coveredYears()?.has(+today.slice(0, 4)) ? "UNVERIFIED holiday status" : isPubDay(today, closed) ? "open" : "holiday, no publish";
  return {
    route: "money-market-rates",
    scope: MMR_SCOPE,
    retrieved_at: etIso(new Date(retrievedAt || served.getTime())),
    served_at: etIso(servedAt),
    calendar: { today_et: today, today_status: todayStatus, holiday_sources: [...HOLIDAY_SOURCES], holiday_checked_at: hol ? etIso(new Date(hol.readAt)) : null },
    rates,
    terms: termsBlock(Number(today.slice(0, 4)), query.rates),
  };
}

export function defaultMmrDeps(): Deps {
  const go = async (url: string, ms: number) => {
    const res = await vendorFetch(url, { signal: AbortSignal.timeout(ms), headers: { "user-agent": "HorizonPulse/1.0 (+https://horizonpulse.dev)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  return {
    fetchJson: async (u, ms) => (await go(u, ms)).json(),
    fetchText: async (u, ms) => (await go(u, ms)).text(),
    now: () => new Date(),
  };
}
