/**
 * /.well-known/* gets X-Content-Type-Options: nosniff ONLY (Sentinel note via Odin
 * 11:18 PM ET 10/17). No CSP, X-Frame-Options or Referrer-Policy there; bodies, CORS
 * and every other header untouched. headers() in next.config only ADDS headers at the
 * edge, so the route handlers' own responses (status, headers, body) must still equal
 * the golden exactly; the live check (next start) is in the packet.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Next compiles header `source` with its bundled path-to-regexp; use the same one.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { match } = require("next/dist/compiled/path-to-regexp") as { match: (p: string) => (s: string) => unknown };
import nextConfig from "../next.config";
import { SITE_PAGES_SOURCE, WELL_KNOWN_SECURITY_HEADERS, WELL_KNOWN_SOURCE } from "@/lib/security-headers";
import { GET as wellKnownX402 } from "@/app/.well-known/x402/route";
import { GET as wellKnownRelated } from "@/app/.well-known/related-routes/route";

const ROOT = path.resolve(__dirname, "..");
const GOLDEN = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/x402-flag-off.golden.json"), "utf8")).discovery as Record<string, { status?: string | number; headers?: [string, string][]; body?: string; sha256?: string } | string>;
const site = new RegExp(`^${SITE_PAGES_SOURCE}$`);
const wk = match(WELL_KNOWN_SOURCE);

describe("/.well-known/* nosniff rule", () => {
  it("adds exactly one header, X-Content-Type-Options: nosniff; no CSP / XFO / Referrer-Policy / CORS", async () => {
    expect(WELL_KNOWN_SOURCE).toBe("/.well-known/:path*");
    expect(WELL_KNOWN_SECURITY_HEADERS).toEqual([{ key: "X-Content-Type-Options", value: "nosniff" }]);
    const rules = (await nextConfig.headers!()).filter((r) => r.source === WELL_KNOWN_SOURCE);
    expect(rules).toEqual([{ source: WELL_KNOWN_SOURCE, headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }]);
    expect(rules[0]!.headers.some((h) => /content-security|frame|referrer|access-control|cache-control|content-type$/i.test(h.key))).toBe(false);
  });
  it.each(["/.well-known/x402", "/.well-known/related-routes", "/.well-known/glama.json", "/.well-known/x402list.txt", "/.well-known/security.txt"])(
    "%s: matched by the nosniff rule and NOT by the site-pages rule (so no CSP / XFO / Referrer-Policy)",
    (p) => {
      expect(wk(p)).not.toBe(false);
      expect(site.test(p)).toBe(false);
    },
  );
  it.each(["/", "/api/pulse", "/mcp", "/well-known/x402", "/x/.well-known/x402", "/.well-knownx"])("%s: not matched by the /.well-known rule", (p) => {
    expect(wk(p)).toBe(false);
  });
});

describe("/.well-known bodies and handler headers are byte-identical to the golden", () => {
  it("GET /.well-known/x402: status, headers (incl. CORS) and body equal the golden exactly", async () => {
    const g = GOLDEN["GET /.well-known/x402"] as { status: string | number; headers: [string, string][]; body: string };
    const res = await wellKnownX402();
    expect(String(res.status)).toBe(String(g.status));
    const hdrs = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
    expect(hdrs).toEqual(g.headers);
    expect(await res.text()).toBe(g.body);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-content-type-options")).toBeNull(); // the handler itself is unchanged; nosniff is added by next.config
  });
  it("public/.well-known/x402list.txt sha256 equals the golden", () => {
    const g = GOLDEN["sha256 public/.well-known/x402list.txt"];
    const want = typeof g === "string" ? g : (g.sha256 ?? g.body);
    expect(createHash("sha256").update(readFileSync(path.join(ROOT, "public/.well-known/x402list.txt"))).digest("hex")).toBe(want);
  });
  it("GET /.well-known/related-routes: handler adds no security headers; CORS kept", async () => {
    const res = await wellKnownRelated();
    expect(res.status).toBe(200);
    for (const h of ["x-content-type-options", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "referrer-policy"]) expect(res.headers.get(h)).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
