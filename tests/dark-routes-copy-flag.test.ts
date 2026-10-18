/**
 * Audit route copy follows HP_AUDIT_HIGH_TIERS_ENABLED (Odin 11:15 PM ET 10/17), still dark.
 * Flag OFF: the 402 description (CDP and no-CDP fallback), OPTIONS discovery, the paid
 * response's method text and the /web-checks page never mention the full/history/deep
 * tiers or certificate history. Flag ON: the existing copy, unchanged. Counsel's wording
 * and the disclaimer are identical in both states. Catalog / manifests / openapi / llms /
 * skill.md never list the audit route in either state. Offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import * as auditRoute from "@/app/api/audit/security/route";
import { auditHandler } from "@/app/api/audit/security/handler";
import { AUDIT_DESCRIPTION_BASE, AUDIT_DESCRIPTION_HIGH_TIERS, AUDIT_HIGH_TIERS_FLAG, AUDIT_TIERS, DARK_DESCRIPTIONS, darkDescription, darkPaymentOpts, darkRouteConfig, resetRateLimitsForTests } from "@/lib/dark-routes";
import { routeMetadata } from "@/lib/route-metadata";
import { auditMethod, METHOD, METHOD_BASE, type AuditDeps } from "@/lib/audit-security";
import { DISCLAIMER, type SharedLimiter } from "@/lib/dark-checks-shared";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { buildSkillMarkdown } from "@/lib/agent-skill";
import { GET as wellKnownX402 } from "@/app/.well-known/x402/route";
import { GET as wellKnownRelated } from "@/app/.well-known/related-routes/route";
import { setCdp } from "./helpers/xrpl-env";
import { installFacilitatorMock } from "./helpers/facilitator-mock";

const ROOT = path.resolve(__dirname, "..");
const URL0 = "https://horizonpulse.dev/api/audit/security?target=example.com";
/** Anything that would advertise the disabled tiers or certificate history. */
const HIGH_COPY = /\bfull\b|\bhistory\b|\bdeep\b|certificate[- ]transparency|\bCT\b|crt\.sh|certificate history/i;
/** Counsel-required sentence (route 402 description) and the pre-change copy, verbatim. */
const COUNSEL_SENTENCE = "Automated checks, not a professional audit or penetration test; informational only, no warranty.";
const PRE_CHANGE_COPY =
  "Web readiness checks for one public host: HTTPS redirect, TLS certificate and expiry, HTTP response headers (HSTS, CSP, frame-embedding, nosniff, referrer), security.txt, DNS, SPF, DMARC and DKIM hints. tier=quick|standard|extended|report|full|history|deep; deeper tiers add checks, CT history and suggested fixes. Automated checks, not a professional audit or penetration test; informational only, no warranty. Callers need the right to check the target. Bad input or unreachable: not charged.";

const flag = (on: boolean) => vi.stubEnv(AUDIT_HIGH_TIERS_FLAG, on ? "true" : "");
beforeEach(() => resetRateLimitsForTests());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("description text, both flag states", () => {
  it("OFF: no full/history/deep or certificate history; ON: the pre-change copy exactly", () => {
    expect(HIGH_COPY.test(AUDIT_DESCRIPTION_BASE)).toBe(false);
    expect(AUDIT_DESCRIPTION_BASE).toContain("tier=quick|standard|extended|report;");
    expect(AUDIT_DESCRIPTION_HIGH_TIERS).toBe(PRE_CHANGE_COPY);
    expect(DARK_DESCRIPTIONS["/api/audit/security"]).toBe(PRE_CHANGE_COPY);
    expect(darkDescription("/api/audit/security", {})).toBe(AUDIT_DESCRIPTION_BASE);
    for (const v of ["", "1", "TRUE", "yes", " true"]) expect(darkDescription("/api/audit/security", { [AUDIT_HIGH_TIERS_FLAG]: v })).toBe(AUDIT_DESCRIPTION_BASE);
    expect(darkDescription("/api/audit/security", { [AUDIT_HIGH_TIERS_FLAG]: "true" })).toBe(PRE_CHANGE_COPY);
  });
  it("Counsel's sentence and the rest of the copy are byte-identical in both; both <= 500 chars", () => {
    for (const d of [AUDIT_DESCRIPTION_BASE, AUDIT_DESCRIPTION_HIGH_TIERS]) {
      expect(d).toContain(COUNSEL_SENTENCE);
      expect(d).toContain("Callers need the right to check the target. Bad input or unreachable: not charged.");
      expect(d.length).toBeLessThanOrEqual(500);
    }
    const [a0, a1] = AUDIT_DESCRIPTION_BASE.split(" tier=");
    const [b0] = AUDIT_DESCRIPTION_HIGH_TIERS.split(" tier=");
    expect(a0).toBe(b0);
    expect(a1!.slice(a1!.indexOf(COUNSEL_SENTENCE))).toBe(AUDIT_DESCRIPTION_HIGH_TIERS.slice(AUDIT_DESCRIPTION_HIGH_TIERS.indexOf(COUNSEL_SENTENCE)));
  });
  it("other dark routes' copy does not depend on the flag", () => {
    for (const on of [false, true]) {
      flag(on);
      expect(darkDescription("/api/package/check")).toBe(DARK_DESCRIPTIONS["/api/package/check"]);
      expect(darkDescription("/api/injection/scan")).toBe(DARK_DESCRIPTIONS["/api/injection/scan"]);
    }
  });
  it("route config, payment opts and the no-CDP fallback metadata all follow the flag", () => {
    for (const on of [false, true]) {
      flag(on);
      const want = on ? PRE_CHANGE_COPY : AUDIT_DESCRIPTION_BASE;
      const cfg = darkRouteConfig("/api/audit/security", AUDIT_TIERS[0]!) as Record<string, { description: string }>;
      expect(cfg["/api/audit/security"]!.description).toBe(want);
      expect(darkPaymentOpts("/api/audit/security", AUDIT_TIERS[0]!).description).toBe(want);
      expect(routeMetadata("/api/audit/security")!.description).toBe(want);
    }
  });
});

describe("served 402 (CDP and no-CDP fallback) and OPTIONS follow the flag, no stale cache", () => {
  for (const cdp of [true, false]) {
    it(`${cdp ? "CDP" : "no-CDP fallback"}: OFF -> base copy, ON -> current copy, OFF again -> base copy`, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      if (cdp) installFacilitatorMock();
      setCdp(cdp);
      vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
      for (const on of [false, true, false]) {
        flag(on);
        const res = await auditRoute.GET(new NextRequest(`${URL0}&tier=quick`));
        expect(res.status).toBe(402);
        const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
        const desc = (pr.resource as { description?: string }).description ?? "";
        expect(desc).toBe(on ? PRE_CHANGE_COPY : AUDIT_DESCRIPTION_BASE);
        expect(pr.accepts[0]!.amount).toBe("1000000");
        const body = await res.text();
        if (!on) expect(HIGH_COPY.test(body)).toBe(false);
      }
    });
  }
  it("OPTIONS discovery: no high-tier copy when OFF; current copy when ON", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installFacilitatorMock();
    setCdp(true);
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    flag(false);
    const off = await auditRoute.OPTIONS(new NextRequest(URL0, { method: "OPTIONS" }));
    const offText = `${await off.text()} ${off.headers.get("payment-required") ?? ""}`;
    expect(offText).not.toContain("full|history|deep");
    expect(offText).not.toContain("CT history");
    flag(true);
    const on = await auditRoute.OPTIONS(new NextRequest(URL0, { method: "OPTIONS" }));
    expect(on.status).not.toBe(404);
    const onText = `${await on.text()} ${on.headers.get("payment-required") ?? ""}`;
    expect(onText.includes("full|history|deep") || onText.includes(Buffer.from(PRE_CHANGE_COPY).toString("base64").slice(0, 40))).toBe(true);
    expect(offText.includes("readiness") || off.headers.get("payment-required") !== null).toBe(true);
  });
});

describe("paid response method text and disclaimer", () => {
  const allowAll: SharedLimiter = async () => ({ ok: true, retryAfter: 0 });
  const deps = (): AuditDeps => ({
    get: (async () => ({ ok: true, status: 200, headers: new Headers({ "strict-transport-security": "max-age=63072000" }), body: "<html></html>", bytes: 13, truncated: false, finalUrl: "https://example.com/", hops: [] })) as unknown as AuditDeps["get"],
    tls: async () => ({ ok: false, error: "stub" }),
    dns: { resolve: async () => [] },
    ct: async () => ({ ok: false, error: "stub" }),
    now: () => Date.now(),
  });
  it("OFF: method omits certificate history; ON: the existing method text; disclaimer verbatim in both", async () => {
    expect(HIGH_COPY.test(METHOD_BASE)).toBe(false);
    expect(METHOD).toContain("certificate-transparency history from crt.sh (history and deep)");
    expect(METHOD_BASE).toBe(METHOD.replace(", and certificate-transparency history from crt.sh (history and deep)", "").replace("one TLS handshake to port 443, public DNS", "one TLS handshake to port 443, and public DNS"));
    expect(auditMethod({})).toBe(METHOD_BASE);
    expect(auditMethod({ [AUDIT_HIGH_TIERS_FLAG]: "true" })).toBe(METHOD);
    for (const on of [false, true]) {
      flag(on);
      const res = await auditHandler(new NextRequest(URL0), AUDIT_TIERS[0]!, "hpr_m", deps(), { limiter: allowAll, optedOut: () => false, safeCheck: (async () => ({ ok: true })) as never });
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.method).toBe(on ? METHOD : METHOD_BASE);
      expect(b.disclaimer).toBe(DISCLAIMER);
      if (!on) expect(HIGH_COPY.test(JSON.stringify(b.method))).toBe(false);
    }
  });
});

describe("/web-checks page follows the flag", () => {
  async function render() {
    const page = (await import("@/app/web-checks/page")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(page());
  }
  it("OFF: no certificate history and no crt.sh; ON: lists both, as before; opt-out and contact in both", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    flag(false);
    const off = await render();
    expect(off).not.toMatch(/certificate-transparency|crt\.sh|\bhistory\b|\bfull\b|\bdeep\b/i);
    expect(off).toContain("npm, PyPI, pypistats, OSV.dev, deps.dev, the CISA KEV feed)");
    flag(true);
    const on = await render();
    expect(on).toContain("Certificate-transparency history for the name from crt.sh (a public log service, not the site itself).");
    expect(on).toContain("npm, PyPI, pypistats, OSV.dev, deps.dev, the CISA KEV feed, crt.sh)");
    for (const html of [off, on]) {
      expect(html).toContain("They are not a security audit or a penetration test.");
      expect(html).toContain('id="opt-out"');
      expect(html).toContain("horizonpulse.co@proton.me");
    }
  });
  it("still 404 while the audit route itself is dark, in both flag states", async () => {
    const page = (await import("@/app/web-checks/page")).default;
    for (const on of [false, true]) {
      flag(on);
      expect(() => page()).toThrow();
    }
  });
});

describe("catalog / manifests / openapi / llms / skill.md never list the audit route, either flag state", () => {
  it.each([false, true])("high tiers flag %s", async (on) => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    flag(on);
    expect(LIVE_PAID_ROUTES.some((r) => r.path.startsWith("/api/audit"))).toBe(false);
    const surfaces = [
      await wellKnownX402().text(),
      await (await wellKnownRelated()).text(),
      readFileSync(path.join(ROOT, "public/openapi.json"), "utf8"),
      readFileSync(path.join(ROOT, "public/llms.txt"), "utf8"),
      buildSkillMarkdown(),
      readFileSync(path.join(ROOT, "lib/mcp-server.ts"), "utf8"),
    ];
    for (const s of surfaces) {
      expect(s).not.toMatch(/audit\/security|web readiness|web-checks/i);
      expect(s).not.toContain(AUDIT_DESCRIPTION_BASE);
      expect(s).not.toContain(PRE_CHANGE_COPY);
    }
  });
});
