/**
 * /api/x402-check/deep — the $0.03 "deep" tier of /api/x402-check (Michael
 * approved 3:37 PM ET 10/19 via Odin). Black-box, live, no source code:
 *
 *  1. The full /api/x402-check report (same function, unchanged: one unpaid
 *     probe, 402 terms decoded, payTo EOA / EIP-7702 / contract on Base and
 *     Ethereum).
 *  2. TLS: one handshake to the target host (protocol, chain trust, expiry).
 *  3. Security headers on one unpaid GET of the final URL (HSTS, nosniff,
 *     frame policy, CSP, referrer policy), no redirect following.
 *  4. CORS as served to that same request (passive: no forged Origin, no
 *     preflight). Browser agents need PAYMENT-REQUIRED exposed to read a v2
 *     challenge cross-origin.
 *  5. Published payee addresses: the target origin's /.well-known/x402,
 *     /openapi.json and /llms.txt (unpaid GETs, capped). Each 402 payTo is
 *     compared with the addresses the payee publishes there.
 *  6. Lookalike payTo: every 402 payTo against every other address the payee
 *     advertises (402 accepts + the three listings). Same rule as
 *     /api/tx-guard expected_match: a different address with >=3 matching
 *     characters at both ends, or >=6 in total, is the address-poisoning
 *     pattern.
 *  7. Discovery drift: the live 402 accepts vs the /.well-known/x402 listing,
 *     the openapi operation and the Coinbase CDP Bazaar entry for this URL
 *     (CDP public discovery API, /merchant by payTo).
 *
 * Never pays, never signs, never sends a payment header. Every outbound
 * request to the target goes through the same SSRF stack as /api/x402-check
 * (assertSafePublicUrl on every hop + connect-time guardedFetch / guarded
 * TLS connect; private, loopback, link-local and metadata IPs blocked) with
 * capped timeouts, bodies and redirects.
 */
import { checkX402Endpoint, type X402CheckResult, type X402CheckError } from "@/lib/x402-check";
import { guardedGet, type GuardedGetOk, type GuardedGetErr, type GuardedGetOpts } from "@/lib/guarded-get";
import { tlsInspect, type TlsInfo } from "@/lib/audit-security";
import { cdpGet, defaultDeps as bazaarDefaultDeps, networkLabel, parseWellKnown, payToKey, resourceKey, type Deps as BazaarDeps } from "@/lib/bazaar-check";

export const DEEP_SIDE_TIMEOUT_MS = 6_000;
export const DEEP_MAX_REDIRECTS = 3;
export const DEEP_LISTING_MAX_BYTES = 200_000;
/** openapi.json files run larger (ours is ~360KB); capped while streaming. */
export const DEEP_OPENAPI_MAX_BYTES = 1_000_000;
export const DEEP_MAX_ADDRESSES = 50;
export const DEEP_BUDGET_MS = 20_000;

export const X402_CHECK_DEEP_METHODOLOGY = {
  base: "Includes the full /api/x402-check report (same code, same single unpaid probe).",
  tls: "One TLS handshake to the target host on 443 through the SSRF-guarded connect (https targets only): protocol, whether the chain is trusted, days to expiry.",
  headers: "One unpaid GET of the final URL, no redirects followed: Strict-Transport-Security, X-Content-Type-Options, frame policy (X-Frame-Options or CSP frame-ancestors), Content-Security-Policy, Referrer-Policy.",
  cors: "Read passively from that same response (no forged Origin, no preflight). A browser agent can read a v2 challenge cross-origin only if Access-Control-Allow-Origin allows it and PAYMENT-REQUIRED is in Access-Control-Expose-Headers.",
  published: `Unpaid GETs of the target origin's /.well-known/x402, /openapi.json and /llms.txt (${DEEP_SIDE_TIMEOUT_MS / 1000}s, ${DEEP_LISTING_MAX_BYTES / 1000}KB, ${DEEP_MAX_REDIRECTS} redirects each, SSRF-checked every hop). Addresses: payTo values in JSON, plus 0x addresses in llms.txt (known USDC contracts and the 402's own asset contracts excluded). A payTo also counts as published when it appears verbatim in any of the three. Comparison is per address family (EVM vs other rails): a Solana or XRPL payTo is only reported as unpublished when the listings publish other addresses of that family.`,
  lookalike: "Each 402 payTo vs every other address the payee advertises. A different address with >=3 matching characters at both ends, or >=6 matching in total (prefix + suffix, EVM case-insensitive), is flagged as the address-poisoning lookalike pattern (same rule as /api/tx-guard).",
  drift: "Live 402 accepts (network, payTo, amount) vs the /.well-known/x402 listing for this URL, the openapi operation for this path (payTo per address family, stated USD price), and the Coinbase CDP Bazaar entry for this URL (public discovery API, /merchant by payTo).",
  limits: `Never pays or signs. SSRF-safe at every hop (private, loopback, link-local and cloud-metadata addresses blocked). ${DEEP_BUDGET_MS / 1000}s overall budget for the extra checks; a check that cannot finish is reported as unavailable.`,
  billing: "Billed exactly like /api/x402-check: any HTTP answer from the target is a completed report. Bad input, blocked host, DNS/connection failure, timeout or too many redirects on the main probe return 400/502/504 and are not charged. Extra checks that fail are reported as unavailable inside a billed report.",
  notAdvice: "Describes what the endpoint and its listings serve right now. A pass is not a guarantee that paying is safe; a published-address match only shows consistency with the payee's own listings.",
} as const;

type Level = "pass" | "warn" | "fail" | "info";
export type DeepCheck = { id: string; level: Level; message: string };

export type DeepDeps = {
  base: typeof checkX402Endpoint;
  get: (url: string, opts?: GuardedGetOpts) => Promise<GuardedGetOk | GuardedGetErr>;
  tls: (host: string) => Promise<TlsInfo>;
  bazaar: BazaarDeps;
  now: () => number;
};

export const defaultDeepDeps = (): DeepDeps => ({
  base: checkX402Endpoint,
  get: guardedGet,
  tls: (h) => tlsInspect(h, DEEP_SIDE_TIMEOUT_MS),
  bazaar: bazaarDefaultDeps(),
  now: () => Date.now(),
});

const KNOWN_TOKEN_CONTRACTS = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // bridged USDC.e (Polygon)
]);

const isEvm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

/** Address-poisoning lookalike (same rule as lib/tx-guard expected_match). EVM compared case-insensitively without 0x. */
export function lookalike(a: string, b: string): { lookalike: boolean; prefixMatch: number; suffixMatch: number } {
  const evm = isEvm(a) && isEvm(b);
  const x = evm ? a.slice(2).toLowerCase() : a;
  const y = evm ? b.slice(2).toLowerCase() : b;
  if (x === y) return { lookalike: false, prefixMatch: x.length, suffixMatch: x.length };
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return { lookalike: (p >= 3 && q >= 3) || p + q >= 6, prefixMatch: p, suffixMatch: q };
}

/** Recursively collect string values under keys named payTo / pay_to / payto (any rail). Bounded. */
export function collectPayTos(j: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 12 || out.size >= DEEP_MAX_ADDRESSES) return out;
  if (Array.isArray(j)) {
    for (const v of j.slice(0, 500)) collectPayTos(v, out, depth + 1);
  } else if (j && typeof j === "object") {
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (/^pay_?to$/i.test(k) && typeof v === "string" && v.length >= 20 && v.length <= 64 && /^[0-9A-Za-z]+$/.test(v)) out.add(v);
      else collectPayTos(v, out, depth + 1);
    }
  }
  return out;
}

/** 0x addresses in free text (llms.txt), known USDC contracts excluded. */
export function collectEvmAddresses(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) {
    if (out.size >= DEEP_MAX_ADDRESSES) break;
    if (!KNOWN_TOKEN_CONTRACTS.has(m[0].toLowerCase())) out.add(m[0]);
  }
  return out;
}

export type HeaderReport = {
  status: number | null;
  hsts: string | null;
  contentTypeOptions: string | null;
  frameOptions: string | null;
  csp: string | null;
  referrerPolicy: string | null;
  error: string | null;
};
export type CorsReport = { allowOrigin: string | null; exposeHeaders: string | null; allowCredentials: string | null; paymentRequiredExposed: boolean };

export function headerChecks(h: Headers, isHttps: boolean): { report: Omit<HeaderReport, "status" | "error">; checks: DeepCheck[] } {
  const g = (n: string) => h.get(n);
  const report = {
    hsts: g("strict-transport-security"),
    contentTypeOptions: g("x-content-type-options"),
    frameOptions: g("x-frame-options"),
    csp: g("content-security-policy"),
    referrerPolicy: g("referrer-policy"),
  };
  const checks: DeepCheck[] = [];
  if (isHttps) {
    const m = /max-age=(\d+)/i.exec(report.hsts ?? "");
    if (!m) checks.push({ id: "hsts", level: "warn", message: "No Strict-Transport-Security header; a downgraded first request could be served over plain http." });
    else if (Number(m[1]) < 15_552_000) checks.push({ id: "hsts", level: "warn", message: `HSTS max-age is ${m[1]}s (under 180 days).` });
    else checks.push({ id: "hsts", level: "pass", message: "HSTS present (max-age >= 180 days)." });
  }
  checks.push(
    (report.contentTypeOptions ?? "").toLowerCase().includes("nosniff")
      ? { id: "nosniff", level: "pass", message: "X-Content-Type-Options: nosniff." }
      : { id: "nosniff", level: "warn", message: "No X-Content-Type-Options: nosniff." },
  );
  const frameOk = Boolean(report.frameOptions) || /frame-ancestors/i.test(report.csp ?? "");
  checks.push(frameOk ? { id: "frame_policy", level: "pass", message: "Frame policy set (X-Frame-Options or CSP frame-ancestors)." } : { id: "frame_policy", level: "info", message: "No frame policy (X-Frame-Options or CSP frame-ancestors); low impact for a JSON API." });
  checks.push(report.referrerPolicy ? { id: "referrer_policy", level: "pass", message: `Referrer-Policy: ${report.referrerPolicy.slice(0, 80)}.` } : { id: "referrer_policy", level: "info", message: "No Referrer-Policy header." });
  return { report, checks };
}

export function corsChecks(h: Headers, x402Version: number | null): { report: CorsReport; checks: DeepCheck[] } {
  const allowOrigin = h.get("access-control-allow-origin");
  const exposeHeaders = h.get("access-control-expose-headers");
  const allowCredentials = h.get("access-control-allow-credentials");
  const exposed = (exposeHeaders ?? "").split(",").map((s) => s.trim().toLowerCase());
  const paymentRequiredExposed = exposed.includes("payment-required") || exposed.includes("*");
  const checks: DeepCheck[] = [];
  if (!allowOrigin) checks.push({ id: "cors", level: "info", message: "No Access-Control-Allow-Origin on the unpaid response (passive read, no Origin sent): browser-based agents on other origins cannot read the challenge; server-side agents are unaffected." });
  else if (allowOrigin === "*" && (allowCredentials ?? "").toLowerCase() === "true") checks.push({ id: "cors", level: "warn", message: "Access-Control-Allow-Origin * together with Allow-Credentials true: browsers reject this combination and it signals a misconfigured CORS policy." });
  else checks.push({ id: "cors", level: "pass", message: `Access-Control-Allow-Origin: ${allowOrigin.slice(0, 80)}.` });
  if (allowOrigin && x402Version === 2 && !paymentRequiredExposed) checks.push({ id: "cors_expose", level: "warn", message: "CORS allows the origin but PAYMENT-REQUIRED is not in Access-Control-Expose-Headers, so a browser agent cannot read the v2 challenge header." });
  return { report: { allowOrigin, exposeHeaders, allowCredentials, paymentRequiredExposed }, checks };
}

export type PublishedSource = { name: "well-known" | "openapi" | "llms"; url: string; status: number | null; addresses: string[]; error: string | null };
export type PayToReport = {
  network: string | null;
  payTo: string;
  payToType: string | null;
  published: "match" | "not_published" | "none_discoverable";
  publishedIn: string[];
  lookalikes: { address: string; seenIn: string[]; prefixMatch: number; suffixMatch: number }[];
};
export type DriftReport = {
  wellKnown: "listed" | "not_listed" | "unavailable";
  openapi: { status: "consistent" | "drift" | "not_listed" | "unavailable"; detail: string | null };
  bazaar: { status: "consistent" | "drift" | "not_indexed" | "unavailable"; networks: string[]; detail: string | null };
};

export type X402CheckDeepResult = Omit<X402CheckResult, "methodology" | "checks" | "summary"> & {
  tier: "deep";
  baseChecks: X402CheckResult["checks"];
  tls: (TlsInfo & { checked: true }) | { checked: false; reason: string };
  securityHeaders: HeaderReport;
  cors: CorsReport | null;
  publishedSources: PublishedSource[];
  payToReports: PayToReport[];
  drift: DriftReport;
  checks: DeepCheck[];
  summary: { pass: number; warn: number; fail: number };
  elapsedMs: number;
  methodology: typeof X402_CHECK_DEEP_METHODOLOGY;
};

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => { t = setTimeout(() => r(fallback), Math.max(0, ms)); })]).finally(() => clearTimeout(t));
}

/** Amount as stated in a 402 accept (v2 amount / v1 maxAmountRequired). */
const amountOf = (a: Record<string, unknown> | null) => str(a?.amount) ?? str(a?.maxAmountRequired);

async function bazaarDrift(deps: BazaarDeps, finalUrl: string, accepts: X402CheckResult["accepts"], deadline: number): Promise<DriftReport["bazaar"]> {
  const key = resourceKey(finalUrl);
  const payTos = [...new Map(accepts.filter((a) => a.payTo).map((a) => [payToKey(a.payTo!), a.payTo!])).values()].slice(0, 2);
  if (!key || !payTos.length) return { status: "unavailable", networks: [], detail: "No payTo to look up in CDP Bazaar." };
  const listed: Record<string, unknown>[] = [];
  let answered = 0;
  for (const p of payTos) {
    try {
      const j = await cdpGet(deps, `/merchant?payTo=${encodeURIComponent(p)}&limit=100&offset=0`, deadline);
      answered += 1;
      for (const r0 of Array.isArray(j.resources) ? j.resources : []) {
        const r = obj(r0);
        if (r && resourceKey(str(r.resource) ?? "") === key) for (const a of Array.isArray(r.accepts) ? r.accepts : []) if (obj(a)) listed.push(obj(a)!);
      }
    } catch {
      /* reported below */
    }
  }
  if (!answered) return { status: "unavailable", networks: [], detail: "CDP discovery did not answer in time." };
  if (!listed.length) return { status: "not_indexed", networks: [], detail: "No CDP Bazaar entry for this URL under its payTo (first 100 resources per payTo)." };
  const networks = [...new Set(listed.map((a) => networkLabel(str(a.network) ?? "?")))];
  const diffs: string[] = [];
  for (const live of accepts) {
    if (!live.network) continue;
    const net = networkLabel(live.network);
    const b = listed.find((a) => networkLabel(str(a.network) ?? "") === net);
    if (!b) { diffs.push(`${net}: served live, not in the Bazaar entry`); continue; }
    if (live.payTo && str(b.payTo) && payToKey(live.payTo) !== payToKey(str(b.payTo)!)) diffs.push(`${net}: payTo live ${live.payTo} vs Bazaar ${str(b.payTo)}`);
    const ba = amountOf(b);
    if (live.amountAtomic && ba && live.amountAtomic !== ba) diffs.push(`${net}: amount live ${live.amountAtomic} vs Bazaar ${ba}`);
  }
  for (const n of networks) if (!accepts.some((a) => a.network && networkLabel(a.network) === n)) diffs.push(`${n}: in the Bazaar entry, not served live`);
  return diffs.length ? { status: "drift", networks, detail: diffs.join("; ") } : { status: "consistent", networks, detail: null };
}

function openapiDrift(spec: unknown, finalUrl: string, method: string, accepts: X402CheckResult["accepts"]): DriftReport["openapi"] {
  const s = obj(spec);
  const paths = obj(s?.paths);
  if (!paths) return { status: "unavailable", detail: "No openapi paths." };
  let path: string;
  try { path = new URL(finalUrl).pathname.replace(/\/+$/, "") || "/"; } catch { return { status: "unavailable", detail: null }; }
  const op = obj(obj(paths[path])?.[method.toLowerCase()]);
  if (!op) return { status: "not_listed", detail: `${method} ${path} is not in openapi.json.` };
  const opPayTos = collectPayTos(op);
  const diffs: string[] = [];
  if (opPayTos.size) {
    const keys = new Set([...opPayTos].map(payToKey));
    for (const a of accepts) {
      if (!a.payTo || keys.has(payToKey(a.payTo))) continue;
      // Only a same-family listing (EVM vs other rails) can contradict the live payTo.
      const fam = isEvm(a.payTo);
      const listedSame = [...opPayTos].filter((x) => isEvm(x) === fam);
      if (listedSame.length) diffs.push(`payTo ${a.payTo} (${a.network ?? "?"}) served live; the openapi operation lists ${listedSame.slice(0, 3).join(", ")}`);
    }
  }
  const text = JSON.stringify(op).slice(0, 20_000);
  for (const a of accepts) {
    if (a.amountUsd && /\$\d/.test(text) && !text.includes(a.amountUsd)) { diffs.push(`price ${a.amountUsd} served live, not stated in the openapi operation`); break; }
  }
  return diffs.length ? { status: "drift", detail: diffs.join("; ") } : { status: "consistent", detail: null };
}

export async function checkX402Deep(input: { url?: string; method?: string; body?: string }, deps: DeepDeps = defaultDeepDeps()): Promise<X402CheckDeepResult | X402CheckError> {
  const started = deps.now();
  const base = await deps.base(input);
  if (!base.ok) return base;

  const final = new URL(base.finalUrl);
  const origin = final.origin;
  const isHttps = final.protocol === "https:";
  const sideOpts: GuardedGetOpts = { timeoutMs: DEEP_SIDE_TIMEOUT_MS, maxRedirects: DEEP_MAX_REDIRECTS, maxBytes: DEEP_LISTING_MAX_BYTES, headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" } };
  const budgetLeft = () => DEEP_BUDGET_MS - (deps.now() - started);
  const timeoutErr: GuardedGetErr = { ok: false, code: "timeout", error: "timed out" };
  const deadline = started + DEEP_BUDGET_MS;

  const [hdrRes, tls, wk, oa, llms] = await Promise.all([
    within(deps.get(base.finalUrl, { ...sideOpts, followRedirects: false, maxBytes: 4_000 }), budgetLeft(), timeoutErr),
    isHttps ? within(deps.tls(final.hostname), budgetLeft(), { ok: false, error: "TLS check timed out" } as TlsInfo) : Promise.resolve(null),
    within(deps.get(`${origin}/.well-known/x402`, sideOpts), budgetLeft(), timeoutErr),
    within(deps.get(`${origin}/openapi.json`, { ...sideOpts, maxBytes: DEEP_OPENAPI_MAX_BYTES }), budgetLeft(), timeoutErr),
    within(deps.get(`${origin}/llms.txt`, sideOpts), budgetLeft(), timeoutErr),
  ]);

  const checks: DeepCheck[] = [];

  // TLS
  let tlsOut: X402CheckDeepResult["tls"];
  if (!tls) {
    tlsOut = { checked: false, reason: "Target is plain http." };
    checks.push({ id: "tls", level: "fail", message: "Target is plain http: payment terms and payTo can be altered in transit." });
  } else if (!tls.ok) {
    tlsOut = { ...tls, checked: true };
    checks.push({ id: "tls", level: "info", message: `TLS check unavailable: ${tls.error}` });
  } else {
    tlsOut = { ...tls, checked: true };
    if (!tls.authorized) checks.push({ id: "tls", level: "fail", message: `TLS certificate not trusted: ${tls.authorizationError ?? "unknown error"}.` });
    else if (tls.daysLeft < 14) checks.push({ id: "tls", level: "warn", message: `TLS certificate expires in ${tls.daysLeft} day(s).` });
    else checks.push({ id: "tls", level: "pass", message: `TLS ${tls.protocol ?? ""} trusted, ${tls.daysLeft} days to expiry.`.replace("  ", " ") });
    if (tls.protocol && /TLSv1(\.[01])?$/.test(tls.protocol)) checks.push({ id: "tls_protocol", level: "warn", message: `Negotiated ${tls.protocol}; TLS 1.2+ expected.` });
  }

  // Headers + CORS
  let securityHeaders: HeaderReport;
  let cors: CorsReport | null = null;
  if (hdrRes.ok) {
    const hc = headerChecks(hdrRes.headers, isHttps);
    securityHeaders = { status: hdrRes.status, ...hc.report, error: null };
    checks.push(...hc.checks);
    const cc = corsChecks(hdrRes.headers, base.x402Version);
    cors = cc.report;
    checks.push(...cc.checks);
  } else {
    securityHeaders = { status: null, hsts: null, contentTypeOptions: null, frameOptions: null, csp: null, referrerPolicy: null, error: hdrRes.error };
    checks.push({ id: "headers", level: "info", message: `Header check unavailable: ${hdrRes.error}` });
  }

  // Published addresses
  const src = (name: PublishedSource["name"], url: string, r: GuardedGetOk | GuardedGetErr, addrs: Set<string>): PublishedSource => ({
    name, url, status: r.ok ? r.status : null, addresses: [...addrs].slice(0, DEEP_MAX_ADDRESSES), error: r.ok ? (r.status === 200 ? null : `HTTP ${r.status}`) : r.error,
  });
  const parseJson = (r: GuardedGetOk | GuardedGetErr): unknown => {
    if (!r.ok || r.status !== 200) return null;
    try { return JSON.parse(r.body); } catch { return null; }
  };
  const wkJson = parseJson(wk);
  const oaJson = parseJson(oa);
  const sources: PublishedSource[] = [
    src("well-known", `${origin}/.well-known/x402`, wk, wkJson ? collectPayTos(wkJson) : new Set()),
    src("openapi", `${origin}/openapi.json`, oa, oaJson ? collectPayTos(oaJson) : new Set()),
    src("llms", `${origin}/llms.txt`, llms, llms.ok && llms.status === 200 ? collectEvmAddresses(llms.body) : new Set()),
  ];
  const assetKeys = new Set(base.accepts.map((a) => (a.asset ? payToKey(a.asset) : "")).filter(Boolean));
  for (const s of sources) s.addresses = s.addresses.filter((a) => !assetKeys.has(payToKey(a)));
  const publishedMap = new Map<string, { address: string; seenIn: Set<string> }>();
  for (const s of sources) for (const a of s.addresses) {
    const k = payToKey(a);
    const cur = publishedMap.get(k) ?? { address: a, seenIn: new Set<string>() };
    cur.seenIn.add(s.name);
    publishedMap.set(k, cur);
  }
  const advertised = new Map([...publishedMap].map(([k, v]) => [k, { address: v.address, seenIn: new Set(v.seenIn) }]));
  for (const a of base.accepts) if (a.payTo) {
    const k = payToKey(a.payTo);
    const cur = advertised.get(k) ?? { address: a.payTo, seenIn: new Set<string>() };
    cur.seenIn.add("402");
    advertised.set(k, cur);
  }

  const okBody = (x: GuardedGetOk | GuardedGetErr) => (x.ok && x.status === 200 ? x.body : "");
  const rawBodies: [string, string][] = [["well-known", okBody(wk)], ["openapi", okBody(oa)], ["llms", okBody(llms)]];
  const payToReports: PayToReport[] = [];
  const seenPayTo = new Set<string>();
  for (const a of base.accepts) {
    if (!a.payTo || seenPayTo.has(payToKey(a.payTo))) continue;
    seenPayTo.add(payToKey(a.payTo));
    const k = payToKey(a.payTo);
    const fam = isEvm(a.payTo);
    const pubIn = new Set<string>(publishedMap.get(k)?.seenIn ?? []);
    for (const [name, body] of rawBodies) if (body && (fam ? body.toLowerCase().includes(a.payTo.toLowerCase()) : body.includes(a.payTo))) pubIn.add(name);
    const sameFamilyPublished = [...publishedMap.values()].filter((v) => isEvm(v.address) === fam).map((v) => v.address);
    const pub = pubIn.size ? { seenIn: pubIn } : undefined;
    const published: PayToReport["published"] = pub ? "match" : sameFamilyPublished.length ? "not_published" : "none_discoverable";
    const lookalikes: PayToReport["lookalikes"] = [];
    for (const [ok, o] of advertised) {
      if (ok === k) continue;
      const l = lookalike(a.payTo, o.address);
      if (l.lookalike) lookalikes.push({ address: o.address, seenIn: [...o.seenIn], prefixMatch: l.prefixMatch, suffixMatch: l.suffixMatch });
    }
    payToReports.push({ network: a.network, payTo: a.payTo, payToType: a.payToType, published, publishedIn: pub ? [...pub.seenIn] : [], lookalikes });
    const typeNote = a.payToType ? ` (${a.payToType === "eoa" ? "EOA" : a.payToType === "eoa_7702" ? "EIP-7702-delegated EOA" : a.payToType})` : "";
    if (published === "match") checks.push({ id: "payto_published", level: "pass", message: `payTo ${a.payTo}${typeNote} matches the address the payee publishes in ${[...pub!.seenIn].join(", ")}.` });
    else if (published === "not_published") checks.push({ id: "payto_published", level: "warn", message: `payTo ${a.payTo}${typeNote} is not among the addresses the payee publishes (${sameFamilyPublished.slice(0, 5).join(", ")}). Confirm it with the payee before paying.` });
    else checks.push({ id: "payto_published", level: "info", message: `No published payee address of this kind found in /.well-known/x402, /openapi.json or /llms.txt to compare payTo ${a.payTo}${typeNote} against.` });
    for (const l of lookalikes) checks.push({ id: "payto_lookalike", level: "fail", message: `payTo ${a.payTo} is a lookalike of ${l.address} (seen in ${l.seenIn.join(", ")}): ${l.prefixMatch} leading and ${l.suffixMatch} trailing characters match but the address differs (address-poisoning pattern). Compare the full address before paying.` });
  }

  // Drift
  let wellKnown: DriftReport["wellKnown"] = "unavailable";
  const parsedWk = wk.ok && wk.status === 200 ? parseWellKnown(wk.body) : null;
  if (parsedWk) {
    const key = resourceKey(base.finalUrl);
    const keyTarget = resourceKey(base.target);
    wellKnown = parsedWk.routes.some((r) => { const rk = resourceKey(r.url); return rk === key || rk === keyTarget; }) ? "listed" : "not_listed";
  }
  if (wellKnown === "listed") checks.push({ id: "drift_well_known", level: "pass", message: "URL is listed in the origin's /.well-known/x402." });
  else if (wellKnown === "not_listed") checks.push({ id: "drift_well_known", level: "warn", message: "Origin publishes /.well-known/x402 but this URL is not in it; discovery crawlers that read it will miss this route." });
  else checks.push({ id: "drift_well_known", level: "info", message: "No parseable /.well-known/x402 at the origin." });
  const openapi = oaJson ? openapiDrift(oaJson, base.finalUrl, base.method, base.accepts) : { status: "unavailable" as const, detail: "No openapi.json at the origin." };
  if (openapi.status === "drift") checks.push({ id: "drift_openapi", level: "warn", message: `openapi.json differs from the live 402: ${openapi.detail}` });
  else if (openapi.status === "consistent") checks.push({ id: "drift_openapi", level: "pass", message: "openapi.json operation is consistent with the live 402." });
  else checks.push({ id: "drift_openapi", level: "info", message: openapi.detail ?? "openapi drift check unavailable." });
  const bazaar = base.isX402
    ? await within(bazaarDrift(deps.bazaar, base.finalUrl, base.accepts, deadline), budgetLeft(), { status: "unavailable" as const, networks: [], detail: "CDP discovery timed out." })
    : { status: "unavailable" as const, networks: [], detail: "Not an x402 challenge; Bazaar not queried." };
  if (bazaar.status === "drift") checks.push({ id: "drift_bazaar", level: "warn", message: `CDP Bazaar entry differs from the live 402: ${bazaar.detail}` });
  else if (bazaar.status === "consistent") checks.push({ id: "drift_bazaar", level: "pass", message: `CDP Bazaar entry matches the live 402 (${bazaar.networks.join(", ")}).` });
  else checks.push({ id: "drift_bazaar", level: "info", message: bazaar.detail ?? "Bazaar check unavailable." });

  const summary = { pass: base.summary.pass, warn: base.summary.warn, fail: base.summary.fail };
  for (const c of checks) if (c.level !== "info") summary[c.level] += 1;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { methodology: _m, checks: baseChecks, summary: _s, elapsedMs: _e, ...rest } = base;
  return {
    ...rest,
    tier: "deep",
    baseChecks,
    tls: tlsOut,
    securityHeaders,
    cors,
    publishedSources: sources,
    payToReports,
    drift: { wellKnown, openapi, bazaar },
    checks,
    summary,
    elapsedMs: deps.now() - started,
    methodology: X402_CHECK_DEEP_METHODOLOGY,
  };
}
