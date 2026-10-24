/**
 * Seller-DD checks (spec §2, §4, Sentinel C2/C4, Counsel D2/D4/D5). Everything a seller returns is untrusted DATA,
 * never instructions; only a sha256 plus (when allowed) a <= 200-char excerpt or field names ever leave this module.
 *
 * Network (C2): both the 402 fetch and the paid fetch use the guarded dispatcher (connect-time IP check on every DNS
 * answer, private/loopback/link-local/metadata blocked). https only. Redirects are never followed (a 3xx is a finding,
 * never paid). The 402 fetch records the connected IP; the paid fetch re-resolves, refuses if that IP is no longer an
 * answer (DNS rebinding), and connects only to the pinned IP. Body and time limits apply. No opt-out for this route.
 */
import { createHash } from "node:crypto";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BASE_CAIP2, USDC_BASE } from "@/lib/config";
import { cdpGet } from "@/lib/bazaar-check";
import { defaultRpcDeps, ethCall, hexToBig, rpcs, type RpcDeps } from "@/lib/chain-rpc";
import { authorizationTxDetailed, readHistoryDetailed, type History } from "./history";
import { distinctOperators } from "@/lib/premium/onchain";
import { AUTHORIZATION_STATE_SELECTOR } from "@/lib/premium/payment";
import { createGuardedAgent, guardedFetch, isBlockedIp, isSsrfBlockedError } from "@/lib/net-guard";
import { EXCERPT_MAX, FETCH_MAX_BYTES, FETCH_TIMEOUT_MS } from "./config";
import { isEvmAddress } from "./screen";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* ------------------------------ network ------------------------------ */
export type FetchOut =
  | { ok: true; status: number; headers: Record<string, string>; body: string; truncated: boolean; ip: string; fetched_at: string }
  | { ok: false; code: "bad_url" | "http_not_allowed" | "host_blocked" | "timeout" | "upstream" | "redirect_not_followed" | "dns_changed" | "too_large" };

export type NetDeps = {
  get402(url: string): Promise<FetchOut>;
  getPaid(url: string, pinnedIp: string, paymentHeader: string): Promise<FetchOut>;
};

type Resolver = (h: string, o: { all: true; verbatim: true }, cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => void;
const sysResolve: Resolver = (h, o, cb) => dnsLookup(h, o, cb);

export function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

async function readCapped(res: Response, max: number) {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > max) { chunks.push(Buffer.from(value.subarray(0, max - n))); truncated = true; break; }
      chunks.push(Buffer.from(value)); n += value.length;
    }
  } finally { reader.cancel().catch(() => {}); }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function guardedOnce(url: string, resolve: Resolver, init: RequestInit, capture: { ip: string | null }): Promise<FetchOut> {
  const u = httpsUrl(url);
  if (!u) return { ok: false, code: url.startsWith("http:") ? "http_not_allowed" : "bad_url" };
  const agent = createGuardedAgent({
    resolve: (h, o, cb) => resolve(h, o, (e, a) => {
      if (e || !a?.length) return cb(e, a);
      // record the single answer we connect to (the guard refuses the whole lookup if ANY answer is blocked)
      if (a.some((x) => isBlockedIp(x.address))) return cb(null, a);
      capture.ip = a[0]!.address;
      cb(null, [a[0]!]);
    }),
  });
  try {
    const res = await guardedFetch(u.toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, agent);
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => {}); return { ok: false, code: "redirect_not_followed" }; }
    const { text, truncated } = await readCapped(res, FETCH_MAX_BYTES);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { ok: true, status: res.status, headers, body: text, truncated, ip: capture.ip ?? "", fetched_at: new Date().toISOString() };
  } catch (e) {
    if (isSsrfBlockedError(e)) return { ok: false, code: "host_blocked" };
    const n = e instanceof Error ? e.name : "";
    return { ok: false, code: n === "TimeoutError" || n === "AbortError" ? "timeout" : "upstream" };
  } finally {
    agent.close().catch(() => {});
  }
}

export function defaultNetDeps(resolve: Resolver = sysResolve): NetDeps {
  return {
    get402: (url) => guardedOnce(url, resolve, { method: "GET", headers: { accept: "application/json" } }, { ip: null }),
    getPaid: async (url, pinnedIp, paymentHeader) => {
      // C2 rebinding: re-resolve; the pinned IP must still be an answer, and we connect only to it.
      const pinned: Resolver = (h, o, cb) => resolve(h, o, (e, a) => {
        if (e) return cb(e, a);
        if (!a?.some((x) => x.address === pinnedIp)) return cb(Object.assign(new Error("dns_changed"), { code: "EDNSCHANGED" }), []);
        cb(null, a.filter((x) => x.address === pinnedIp));
      });
      const out = await guardedOnce(url, pinned, { method: "GET", headers: { accept: "application/json", "PAYMENT-SIGNATURE": paymentHeader, "X-PAYMENT": paymentHeader } }, { ip: null });
      if (!out.ok && out.code === "upstream") {
        // distinguish rebinding from a plain upstream failure with one more resolve
        const still = await new Promise<boolean>((r) => resolve(new URL(url).hostname, { all: true, verbatim: true }, (e, a) => r(!e && !!a?.some((x) => x.address === pinnedIp))));
        if (!still) return { ok: false, code: "dns_changed" };
      }
      if (out.ok && out.ip && out.ip !== pinnedIp) return { ok: false, code: "dns_changed" };
      return out;
    },
  };
}

/* ------------------------------ 402 parse ------------------------------ */
export type Listed = { price_atomic: string; network: string; asset: string; payTo: string; extra: Record<string, unknown> | null; mimeType: string | null; outputSchema: unknown; terms: string | null; x402Version: number; rawNetwork: string; accept: Record<string, any> };
export type ParseOut = { ok: true; listed: Listed; response_sha256: string } | { ok: false; code: string; response_sha256?: string };

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);

export function parse402(f: FetchOut & { ok: true }): ParseOut {
  const response_sha256 = sha256(f.body);
  if (f.status !== 402) return { ok: false, code: `not_402_status_${f.status}`, response_sha256 };
  let pr: Record<string, any> | null = null;
  const hdr = f.headers["payment-required"];
  if (hdr) { try { pr = obj(decodePaymentRequiredHeader(hdr)); } catch { pr = null; } }
  if (!pr) { try { pr = obj(JSON.parse(f.body)); } catch { pr = null; } }
  if (!pr || !Array.isArray(pr.accepts)) return { ok: false, code: "malformed_402", response_sha256 };
  const a = pr.accepts.map(obj).find((x: any) => x && x.scheme === "exact" && (x.network === BASE_CAIP2 || x.network === "base") && typeof x.asset === "string" && x.asset.toLowerCase() === USDC_BASE.toLowerCase());
  if (!a) return { ok: false, code: "no_base_usdc_exact_accept", response_sha256 };
  const amount = String(a.amount ?? a.maxAmountRequired ?? "");
  if (!/^\d{1,20}$/.test(amount) || !isEvmAddress(a.payTo)) return { ok: false, code: "malformed_402", response_sha256 };
  const res = obj(pr.resource);
  return {
    ok: true,
    response_sha256,
    listed: {
      price_atomic: amount,
      network: BASE_CAIP2,
      asset: a.asset,
      payTo: a.payTo,
      extra: obj(a.extra),
      mimeType: (typeof res?.mimeType === "string" ? res.mimeType : typeof a.mimeType === "string" ? a.mimeType : null),
      outputSchema: a.outputSchema ?? obj(obj(obj(pr.extensions)?.bazaar)?.info)?.output ?? obj(obj(obj(pr.extensions)?.bazaar)?.schema)?.properties?.output ?? null,
      terms: typeof res?.terms === "string" ? res.terms : typeof pr.terms === "string" ? pr.terms : null,
      x402Version: Number(pr.x402Version ?? 1),
      rawNetwork: String(a.network),
      accept: a,
    },
  };
}

/* ------------------------------ schema match ------------------------------ */
export type SchemaOut = { result: "ok" | "warn" | "fail"; diff: string[]; note: string };
/** Field NAMES only (D5); values never leave. */
export function schemaMatch(paid: FetchOut & { ok: true }, listed: Listed, namesAllowed: boolean): SchemaOut {
  const ct = (paid.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const diff: string[] = [];
  if (listed.mimeType && ct && listed.mimeType.toLowerCase() !== ct) diff.push(`content_type:${ct}!=${listed.mimeType.toLowerCase()}`);
  if (paid.status < 200 || paid.status >= 300) return { result: "fail", diff: namesAllowed ? diff : [], note: `paid response HTTP ${paid.status}` };
  const schema = obj(listed.outputSchema);
  if (!schema) return { result: diff.length ? "warn" : "warn", diff: namesAllowed ? diff : [], note: "no output schema listed; content type compared only" };
  let body: Record<string, any> | null = null;
  try { body = obj(JSON.parse(paid.body)); } catch { body = null; }
  if (!body) return { result: "fail", diff: namesAllowed ? [...diff, "body_not_json_object"] : [], note: "paid body is not a JSON object while a schema is listed" };
  const props = obj(schema.properties) ?? obj(obj(schema.schema)?.properties) ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required.filter((x: unknown) => typeof x === "string") : Object.keys(props);
  for (const k of required) if (!(k in body)) diff.push(`missing:${k}`);
  for (const [k, p] of Object.entries(props)) {
    const t = obj(p)?.type;
    if (k in body && typeof t === "string") {
      const v = body[k];
      const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" ? (Number.isInteger(v) && t === "integer" ? "integer" : "number") : typeof v;
      if (actual !== t && !(t === "number" && actual === "integer")) diff.push(`type:${k}:${actual}!=${t}`);
    }
  }
  const note = diff.length ? `paid response differs from listed schema in ${diff.length} place(s)` : "paid response matches listed schema fields";
  return { result: diff.length ? (diff.some((d) => d.startsWith("missing:")) ? "fail" : "warn") : "ok", diff: namesAllowed ? diff : [], note };
}

/** D4/D5: excerpt only when terms allow; never paid data values beyond a short excerpt. */
export function excerptFor(body: string, termsAllowExcerpt: boolean): string | null {
  if (!termsAllowExcerpt) return null;
  return body.replace(/\s+/g, " ").slice(0, EXCERPT_MAX);
}
const BARS = /(no|not|never|prohibit\w*|forbid\w*)\s+[^.]{0,80}(redistribut\w*|benchmark\w*|republish\w*)/i;
/** D4: read the seller terms link (guarded). Bars redistribution/benchmarking or unreadable -> hash only. No link -> D5. */
export async function termsAllowExcerpt(terms: string | null, net: NetDeps): Promise<{ allowed: boolean; note: string }> {
  if (!terms) return { allowed: true, note: "no terms link; D5 excerpt cap applies" };
  const f = await net.get402(terms).catch(() => null);
  if (!f || !f.ok) return { allowed: false, note: "terms link unreadable; hash only" };
  return BARS.test(f.body) ? { allowed: false, note: "terms bar redistribution or benchmarking; hash only" } : { allowed: true, note: "terms read; excerpt capped" };
}

/* ------------------------------ continuity ------------------------------ */
export type ListingRef = { payTo: string; source_url: string; fetched_at: string; snapshot_id?: string; snapshot_date?: string };
export type ContinuityDeps = { lookup(resource: string, deadline: number): Promise<ListingRef | null> };

/** CDP public discovery /search?query=<host>, exact resource URL match, Base accept payTo. */
export function cdpContinuityDeps(rpc: RpcDeps = defaultRpcDeps()): ContinuityDeps {
  return {
    async lookup(resource, deadline) {
      const host = new URL(resource).host;
      const path = `/search?query=${encodeURIComponent(host)}`;
      const j = await cdpGet({ fetch: rpc.fetch, now: rpc.now } as never, path, deadline).catch(() => null);
      const items: unknown[] = Array.isArray(j?.items) ? (j!.items as unknown[]) : Array.isArray(j?.resources) ? (j!.resources as unknown[]) : [];
      for (const it of items) {
        const r = obj(it);
        if (!r || r.resource !== resource) continue;
        const a = (Array.isArray(r.accepts) ? r.accepts : []).map(obj).find((x: any) => x && (x.network === BASE_CAIP2 || x.network === "base") && isEvmAddress(x.payTo));
        if (a) return { payTo: a.payTo, source_url: `https://api.cdp.coinbase.com/platform/v2/x402/discovery${path}`, fetched_at: new Date(rpc.now()).toISOString() };
      }
      return null;
    },
  };
}

/* ------------------------------ on-chain ------------------------------ */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTH_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

async function rpcAt(deps: RpcDeps, url: string, method: string, params: unknown, deadline: number): Promise<unknown> {
  const budget = Math.min(5_000, deadline - deps.now());
  if (budget <= 0) throw new Error("deadline");
  const res = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(budget) });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const j = obj(await res.json());
  if (!j || !("result" in j)) throw new Error("rpc_error");
  return j.result;
}

/** C4: our own two-node read of authorizationState(tester, nonce). Both distinct operators must say used. */
/** `token`: contract to read (default Base USDC = our tester's own test pay; EURC only for a buyer's EURC payment). */
export async function testPayLanded(tester: string, nonce: string, deadline: number, deps: RpcDeps = defaultRpcDeps(), token: string = USDC_BASE): Promise<{ state: "used" | "unused" | "unknown"; nodes: string[] }> {
  const urls = distinctOperators(rpcs("base")).slice(0, 3);
  const data = AUTHORIZATION_STATE_SELECTOR + tester.toLowerCase().replace(/^0x/, "").padStart(64, "0") + nonce.toLowerCase().replace(/^0x/, "");
  const answers: { url: string; v: string }[] = [];
  for (const url of urls) {
    if (answers.length >= 2) break;
    try {
      const r = await rpcAt(deps, url, "eth_call", [{ to: token, data }, "latest"], deadline);
      if (typeof r === "string") answers.push({ url, v: /^0x0*1$/.test(r) ? "used" : /^0x0*$/.test(r) ? "unused" : "unknown" });
    } catch { /* next */ }
  }
  const nodes = answers.map((a) => new URL(a.url).host);
  if (answers.length < 2 || answers[0]!.v !== answers[1]!.v) return { state: "unknown", nodes };
  return { state: answers[0]!.v as "used" | "unused" | "unknown", nodes };
}
export async function nonceStateTwoNode(tester: string) {
  return async (nonce: string) => (await testPayLanded(tester, nonce, Date.now() + 10_000)).state;
}

/** tx hash of our AuthorizationUsed(tester, nonce) event. Provider fallback + reasons: lib/seller-dd/history.ts. */
export async function authorizationTx(tester: string, nonce: string, deadline: number, deps: RpcDeps = defaultRpcDeps(), lookback = 300): Promise<string | null> {
  return (await authorizationTxDetailed(tester, nonce, deadline, deps, lookback).catch(() => ({ tx: null }))).tx;
}

export type { History } from "./history";
/** Back-compat wrapper (History or null). The engine uses readHistoryDetailed for per-source reasons. */
export async function readHistory(payTo: string, deadline: number, deps: RpcDeps = defaultRpcDeps(), windowBlocks = 9_000): Promise<History | null> {
  const r = await readHistoryDetailed(payTo, deadline, deps, windowBlocks).catch(() => null);
  return r && r.ok ? r.history : null;
}

export { ethCall };
