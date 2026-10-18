/**
 * Web readiness checks (dark route /api/audit/security; the path is kept, the
 * copy never calls it an audit: Counsel C4).
 * Outside-in only, ONE target host: ordinary GETs of its home page (https and
 * http) and /.well-known/security.txt through the SSRF guard, one TLS handshake,
 * public DNS lookups, and (history/deep) public certificate-transparency data
 * from crt.sh. Counsel C1 (10/18): no /.env or /.git probes, no forged-Origin
 * CORS request, no extra hosts from certificate SANs or CT names (no ownership
 * mode for now). Opt-out list is checked before any request (handler/parseTarget).
 */
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from "node:tls";
import { Resolver } from "node:dns/promises";
import { guardedGet, type GuardedGetOk } from "./guarded-get";
import { guardedNetConnect } from "./net-guard";
import { assertSafePublicUrl } from "./fetch-url";
import { BodyTooLargeError, CRTSH_ATTRIBUTION, DATA_USER_AGENT, isOptedOut, readTextCapped, REDIRECT_COPY, upstashCache, upstashLimiter, type SharedCache, type SharedLimiter } from "./dark-checks-shared";

export const AUDIT_TIER_ORDER = ["quick", "standard", "extended", "report", "full", "history", "deep"] as const;
export type AuditTier = (typeof AUDIT_TIER_ORDER)[number];
const level = (t: AuditTier) => AUDIT_TIER_ORDER.indexOf(t);
/** ONE deadline across every stage (Odin C2); stages run in parallel and a stage still running at the deadline is reported "unavailable". Well under maxDuration 60. */
export const AUDIT_BUDGET_MS = 30_000;
const TIMED_OUT = Symbol("timed_out");
function within<T>(p: Promise<T>, deadline: number, now: () => number): Promise<T | typeof TIMED_OUT> {
  const ms = Math.max(0, deadline - now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch((): typeof TIMED_OUT => TIMED_OUT), new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), ms); })]).finally(() => clearTimeout(timer));
}

/** not_detected = this specific check found no issue; it does not mean the site is secure (Counsel C4). */
export type Status = "not_detected" | "warn" | "fail" | "info" | "unavailable";
export type Finding = { id: string; title: string; status: Status; severity: "low" | "medium" | "high" | null; detail: string; fix?: string; snippet?: string };

export type TlsInfo = { ok: true; protocol: string | null; authorized: boolean; authorizationError: string | null; validFrom: string; validTo: string; daysLeft: number; issuer: string; subject: string; san: string[] } | { ok: false; error: string };

export type AuditDeps = {
  get: typeof guardedGet;
  tls: (host: string) => Promise<TlsInfo>;
  dns: { resolve: (name: string, type: "A" | "AAAA" | "NS" | "MX" | "CAA" | "TXT") => Promise<unknown[]> };
  ct: (host: string) => Promise<{ ok: true; entries: { name: string; issuer: string; notBefore: string; notAfter: string }[] } | { ok: false; error: string }>;
  now: () => number;
};

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------
export async function tlsInspect(host: string, timeoutMs = 6_000): Promise<TlsInfo> {
  let sock;
  try {
    sock = await guardedNetConnect(host, 443, { timeoutMs });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "connect failed" };
  }
  return await new Promise<TlsInfo>((resolve) => {
    const t: TLSSocket = tlsConnect({ socket: sock, servername: host, rejectUnauthorized: false });
    const timer = setTimeout(() => {
      t.destroy();
      resolve({ ok: false, error: "TLS handshake timed out" });
    }, timeoutMs);
    t.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    t.once("secureConnect", () => {
      clearTimeout(timer);
      const c = t.getPeerCertificate() as PeerCertificate;
      const validTo = c.valid_to ?? "";
      const info: TlsInfo = {
        ok: true,
        protocol: t.getProtocol(),
        authorized: t.authorized,
        authorizationError: t.authorizationError ? String(t.authorizationError) : null,
        validFrom: c.valid_from ?? "",
        validTo,
        daysLeft: Math.floor((Date.parse(validTo) - Date.now()) / 86_400_000),
        issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(" / "),
        subject: String(c.subject?.CN ?? ""),
        san: (c.subjectaltname ?? "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("DNS:")).map((s) => s.slice(4).toLowerCase()),
      };
      t.destroy();
      resolve(info);
    });
  });
}

function defaultDns(): AuditDeps["dns"] {
  const r = new Resolver({ timeout: 4_000, tries: 2 });
  return {
    resolve: async (name, type) => {
      try {
        return (await r.resolve(name, type)) as unknown[];
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ENODATA" || code === "ENOTFOUND") return [];
        throw e;
      }
    },
  };
}

type CtResult = Awaited<ReturnType<AuditDeps["ct"]>>;
/** crt.sh body cap, enforced WHILE streaming (Sentinel LOW 10/17). */
export const CRTSH_MAX_BYTES = 5_000_000;
/** crt.sh is a free community service: history/deep tiers only, 24 h cache per host, at most this many live queries per minute across all instances. */
export const CRTSH_CACHE_TTL_S = 24 * 3600;
export const CRTSH_GLOBAL_PER_MINUTE = 10;
/** Newest certificates kept (same cap live and cached, so both give the same summary). */
const CT_KEEP = 300;

export async function crtShFetch(host: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<CtResult> {
  try {
    const res = await fetchFn(`https://crt.sh/?q=${encodeURIComponent(`%.${host}`)}&output=json&exclude=expired`, { headers: { "user-agent": DATA_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `crt.sh answered ${res.status}` };
    }
    const text = await readTextCapped(res, CRTSH_MAX_BYTES);
    const rows = JSON.parse(text) as { name_value?: string; issuer_name?: string; not_before?: string; not_after?: string }[];
    rows.sort((a, b) => String(b.not_before ?? "").localeCompare(String(a.not_before ?? "")));
    return { ok: true, entries: rows.slice(0, CT_KEEP).map((r) => ({ name: String(r.name_value ?? "").slice(0, 500), issuer: String(r.issuer_name ?? "").slice(0, 200), notBefore: String(r.not_before ?? ""), notAfter: String(r.not_after ?? "") })) };
  } catch (e) {
    if (e instanceof BodyTooLargeError) return { ok: false, error: "crt.sh result too large" };
    return { ok: false, error: `crt.sh: ${e instanceof Error ? e.message : "unreachable"}` };
  }
}

/** Cache first (shared, 24 h); a live query only within the global crt.sh budget. */
export function cachedCt(opts: { cache: SharedCache; limiter: SharedLimiter; fetchFn?: typeof fetch }): AuditDeps["ct"] {
  return async (host) => {
    const key = `crtsh:${host}`;
    const hit = await opts.cache.get(key);
    if (hit) {
      try {
        return JSON.parse(hit) as CtResult;
      } catch {
        /* refetch */
      }
    }
    const lim = await opts.limiter("crtsh:global", CRTSH_GLOBAL_PER_MINUTE);
    if (!lim.ok) return { ok: false, error: `crt.sh budget check unavailable (${lim.error})` };
    if (lim.retryAfter) return { ok: false, error: "crt.sh query budget for this minute is used" };
    const r = await crtShFetch(host, opts.fetchFn);
    if (r.ok) {
      await opts.cache.set(key, JSON.stringify(r), CRTSH_CACHE_TTL_S);
    }
    return r;
  };
}

export const defaultAuditDeps = (): AuditDeps => ({ get: guardedGet, tls: (h) => tlsInspect(h), dns: defaultDns(), ct: cachedCt({ cache: upstashCache(), limiter: upstashLimiter() }), now: () => Date.now() });

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export async function parseTarget(raw: string | null, optedOut: (host: string) => boolean = (h) => isOptedOut(h), safeCheck: typeof assertSafePublicUrl = assertSafePublicUrl): Promise<{ ok: true; host: string } | { ok: false; error: string; code: string; status?: number }> {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return { ok: false, code: "missing_target", error: "target is required (hostname or https URL)" };
  let host = s;
  if (/^[a-z]+:\/\//.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, code: "bad_target", error: "only http(s) URLs or bare hostnames" };
      if (u.username || u.password) return { ok: false, code: "bad_target", error: "URLs with credentials are not allowed" };
      host = u.hostname;
    } catch {
      return { ok: false, code: "bad_target", error: "target is not a valid URL or hostname" };
    }
  }
  host = host.replace(/\.$/, "");
  if (!HOSTNAME.test(host)) return { ok: false, code: "bad_target", error: "target must be a public DNS hostname (IP addresses are not checked)" };
  // Opt-out is honored before ANY outbound request, including the DNS lookup below.
  if (optedOut(host)) return { ok: false, code: "target_opted_out", status: 403, error: "The owner of this domain asked not to be checked; no request was sent. Not charged." };
  const safe = await safeCheck(`https://${host}/`);
  if ("ok" in safe && safe.ok === false) return { ok: false, code: "host_blocked", error: safe.error };
  return { ok: true, host };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
const FIX = {
  https: "Serve the site over HTTPS with a valid certificate (e.g. a free ACME certificate).",
  redirect: "Redirect every http:// request to https:// with a 301 or 308.",
  tls_valid: "Install a certificate that chains to a public root and covers this hostname.",
  tls_expiry: "Renew the certificate; automate renewal (ACME) so it renews at 30 days left.",
  tls_proto: "Disable TLS 1.0 and 1.1; offer TLS 1.2 and 1.3 only.",
  hsts: "Send Strict-Transport-Security: max-age=31536000; includeSubDomains (add preload only after checking every subdomain).",
  csp: "Add a Content-Security-Policy (start with Content-Security-Policy-Report-Only and tighten).",
  frame: "Send X-Frame-Options: DENY or CSP frame-ancestors 'none' (or 'self').",
  nosniff: "Send X-Content-Type-Options: nosniff.",
  referrer: "Send Referrer-Policy: strict-origin-when-cross-origin (or stricter).",
  permissions: "Send a Permissions-Policy that turns off features the site does not use (camera=(), microphone=(), geolocation=()).",
  disclosure: "Remove version numbers from Server and X-Powered-By headers.",
  cookies: "Set Secure, HttpOnly and SameSite on cookies.",
  securitytxt: "Publish /.well-known/security.txt with Contact and Expires (RFC 9116).",
  spf: "Publish one SPF TXT record ending in -all (or ~all while testing).",
  dmarc: "Publish _dmarc TXT v=DMARC1 with p=quarantine or p=reject and a rua= report address.",
  dkim: "Enable DKIM signing at the mail provider and publish its selector record.",
  caa: "Publish CAA records naming the certificate authorities allowed to issue for this domain.",
  mixed: "Load every page resource over https://.",
  sri: "Add integrity= (Subresource Integrity) to third-party scripts, or self-host them.",
} as const;

const SNIPPETS = {
  vercel_next: `// next.config.ts\nheaders: async () => [{ source: "/(.*)", headers: [\n  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },\n  { key: "Content-Security-Policy-Report-Only", value: "default-src 'self'; frame-ancestors 'none'" },\n  { key: "X-Frame-Options", value: "DENY" },\n  { key: "X-Content-Type-Options", value: "nosniff" },\n  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },\n] }]`,
  nginx: `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\nadd_header X-Frame-Options "DENY" always;\nadd_header X-Content-Type-Options "nosniff" always;\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;`,
  dns_email: (host: string) => `${host}.  TXT  "v=spf1 include:<your-mail-provider> -all"\n_dmarc.${host}.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@${host}"`,
};

function h(res: GuardedGetOk, name: string): string | null {
  return res.headers.get(name);
}

function headerFindings(res: GuardedGetOk, t: AuditTier): Finding[] {
  const out: Finding[] = [];
  const hsts = h(res, "strict-transport-security");
  const maxAge = Number(/max-age=(\d+)/i.exec(hsts ?? "")?.[1] ?? 0);
  out.push(hsts && maxAge >= 15_552_000 ? { id: "hsts", title: "HSTS", status: "not_detected", severity: null, detail: hsts } : { id: "hsts", title: "HSTS", status: hsts ? "warn" : "fail", severity: "medium", detail: hsts ? `max-age ${maxAge}s is under 180 days` : "No Strict-Transport-Security header", fix: FIX.hsts });
  const csp = h(res, "content-security-policy");
  const cspRo = h(res, "content-security-policy-report-only");
  out.push(csp ? { id: "csp", title: "Content-Security-Policy", status: /unsafe-inline/.test(csp) && /script-src[^;]*unsafe-inline/.test(csp) ? "warn" : "not_detected", severity: "low", detail: csp.slice(0, 300) } : { id: "csp", title: "Content-Security-Policy", status: cspRo ? "warn" : "fail", severity: "medium", detail: cspRo ? "Report-Only policy only (not enforced)" : "No Content-Security-Policy header", fix: FIX.csp });
  const xfo = h(res, "x-frame-options");
  const fa = /frame-ancestors/i.test(csp ?? "");
  out.push(xfo || fa ? { id: "frame", title: "Frame-embedding header", status: "not_detected", severity: null, detail: xfo ? `X-Frame-Options: ${xfo}` : "CSP frame-ancestors" } : { id: "frame", title: "Frame-embedding header", status: "fail", severity: "medium", detail: "No X-Frame-Options or CSP frame-ancestors", fix: FIX.frame });
  const ns = h(res, "x-content-type-options");
  out.push(ns?.toLowerCase() === "nosniff" ? { id: "nosniff", title: "X-Content-Type-Options", status: "not_detected", severity: null, detail: "nosniff" } : { id: "nosniff", title: "X-Content-Type-Options", status: "fail", severity: "low", detail: "Missing nosniff", fix: FIX.nosniff });
  const rp = h(res, "referrer-policy");
  out.push(rp ? { id: "referrer", title: "Referrer-Policy", status: /unsafe-url/i.test(rp) ? "warn" : "not_detected", severity: "low", detail: rp } : { id: "referrer", title: "Referrer-Policy", status: "warn", severity: "low", detail: "No Referrer-Policy (browser default applies)", fix: FIX.referrer });
  if (level(t) >= 1) {
    const pp = h(res, "permissions-policy");
    out.push(pp ? { id: "permissions", title: "Permissions-Policy", status: "not_detected", severity: null, detail: pp.slice(0, 200) } : { id: "permissions", title: "Permissions-Policy", status: "warn", severity: "low", detail: "No Permissions-Policy", fix: FIX.permissions });
    const server = h(res, "server");
    const xpb = h(res, "x-powered-by");
    const versioned = [server, xpb].filter((v): v is string => !!v && /\d+\.\d+/.test(v));
    out.push(versioned.length ? { id: "disclosure", title: "Software version disclosure", status: "warn", severity: "low", detail: `Version strings in headers: ${versioned.join("; ").slice(0, 200)}`, fix: FIX.disclosure } : { id: "disclosure", title: "Software version disclosure", status: "not_detected", severity: null, detail: xpb ? `X-Powered-By: ${xpb}` : "No version numbers in Server / X-Powered-By" });
    const cookies = typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function" ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie() : [];
    if (cookies.length) {
      const weak = cookies.filter((c) => !/;\s*secure/i.test(c) || !/;\s*httponly/i.test(c) || !/;\s*samesite=/i.test(c)).map((c) => c.split("=")[0]!.trim());
      out.push(weak.length ? { id: "cookies", title: "Cookie flags", status: "warn", severity: "medium", detail: `${weak.length}/${cookies.length} cookie(s) missing Secure, HttpOnly or SameSite: ${weak.slice(0, 5).join(", ")}`, fix: FIX.cookies } : { id: "cookies", title: "Cookie flags", status: "not_detected", severity: null, detail: `${cookies.length} cookie(s) with Secure, HttpOnly and SameSite` });
    } else out.push({ id: "cookies", title: "Cookie flags", status: "info", severity: null, detail: "No cookies set on the home page" });
  }
  return out;
}

async function dnsFindings(deps: AuditDeps, host: string): Promise<{ findings: Finding[]; records: Record<string, unknown> }> {
  const safe = async (n: string, t: "A" | "AAAA" | "NS" | "MX" | "CAA" | "TXT") => {
    try {
      return await deps.dns.resolve(n, t);
    } catch {
      return null;
    }
  };
  const flat = (txt: unknown[] | null) => (txt ?? []).map((r) => (Array.isArray(r) ? r.join("") : String(r)));
  const www = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  const [a, aaaa, ns, mx, caa, txt, dmarc, wwwA] = await Promise.all([safe(host, "A"), safe(host, "AAAA"), safe(host, "NS"), safe(host, "MX"), safe(host, "CAA"), safe(host, "TXT"), safe(`_dmarc.${host}`, "TXT"), safe(www, "A")]);
  const out: Finding[] = [];
  const spf = flat(txt).filter((t) => /^v=spf1\b/i.test(t));
  const sendsMail = (mx ?? []).length > 0;
  if (spf.length === 0) out.push({ id: "spf", title: "SPF", status: sendsMail ? "fail" : "warn", severity: sendsMail ? "medium" : "low", detail: sendsMail ? "MX present but no SPF record" : "No SPF record (publish v=spf1 -all if the domain sends no mail)", fix: FIX.spf });
  else if (spf.length > 1) out.push({ id: "spf", title: "SPF", status: "fail", severity: "medium", detail: `${spf.length} SPF records (receivers treat this as an error)`, fix: FIX.spf });
  else out.push({ id: "spf", title: "SPF", status: /\+all\b/.test(spf[0]!) ? "fail" : /[-~]all\b/.test(spf[0]!) ? "not_detected" : "warn", severity: /\+all\b/.test(spf[0]!) ? "high" : null, detail: spf[0]!.slice(0, 200), ...(/[-~]all\b/.test(spf[0]!) ? {} : { fix: FIX.spf }) });
  const dm = flat(dmarc).find((t) => /^v=DMARC1/i.test(t));
  const p = /;\s*p=(\w+)/i.exec(dm ?? "")?.[1]?.toLowerCase();
  out.push(!dm ? { id: "dmarc", title: "DMARC", status: "fail", severity: "medium", detail: "No _dmarc record", fix: FIX.dmarc } : { id: "dmarc", title: "DMARC", status: p === "reject" || p === "quarantine" ? "not_detected" : "warn", severity: p === "none" ? "low" : null, detail: dm.slice(0, 200), ...(p === "reject" || p === "quarantine" ? {} : { fix: FIX.dmarc }) });
  const selectors = ["default", "google", "selector1", "selector2", "k1", "s1", "s2", "mail", "dkim"];
  const found: string[] = [];
  await Promise.all(selectors.map(async (s) => {
    const r = flat(await safe(`${s}._domainkey.${host}`, "TXT"));
    if (r.some((x) => /v=DKIM1|p=/i.test(x))) found.push(s);
  }));
  out.push(found.length ? { id: "dkim", title: "DKIM (common selectors)", status: "not_detected", severity: null, detail: `Selector(s) found: ${found.sort().join(", ")}` } : { id: "dkim", title: "DKIM (common selectors)", status: sendsMail ? "warn" : "info", severity: sendsMail ? "low" : null, detail: `No record at ${selectors.length} common selectors (a custom selector may still exist)`, ...(sendsMail ? { fix: FIX.dkim } : {}) });
  out.push((caa ?? []).length ? { id: "caa", title: "CAA", status: "not_detected", severity: null, detail: `${(caa ?? []).length} CAA record(s)` } : { id: "caa", title: "CAA", status: "warn", severity: "low", detail: "No CAA records", fix: FIX.caa });
  out.push({ id: "www_apex", title: "www / apex", status: (wwwA ?? []).length ? "not_detected" : "info", severity: null, detail: (wwwA ?? []).length ? `${www} resolves` : `${www} does not resolve` });
  return { findings: out, records: { A: a ?? "unavailable", AAAA: aaaa ?? "unavailable", NS: ns ?? "unavailable", MX: mx ?? "unavailable", CAA: caa ?? "unavailable" } };
}

/** Tags by a bounded tokenizer: each "<tag" start scans at most 2,000 chars, attributes parsed inside the tag (Odin C1 HIGH, ReDoS). */
const TAG_RE = /<(script|img|iframe|link|source|audio|video)\b([^>]{0,2000})>/gi;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"'\\s>]{1,2000})["']`, "i");
const SRC_ATTR = ATTR("src");
const HREF_ATTR = ATTR("href");
const MAX_TAGS = 3_000;
const BUCKET_RE = /\b([a-z0-9][a-z0-9.-]{0,252}\.(?:s3[.-][a-z0-9.-]{0,60}amazonaws\.com|s3\.amazonaws\.com|storage\.googleapis\.com|blob\.core\.windows\.net|digitaloceanspaces\.com|r2\.dev))\b/gi;

export function htmlHints(body: string, host: string): Finding[] {
  const out: Finding[] = [];
  const mixed: string[] = [];
  const third: { host: string; sri: boolean }[] = [];
  let n = 0;
  for (const m of body.matchAll(TAG_RE)) {
    if (++n > MAX_TAGS) break;
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? "";
    const url = SRC_ATTR.exec(attrs)?.[1] ?? HREF_ATTR.exec(attrs)?.[1] ?? "";
    const u = /^(https?):\/\/([^/?#:]{1,253})/i.exec(url);
    if (!u) continue;
    if (u[1]!.toLowerCase() === "http") mixed.push(u[2]!.toLowerCase());
    else if (tag === "script" && SRC_ATTR.test(attrs)) {
      const h2 = u[2]!.toLowerCase();
      if (!h2.endsWith(host)) third.push({ host: h2, sri: /\bintegrity\s*=/i.test(attrs) });
    }
  }
  out.push(mixed.length ? { id: "mixed_content", title: "Mixed content", status: "warn", severity: "medium", detail: `${mixed.length} http:// resource(s) from: ${[...new Set(mixed)].slice(0, 5).join(", ")}`, fix: FIX.mixed } : { id: "mixed_content", title: "Mixed content", status: "not_detected", severity: null, detail: "No http:// resources on the home page" });
  const buckets: string[] = [];
  for (const m of body.matchAll(BUCKET_RE)) {
    if (buckets.length >= 50) break;
    buckets.push(m[1]!.toLowerCase());
  }
  const ub = [...new Set(buckets)];
  out.push({ id: "bucket_hints", title: "Cloud storage references", status: ub.length ? "info" : "not_detected", severity: null, detail: ub.length ? `Page references storage host(s): ${ub.slice(0, 5).join(", ")} (hint only; buckets were not listed or probed)` : "No cloud storage hosts referenced" });
  const noSri = third.filter((t) => !t.sri);
  out.push(noSri.length ? { id: "sri", title: "Third-party scripts without SRI", status: "warn", severity: "low", detail: `${noSri.length} script(s) from: ${[...new Set(noSri.map((t) => t.host))].slice(0, 5).join(", ")}`, fix: FIX.sri } : { id: "sri", title: "Third-party scripts without SRI", status: third.length ? "not_detected" : "info", severity: null, detail: third.length ? "All third-party scripts carry integrity=" : "No third-party scripts on the home page" });
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/** Flag-ON method text (unchanged). Use auditMethod() for what is served. */
export const METHOD =
  "Web readiness checks of the one submitted host, outside-in: a GET of https://host/ and http://host/ (no redirect follow on http), a GET of /.well-known/security.txt (standard and up), one TLS handshake to port 443, public DNS lookups (A, AAAA, NS, MX, CAA, TXT, _dmarc, 9 common DKIM selectors; extended and up), and certificate-transparency history from crt.sh (history and deep). " + REDIRECT_COPY + " Status not_detected = this specific check found no issue; it does not mean the site is secure.";
/** Flag-OFF method text: same, without the certificate-history clause (HP_AUDIT_HIGH_TIERS_ENABLED off). */
export const METHOD_BASE =
  "Web readiness checks of the one submitted host, outside-in: a GET of https://host/ and http://host/ (no redirect follow on http), a GET of /.well-known/security.txt (standard and up), one TLS handshake to port 443, and public DNS lookups (A, AAAA, NS, MX, CAA, TXT, _dmarc, 9 common DKIM selectors; extended and up). " + REDIRECT_COPY + " Status not_detected = this specific check found no issue; it does not mean the site is secure.";
export function auditMethod(env: Record<string, string | undefined> = process.env): string {
  return env.HP_AUDIT_HIGH_TIERS_ENABLED === "true" ? METHOD : METHOD_BASE;
}
const DISCLAIMER_MD = "Automated, point-in-time web readiness checks; informational only, not a security audit, penetration test or certification. See the disclaimer field.";

export type AuditResult = { ok: true; report: Record<string, unknown> } | { ok: false; status: number; code: string; error: string };

export async function runAudit(host: string, tier: AuditTier, deps: AuditDeps = defaultAuditDeps(), optedOut: (host: string) => boolean = (h) => isOptedOut(h)): Promise<AuditResult> {
  const started = deps.now();
  const deadline = started + AUDIT_BUDGET_MS;
  const L = level(tier);
  const findings: Finding[] = [];

  const timedOut = (id: string, title: string): Finding => ({ id, title, status: "unavailable", severity: null, detail: `Not completed within the ${AUDIT_BUDGET_MS / 1000}s time budget` });
  const w = <T,>(p: Promise<T>) => within(p, deadline, deps.now);

  // Every independent stage starts at once (Odin C2); each also keeps its own request timeout.
  const homeP = w(deps.get(`https://${host}/`, { maxBytes: L >= 4 ? 300_000 : 64_000, timeoutMs: 8_000, maxRedirects: 5, optedOut }));
  const plainP = w(deps.get(`http://${host}/`, { followRedirects: false, maxBytes: 1024, timeoutMs: 6_000, optedOut }));
  const tlsP = w(deps.tls(host));
  const stP = L >= 1 ? w(deps.get(`https://${host}/.well-known/security.txt`, { maxBytes: 4096, timeoutMs: 5_000, maxRedirects: 2, optedOut })) : null;
  const dnsP = L >= 2 ? w(dnsFindings(deps, host)) : null;
  const ctP = L >= 5 ? w(deps.ct(host)) : null;
  const [home0, plain0, tls0, st0, dns0, ct0] = await Promise.all([homeP, plainP, tlsP, stP, dnsP, ctP]);
  const home = home0 === TIMED_OUT ? ({ ok: false, code: "timeout", error: "time budget" } as const) : home0;
  const plain = plain0 === TIMED_OUT ? ({ ok: false, code: "timeout", error: "time budget" } as const) : plain0;
  // Opt-out re-checked on every redirect hop (guardedGet): a hop into an opted-out host was never requested; refuse the whole check, not charged.
  const optedHop = [home0, st0].find((x): x is { ok: false; code: "opted_out"; error: string } => typeof x === "object" && x !== null && !x.ok && x.code === "opted_out");
  if (optedHop) return { ok: false, status: 403, code: "redirect_target_opted_out", error: `${optedHop.error} Check stopped; not charged.` };

  // HTTPS home page (required: nothing to check if the host answers neither https nor http).
  if (!home.ok && !plain.ok) return { ok: false, status: 502, code: "target_unreachable", error: `Host did not answer over https (${home.code}) or http (${plain.code}); not charged.` };
  findings.push(home.ok ? { id: "https", title: "HTTPS", status: "not_detected", severity: null, detail: `HTTP ${home.status} at ${home.finalUrl}` } : { id: "https", title: "HTTPS", status: "fail", severity: "high", detail: `https:// did not answer (${home.code})`, fix: FIX.https });
  if (plain.ok) {
    const loc = plain.headers.get("location") ?? "";
    findings.push(plain.status >= 300 && plain.status < 400 && loc.startsWith("https://") ? { id: "http_redirect", title: "HTTP to HTTPS redirect", status: "not_detected", severity: null, detail: `${plain.status} -> ${loc.slice(0, 120)}` } : { id: "http_redirect", title: "HTTP to HTTPS redirect", status: "fail", severity: "medium", detail: `http:// answered ${plain.status} without redirecting to https`, fix: FIX.redirect });
  } else findings.push({ id: "http_redirect", title: "HTTP to HTTPS redirect", status: "info", severity: null, detail: `http:// not reachable (${plain.code})` });

  if (tls0 === TIMED_OUT) findings.push(timedOut("tls_valid", "TLS certificate"));
  else if (tls0.ok) {
    const tls = tls0;
    findings.push(tls.authorized ? { id: "tls_valid", title: "TLS certificate", status: "not_detected", severity: null, detail: `Issuer ${tls.issuer}; valid to ${tls.validTo}` } : { id: "tls_valid", title: "TLS certificate", status: "fail", severity: "high", detail: `Certificate not trusted: ${tls.authorizationError}`, fix: FIX.tls_valid });
    findings.push(tls.daysLeft > 30 ? { id: "tls_expiry", title: "Certificate expiry", status: "not_detected", severity: null, detail: `${tls.daysLeft} days left` } : { id: "tls_expiry", title: "Certificate expiry", status: tls.daysLeft > 7 ? "warn" : "fail", severity: tls.daysLeft > 7 ? "medium" : "high", detail: `${tls.daysLeft} days left (${tls.validTo})`, fix: FIX.tls_expiry });
    if (L >= 1) findings.push(tls.protocol === "TLSv1" || tls.protocol === "TLSv1.1" ? { id: "tls_protocol", title: "Negotiated TLS version", status: "fail", severity: "medium", detail: tls.protocol, fix: FIX.tls_proto } : { id: "tls_protocol", title: "Negotiated TLS version", status: "not_detected", severity: null, detail: tls.protocol ?? "unknown" });
  } else findings.push({ id: "tls_valid", title: "TLS certificate", status: home.ok ? "unavailable" : "fail", severity: home.ok ? null : "high", detail: `TLS handshake failed: ${tls0.error}`, ...(home.ok ? {} : { fix: FIX.https }) });

  if (home.ok) findings.push(...headerFindings(home, tier));

  if (st0 === TIMED_OUT) findings.push(timedOut("security_txt", "security.txt"));
  else if (st0) {
    const st = st0;
    const has = st.ok && st.status === 200 && /^contact:/im.test(st.body);
    const missing = !st.ok ? `Not found at this path (${st.code})` : st.status === 200 ? "Present at this path without a Contact line" : `Not found at this path (HTTP ${st.status})`;
    findings.push(has ? { id: "security_txt", title: "security.txt", status: /^expires:/im.test((st as GuardedGetOk).body) ? "not_detected" : "warn", severity: null, detail: "Present at /.well-known/security.txt with a Contact line" } : { id: "security_txt", title: "security.txt", status: "warn", severity: "low", detail: missing, fix: FIX.securitytxt });
  }

  let dnsRecords: Record<string, unknown> | undefined;
  if (dns0 === TIMED_OUT) findings.push(timedOut("dns", "DNS records"));
  else if (dns0) {
    findings.push(...dns0.findings);
    dnsRecords = dns0.records;
  }

  if (L >= 4 && home.ok) findings.push(...htmlHints(home.body, host));

  // Certificate-transparency history (history/deep). Core value of those tiers: if unavailable, not charged.
  let ctSummary: Record<string, unknown> | undefined;
  if (ct0 === TIMED_OUT) return { ok: false, status: 503, code: "ct_source_unavailable", error: `crt.sh did not answer within the time budget; the ${tier} tier needs certificate-transparency history, not charged. Retry later.` };
  if (ct0) {
    const ct = ct0;
    if (!ct.ok) return { ok: false, status: 503, code: "ct_source_unavailable", error: `${ct.error}; the ${tier} tier needs certificate-transparency history, not charged. Retry later.` };
    const yearAgo = deps.now() - 365 * 86_400_000;
    const recent = ct.entries.filter((e) => Date.parse(e.notBefore) >= yearAgo);
    const ctNames = [...new Set(recent.flatMap((e) => e.name.split("\n")).map((n) => n.trim().toLowerCase()).filter((n) => n && !n.startsWith("*.") && (n === host || n.endsWith(`.${host}`))))].sort();
    const issuers: Record<string, number> = {};
    for (const e of recent) {
      const o = /O=([^,]{1,100})/.exec(e.issuer)?.[1]?.trim() ?? e.issuer.slice(0, 60);
      issuers[o] = (issuers[o] ?? 0) + 1;
    }
    ctSummary = { source: "crt.sh (public certificate-transparency logs)", attribution: CRTSH_ATTRIBUTION, windowDays: 365, certificates: recent.length, issuers, distinctNames: ctNames.length, names: ctNames.slice(0, 50) };
  }

  // Fix lines are part of report+ tiers only.
  const withFix = L >= 3;
  const shaped = findings.map((f) => (withFix ? f : { ...f, fix: undefined }));
  const counts = { not_detected: 0, warn: 0, fail: 0, info: 0, unavailable: 0 } as Record<Status, number>;
  for (const f of shaped) counts[f.status]++;

  const report: Record<string, unknown> = {
    target: host,
    tier,
    checksRun: shaped.length,
    summary: counts,
    findings: shaped.map(({ fix, ...rest }) => (fix ? { ...rest, fix } : rest)),
    ...(dnsRecords ? { dns: dnsRecords } : {}),
    ...(ctSummary ? { certificateHistory: ctSummary } : {}),
    method: auditMethod(),
    note: "Informational results at the time of the check, not a certification or a guarantee of anything. Outside-in checks cannot see server-side issues.",
    elapsedMs: deps.now() - started,
  };
  if (withFix) report.markdown = toMarkdown(host, tier, shaped, counts);
  if (L >= 6) {
    const sevRank = { high: 0, medium: 1, low: 2 } as const;
    const todo = shaped.filter((f) => (f.status === "fail" || f.status === "warn") && f.fix).sort((a, b) => (sevRank[a.severity ?? "low"] - sevRank[b.severity ?? "low"]) || (a.status === "fail" ? -1 : 1));
    report.suggestedFixes = { title: "Suggested fixes for the findings above", items: todo.map((f, i) => ({ order: i + 1, id: f.id, severity: f.severity, fix: f.fix })) };
    report.snippets = { nextjsVercelHeaders: SNIPPETS.vercel_next, nginx: SNIPPETS.nginx, dnsEmail: SNIPPETS.dns_email(host) };
  }
  return { ok: true, report };
}

function toMarkdown(host: string, tier: string, f: Finding[], c: Record<Status, number>): string {
  const lines = [`# Web readiness checks: ${host} (${tier})`, "", `not detected ${c.not_detected} / warn ${c.warn} / fail ${c.fail} / info ${c.info} / unavailable ${c.unavailable}`, "", "| Check | Result | Detail | Fix |", "|---|---|---|---|"];
  for (const x of f) lines.push(`| ${x.title} | ${x.status} | ${x.detail.replace(/\|/g, "/").slice(0, 160)} | ${(x.fix ?? "").replace(/\|/g, "/")} |`);
  lines.push("", `_${DISCLAIMER_MD}_`);
  return lines.join("\n");
}
