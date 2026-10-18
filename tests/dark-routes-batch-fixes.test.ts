/**
 * Odin Class A batch, item B (10/18): feat/dark-audit-routes fixes. Flags stay OFF
 * in production; every network source here is a stub.
 *   B-1 exact npm security blocklist (audit-ci, advisory-db, @x/advisor are ordinary
 *       names) and never a 500
 *   B-3 per-IP key from the shared callerIp() helper
 *   B-4 Counsel's redirect wording verbatim (method text both tiers + /web-checks)
 *   Counsel FAIL: no published opt-out list; count + rate-limited exact-domain check
 *   B-5 deps.dev (derived signals only, attribution, cached) + CISA KEV cross-check
 *   route log: receipt id is random and never joined (assertions)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { assertAllowedSource, BUILD_PROVENANCE_MEANING, checkPackage, DEPSDEV_ATTRIBUTION, kevCves, KEV_NEGATIVE_TTL_MS, PACKAGE_DEADLINE_MS, packageVerdict, SCORECARD_ATTRIBUTION, deriveDepsDev, isNpmSecurityEndpoint, KEV_ATTRIBUTION, KEV_URL, resetKevCacheForTests, type Deps } from "@/lib/package-safety";
import { packageCheckHandler } from "@/app/api/package/check/handler";
import { clientKey, INJECTION_TIERS, newReceiptId, PACKAGE_TIERS, RECEIPT_HEADER, resetRateLimitsForTests } from "@/lib/dark-routes";
import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { METHOD, METHOD_BASE } from "@/lib/audit-security";
import { DATA_USER_AGENT, memoryCache, normalizeOptOutQuery, OPT_OUT_CHECK_PER_IP_PER_MIN, REDIRECT_COPY, type SharedLimiter } from "@/lib/dark-checks-shared";
import { optOutHandler } from "@/app/web-checks/opt-out/handler";
import { installFacilitatorMock, CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { setCdp } from "./helpers/xrpl-env";

const ROOT = path.resolve(__dirname, "..");
const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

beforeEach(() => {
  resetRateLimitsForTests();
  resetKevCacheForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-10-18T12:00:00Z");
type Opts = { vulns?: unknown[]; depsdev?: unknown | "down"; project?: unknown; kev?: unknown | "down" };
function pdeps(o: Opts = {}): Deps & { calls: string[]; inits: (RequestInit | undefined)[] } {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  return {
    calls,
    inits,
    now: () => NOW,
    cache: memoryCache(() => NOW),
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      calls.push(url);
      inits.push(init);
      expect(new Headers(init?.headers).get("user-agent")).toBe(DATA_USER_AGENT);
      if (url.startsWith("https://api.osv.dev/")) return Response.json({ vulns: o.vulns ?? [] });
      if (url.startsWith("https://api.deps.dev/v3/projects/")) return Response.json(o.project ?? {});
      if (url.startsWith("https://api.deps.dev/")) return o.depsdev === "down" ? new Response("x", { status: 503 }) : Response.json(o.depsdev ?? {});
      if (url === KEV_URL) return o.kev === "down" ? new Response("x", { status: 500 }) : Response.json(o.kev ?? { vulnerabilities: [] });
      if (url.startsWith("https://api.npmjs.org/downloads/")) return Response.json({ downloads: 5000 });
      if (url.endsWith("/latest")) return Response.json({ version: "1.0.0", license: "MIT", maintainers: [{ name: "a" }] });
      if (url.startsWith("https://registry.npmjs.org/")) return Response.json({ time: { created: "2024-01-01T00:00:00Z", modified: "2026-10-01T00:00:00Z", "1.0.0": "2026-10-01T00:00:00Z" }, versions: { "1.0.0": {} } });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
  };
}

describe("B-1: exact npm security blocklist; names like audit-ci / advisory-db / @x/advisor get a clean answer", () => {
  it.each(["audit-ci", "advisory-db", "@x/advisor", "npm-audit-resolver", "advisories", "security", "audits", "@npm/audit", "better-npm-audit"])("%s: 200-shaped report, registry requested", async (name) => {
    const d = pdeps();
    const r = await checkPackage({ ecosystem: "npm", name, version: null }, "deep", d);
    expect(r).toMatchObject({ ok: true, report: { exists: true, name } });
    expect(d.calls.some((u) => u.startsWith("https://registry.npmjs.org/"))).toBe(true);
    expect(d.calls.some((u) => isNpmSecurityEndpoint(u))).toBe(false);
  });
  it("handler: audit-ci answers 200 (not 500, not refused)", async () => {
    const res = await packageCheckHandler(new NextRequest("https://horizonpulse.dev/api/package/check?ecosystem=npm&name=audit-ci"), PACKAGE_TIERS[0]!, "hpr_t", pdeps());
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("audit-ci");
  });
  it("npm security / audit / advisory endpoints are still refused (exact endpoint match, any npm host, any case)", () => {
    for (const bad of [
      "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
      "https://registry.npmjs.org/-/npm/v1/security/audits/quick",
      "https://registry.npmjs.org/-/npm/v1/security/audits",
      "https://registry.npmjs.org/-/npm/v1/security/advisories/search",
      "https://registry.npmjs.org/-/NPM/v1/Security/audits",
      "https://registry.npmjs.org/-/v1/security/audits",
      "https://registry.npmjs.com/-/npm/v1/security/audits",
    ]) {
      expect(isNpmSecurityEndpoint(bad)).toBe(true);
      expect(() => assertAllowedSource(bad)).toThrow(/source not allowed/);
    }
  });
  it("ordinary registry URLs for those names are allowed; look-alike hosts are not", () => {
    for (const ok of ["https://registry.npmjs.org/audit-ci/latest", "https://registry.npmjs.org/advisory-db", "https://registry.npmjs.org/@x%2Fadvisor/latest", "https://api.npmjs.org/downloads/point/last-week/@x/advisor"]) expect(() => assertAllowedSource(ok)).not.toThrow();
    for (const bad of ["https://registry.npmjs.org.evil.example/x", "https://evil.example/registry.npmjs.org/", "http://registry.npmjs.org/x"]) expect(() => assertAllowedSource(bad)).toThrow();
  });
  it("an unexpected failure is a 502 refusal (not charged), never a 500 or a throw", async () => {
    const d = pdeps();
    d.now = () => {
      throw new Error("boom");
    };
    expect(await checkPackage({ ecosystem: "npm", name: "audit-ci", version: null }, "base", d)).toMatchObject({ ok: false, status: 502, code: "check_failed" });
    const res = await packageCheckHandler(new NextRequest("https://horizonpulse.dev/api/package/check?ecosystem=npm&name=audit-ci"), PACKAGE_TIERS[0]!, "hpr_t", d);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ charged: false, code: "check_failed" });
  });
  it("runtime: a handler that throws after payment verify answers 502, never settles (not charged)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const PAYER = `0x${"22".repeat(20)}`;
    const calls = installFacilitatorMock({
      verify: (url) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: "x" }),
      settle: (_url, _p, r) => ({ success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: PAYER }),
    });
    setCdp(true);
    vi.stubEnv("HP_INJECTION_SCAN_ENABLED", "true");
    const r = makeDarkRoute({ route: "injection", path: "/api/injection/scan", tiers: INJECTION_TIERS, defaultTier: "base", handler: async () => {
      throw new Error("boom");
    } });
    const url = "https://horizonpulse.dev/api/injection/scan?text=hi";
    const unpaid = await r.GET(new NextRequest(url));
    expect(unpaid.status).toBe(402);
    const accept = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!).accepts[0]! as unknown as Record<string, unknown>;
    const payload = { x402Version: 2, accepted: accept, payload: { signature: `0x${"cd".repeat(65)}`, authorization: { from: PAYER, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` } } } as unknown as PaymentPayload;
    const res = await r.GET(new NextRequest(url, { headers: { "payment-signature": encodePaymentSignatureHeader(payload), "x-real-ip": "198.51.100.9" } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "check_failed", charged: false });
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(/^hpr_/);
    expect(calls.filter((c) => c.op === "settle")).toHaveLength(0);
  });
});

describe("B-3: dark per-IP key from the shared callerIp() helper (Vercel ipAddress() source)", () => {
  it("reads x-real-ip only; x-forwarded-for is ignored; no IP -> one shared bucket", () => {
    expect(clientKey(new Headers({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "9.9.9.9" }))).toBe("203.0.113.5");
    expect(clientKey(new Headers({ "x-forwarded-for": "9.9.9.9" }))).toBe("unknown");
    expect(clientKey(new Headers({ "x-real-ip": "1.1.1.1, 2.2.2.2" }))).toBe("unknown");
    expect(clientKey(new Headers({ "x-real-ip": "2001:db8:1:2:3:4:5:6" }))).toBe("2001:db8:1:2::/64");
  });
  it("no dark-route file reads x-forwarded-for any more", () => {
    const files = ["lib/dark-routes.ts", "lib/dark-route-runtime.ts", "lib/dark-checks-shared.ts", "lib/audit-security.ts", "lib/package-safety.ts", "app/web-checks/opt-out/handler.ts", "app/api/audit/security/handler.ts", "app/api/package/check/handler.ts", "app/api/injection/scan/handler.ts"];
    for (const f of files) expect(src(f), f).not.toMatch(/\.get\(\s*["']x-forwarded-for["']/i);
    expect(src("lib/dark-routes.ts")).toContain('import { callerIp } from "./caller-ip"');
  });
});

describe("B-4: Counsel's redirect wording, verbatim", () => {
  const COUNSEL =
    "The GET of https://host/ follows the site's own redirects (up to 5), and the security.txt GET follows up to 2; each redirect target is checked against the opt-out list and our network guard before it is requested, and opted-out hosts are never requested. Apart from those redirects, nothing else is requested: no other paths, hosts or subdomains, no port scans, no login attempts, no exploit payloads.";
  it("constant is the exact text; both method texts carry it; the old 'no other hosts' line is gone", () => {
    expect(REDIRECT_COPY).toBe(COUNSEL);
    expect(METHOD).toContain(COUNSEL);
    expect(METHOD_BASE).toContain(COUNSEL);
    for (const m of [METHOD, METHOD_BASE]) expect(m).not.toMatch(/No other paths, hosts or ports are requested/);
  });
  it("the copy matches the code: 5 redirects on https://host/, 2 on security.txt, opt-out checked per hop", () => {
    const a = src("lib/audit-security.ts");
    expect(a).toMatch(/deps\.get\(`https:\/\/\$\{host\}\/`, \{[^}]*maxRedirects: 5, optedOut \}/);
    expect(a).toMatch(/security\.txt`, \{[^}]*maxRedirects: 2, optedOut \}/);
  });
  it("/web-checks renders it", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    const page = (await import("@/app/web-checks/page.audit")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(page()).replace(/&#x27;/g, "'");
    expect(html).toContain(COUNSEL);
    expect(html).not.toContain("no other hosts or subdomains, no port scans");
  });
  it("/web-checks says the lookup covers subdomains, because isOptedOut really matches them (h === d || h.endsWith(`.${d}`))", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    expect(src("lib/dark-checks-shared.ts")).toMatch(/h === d \|\| h\.endsWith\(`\.\$\{d\}`\)/);
    const page = (await import("@/app/web-checks/page.audit")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(page()).replace(/&#x27;/g, "'");
    expect(html).toContain("The lookup answers only yes or no for the one domain entered (no wildcards or partial matches) and is rate limited (a listed domain also covers its subdomains).");
  });
});

describe("Counsel FAIL fix: opt-out count + rate-limited exact-domain yes/no", () => {
  const ok: SharedLimiter = async () => ({ ok: true, retryAfter: 0 });
  const req = (q: string, ip = "203.0.113.7") => new NextRequest(`https://horizonpulse.dev/web-checks/opt-out?${q}`, { headers: { "x-real-ip": ip } });
  it("dark (404) exactly when /web-checks is", async () => {
    expect((await optOutHandler(req("domain=example.com"), ok)).status).toBe(404);
  });
  it("answers yes/no for one exact domain; body carries nothing else; never the list", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    vi.stubEnv("HP_WEB_CHECKS_OPTOUT", "listed.example,second.example");
    const yes = await optOutHandler(req("domain=Listed.Example."), ok);
    expect(yes.status).toBe(200);
    expect(await yes.json()).toEqual({ domain: "listed.example", optedOut: true });
    expect(yes.headers.get("cache-control")).toBe("no-store");
    expect(await (await optOutHandler(req("domain=www.listed.example"), ok)).json()).toEqual({ domain: "www.listed.example", optedOut: true });
    const no = await (await optOutHandler(req("domain=other.example"), ok)).text();
    expect(JSON.parse(no)).toEqual({ domain: "other.example", optedOut: false });
    expect(no).not.toMatch(/listed|second/);
  });
  it("no wildcards, partial names, paths, IPs or lists: 400", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    for (const q of ["domain=*.example.com", "domain=example", "domain=example.com/x", "domain=1.2.3.4", "domain=a.example,b.example", "domain=", "domain=%25", "x=example.com"]) expect((await optOutHandler(req(q), ok)).status, q).toBe(400);
    expect(normalizeOptOutQuery("*")).toBeNull();
  });
  it("per-IP limit in memory (the IP is never sent to the shared store); global limit shared; store down = fail closed", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    const keys: string[] = [];
    const lim: SharedLimiter = async (k) => (keys.push(k), { ok: true, retryAfter: 0 });
    for (let i = 0; i < OPT_OUT_CHECK_PER_IP_PER_MIN; i++) expect((await optOutHandler(req("domain=example.com"), lim)).status).toBe(200);
    const over = await optOutHandler(req("domain=example.com"), lim);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await optOutHandler(req("domain=example.com", "203.0.113.8"), lim)).status).toBe(200);
    expect(new Set(keys)).toEqual(new Set(["optout:global"]));
    expect((await optOutHandler(req("domain=example.com", "203.0.113.9"), async () => ({ ok: true, retryAfter: 12 }))).status).toBe(429);
    expect((await optOutHandler(req("domain=example.com", "203.0.113.10"), async () => ({ ok: false, error: "down" }))).status).toBe(503);
  });
  it("route serves GET only (every other method is a bare 404, Odin 10:31) and logs nothing", () => {
    const r = src("app/web-checks/opt-out/route.audit.ts");
    expect(r.match(/export (async )?function (\w+)/g)).toEqual(["export async function GET", "export async function HEAD"]);
    expect(r).toMatch(/export async function HEAD[\s\S]*darkEnabled\("audit"\) \? await optOutHandler\(req\) : notFound\(\)/);
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) expect(r).toContain(`export const ${m} = async () => notFound();`);
    expect(r + src("app/web-checks/opt-out/handler.ts")).not.toMatch(/console\.|logRouteRequest/);
  });
});

describe("B-5: deps.dev (one input, derived signals only, attributed, cached) and CISA KEV cross-check", () => {
  const ATTESTED = {
    slsaProvenances: [{ sourceRepository: "https://github.com/acme/widget", commit: "abc", url: "https://x", verified: true }],
    attestations: [{ type: "https://slsa.dev/provenance/v1", verified: true, sourceRepository: "https://github.com/acme/widget" }],
    relatedProjects: [{ projectKey: { id: "github.com/acme/widget" }, relationProvenance: "SLSA_ATTESTATION", relationType: "SOURCE_REPO" }],
    advisoryKeys: [{ id: "GHSA-zzzz" }],
    licenses: ["MIT"],
  };
  it("deriveDepsDev: verified / unverified / none; repo only from an attested relation", () => {
    expect(deriveDepsDev(ATTESTED)).toEqual({ buildProvenance: "verified", attestedRepo: "github.com/acme/widget" });
    expect(deriveDepsDev({ attestations: [{ verified: false }] })).toEqual({ buildProvenance: "unverified", attestedRepo: null });
    expect(deriveDepsDev({ relatedProjects: [{ projectKey: { id: "github.com/acme/widget" }, relationProvenance: "UNVERIFIED_METADATA", relationType: "SOURCE_REPO" }] })).toEqual({ buildProvenance: "none", attestedRepo: null });
    expect(deriveDepsDev({ relatedProjects: [{ projectKey: { id: "evil/../x" }, relationProvenance: "SLSA_ATTESTATION", relationType: "SOURCE_REPO" }] }).attestedRepo).toBeNull();
  });
  it("deep: GetVersion + GetProject (attested repo only); score rounded; no deps.dev field passed through; attribution verbatim; no key", async () => {
    const d = pdeps({ depsdev: ATTESTED, project: { projectKey: { id: "github.com/acme/widget" }, starsCount: 99, scorecard: { overallScore: 3.14159, checks: [{ name: "Maintained", score: 0 }] } } });
    const r = await checkPackage({ ecosystem: "npm", name: "@x/advisor", version: null }, "deep", d);
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.provenance).toEqual({ status: "ok", checkedVersion: "1.0.0", buildProvenance: "verified", buildProvenanceMeaning: BUILD_PROVENANCE_MEANING, sourceRepoAttested: true, scorecardOverall: 3.1, source: "deps.dev", attribution: DEPSDEV_ATTRIBUTION + SCORECARD_ATTRIBUTION });
    expect(DEPSDEV_ATTRIBUTION).toBe("Includes data from deps.dev (Open Source Insights, Google), generated data under CC-BY 4.0; advisories via OSV.dev, see each record's source.");
    const all = JSON.stringify(r.report);
    for (const raw of ["slsaProvenances", "attestations", "relatedProjects", "projectKey", "acme/widget", "starsCount", "Maintained", "advisoryKeys", "GHSA-zzzz", "https://x"]) expect(all).not.toContain(raw);
    expect(r.report.signals).toContainEqual({ signal: "Low OpenSSF Scorecard for the attested source repository (3.1/10, via deps.dev). OpenSSF Scorecard score from the OpenSSF Scorecard project (via deps.dev), data licensed under CDLA-Permissive-2.0: https://cdla.dev/permissive-2-0/", level: "caution" });
    const dd = d.calls.filter((u) => u.includes("api.deps.dev"));
    expect(dd).toEqual(["https://api.deps.dev/v3/systems/npm/packages/%40x%2Fadvisor/versions/1.0.0", "https://api.deps.dev/v3/projects/github.com%2Facme%2Fwidget"]);
    for (const init of d.inits) {
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBeNull();
      expect(h.get("x-api-key")).toBeNull();
    }
  });
  it("base: GetVersion only (no Scorecard); unattested repo never triggers GetProject", async () => {
    const d = pdeps({ depsdev: ATTESTED });
    const r = await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "base", d);
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.provenance).toEqual({ status: "ok", checkedVersion: "1.0.0", buildProvenance: "verified", buildProvenanceMeaning: BUILD_PROVENANCE_MEANING, sourceRepoAttested: true, source: "deps.dev", attribution: DEPSDEV_ATTRIBUTION });
    expect(d.calls.some((u) => u.includes("/v3/projects/"))).toBe(false);
    const d2 = pdeps({ depsdev: { relatedProjects: [{ projectKey: { id: "github.com/a/b" }, relationProvenance: "UNVERIFIED_METADATA", relationType: "SOURCE_REPO" }] } });
    await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "deep", d2);
    expect(d2.calls.some((u) => u.includes("/v3/projects/"))).toBe(false);
  });
  it("cached 24 h (derived signals only); deps.dev down = 'unavailable', answer still ok", async () => {
    const d = pdeps({ depsdev: ATTESTED });
    await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "base", d);
    await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "base", d);
    expect(d.calls.filter((u) => u.includes("api.deps.dev"))).toHaveLength(1);
    const down = await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "deep", pdeps({ depsdev: "down" }));
    expect(down).toMatchObject({ ok: true, report: { provenance: { status: "unavailable" } } });
  });
  it("KEV: fetched only when an advisory has a CVE; warn signal + CC0 line; 24 h in-memory cache; down = unavailable; never NVD", async () => {
    const vulns = [{ id: "GHSA-aaaa", aliases: ["CVE-2024-1111"] }, { id: "GHSA-bbbb", aliases: ["CVE-2023-2222"] }];
    const kev = { vulnerabilities: [{ cveID: "CVE-2024-1111" }, { cveID: "CVE-2020-0001" }] };
    const d = pdeps({ vulns, kev });
    const r = await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "base", d);
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.knownExploited).toEqual({ status: "ok", cves: ["CVE-2024-1111"], attribution: KEV_ATTRIBUTION });
    expect(KEV_ATTRIBUTION).toBe("Known-exploited status from the CISA KEV catalog (CC0)");
    expect(r.report.signals).toContainEqual({ signal: "1 advisory CVE is in the CISA KEV catalog of known exploited vulnerabilities: CVE-2024-1111", level: "warn" });
    await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "base", d);
    expect(d.calls.filter((u) => u === KEV_URL)).toHaveLength(1);
    const none = pdeps({ vulns: [{ id: "GHSA-cccc", aliases: [] }] });
    resetKevCacheForTests();
    const r2 = await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "base", none);
    expect(none.calls.includes(KEV_URL)).toBe(false);
    expect((r2 as { report: Record<string, unknown> }).report.knownExploited).toBeUndefined();
    resetKevCacheForTests();
    expect(await checkPackage({ ecosystem: "npm", name: "widget", version: null }, "base", pdeps({ vulns, kev: "down" }))).toMatchObject({ ok: true, report: { knownExploited: { status: "unavailable" } } });
    const pk = src("lib/package-safety.ts");
    expect(pk).not.toMatch(/nvd\.nist\.gov|services\.nvd/i);
    const code = pk.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/logo|CISA-verified|verified by CISA/i);
    expect(JSON.stringify(r.report)).not.toMatch(/logo|CISA-verified|verified by CISA/i);
  });
});

describe("route log: the receipt id is random and never joined", () => {
  it("hpr_<uuid v4>, no input, unique", () => {
    expect(newReceiptId.length).toBe(0);
    const ids = new Set(Array.from({ length: 1000 }, () => newReceiptId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^hpr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("the receipt id appears only in the dark-route response path, never in the route log or any store write", () => {
    expect(src("lib/route-log.ts")).not.toMatch(/receipt|hpr_/i);
    expect(src("lib/dark-checks-shared.ts")).not.toMatch(/receipt|hpr_/i);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(path.join(ROOT, dir))) {
        const p = path.join(dir, n);
        if (statSync(path.join(ROOT, p)).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n) && /receiptId|newReceiptId|RECEIPT_HEADER/.test(src(p))) hits.push(p);
      }
    };
    walk("lib");
    walk("app");
    // The three dark routes' route.ts only pass the id from the runtime to their handler.
    expect(hits.sort()).toEqual(["app/api/audit/security/handler.ts", "app/api/audit/security/route.audit.ts", "app/api/injection/scan/handler.ts", "app/api/injection/scan/route.inj.ts", "app/api/package/check/handler.ts", "app/api/package/check/route.pkg.ts", "lib/dark-route-runtime.ts", "lib/dark-routes.ts"].sort());
    for (const f of hits) for (const line of src(f).split("\n").filter((l) => /receiptId/.test(l))) expect(line, f).not.toMatch(/logRouteRequest|upstash|cache\.set|limiter\(|EVAL/i);
  });
});
