/**
 * Site security headers (Sentinel appsec 2026-10-17 §13). Pages get CSP
 * (Report-Only), X-Frame-Options DENY, nosniff and Referrer-Policy; /api/*,
 * /mcp and /.well-known/* are excluded so CORS, x402 headers and 402 bodies
 * are untouched.
 */
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { SITE_CSP_REPORT_ONLY, SITE_PAGES_SOURCE, SITE_SECURITY_HEADERS } from "@/lib/security-headers";

// Next compiles `source` with path-to-regexp; a source that is one custom
// group behaves like this anchored RegExp.
const re = new RegExp(`^${SITE_PAGES_SOURCE}$`);

describe("site security headers", () => {
  it("next.config headers() applies exactly the four headers to the site-pages source, and nothing else", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: SITE_PAGES_SOURCE, headers: SITE_SECURITY_HEADERS.map((h) => ({ ...h })) }]);
    expect(Object.fromEntries(SITE_SECURITY_HEADERS.map((h) => [h.key, h.value]))).toEqual({
      "Content-Security-Policy-Report-Only": SITE_CSP_REPORT_ONLY,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    // No CORS header is set or changed here.
    expect(SITE_SECURITY_HEADERS.some((h) => /access-control/i.test(h.key))).toBe(false);
  });

  it.each(["/", "/docs", "/try", "/privacy", "/status", "/agents", "/blog/why-agent-discoverability-matters", "/listing-fix", "/llms.txt", "/openapi.json", "/apis", "/mcp-guide"])(
    "applies to %s",
    (p) => expect(re.test(p)).toBe(true),
  );

  it.each(["/api", "/api/pulse", "/api/http", "/api/demo/pulse", "/mcp", "/mcp/", "/.well-known/x402", "/.well-known/glama.json", "/.well-known"])(
    "does NOT apply to %s",
    (p) => expect(re.test(p)).toBe(false),
  );

  it("CSP keeps frame-ancestors 'none', base-uri 'none', object-src 'none' and only self sources", () => {
    expect(SITE_CSP_REPORT_ONLY).toContain("frame-ancestors 'none'");
    expect(SITE_CSP_REPORT_ONLY).toContain("base-uri 'none'");
    expect(SITE_CSP_REPORT_ONLY).toContain("object-src 'none'");
    expect(SITE_CSP_REPORT_ONLY).toContain("connect-src 'self'");
  });
});
