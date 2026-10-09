/**
 * /api/bazaar-check — "is this x402 seller indexed in Coinbase CDP Bazaar,
 * and if not, why not?"
 *
 * (a) INDEX: reads CDP's public discovery API (no key, read-only):
 *     GET /discovery/merchant?payTo=<payTo>&limit=100 for every payTo the
 *     host's 402s advertise, plus GET /discovery/search?query=<host>. CDP
 *     ignores a urlSubstring filter on both endpoints (checked 2026-10-09), so
 *     results are filtered to the host here. Reports which of the host's
 *     advertised routes are indexed and on which networks.
 * (b) LINT: fetches https://<host>/.well-known/x402 and sends ONE unpaid
 *     request per listed route+method (no payment header; POST sends "{}").
 *     Each finding carries a plain fix line. Never pays, never signs.
 *
 * Only public https hosts are fetched: every hop goes through
 * assertSafePublicUrl (the /api/fetch and /api/x402-check guard: private,
 * loopback, link-local, metadata and CGNAT targets blocked, DNS checked),
 * redirects are re-checked and must stay on https, bodies are streamed and
 * capped, every request has a timeout. Routes on other hosts are listed but
 * not probed. Nothing is logged. Reports technical facts only: no revenue,
 * volume or customer figures (the on-chain check reports one boolean).
 */
import { assertSafePublicUrl } from "@/lib/fetch-url";
import { USDC_BASE } from "@/lib/config";
import { DEFAULT_SOLANA_RPC_URL, USDC_SOLANA_MINT } from "@/lib/solana-config";

export const CDP_DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery" as const;
export const CDP_TROUBLESHOOTING_URL =
  "https://docs.cdp.coinbase.com/x402/support/troubleshooting#my-endpoint-is-missing-from-the-bazaar" as const;
export const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402" as const;

export const BC_PROBE_TIMEOUT_MS = 6_000;
export const BC_TOTAL_BUDGET_MS = 22_000;
export const BC_MAX_REDIRECTS = 3;
export const BC_MAX_BODY_BYTES = 64_000;
export const BC_MAX_ROUTES = 25;
export const BC_PROBE_CONCURRENCY = 5;
const CDP_TIMEOUT_MS = 8_000;
const CDP_MAX_BYTES = 2_000_000;
const CDP_MAX_PAGES = 3;
const MAX_DESCRIPTION_CHARS = 500;
const UA = "HorizonPulseBazaarCheck/1.0 (+https://horizonpulse.dev)";

export const BAZAAR_CHECK_METHODOLOGY = {
  index: `CDP public discovery API (${CDP_DISCOVERY_URL}): /merchant?payTo=… for each payTo seen in the host's 402s (up to ${CDP_MAX_PAGES} pages of 100) and /search?query=<host>, filtered to resources on the host. Indexed networks come from each entry's accepts.`,
  lint: `GET https://<host>/.well-known/x402, then one unpaid request per listed route and method (GET with no body, POST with '{}'), up to ${BC_MAX_ROUTES} routes, ${BC_PROBE_CONCURRENCY} at a time. No payment header is ever sent; nothing is signed or paid.`,
  settleInference: `'Likely needs one CDP-facilitated paid settle' is inferred only when CDP discovery returns no resources for a payTo AND a read-only on-chain check (USDC balanceOf on Base, USDC token accounts on Solana) has run. CDP indexes an endpoint only after it settles a payment through the CDP facilitator: ${CDP_TROUBLESHOOTING_URL}. The on-chain check reports one boolean, never an amount.`,
  limits: `https only; private/local targets blocked at every hop (DNS checked); ${BC_MAX_REDIRECTS} redirects; ${BC_PROBE_TIMEOUT_MS / 1000}s per request; ${BC_MAX_BODY_BYTES / 1000}KB body cap; ${BC_TOTAL_BUDGET_MS / 1000}s total budget. Routes on other hosts are listed, not probed.`,
  billing:
    "Billed when a report is returned. Not billed: missing/bad/http-only input, blocked private/local host, host unreachable (DNS/connection/timeout on every request), or CDP discovery unavailable; those return 400/502/504 and settlement is skipped.",
  notAdvice:
    "Technical facts only: no revenue, volume or customer claims. Fix lines reflect CDP's documented requirements and Horizon Pulse's own indexing experience, not a CDP guarantee.",
} as const;

export type Level = "fail" | "warn" | "info" | "pass";
export type Finding = { id: string; level: Level; message: string; fix?: string; doc?: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

export type NetworkLabel = "base" | "solana" | string;
export function networkLabel(n: string): NetworkLabel {
  if (n === "eip155:8453" || n === "base") return "base";
  if (n.startsWith("solana:") || n === "solana") return "solana";
  return n;
}

/** Normalized resource key: https://host/path (lowercase host, no query/hash/trailing slash). */
export function resourceKey(u: string): string | null {
  try {
    const url = new URL(u);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host.toLowerCase()}${p}`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export type ParsedTarget = { origin: string; host: string; path: string | null };

export function parseTarget(raw: string | undefined): ParsedTarget | { error: string; code: string } {
  const s = raw?.trim();
  if (!s) return { error: "Query param url is required (a host like example.com or an https URL)", code: "missing_url" };
  if (s.length > 2048) return { error: "url too long", code: "bad_url" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { error: "url is not a valid host or absolute URL", code: "bad_url" };
  }
  if (u.protocol === "http:")
    return { error: "Only https hosts are checked (CDP does not index plain-http endpoints). Use the https URL.", code: "https_only" };
  if (u.protocol !== "https:") return { error: "Only https URLs are allowed", code: "scheme_blocked" };
  if (u.username || u.password) return { error: "URLs with embedded credentials are not allowed", code: "bad_url" };
  const path = u.pathname && u.pathname !== "/" ? u.pathname : null;
  return { origin: u.origin, host: u.host.toLowerCase(), path };
}

/* ------------------------------------------------------------------ */
/* Safe fetch (public https only)                                     */
/* ------------------------------------------------------------------ */

export type SafeResponse = { status: number; headers: Headers; body: string; finalUrl: string };
export type SafeError = { error: string; code: "host_blocked" | "https_only" | "timeout" | "unreachable" | "redirects" | "bad_url" };

/** Stream the body and stop after `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = value.subarray(0, cap - total);
      chunks.push(take);
      total += take.length;
    }
  } catch {
    /* unreadable body: the header may still carry the challenge */
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type Deps = {
  fetch: typeof fetch;
  /** SSRF guard; defaults to assertSafePublicUrl from lib/fetch-url. */
  assertSafe: (u: string) => Promise<{ url: URL } | { ok: false; error: string; code: string; status: number }>;
  now: () => number;
};

export const defaultDeps = (): Deps => ({ fetch: (...a) => fetch(...a), assertSafe: assertSafePublicUrl, now: () => Date.now() });

export async function safeFetch(
  deps: Deps,
  target: string,
  method: "GET" | "POST",
  timeoutMs: number,
): Promise<SafeResponse | SafeError> {
  let current = target;
  const deadline = deps.now() + timeoutMs;
  let m = method;
  for (let hop = 0; ; hop++) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { error: `timed out after ${timeoutMs}ms`, code: "timeout" };
    if (!current.startsWith("https://")) return { error: "only https targets are fetched", code: "https_only" };
    const checked = await deps.assertSafe(current);
    if ("ok" in checked && checked.ok === false) return { error: checked.error, code: "host_blocked" };
    const url = (checked as { url: URL }).url;
    let res: Response;
    try {
      res = await deps.fetch(url.toString(), {
        method: m,
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: { accept: "application/json", "user-agent": UA, ...(m === "POST" ? { "content-type": "application/json" } : {}) },
        ...(m === "POST" ? { body: "{}" } : {}),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") return { error: `timed out after ${timeoutMs}ms`, code: "timeout" };
      return { error: "connection failed", code: "unreachable" };
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      if (hop + 1 > BC_MAX_REDIRECTS) return { error: `too many redirects (max ${BC_MAX_REDIRECTS})`, code: "redirects" };
      try {
        current = new URL(loc, url).toString();
      } catch {
        return { error: "bad redirect location", code: "bad_url" };
      }
      if (m === "POST" && res.status !== 307 && res.status !== 308) m = "GET";
      continue;
    }
    const body = await readCapped(res, BC_MAX_BODY_BYTES);
    return { status: res.status, headers: res.headers, body, finalUrl: url.toString() };
  }
}

/* ------------------------------------------------------------------ */
/* /.well-known/x402                                                   */
/* ------------------------------------------------------------------ */

export type ListedRoute = { url: string; methods: ("GET" | "POST")[]; listedAs: string[] };

/**
 * Parse /.well-known/x402 (x402scan DISCOVERY.md: { version, resources: string[] },
 * each "METHOD https://…" or a bare URL; objects {resource|url, method} accepted).
 * Bare entries are probed with GET (the method most x402 routes charge).
 */
export function parseWellKnown(body: string): { routes: ListedRoute[]; findings: Finding[] } | null {
  let j: Json | null;
  try {
    j = obj(JSON.parse(body));
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.resources)) return null;
  const byKey = new Map<string, ListedRoute>();
  const findings: Finding[] = [];
  let bare = 0;
  for (const r of j.resources.slice(0, 200)) {
    let method: string | null = null;
    let url: string | null = null;
    if (typeof r === "string") {
      const m = r.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
      if (m) {
        method = m[1]!.toUpperCase();
        url = m[2]!;
      } else url = r.trim();
    } else {
      const o = obj(r);
      url = str(o?.resource) ?? str(o?.url);
      method = str(o?.method)?.toUpperCase() ?? null;
    }
    if (!url) continue;
    if (!method) bare += 1;
    const meth = method === "POST" ? "POST" : "GET";
    const key = resourceKey(url) ?? url;
    const cur = byKey.get(key) ?? { url, methods: [], listedAs: [] };
    if (!cur.methods.includes(meth)) cur.methods.push(meth);
    cur.listedAs.push(method ? `${method} ${url}` : url);
    byKey.set(key, cur);
  }
  if (bare)
    findings.push({
      id: "well_known_no_method",
      level: "info",
      message: `${bare} /.well-known/x402 entr${bare === 1 ? "y has" : "ies have"} no HTTP method prefix; probed with GET. Some discovery tools default bare entries to POST.`,
      fix: 'Prefix each entry with its method, e.g. "GET https://host/api/route".',
    });
  return { routes: [...byKey.values()], findings };
}

/* ------------------------------------------------------------------ */
/* LINT: one unpaid probe → findings                                  */
/* ------------------------------------------------------------------ */

export type ProbeInput = {
  /** URL as listed (well-known entry or the caller's URL). */
  listedUrl: string;
  method: "GET" | "POST";
  status: number;
  headers: Headers;
  body: string;
};

export type ProbeLint = {
  method: "GET" | "POST";
  httpStatus: number;
  x402Version: number | null;
  challengeSource: "header" | "body" | null;
  advertisedNetworks: NetworkLabel[];
  payTos: { network: string; payTo: string }[];
  bazaar: { present: boolean; method: string | null; methodEnum: string[] | null };
  findings: Finding[];
};

function decodeChallenge(v: string): Json | null {
  try {
    return obj(JSON.parse(Buffer.from(v, "base64").toString("utf8")));
  } catch {
    try {
      return obj(JSON.parse(v));
    } catch {
      return null;
    }
  }
}

export const FIX = {
  https: "Serve and advertise the route on https only, and set resource.url to the public https URL (behind a proxy, build it from X-Forwarded-Proto or a pinned public base URL).",
  not402: "Return HTTP 402 with the x402 challenge to an unpaid request on the declared method, before any auth, rate-limit or body validation.",
  header: "Send the challenge as base64 JSON in the PAYMENT-REQUIRED response header (x402 v2; e.g. encodePaymentRequiredHeader from @x402/core/http).",
  version: "Serve an x402 v2 challenge (x402Version: 2, CAIP-2 networks, accepts[].amount); current @x402/* SDKs do this by default.",
  fields: "Fill every required v2 field: resource.url, and per accepts entry scheme, network (CAIP-2), amount, asset, payTo, maxTimeoutSeconds.",
  bazaar: "Declare Bazaar discovery metadata on the route (declareDiscoveryExtension from @x402/extensions/bazaar) so the 402 carries extensions.bazaar with input and output info.",
  method: "Set an explicit HTTP method in the Bazaar declaration (info.input.method, e.g. \"GET\").",
  mismatch: "Declare the method the route actually charges; if a route charges GET and POST, give each method its own route config and declaration.",
  enumWide: "Pin extensions.bazaar.schema.properties.input.properties.method.enum to the one charged method (some SDK versions emit the whole verb family, e.g. GET/HEAD/DELETE, and rely on runtime enrichment that may not run in a bundled deployment).",
  description: `Keep resource.description at or under ${MAX_DESCRIPTION_CHARS} characters (CDP rejects verify/settle above that).`,
  resourceMismatch: "Set resource.url to the exact public URL of this route (same host and path the route is listed and called at).",
} as const;

export function lintProbe(p: ProbeInput): ProbeLint {
  const f: Finding[] = [];
  const out: ProbeLint = {
    method: p.method,
    httpStatus: p.status,
    x402Version: null,
    challengeSource: null,
    advertisedNetworks: [],
    payTos: [],
    bazaar: { present: false, method: null, methodEnum: null },
    findings: f,
  };

  if (p.status !== 402) {
    f.push({
      id: "not_402",
      level: "fail",
      message: `Unpaid ${p.method} returned HTTP ${p.status}, not 402. x402 clients and CDP's indexer only see a payable route on a 402.${p.status === 405 ? " 405 suggests the route is listed with the wrong method." : ""}`,
      fix: FIX.not402,
    });
    return out;
  }

  let parsed: Json | null = null;
  const hdr = p.headers.get("payment-required");
  if (hdr) {
    parsed = decodeChallenge(hdr);
    if (parsed) out.challengeSource = "header";
    else f.push({ id: "header_undecodable", level: "fail", message: "PAYMENT-REQUIRED header is present but is not base64 JSON.", fix: FIX.header });
  }
  if (!parsed) {
    try {
      const b = obj(JSON.parse(p.body));
      if (b && ("x402Version" in b || "accepts" in b)) {
        parsed = b;
        out.challengeSource = "body";
      }
    } catch {
      /* not JSON */
    }
  }
  if (!hdr)
    f.push({
      id: "payment_required_header_missing",
      level: "fail",
      message: out.challengeSource === "body" ? "402 has the challenge only in the JSON body; x402 v2 clients and CDP read the PAYMENT-REQUIRED header." : "402 without a PAYMENT-REQUIRED header.",
      fix: FIX.header,
    });
  if (!parsed) {
    f.push({ id: "challenge_missing", level: "fail", message: "402 without a parseable x402 challenge (no PAYMENT-REQUIRED header and no x402 JSON body).", fix: FIX.header });
    return out;
  }

  const version = typeof parsed.x402Version === "number" ? parsed.x402Version : null;
  out.x402Version = version;
  if (version !== 2)
    f.push({
      id: "x402_version",
      level: "fail",
      message: version === 1 ? "x402Version is 1 (legacy: network names like 'base', maxAmountRequired). This check and CDP's v2 discovery expect x402Version 2." : "x402Version is missing or not 2.",
      fix: FIX.version,
    });

  // resource
  const resource = obj(parsed.resource);
  const resourceUrl = str(resource?.url);
  const missing: string[] = [];
  if (!resourceUrl) missing.push("resource.url");
  else {
    if (resourceUrl.startsWith("http://"))
      f.push({ id: "resource_http", level: "fail", message: `resource.url is plain http (${resourceUrl}). CDP does not index endpoints reachable only over http.`, fix: FIX.https, doc: CDP_TROUBLESHOOTING_URL });
    const a = resourceKey(resourceUrl);
    const b = resourceKey(p.listedUrl);
    if (a && b && a.replace(/^http:/, "https:") !== b.replace(/^http:/, "https:"))
      f.push({ id: "resource_mismatch", level: "warn", message: `resource.url (${resourceUrl}) differs from the listed URL (${p.listedUrl}).`, fix: FIX.resourceMismatch });
  }
  const desc = str(resource?.description);
  if (desc && desc.length > MAX_DESCRIPTION_CHARS)
    f.push({ id: "description_too_long", level: "warn", message: `resource.description is ${desc.length} characters (> ${MAX_DESCRIPTION_CHARS}).`, fix: FIX.description });

  // accepts
  const accepts = Array.isArray(parsed.accepts) ? (parsed.accepts as unknown[]) : [];
  if (!accepts.length) missing.push("accepts[]");
  accepts.slice(0, 10).forEach((a0, i) => {
    const a = obj(a0) ?? {};
    for (const k of ["scheme", "network", "asset", "payTo"]) if (!str(a[k])) missing.push(`accepts[${i}].${k}`);
    if (!str(a.amount)) missing.push(`accepts[${i}].amount`);
    if (typeof a.maxTimeoutSeconds !== "number") missing.push(`accepts[${i}].maxTimeoutSeconds`);
    const network = str(a.network);
    if (network) {
      if (version === 2 && !/^[a-z0-9-]+:[A-Za-z0-9-]+$/.test(network))
        f.push({ id: "network_not_caip2", level: "fail", message: `accepts[${i}].network '${network}' is not CAIP-2 (e.g. eip155:8453).`, fix: FIX.version });
      const label = networkLabel(network);
      if (!out.advertisedNetworks.includes(label)) out.advertisedNetworks.push(label);
    }
    const payTo = str(a.payTo);
    if (payTo && network && !out.payTos.some((x) => x.payTo === payTo && x.network === network)) out.payTos.push({ network, payTo });
  });
  if (missing.length)
    f.push({ id: "v2_fields_missing", level: "fail", message: `Missing x402 v2 field(s): ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", …" : ""}.`, fix: FIX.fields });

  // extensions.bazaar
  const bz = obj(obj(parsed.extensions)?.bazaar);
  if (!bz) {
    f.push({ id: "bazaar_missing", level: "fail", message: "The 402 has no extensions.bazaar (discovery metadata). CDP needs valid Bazaar metadata on the 402 to index the route.", fix: FIX.bazaar, doc: CDP_TROUBLESHOOTING_URL });
    return out;
  }
  out.bazaar.present = true;
  const info = obj(bz.info);
  const input = obj(info?.input);
  const bMethod = str(input?.method)?.toUpperCase() ?? null;
  out.bazaar.method = bMethod;
  const enumRaw = obj(obj(obj(obj(obj(bz.schema)?.properties)?.input)?.properties)?.method)?.enum;
  const methodEnum = Array.isArray(enumRaw) ? enumRaw.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()) : null;
  out.bazaar.methodEnum = methodEnum;
  if (!bMethod) {
    f.push({ id: "bazaar_no_method", level: "fail", message: "extensions.bazaar.info.input.method is missing: the discovery metadata does not say which HTTP method the route charges.", fix: FIX.method });
  } else if (bMethod !== p.method) {
    f.push({
      id: "method_mismatch",
      level: "fail",
      message: `Bazaar metadata declares ${bMethod}, but the route is listed and charged on ${p.method}.${bMethod === "HEAD" ? " HEAD and GET are separate methods to CDP's validator." : ""}`,
      fix: FIX.mismatch,
    });
  }
  if (methodEnum && (methodEnum.length !== 1 || methodEnum[0] !== p.method)) {
    f.push({
      id: "method_enum_mismatch",
      level: methodEnum.includes(p.method) ? "warn" : "fail",
      message: `Bazaar schema method enum is [${methodEnum.join(", ")}], not [${p.method}]${methodEnum.includes("HEAD") ? " (includes HEAD, a HEAD vs GET mismatch)" : ""}.`,
      fix: FIX.enumWide,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* INDEX: CDP discovery                                               */
/* ------------------------------------------------------------------ */

export type IndexEntry = { url: string; networks: NetworkLabel[]; lastUpdated: string | null };
export type IndexData = {
  byKey: Map<string, IndexEntry>;
  merchantTotals: { payTo: string; network: string; totalForPayTo: number; onHost: number }[];
  searchHitsOnHost: number;
  searchError: string | null;
};

async function cdpGet(deps: Deps, path: string): Promise<Json> {
  const res = await deps.fetch(`${CDP_DISCOVERY_URL}${path}`, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`CDP discovery ${path.split("?")[0]} returned HTTP ${res.status}`);
  }
  const text = await readCapped(res, CDP_MAX_BYTES);
  const j = obj(JSON.parse(text));
  if (!j) throw new Error("CDP discovery returned non-object JSON");
  return j;
}

function absorb(byKey: Map<string, IndexEntry>, host: string, resources: unknown): number {
  let n = 0;
  if (!Array.isArray(resources)) return 0;
  for (const r0 of resources) {
    const r = obj(r0);
    const url = str(r?.resource);
    if (!url) continue;
    let h: string;
    try {
      h = new URL(url).host.toLowerCase();
    } catch {
      continue;
    }
    if (h !== host) continue;
    n += 1;
    const key = resourceKey(url)!;
    const cur = byKey.get(key) ?? { url, networks: [], lastUpdated: null };
    for (const a0 of Array.isArray(r!.accepts) ? (r!.accepts as unknown[]) : []) {
      const net = str(obj(a0)?.network);
      if (net) {
        const l = networkLabel(net);
        if (!cur.networks.includes(l)) cur.networks.push(l);
      }
    }
    const lu = str(r!.lastUpdated);
    if (lu && (!cur.lastUpdated || lu > cur.lastUpdated)) cur.lastUpdated = lu;
    byKey.set(key, cur);
  }
  return n;
}

/** Throws if every CDP call fails (caller returns 502, not billed). */
export async function queryIndex(deps: Deps, host: string, payTos: { network: string; payTo: string }[]): Promise<IndexData> {
  const byKey = new Map<string, IndexEntry>();
  const merchantTotals: IndexData["merchantTotals"] = [];
  let ok = 0;
  let lastErr: unknown = null;
  const seen = new Set<string>();
  for (const { payTo, network } of payTos) {
    if (seen.has(payTo)) continue;
    seen.add(payTo);
    try {
      let total = 0;
      let onHost = 0;
      for (let page = 0; page < CDP_MAX_PAGES; page++) {
        const j = await cdpGet(deps, `/merchant?payTo=${encodeURIComponent(payTo)}&limit=100&offset=${page * 100}`);
        total = Number(obj(j.pagination)?.total ?? 0) || 0;
        const res = Array.isArray(j.resources) ? j.resources : [];
        onHost += absorb(byKey, host, res);
        if ((page + 1) * 100 >= total || res.length === 0) break;
      }
      merchantTotals.push({ payTo, network, totalForPayTo: total, onHost });
      ok += 1;
    } catch (e) {
      lastErr = e;
    }
  }
  let searchHitsOnHost = 0;
  let searchError: string | null = null;
  try {
    const j = await cdpGet(deps, `/search?query=${encodeURIComponent(host)}`);
    searchHitsOnHost = absorb(byKey, host, j.resources);
    ok += 1;
  } catch (e) {
    searchError = e instanceof Error ? e.message : "search failed";
    lastErr = e;
  }
  if (ok === 0) throw lastErr instanceof Error ? lastErr : new Error("CDP discovery unavailable");
  return { byKey, merchantTotals, searchHitsOnHost, searchError };
}

/* ------------------------------------------------------------------ */
/* Read-only on-chain check (boolean only)                            */
/* ------------------------------------------------------------------ */

const BASE_RPCS = [process.env.BASE_RPC_URL ?? "", "https://base.drpc.org", "https://mainnet.base.org"].filter(Boolean);

export type OnchainCheck = { network: string; payTo: string; method: string; holdsUsdc: boolean | null };

async function rpc(deps: Deps, urls: string[], body: unknown): Promise<Json | null> {
  for (const u of urls) {
    try {
      const res = await deps.fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      const j = obj(await res.json());
      if (j && "result" in j) return j;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function onchainCheck(deps: Deps, network: string, payTo: string): Promise<OnchainCheck | null> {
  const label = networkLabel(network);
  if (label === "base" && /^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    const data = `0x70a08231${payTo.slice(2).toLowerCase().padStart(64, "0")}`;
    const j = await rpc(deps, BASE_RPCS, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] });
    const r = typeof j?.result === "string" ? j.result : null;
    let holds: boolean | null = null;
    if (r && /^0x[0-9a-fA-F]*$/.test(r)) holds = r.replace(/^0x0*/, "") !== "";
    return { network, payTo, method: "USDC balanceOf on Base (eth_call)", holdsUsdc: holds };
  }
  if (label === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo)) {
    const j = await rpc(deps, [DEFAULT_SOLANA_RPC_URL], {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [payTo, { mint: USDC_SOLANA_MINT }, { encoding: "jsonParsed" }],
    });
    const val = obj(j?.result)?.value;
    let holds: boolean | null = null;
    if (Array.isArray(val))
      holds = val.some((acc) => {
        const amt = obj(obj(obj(obj(obj(obj(acc)?.account)?.data)?.parsed)?.info)?.tokenAmount)?.amount;
        return typeof amt === "string" && amt !== "0";
      });
    return { network, payTo, method: "USDC token accounts on Solana (getTokenAccountsByOwner)", holdsUsdc: holds };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export type RouteReport = {
  url: string;
  methods: ("GET" | "POST")[];
  probed: boolean;
  skippedReason: string | null;
  indexed: boolean;
  indexedNetworks: NetworkLabel[];
  advertisedNetworks: NetworkLabel[];
  lastIndexed: string | null;
  /** Per-method probe facts; their findings are merged into `findings` below. */
  probes: Omit<ProbeLint, "payTos" | "advertisedNetworks" | "findings">[];
  findings: Finding[];
};

export type BazaarCheckResult = {
  ok: true;
  target: { input: string; host: string; origin: string };
  verdict: "fully_indexed" | "partially_indexed" | "not_indexed" | "no_routes_found";
  summary: {
    routesListed: number;
    routesProbed: number;
    indexed: number;
    notIndexed: number;
    indexedOnBase: number;
    indexedOnSolana: number;
    fail: number;
    warn: number;
  };
  wellKnown: { url: string; httpStatus: number | null; found: boolean; entries: number };
  index: {
    source: string;
    payTos: { network: string; payTo: string; indexedTotalForPayTo: number; indexedOnHost: number }[];
    searchHitsOnHost: number;
    searchError: string | null;
    indexedNotListed: IndexEntry[];
  };
  onchain: OnchainCheck[];
  routes: RouteReport[];
  findings: Finding[];
  elapsedMs: number;
  methodology: typeof BAZAAR_CHECK_METHODOLOGY;
};

export type BazaarCheckError = { ok: false; error: string; code: string; status: number };

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

export async function checkBazaar(input: { url?: string }, deps: Deps = defaultDeps()): Promise<BazaarCheckResult | BazaarCheckError> {
  const started = deps.now();
  const t = parseTarget(input.url);
  if ("error" in t) return { ok: false, error: t.error, code: t.code, status: 400 };
  const gate = await deps.assertSafe(t.origin);
  if ("ok" in gate && gate.ok === false) return { ok: false, error: gate.error, code: "host_blocked", status: 400 };

  const hostFindings: Finding[] = [];
  const wkUrl = `${t.origin}/.well-known/x402`;
  const wkRes = await safeFetch(deps, wkUrl, "GET", BC_PROBE_TIMEOUT_MS);
  let listed: ListedRoute[] = [];
  const wellKnown = { url: wkUrl, httpStatus: null as number | null, found: false, entries: 0 };
  let reachable = false;
  if ("status" in wkRes) {
    reachable = true;
    wellKnown.httpStatus = wkRes.status;
    const parsed = wkRes.status === 200 ? parseWellKnown(wkRes.body) : null;
    if (parsed) {
      wellKnown.found = true;
      listed = parsed.routes;
      wellKnown.entries = parsed.routes.reduce((n, r) => n + r.methods.length, 0);
      hostFindings.push(...parsed.findings);
    }
  } else if (wkRes.code === "host_blocked") {
    return { ok: false, error: wkRes.error, code: "host_blocked", status: 400 };
  }
  if (!wellKnown.found) {
    hostFindings.push({
      id: "well_known_missing",
      level: "warn",
      message: `${wkUrl} ${wellKnown.httpStatus ? `returned HTTP ${wellKnown.httpStatus} or is not a { resources: [...] } JSON list` : "could not be fetched"}. Routes were not discovered from it.`,
      fix: 'Serve /.well-known/x402 as JSON { "version": 1, "resources": ["GET https://host/api/route", ...] } listing every paid route.',
    });
  }
  // A caller-supplied path is always probed (with GET unless already listed).
  if (t.path) {
    const u = `${t.origin}${t.path}`;
    const key = resourceKey(u);
    if (!listed.some((r) => resourceKey(r.url) === key)) {
      listed.push({ url: u, methods: ["GET"], listedAs: [u] });
      if (wellKnown.found)
        hostFindings.push({ id: "route_not_in_well_known", level: "warn", message: `${u} is not listed in /.well-known/x402.`, fix: "Add the route to /.well-known/x402 with its method." });
    }
  }
  const truncated = listed.length > BC_MAX_ROUTES;
  if (truncated)
    hostFindings.push({ id: "routes_truncated", level: "info", message: `${listed.length} routes listed; only the first ${BC_MAX_ROUTES} were checked.` });
  listed = listed.slice(0, BC_MAX_ROUTES);

  // LINT: probe each same-host https route + method.
  type Job = { route: ListedRoute; method: "GET" | "POST" };
  const routeFindings = new Map<ListedRoute, Finding[]>();
  const skipped = new Map<ListedRoute, string>();
  const jobs: Job[] = [];
  for (const r of listed) {
    const fs: Finding[] = [];
    routeFindings.set(r, fs);
    let u: URL | null = null;
    try {
      u = new URL(r.url);
    } catch {
      skipped.set(r, "not a valid URL");
      fs.push({ id: "bad_listed_url", level: "fail", message: `Listed resource '${r.url}' is not a valid absolute URL.`, fix: "List absolute https URLs." });
      continue;
    }
    if (u.protocol === "http:") {
      fs.push({ id: "resource_http", level: "fail", message: `Listed as plain http (${r.url}). CDP does not index endpoints reachable only over http.`, fix: FIX.https, doc: CDP_TROUBLESHOOTING_URL });
      skipped.set(r, "plain http (not fetched)");
      continue;
    }
    if (u.protocol !== "https:") {
      skipped.set(r, "not https");
      continue;
    }
    if (u.host.toLowerCase() !== t.host) {
      skipped.set(r, `on another host (${u.host}); only ${t.host} is probed`);
      continue;
    }
    for (const m of r.methods) jobs.push({ route: r, method: m });
  }
  const deadline = started + BC_TOTAL_BUDGET_MS;
  const probeResults = await pool(jobs, BC_PROBE_CONCURRENCY, async (j) => {
    const budget = Math.min(BC_PROBE_TIMEOUT_MS, deadline - deps.now());
    if (budget <= 0) return { job: j, lint: null as ProbeLint | null, err: "skipped: total time budget used" };
    const res = await safeFetch(deps, j.route.url, j.method, budget);
    if (!("status" in res)) return { job: j, lint: null, err: res.error };
    reachable = true;
    return { job: j, lint: lintProbe({ listedUrl: j.route.url, method: j.method, status: res.status, headers: res.headers, body: res.body }), err: null };
  });
  if (!reachable) return { ok: false, error: `${t.host} could not be reached over https (DNS, connection or timeout)`, code: "unreachable", status: 502 };

  const payTos: { network: string; payTo: string }[] = [];
  for (const pr of probeResults) for (const p of pr.lint?.payTos ?? []) if (!payTos.some((x) => x.payTo === p.payTo)) payTos.push(p);

  // INDEX
  let index: IndexData;
  try {
    index = await queryIndex(deps, t.host, payTos);
  } catch (e) {
    return { ok: false, error: `CDP discovery unavailable: ${e instanceof Error ? e.message : "error"}`, code: "cdp_unavailable", status: 502 };
  }
  if (index.searchError)
    hostFindings.push({ id: "cdp_search_unavailable", level: "info", message: `CDP /search failed (${index.searchError}); index status is from /merchant only.` });
  if (!payTos.length)
    hostFindings.push({ id: "no_payto_found", level: "info", message: "No payTo was found in any 402, so CDP /merchant was not queried; index status is from /search only." });

  // Settle inference: payTo with zero index entries + on-chain check.
  const onchain: OnchainCheck[] = [];
  for (const m of index.merchantTotals) {
    if (m.totalForPayTo !== 0) continue;
    const oc = await onchainCheck(deps, m.network, m.payTo);
    if (!oc) continue;
    onchain.push(oc);
    const chainNote =
      oc.holdsUsdc === false
        ? "a read-only on-chain check finds no USDC held by it"
        : oc.holdsUsdc === true
          ? "it does hold USDC on-chain (amount not reported), but payments settled through other facilitators do not trigger CDP indexing"
          : "the on-chain check was inconclusive (RPC unavailable)";
    hostFindings.push({
      id: "no_cdp_settle_likely",
      level: "fail",
      message: `CDP discovery has no resources at all for payTo ${m.payTo} (${networkLabel(m.network)}), and ${chainNote}. This payTo likely needs one CDP-facilitated paid settle: CDP indexes an endpoint only after it settles a payment through the CDP facilitator.`,
      fix: `Make one paid call to a route through the CDP facilitator (${CDP_FACILITATOR}), with extensions.bazaar and resource on the payment payload; indexing runs after the settle and can take up to 15 minutes.`,
      doc: CDP_TROUBLESHOOTING_URL,
    });
  }

  // Assemble per-route reports.
  const routes: RouteReport[] = listed.map((r) => {
    const key = resourceKey(r.url) ?? r.url;
    const entry = index.byKey.get(key) ?? index.byKey.get(key.replace(/^http:/, "https:"));
    const mine = probeResults.filter((p) => p.job.route === r);
    const findings = [...(routeFindings.get(r) ?? [])];
    const adv: NetworkLabel[] = [];
    const probes: RouteReport["probes"] = [];
    for (const p of mine) {
      if (p.lint) {
        const { payTos: _p, advertisedNetworks, findings: _f, ...rest } = p.lint;
        void _p;
        void _f;
        for (const n of advertisedNetworks) if (!adv.includes(n)) adv.push(n);
        probes.push(rest);
        for (const fd of p.lint.findings) findings.push({ ...fd, message: mine.length > 1 ? `[${p.job.method}] ${fd.message}` : fd.message });
      } else {
        findings.push({ id: "probe_failed", level: "warn", message: `Unpaid ${p.job.method} probe failed: ${p.err}.`, fix: "Make sure the route answers public https requests within a few seconds." });
      }
    }
    const indexed = Boolean(entry);
    const indexedNetworks = entry?.networks ?? [];
    if (!indexed && !skipped.has(r)) {
      const lintFails = findings.some((x) => x.level === "fail");
      const payToEmpty = index.merchantTotals.some((m) => m.totalForPayTo === 0);
      findings.push({
        id: "not_indexed",
        level: "fail",
        message: lintFails
          ? "Not in CDP discovery. Fix the failures above first; CDP needs a public https route that returns valid Bazaar metadata on a 402."
          : payToEmpty
            ? "Not in CDP discovery; see no_cdp_settle_likely (the payTo has no indexed resources)."
            : "Not in CDP discovery, although other routes for this payTo are. Lint passed, so this route most likely has not settled a payment through the CDP facilitator since it was added or changed.",
        fix: lintFails
          ? "After fixing, make one CDP-facilitated paid call to this route; indexing can take up to 15 minutes."
          : "Make one paid call to this route through the CDP facilitator; indexing runs after the settle and can take up to 15 minutes.",
        doc: CDP_TROUBLESHOOTING_URL,
      });
    }
    if (indexed) {
      const missingNets = adv.filter((n) => !indexedNetworks.includes(n));
      if (missingNets.length)
        findings.push({
          id: "network_not_indexed",
          level: "warn",
          message: `The 402 advertises ${missingNets.join(", ")}, but the CDP index entry lists only ${indexedNetworks.join(", ") || "no networks"}${entry?.lastUpdated ? ` (last updated ${entry.lastUpdated})` : ""}.`,
          fix: "CDP refreshes an entry from the live 402 after a new CDP-facilitated paid call to that route (in our experience); make one, then recheck after about 15 minutes.",
          doc: CDP_TROUBLESHOOTING_URL,
        });
    }
    return {
      url: r.url,
      methods: r.methods,
      probed: mine.some((p) => p.lint),
      skippedReason: skipped.get(r) ?? null,
      indexed,
      indexedNetworks,
      advertisedNetworks: adv,
      lastIndexed: entry?.lastUpdated ?? null,
      probes,
      findings,
    };
  });

  const listedKeys = new Set(listed.map((r) => resourceKey(r.url)));
  const indexedNotListed = [...index.byKey.entries()].filter(([k]) => !listedKeys.has(k)).map(([, v]) => v);

  const considered = routes.filter((r) => !r.skippedReason || r.skippedReason.startsWith("plain http"));
  const nIndexed = considered.filter((r) => r.indexed).length;
  const all = [...hostFindings, ...routes.flatMap((r) => r.findings)];
  const verdict: BazaarCheckResult["verdict"] = !considered.length
    ? "no_routes_found"
    : nIndexed === considered.length
      ? "fully_indexed"
      : nIndexed === 0
        ? "not_indexed"
        : "partially_indexed";

  return {
    ok: true,
    target: { input: input.url!.trim(), host: t.host, origin: t.origin },
    verdict,
    summary: {
      routesListed: listed.length,
      routesProbed: routes.filter((r) => r.probed).length,
      indexed: nIndexed,
      notIndexed: considered.length - nIndexed,
      indexedOnBase: considered.filter((r) => r.indexedNetworks.includes("base")).length,
      indexedOnSolana: considered.filter((r) => r.indexedNetworks.includes("solana")).length,
      fail: all.filter((x) => x.level === "fail").length,
      warn: all.filter((x) => x.level === "warn").length,
    },
    wellKnown,
    index: {
      source: CDP_DISCOVERY_URL,
      payTos: index.merchantTotals.map((m) => ({ network: m.network, payTo: m.payTo, indexedTotalForPayTo: m.totalForPayTo, indexedOnHost: m.onHost })),
      searchHitsOnHost: index.searchHitsOnHost,
      searchError: index.searchError,
      indexedNotListed,
    },
    onchain,
    routes,
    findings: hostFindings,
    elapsedMs: deps.now() - started,
    methodology: BAZAAR_CHECK_METHODOLOGY,
  };
}
