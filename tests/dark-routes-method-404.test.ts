/**
 * Odin 10:31 AM ET 10/18: while its flag is off, every dark route answers every method exactly like an
 * unknown path (the 10:26 smoke found /web-checks/opt-out answering POST 405 and OPTIONS 204 + Allow).
 * Line 1 (prod): next.config.ts rewrites dark paths to an unknown path at build time -> tested here on
 * the config; the platform-level identity (status + headers + body vs a random unknown path) is checked
 * by scripts/smoke-dark-404.mjs against `next start` (42/42 identical, see the packet) and prod.
 * Line 2 (handlers): every method exported, 404 without Allow / payment headers -> tested here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { DARK_404_DESTINATION, DARK_METHODS, DARK_PATHS, darkRewrites } from "@/lib/dark-paths";
import { DARK_FLAGS } from "@/lib/dark-routes";
import * as pkgRoute from "@/app/api/package/check/route";
import * as auditRoute from "@/app/api/audit/security/route";
import * as injRoute from "@/app/api/injection/scan/route";
import * as optOutRoute from "@/app/web-checks/opt-out/route";

const ROOT = path.resolve(__dirname, "..");
const ROUTES = [
  { name: "/api/package/check", mod: pkgRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/package/check?ecosystem=npm&name=lodash" },
  { name: "/api/package/check?tier=deep", mod: pkgRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/package/check?ecosystem=npm&name=lodash&tier=deep" },
  { name: "/api/audit/security", mod: auditRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/audit/security?url=https://example.com" },
  { name: "/api/injection/scan", mod: injRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/injection/scan?text=hi" },
  { name: "/web-checks/opt-out", mod: optOutRoute as Record<string, unknown>, url: "https://horizonpulse.dev/web-checks/opt-out?domain=example.com" },
];
const LEAKY = ["allow", "access-control-allow-methods", "payment-required", "x-hp-receipt-id", "link"];
type H = (req: NextRequest) => Promise<Response>;
const call = (mod: Record<string, unknown>, m: string, url: string) =>
  (mod[m] as H)(new NextRequest(url, { method: m, ...(["POST", "PUT", "PATCH", "DELETE"].includes(m) ? { body: "{}", headers: { "content-type": "application/json" } } : {}) }));
const shape = async (r: Response) => ({ status: r.status, headers: [...r.headers.keys()].sort(), body: await r.text() });

afterEach(() => vi.unstubAllEnvs());

describe("line 1: next.config.ts rewrites every dark path to an unknown path while its flag is off", () => {
  it("flags unset: all five dark paths rewritten, any method/query (path-only source), to a path that does not exist", () => {
    expect(darkRewrites({})).toEqual(DARK_PATHS.map((d) => ({ source: d.path, destination: DARK_404_DESTINATION })));
    expect(DARK_PATHS.map((d) => d.path).sort()).toEqual(["/api/audit/security", "/api/injection/scan", "/api/package/check", "/web-checks", "/web-checks/opt-out"]);
    expect(existsSync(path.join(ROOT, "app", DARK_404_DESTINATION.slice(1)))).toBe(false);
    expect(existsSync(path.join(ROOT, "public", DARK_404_DESTINATION.slice(1)))).toBe(false);
  });
  it("every dark route directory in app/ is covered, and the flags match DARK_FLAGS", () => {
    for (const p of ["api/audit/security", "api/package/check", "api/injection/scan", "web-checks", "web-checks/opt-out"]) {
      expect(existsSync(path.join(ROOT, "app", p))).toBe(true);
      expect(DARK_PATHS.some((d) => d.path === `/${p}`)).toBe(true);
    }
    const flags = new Set(Object.values(DARK_FLAGS));
    for (const d of DARK_PATHS) expect(flags.has(d.flag)).toBe(true);
    expect(DARK_PATHS.filter((d) => d.path.startsWith("/web-checks")).every((d) => d.flag === DARK_FLAGS.audit)).toBe(true);
  });
  it("a flag exactly 'true' removes only its own paths; anything else keeps them dark", () => {
    expect(darkRewrites({ HP_PACKAGE_CHECK_ENABLED: "true" }).map((r) => r.source)).not.toContain("/api/package/check");
    expect(darkRewrites({ HP_PACKAGE_CHECK_ENABLED: "true" })).toHaveLength(4);
    expect(darkRewrites({ HP_AUDIT_SECURITY_ENABLED: "true" }).map((r) => r.source).sort()).toEqual(["/api/injection/scan", "/api/package/check"]);
    for (const v of ["1", "TRUE", "yes", " true", ""]) expect(darkRewrites({ HP_PACKAGE_CHECK_ENABLED: v, HP_AUDIT_SECURITY_ENABLED: v, HP_INJECTION_SCAN_ENABLED: v })).toHaveLength(5);
    expect(darkRewrites({ HP_PACKAGE_CHECK_ENABLED: "true", HP_AUDIT_SECURITY_ENABLED: "true", HP_INJECTION_SCAN_ENABLED: "true" })).toEqual([]);
  });
  it("next.config.ts serves them as beforeFiles rewrites (ahead of the route files)", async () => {
    for (const f of Object.values(DARK_FLAGS)) vi.stubEnv(f, "");
    const cfg = (await import("../next.config")).default;
    const r = (await cfg.rewrites!()) as { beforeFiles: unknown[] };
    expect(r.beforeFiles).toEqual(darkRewrites({}));
    expect(readFileSync(path.join(ROOT, "next.config.ts"), "utf8")).toMatch(/beforeFiles: darkRewrites\(\)/);
  });
  it("the smoke script compares every dark URL x every method with a random unknown path", () => {
    const s = readFileSync(path.join(ROOT, "scripts/smoke-dark-404.mjs"), "utf8");
    for (const m of DARK_METHODS) expect(s).toContain(`"${m}"`);
    for (const d of DARK_PATHS) expect(s).toContain(`"${d.path}`);
    expect(s).toMatch(/zz-unknown-/);
  });
});

describe("line 2: route handlers, flags off - every method exported, a bare 404, identical across methods and routes", () => {
  it("every dark route module exports all seven methods (so Next never answers 405 or an auto-OPTIONS with Allow)", () => {
    for (const r of ROUTES) for (const m of DARK_METHODS) expect(typeof r.mod[m], `${r.name} ${m}`).toBe("function");
  });
  it("routes x methods: 404, no Allow / CORS-methods / payment / receipt headers; all identical to one baseline", async () => {
    for (const f of [...Object.values(DARK_FLAGS), "HP_PACKAGE_DEEP_ENABLED", "HP_AUDIT_HIGH_TIERS_ENABLED"]) vi.stubEnv(f, "");
    let baseline: Awaited<ReturnType<typeof shape>> | null = null;
    let n = 0;
    for (const r of ROUTES) {
      for (const m of DARK_METHODS) {
        const res = await call(r.mod, m, r.url);
        expect(res.status, `${r.name} ${m}`).toBe(404);
        for (const h of LEAKY) expect(res.headers.get(h), `${r.name} ${m} ${h}`).toBeNull();
        const s = await shape(res);
        if (m === "HEAD") {
          expect(s.body, `${r.name} HEAD has no body`).toBe("");
          continue;
        }
        baseline ??= s;
        expect(s, `${r.name} ${m}`).toEqual(baseline);
        n++;
      }
    }
    expect(n).toBe(ROUTES.length * (DARK_METHODS.length - 1));
  });
  it("flag on: PUT / PATCH / DELETE stay a bare 404 (never 405, never Allow); HEAD answers like GET without a body", async () => {
    vi.stubEnv("HP_PACKAGE_CHECK_ENABLED", "true");
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    vi.stubEnv("HP_INJECTION_SCAN_ENABLED", "true");
    for (const r of ROUTES.filter((x) => !x.name.includes("deep"))) {
      for (const m of ["PUT", "PATCH", "DELETE"]) {
        const res = await call(r.mod, m, r.url);
        expect(res.status, `${r.name} ${m}`).toBe(404);
        expect(res.headers.get("allow")).toBeNull();
      }
    }
    const head = await call(pkgRoute as Record<string, unknown>, "HEAD", ROUTES[0]!.url);
    expect(head.status).toBe(402);
    expect(head.headers.get("payment-required")).toBeTruthy();
    expect(await head.text()).toBe("");
    const opt = await call(optOutRoute as Record<string, unknown>, "OPTIONS", ROUTES[4]!.url);
    expect(opt.status).toBe(404);
    expect(opt.headers.get("allow")).toBeNull();
  });
});
