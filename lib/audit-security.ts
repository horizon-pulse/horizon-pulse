/**
 * Security & readiness audit (dark route /api/audit/security).
 * PASSIVE, outside-in only: ordinary GETs of public URLs (through the SSRF
 * guard), one TLS handshake per host, public DNS lookups, and public
 * certificate-transparency data (crt.sh). Never exploits, never sends
 * credentials, never tries auth bypass, never reads or returns file contents
 * (an exposed /.env or /.git is reported as a yes/no + status + size only).
 * Results are informational, not a certification.
 */
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from "node:tls";
import { Resolver } from "node:dns/promises";
import { guardedGet, type GuardedGetOk } from "./guarded-get";
import { guardedNetConnect } from "./net-guard";
import { assertSafePublicUrl } from "./fetch-url";

export const AUDIT_TIER_ORDER = ["quick", "standard", "extended", "report", "full", "history", "deep"] as const;
export type AuditTier = (typeof AUDIT_TIER_ORDER)[number];
const level = (t: AuditTier) => AUDIT_TIER_ORDER.indexOf(t);
export const HOST_CAP: Record<AuditTier, number> = { quick: 0, standard: 0, extended: 0, report: 0, full: 10, history: 20, deep: 30 };
export const AUDIT_BUDGET_MS = 45_000;

export type Status = "pass" | "warn" | "fail" | "info" | "unavailable";
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

async function crtSh(host: string): Promise<{ ok: true; entries: { name: string; issuer: string; notBefore: string; notAfter: string }[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(`%.${host}`)}&output=json&exclude=expired`, { headers: { "user-agent": "HorizonPulse/1.0 (+https://horizonpulse.dev)" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, error: `crt.sh answered ${res.status}` };
    const text = await res.text();
    if (text.length > 5_000_000) return { ok: false, error: "crt.sh result too large" };
    const rows = JSON.parse(text) as { name_value?: string; issuer_name?: string; not_before?: string; not_after?: string }[];
    return { ok: true, entries: rows.slice(0, 5000).map((r) => ({ name: String(r.name_value ?? ""), issuer: String(r.issuer_name ?? ""), notBefore: String(r.not_before ?? ""), notAfter: String(r.not_after ?? "") })) };
  } catch (e) {
    return { ok: false, error: `crt.sh: ${e instanceof Error ? e.message : "unreachable"}` };
  }
}

export const defaultAuditDeps = (): AuditDeps => ({ get: guardedGet, tls: (h) => tlsInspect(h), dns: defaultDns(), ct: crtSh, now: () => Date.now() });

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export async function parseTarget(raw: string | null): Promise<{ ok: true; host: string } | { ok: false; error: string; code: string }> {
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
  if (!HOSTNAME.test(host)) return { ok: false, code: "bad_target", error: "target must be a public DNS hostname (IP addresses are not audited)" };
  const safe = await assertSafePublicUrl(`https://${host}/`);
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
  cors: "Do not reflect arbitrary Origin values; never combine a reflected or wildcard origin with Access-Control-Allow-Credentials: true.",
  env: "Block public access to /.env (deny dotfiles at the web server or CDN) and rotate every secret it contained.",
  git: "Block public access to /.git/ and remove the directory from the web root; review the repository history for secrets.",
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
  nginx: `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\nadd_header X-Frame-Options "DENY" always;\nadd_header X-Content-Type-Options "nosniff" always;\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;\nlocation ~ /\\.(env|git) { deny all; }`,
  dns_email: (host: string) => `${host}.  TXT  "v=spf1 include:<your-mail-provider> -all"\n_dmarc.${host}.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@${host}"`,
};

function h(res: GuardedGetOk, name: string): string | null {
  return res.headers.get(name);
}

function headerFindings(res: GuardedGetOk, t: AuditTier): Finding[] {
  const out: Finding[] = [];
  const hsts = h(res, "strict-transport-security");
  const maxAge = Number(/max-age=(\d+)/i.exec(hsts ?? "")?.[1] ?? 0);
  out.push(hsts && maxAge >= 15_552_000 ? { id: "hsts", title: "HSTS", status: "pass", severity: null, detail: hsts } : { id: "hsts", title: "HSTS", status: hsts ? "warn" : "fail", severity: "medium", detail: hsts ? `max-age ${maxAge}s is under 180 days` : "No Strict-Transport-Security header", fix: FIX.hsts });
  const csp = h(res, "content-security-policy");
  const cspRo = h(res, "content-security-policy-report-only");
  out.push(csp ? { id: "csp", title: "Content-Security-Policy", status: /unsafe-inline/.test(csp) && /script-src[^;]*unsafe-inline/.test(csp) ? "warn" : "pass", severity: "low", detail: csp.slice(0, 300) } : { id: "csp", title: "Content-Security-Policy", status: cspRo ? "warn" : "fail", severity: "medium", detail: cspRo ? "Report-Only policy only (not enforced)" : "No Content-Security-Policy header", fix: FIX.csp });
  const xfo = h(res, "x-frame-options");
  const fa = /frame-ancestors/i.test(csp ?? "");
  out.push(xfo || fa ? { id: "frame", title: "Clickjacking protection", status: "pass", severity: null, detail: xfo ? `X-Frame-Options: ${xfo}` : "CSP frame-ancestors" } : { id: "frame", title: "Clickjacking protection", status: "fail", severity: "medium", detail: "No X-Frame-Options or CSP frame-ancestors", fix: FIX.frame });
  const ns = h(res, "x-content-type-options");
  out.push(ns?.toLowerCase() === "nosniff" ? { id: "nosniff", title: "X-Content-Type-Options", status: "pass", severity: null, detail: "nosniff" } : { id: "nosniff", title: "X-Content-Type-Options", status: "fail", severity: "low", detail: "Missing nosniff", fix: FIX.nosniff });
  const rp = h(res, "referrer-policy");
  out.push(rp ? { id: "referrer", title: "Referrer-Policy", status: /unsafe-url/i.test(rp) ? "warn" : "pass", severity: "low", detail: rp } : { id: "referrer", title: "Referrer-Policy", status: "warn", severity: "low", detail: "No Referrer-Policy (browser default applies)", fix: FIX.referrer });
  if (level(t) >= 1) {
    const pp = h(res, "permissions-policy");
    out.push(pp ? { id: "permissions", title: "Permissions-Policy", status: "pass", severity: null, detail: pp.slice(0, 200) } : { id: "permissions", title: "Permissions-Policy", status: "warn", severity: "low", detail: "No Permissions-Policy", fix: FIX.permissions });
    const server = h(res, "server");
    const xpb = h(res, "x-powered-by");
    const versioned = [server, xpb].filter((v): v is string => !!v && /\d+\.\d+/.test(v));
    out.push(versioned.length ? { id: "disclosure", title: "Software version disclosure", status: "warn", severity: "low", detail: `Version strings in headers: ${versioned.join("; ").slice(0, 200)}`, fix: FIX.disclosure } : { id: "disclosure", title: "Software version disclosure", status: "pass", severity: null, detail: xpb ? `X-Powered-By: ${xpb}` : "No version numbers in Server / X-Powered-By" });
    const cookies = typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function" ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie() : [];
    if (cookies.length) {
      const weak = cookies.filter((c) => !/;\s*secure/i.test(c) || !/;\s*httponly/i.test(c) || !/;\s*samesite=/i.test(c)).map((c) => c.split("=")[0]!.trim());
      out.push(weak.length ? { id: "cookies", title: "Cookie flags", status: "warn", severity: "medium", detail: `${weak.length}/${cookies.length} cookie(s) missing Secure, HttpOnly or SameSite: ${weak.slice(0, 5).join(", ")}`, fix: FIX.cookies } : { id: "cookies", title: "Cookie flags", status: "pass", severity: null, detail: `${cookies.length} cookie(s) with Secure, HttpOnly and SameSite` });
    } else out.push({ id: "cookies", title: "Cookie flags", status: "info", severity: null, detail: "No cookies set on the home page" });
  }
  return out;
}

async function exposure(deps: AuditDeps, host: string): Promise<Finding[]> {
  const probe = async (path: string, sig: RegExp) => {
    const r = await deps.get(`https://${host}${path}`, { followRedirects: false, maxBytes: 2048, timeoutMs: 5_000 });
    if (!r.ok) return { exposed: false, note: `not reachable (${r.code})` };
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    const exposed = r.status === 200 && !ct.includes("text/html") && sig.test(r.body);
    return { exposed, note: `HTTP ${r.status}, ${r.bytes} bytes${exposed ? "" : ""}` };
  };
  const env = await probe("/.env", /^[A-Z][A-Z0-9_]{2,}=.*$/m);
  const gitHead = await probe("/.git/HEAD", /^ref: refs\//m);
  const gitCfg = gitHead.exposed ? gitHead : await probe("/.git/config", /^\[core\]/m);
  return [
    env.exposed ? { id: "exposed_env", title: "Exposed /.env", status: "fail", severity: "high", detail: `/.env is publicly readable (${env.note}); contents not read or returned`, fix: FIX.env } : { id: "exposed_env", title: "Exposed /.env", status: "pass", severity: null, detail: `Not exposed (${env.note})` },
    gitCfg.exposed ? { id: "exposed_git", title: "Exposed /.git", status: "fail", severity: "high", detail: `/.git metadata is publicly readable (${gitCfg.note}); contents not read or returned`, fix: FIX.git } : { id: "exposed_git", title: "Exposed /.git", status: "pass", severity: null, detail: `Not exposed (${gitCfg.note})` },
  ];
}

async function cors(deps: AuditDeps, host: string): Promise<Finding> {
  const origin = "https://hp-cors-probe.invalid";
  const r = await deps.get(`https://${host}/`, { headers: { Origin: origin }, maxBytes: 1024, timeoutMs: 5_000 });
  if (!r.ok) return { id: "cors", title: "CORS", status: "unavailable", severity: null, detail: `probe failed (${r.code})` };
  const acao = r.headers.get("access-control-allow-origin");
  const acac = (r.headers.get("access-control-allow-credentials") ?? "").toLowerCase() === "true";
  if (acao === origin && acac) return { id: "cors", title: "CORS", status: "fail", severity: "high", detail: "Arbitrary Origin reflected WITH Access-Control-Allow-Credentials: true", fix: FIX.cors };
  if (acao === origin) return { id: "cors", title: "CORS", status: "warn", severity: "medium", detail: "Arbitrary Origin reflected (no credentials)", fix: FIX.cors };
  if (acao === "*" && acac) return { id: "cors", title: "CORS", status: "warn", severity: "medium", detail: "Wildcard origin with credentials header (browsers refuse this combination)", fix: FIX.cors };
  return { id: "cors", title: "CORS", status: acao === "*" ? "info" : "pass", severity: null, detail: acao ? `Access-Control-Allow-Origin: ${acao}` : "No CORS headers for a foreign origin" };
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
  const [a, aaaa, ns, mx, caa, txt, dmarc] = await Promise.all([safe(host, "A"), safe(host, "AAAA"), safe(host, "NS"), safe(host, "MX"), safe(host, "CAA"), safe(host, "TXT"), safe(`_dmarc.${host}`, "TXT")]);
  const out: Finding[] = [];
  const spf = flat(txt).filter((t) => /^v=spf1\b/i.test(t));
  const sendsMail = (mx ?? []).length > 0;
  if (spf.length === 0) out.push({ id: "spf", title: "SPF", status: sendsMail ? "fail" : "warn", severity: sendsMail ? "medium" : "low", detail: sendsMail ? "MX present but no SPF record" : "No SPF record (publish v=spf1 -all if the domain sends no mail)", fix: FIX.spf });
  else if (spf.length > 1) out.push({ id: "spf", title: "SPF", status: "fail", severity: "medium", detail: `${spf.length} SPF records (receivers treat this as an error)`, fix: FIX.spf });
  else out.push({ id: "spf", title: "SPF", status: /\+all\b/.test(spf[0]!) ? "fail" : /[-~]all\b/.test(spf[0]!) ? "pass" : "warn", severity: /\+all\b/.test(spf[0]!) ? "high" : null, detail: spf[0]!.slice(0, 200), ...(/[-~]all\b/.test(spf[0]!) ? {} : { fix: FIX.spf }) });
  const dm = flat(dmarc).find((t) => /^v=DMARC1/i.test(t));
  const p = /;\s*p=(\w+)/i.exec(dm ?? "")?.[1]?.toLowerCase();
  out.push(!dm ? { id: "dmarc", title: "DMARC", status: "fail", severity: "medium", detail: "No _dmarc record", fix: FIX.dmarc } : { id: "dmarc", title: "DMARC", status: p === "reject" || p === "quarantine" ? "pass" : "warn", severity: p === "none" ? "low" : null, detail: dm.slice(0, 200), ...(p === "reject" || p === "quarantine" ? {} : { fix: FIX.dmarc }) });
  const selectors = ["default", "google", "selector1", "selector2", "k1", "s1", "s2", "mail", "dkim"];
  const found: string[] = [];
  await Promise.all(selectors.map(async (s) => {
    const r = flat(await safe(`${s}._domainkey.${host}`, "TXT"));
    if (r.some((x) => /v=DKIM1|p=/i.test(x))) found.push(s);
  }));
  out.push(found.length ? { id: "dkim", title: "DKIM (common selectors)", status: "pass", severity: null, detail: `Selector(s) found: ${found.sort().join(", ")}` } : { id: "dkim", title: "DKIM (common selectors)", status: sendsMail ? "warn" : "info", severity: sendsMail ? "low" : null, detail: `No record at ${selectors.length} common selectors (a custom selector may still exist)`, ...(sendsMail ? { fix: FIX.dkim } : {}) });
  out.push((caa ?? []).length ? { id: "caa", title: "CAA", status: "pass", severity: null, detail: `${(caa ?? []).length} CAA record(s)` } : { id: "caa", title: "CAA", status: "warn", severity: "low", detail: "No CAA records", fix: FIX.caa });
  const www = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  const wwwA = await safe(www, "A");
  out.push({ id: "www_apex", title: "www / apex", status: (wwwA ?? []).length ? "pass" : "info", severity: null, detail: (wwwA ?? []).length ? `${www} resolves` : `${www} does not resolve` });
  return { findings: out, records: { A: a ?? "unavailable", AAAA: aaaa ?? "unavailable", NS: ns ?? "unavailable", MX: mx ?? "unavailable", CAA: caa ?? "unavailable" } };
}

function htmlHints(body: string, host: string): Finding[] {
  const out: Finding[] = [];
  const mixed = [...body.matchAll(/<(?:script|img|iframe|link|source|audio|video)\b[^>]*\b(?:src|href)\s*=\s*["']http:\/\/([^"'/]+)/gi)].map((m) => m[1]!);
  out.push(mixed.length ? { id: "mixed_content", title: "Mixed content", status: "warn", severity: "medium", detail: `${mixed.length} http:// resource(s) from: ${[...new Set(mixed)].slice(0, 5).join(", ")}`, fix: FIX.mixed } : { id: "mixed_content", title: "Mixed content", status: "pass", severity: null, detail: "No http:// resources on the home page" });
  const buckets = [...new Set([...body.matchAll(/([a-z0-9.-]+\.(?:s3[.-][a-z0-9.-]*amazonaws\.com|s3\.amazonaws\.com|storage\.googleapis\.com|blob\.core\.windows\.net|digitaloceanspaces\.com|r2\.dev))/gi)].map((m) => m[1]!.toLowerCase()))];
  out.push({ id: "bucket_hints", title: "Cloud storage references", status: buckets.length ? "info" : "pass", severity: null, detail: buckets.length ? `Page references storage host(s): ${buckets.slice(0, 5).join(", ")} (hint only; buckets were not listed or probed)` : "No cloud storage hosts referenced" });
  const third = [...body.matchAll(/<script\b([^>]*)\bsrc\s*=\s*["']https:\/\/([^"'/]+)[^"']*["']([^>]*)>/gi)].filter((m) => !m[2]!.toLowerCase().endsWith(host)).map((m) => ({ host: m[2]!.toLowerCase(), sri: /\bintegrity\s*=/.test(`${m[1]} ${m[3]}`) }));
  const noSri = third.filter((t) => !t.sri);
  out.push(noSri.length ? { id: "sri", title: "Third-party scripts without SRI", status: "warn", severity: "low", detail: `${noSri.length} script(s) from: ${[...new Set(noSri.map((t) => t.host))].slice(0, 5).join(", ")}`, fix: FIX.sri } : { id: "sri", title: "Third-party scripts without SRI", status: third.length ? "pass" : "info", severity: null, detail: third.length ? "All third-party scripts carry integrity=" : "No third-party scripts on the home page" });
  return out;
}

type HostCheck = { host: string; https: number | null; tlsDaysLeft: number | null; tlsValid: boolean | null; hsts: boolean | null; error?: string };
async function quickHost(deps: AuditDeps, host: string): Promise<HostCheck> {
  const safe = await assertSafePublicUrl(`https://${host}/`);
  if ("ok" in safe && safe.ok === false) return { host, https: null, tlsDaysLeft: null, tlsValid: null, hsts: null, error: "blocked or unresolvable" };
  const [tls, res] = await Promise.all([deps.tls(host), deps.get(`https://${host}/`, { maxBytes: 1024, timeoutMs: 5_000, maxRedirects: 2 })]);
  return { host, https: res.ok ? res.status : null, tlsDaysLeft: tls.ok ? tls.daysLeft : null, tlsValid: tls.ok ? tls.authorized : null, hsts: res.ok ? !!res.headers.get("strict-transport-security") : null, ...(res.ok || tls.ok ? {} : { error: res.ok ? undefined : res.code }) };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>, deadline: number, now: () => number): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && now() < deadline) {
      const it = items[i++]!;
      out.push(await fn(it));
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export type AuditResult = { ok: true; report: Record<string, unknown> } | { ok: false; status: number; code: string; error: string };

export async function runAudit(host: string, tier: AuditTier, deps: AuditDeps = defaultAuditDeps()): Promise<AuditResult> {
  const started = deps.now();
  const deadline = started + AUDIT_BUDGET_MS;
  const L = level(tier);
  const findings: Finding[] = [];

  // HTTPS home page (required: nothing to audit if the host answers neither https nor http).
  const home = await deps.get(`https://${host}/`, { maxBytes: L >= 4 ? 300_000 : 64_000, timeoutMs: 8_000, maxRedirects: 5 });
  const plain = await deps.get(`http://${host}/`, { followRedirects: false, maxBytes: 1024, timeoutMs: 6_000 });
  if (!home.ok && !plain.ok) return { ok: false, status: 502, code: "target_unreachable", error: `Host did not answer over https (${home.code}) or http (${plain.code}); not charged.` };
  findings.push(home.ok ? { id: "https", title: "HTTPS", status: "pass", severity: null, detail: `HTTP ${home.status} at ${home.finalUrl}` } : { id: "https", title: "HTTPS", status: "fail", severity: "high", detail: `https:// did not answer (${home.code})`, fix: FIX.https });
  if (plain.ok) {
    const loc = plain.headers.get("location") ?? "";
    findings.push(plain.status >= 300 && plain.status < 400 && loc.startsWith("https://") ? { id: "http_redirect", title: "HTTP to HTTPS redirect", status: "pass", severity: null, detail: `${plain.status} -> ${loc.slice(0, 120)}` } : { id: "http_redirect", title: "HTTP to HTTPS redirect", status: "fail", severity: "medium", detail: `http:// answered ${plain.status} without redirecting to https`, fix: FIX.redirect });
  } else findings.push({ id: "http_redirect", title: "HTTP to HTTPS redirect", status: "info", severity: null, detail: `http:// not reachable (${plain.code})` });

  const tls = await deps.tls(host);
  if (tls.ok) {
    findings.push(tls.authorized ? { id: "tls_valid", title: "TLS certificate", status: "pass", severity: null, detail: `Issuer ${tls.issuer}; valid to ${tls.validTo}` } : { id: "tls_valid", title: "TLS certificate", status: "fail", severity: "high", detail: `Certificate not trusted: ${tls.authorizationError}`, fix: FIX.tls_valid });
    findings.push(tls.daysLeft > 30 ? { id: "tls_expiry", title: "Certificate expiry", status: "pass", severity: null, detail: `${tls.daysLeft} days left` } : { id: "tls_expiry", title: "Certificate expiry", status: tls.daysLeft > 7 ? "warn" : "fail", severity: tls.daysLeft > 7 ? "medium" : "high", detail: `${tls.daysLeft} days left (${tls.validTo})`, fix: FIX.tls_expiry });
    if (L >= 1) findings.push(tls.protocol === "TLSv1" || tls.protocol === "TLSv1.1" ? { id: "tls_protocol", title: "Negotiated TLS version", status: "fail", severity: "medium", detail: tls.protocol, fix: FIX.tls_proto } : { id: "tls_protocol", title: "Negotiated TLS version", status: "pass", severity: null, detail: tls.protocol ?? "unknown" });
  } else findings.push({ id: "tls_valid", title: "TLS certificate", status: home.ok ? "unavailable" : "fail", severity: home.ok ? null : "high", detail: `TLS handshake failed: ${tls.error}`, ...(home.ok ? {} : { fix: FIX.https }) });

  if (home.ok) findings.push(...headerFindings(home, tier));

  if (L >= 1) {
    findings.push(await cors(deps, host));
    findings.push(...(await exposure(deps, host)));
    const st = await deps.get(`https://${host}/.well-known/security.txt`, { maxBytes: 4096, timeoutMs: 5_000, maxRedirects: 2 });
    const has = st.ok && st.status === 200 && /^contact:/im.test(st.body);
    findings.push(has ? { id: "security_txt", title: "security.txt", status: /^expires:/im.test((st as GuardedGetOk).body) ? "pass" : "warn", severity: null, detail: "Present with Contact" } : { id: "security_txt", title: "security.txt", status: "warn", severity: "low", detail: "No /.well-known/security.txt with a Contact line", fix: FIX.securitytxt });
  }

  let dnsRecords: Record<string, unknown> | undefined;
  if (L >= 2) {
    const d = await dnsFindings(deps, host);
    findings.push(...d.findings);
    dnsRecords = d.records;
  }

  if (L >= 4 && home.ok) findings.push(...htmlHints(home.body, host));

  // Certificate-transparency history (history/deep). Core value of those tiers: if unavailable, not charged.
  let ctSummary: Record<string, unknown> | undefined;
  let ctNames: string[] = [];
  if (L >= 5) {
    const ct = await deps.ct(host);
    if (!ct.ok) return { ok: false, status: 503, code: "ct_source_unavailable", error: `${ct.error}; the ${tier} tier needs certificate-transparency history, not charged. Retry later.` };
    const yearAgo = deps.now() - 365 * 86_400_000;
    const recent = ct.entries.filter((e) => Date.parse(e.notBefore) >= yearAgo);
    ctNames = [...new Set(recent.flatMap((e) => e.name.split("\n")).map((n) => n.trim().toLowerCase()).filter((n) => n && !n.startsWith("*.") && (n === host || n.endsWith(`.${host}`))))].sort();
    const issuers: Record<string, number> = {};
    for (const e of recent) {
      const o = /O=([^,]+)/.exec(e.issuer)?.[1]?.trim() ?? e.issuer.slice(0, 60);
      issuers[o] = (issuers[o] ?? 0) + 1;
    }
    ctSummary = { source: "crt.sh (public certificate-transparency logs)", windowDays: 365, certificates: recent.length, issuers, distinctNames: ctNames.length, names: ctNames.slice(0, 50) };
  }

  // Extra hosts (cert SANs, plus CT names on history/deep): passive quick checks.
  let hostChecks: HostCheck[] | undefined;
  if (L >= 4) {
    const san = tls.ok ? tls.san.filter((n) => !n.startsWith("*.") && n !== host) : [];
    const candidates = [...new Set([...san, ...ctNames.filter((n) => n !== host)])].slice(0, HOST_CAP[tier]);
    hostChecks = await pool(candidates, 5, (h2) => quickHost(deps, h2), deadline - 3_000, deps.now);
    const expiring = hostChecks.filter((c) => c.tlsDaysLeft != null && c.tlsDaysLeft <= 30);
    const invalid = hostChecks.filter((c) => c.tlsValid === false);
    findings.push({ id: "hosts", title: "Related hosts", status: invalid.length ? "fail" : expiring.length ? "warn" : "pass", severity: invalid.length ? "high" : expiring.length ? "medium" : null, detail: `${hostChecks.length} of ${candidates.length} host(s) checked; ${invalid.length} untrusted certificate(s), ${expiring.length} expiring within 30 days`, ...(invalid.length || expiring.length ? { fix: FIX.tls_expiry } : {}) });
  }

  // Fix lines are part of report+ tiers only.
  const withFix = L >= 3;
  const shaped = findings.map((f) => (withFix ? f : { ...f, fix: undefined }));
  const counts = { pass: 0, warn: 0, fail: 0, info: 0, unavailable: 0 } as Record<Status, number>;
  for (const f of shaped) counts[f.status]++;

  const report: Record<string, unknown> = {
    target: host,
    tier,
    checksRun: shaped.length,
    summary: counts,
    findings: shaped.map(({ fix, ...rest }) => (fix ? { ...rest, fix } : rest)),
    ...(dnsRecords ? { dns: dnsRecords } : {}),
    ...(ctSummary ? { certificateHistory: ctSummary } : {}),
    ...(hostChecks ? { hosts: hostChecks } : {}),
    method: "Passive outside-in checks: ordinary GET requests through an SSRF guard, one TLS handshake per host, public DNS, and (history/deep) public certificate-transparency logs. No exploit attempts, no credentials, no auth bypass; exposed files are reported yes/no without reading or returning their contents.",
    note: "Informational results at the time of the check, not a certification or a guarantee of anything. Passive checks cannot see server-side issues.",
    elapsedMs: deps.now() - started,
  };
  if (withFix) report.markdown = toMarkdown(host, tier, shaped, counts);
  if (L >= 6) {
    const sevRank = { high: 0, medium: 1, low: 2 } as const;
    const todo = shaped.filter((f) => (f.status === "fail" || f.status === "warn") && f.fix).sort((a, b) => (sevRank[a.severity ?? "low"] - sevRank[b.severity ?? "low"]) || (a.status === "fail" ? -1 : 1));
    report.fixList = todo.map((f, i) => ({ priority: i + 1, id: f.id, severity: f.severity, fix: f.fix }));
    report.snippets = { nextjsVercelHeaders: SNIPPETS.vercel_next, nginx: SNIPPETS.nginx, dnsEmail: SNIPPETS.dns_email(host) };
  }
  return { ok: true, report };
}

function toMarkdown(host: string, tier: string, f: Finding[], c: Record<Status, number>): string {
  const lines = [`# Readiness checks: ${host} (${tier})`, "", `pass ${c.pass} / warn ${c.warn} / fail ${c.fail} / info ${c.info} / unavailable ${c.unavailable}`, "", "| Check | Result | Detail | Fix |", "|---|---|---|---|"];
  for (const x of f) lines.push(`| ${x.title} | ${x.status} | ${x.detail.replace(/\|/g, "/").slice(0, 160)} | ${(x.fix ?? "").replace(/\|/g, "/")} |`);
  lines.push("", "_Informational, passive outside-in checks; not a certification._");
  return lines.join("\n");
}
