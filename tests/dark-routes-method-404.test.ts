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
import { BASE_PAGE_EXTENSIONS, DARK_METHODS, DARK_PATHS, darkPageExtensions } from "@/lib/dark-paths";
import { DARK_FLAGS } from "@/lib/dark-routes";
import * as pkgRoute from "@/app/api/package/check/route.pkg";
import * as auditRoute from "@/app/api/audit/security/route.audit";
import * as injRoute from "@/app/api/injection/scan/route.inj";
import * as optOutRoute from "@/app/web-checks/opt-out/route.audit";
import * as tgRoute from "@/app/api/trade-gate/route.tg";
import * as aaveRoute from "@/app/api/aave-equities/collateral-data/route.aave";
import * as rpRoute from "@/app/api/repo-pressure/route.rp";

const ROOT = path.resolve(__dirname, "..");
const ROUTES = [
  { name: "/api/package/check", mod: pkgRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/package/check?ecosystem=npm&name=lodash" },
  { name: "/api/package/check?tier=deep", mod: pkgRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/package/check?ecosystem=npm&name=lodash&tier=deep" },
  { name: "/api/audit/security", mod: auditRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/audit/security?url=https://example.com" },
  { name: "/api/injection/scan", mod: injRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/injection/scan?text=hi" },
  { name: "/api/trade-gate", mod: tgRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/trade-gate" },
  { name: "/api/aave-equities/collateral-data", mod: aaveRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/aave-equities/collateral-data?token=NVDAc" },
  { name: "/api/repo-pressure", mod: rpRoute as Record<string, unknown>, url: "https://horizonpulse.dev/api/repo-pressure" },
  { name: "/web-checks/opt-out", mod: optOutRoute as Record<string, unknown>, url: "https://horizonpulse.dev/web-checks/opt-out?domain=example.com" },
];
const LEAKY = ["allow", "access-control-allow-methods", "payment-required", "x-hp-receipt-id", "link"];
type H = (req: NextRequest) => Promise<Response>;
const call = (mod: Record<string, unknown>, m: string, url: string) =>
  (mod[m] as H)(new NextRequest(url, { method: m, ...(["POST", "PUT", "PATCH", "DELETE"].includes(m) ? { body: "{}", headers: { "content-type": "application/json" } } : {}) }));
const shape = async (r: Response) => ({ status: r.status, headers: [...r.headers.keys()].sort(), body: await r.text() });

afterEach(() => vi.unstubAllEnvs());

describe("line 1: dark route files are not routes at all unless their flag is 'true' at build (pageExtensions)", () => {
  it("flags unset: pageExtensions are exactly Next's defaults, so no dark file is a route", () => {
    expect(darkPageExtensions({})).toEqual([...BASE_PAGE_EXTENSIONS]);
    expect(DARK_PATHS.map((d) => d.path).sort()).toEqual(["/api/aave-equities/collateral-data", "/api/audit/security", "/api/injection/scan", "/api/package/check", "/api/trade-gate", "/web-checks", "/web-checks/opt-out", "/api/repo-pressure"].sort());
  });
  it("every dark file exists with its flag extension, and no plain route.ts / page.tsx is left beside it", () => {
    for (const d of DARK_PATHS) {
      expect(existsSync(path.join(ROOT, d.file)), d.file).toBe(true);
      expect(path.basename(d.file)).toMatch(new RegExp(`^(route|page)\\.${d.ext}\\.tsx?$`));
      const dir = path.dirname(path.join(ROOT, d.file));
      for (const plain of ["route.ts", "route.tsx", "route.js", "page.tsx", "page.ts", "page.js"]) expect(existsSync(path.join(dir, plain)), `${dir}/${plain}`).toBe(false);
    }
  });
  it("the flags match DARK_FLAGS; extensions never collide with the defaults", () => {
    const flags = new Set(Object.values(DARK_FLAGS));
    for (const d of DARK_PATHS) {
      expect(flags.has(d.flag)).toBe(true);
      expect(BASE_PAGE_EXTENSIONS as readonly string[]).not.toContain(d.ext);
    }
    expect(DARK_PATHS.filter((d) => d.path.startsWith("/web-checks")).every((d) => d.flag === DARK_FLAGS.audit)).toBe(true);
  });
  it("a flag exactly 'true' adds only its own extensions; anything else keeps them dark", () => {
    expect(darkPageExtensions({ HP_PACKAGE_CHECK_ENABLED: "true" })).toEqual([...BASE_PAGE_EXTENSIONS, "pkg.tsx", "pkg.ts"]);
    expect(darkPageExtensions({ HP_AUDIT_SECURITY_ENABLED: "true" })).toEqual([...BASE_PAGE_EXTENSIONS, "audit.tsx", "audit.ts"]);
    for (const v of ["1", "TRUE", "yes", " true", ""]) expect(darkPageExtensions({ HP_PACKAGE_CHECK_ENABLED: v, HP_AUDIT_SECURITY_ENABLED: v, HP_INJECTION_SCAN_ENABLED: v, HP_TRADE_GATE_ENABLED: v, HP_AAVE_EQUITIES_ENABLED: v, HP_REPO_PRESSURE_ENABLED: v })).toEqual([...BASE_PAGE_EXTENSIONS]);
    expect(darkPageExtensions({ HP_PACKAGE_CHECK_ENABLED: "true", HP_AUDIT_SECURITY_ENABLED: "true", HP_INJECTION_SCAN_ENABLED: "true" })).toHaveLength(10);
  });
  it("no other file in app/ uses a dark extension (so nothing else turns on with a flag)", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const files = execSync("git ls-files app", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const dark = files.filter((f) => /\.(audit|pkg|inj|tg|aave|rp)\.tsx?$/.test(f)).sort();
    expect(dark).toEqual(DARK_PATHS.map((d) => d.file).sort());
  });
  it("next.config.ts uses darkPageExtensions() and has no dark rewrite (no x-nextjs-rewritten-path under RSC)", async () => {
    for (const f of Object.values(DARK_FLAGS)) vi.stubEnv(f, "");
    const src = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(src).toMatch(/pageExtensions: darkPageExtensions\(\)/);
    expect(src).not.toMatch(/darkRewrites|_hp-dark-404/);
  });
  it("the smoke script compares every dark URL x every method x variants with an unknown path", () => {
    const s = readFileSync(path.join(ROOT, "scripts/smoke-dark-404.mjs"), "utf8");
    for (const m of DARK_METHODS) expect(s).toContain(`"${m}"`);
    for (const d of DARK_PATHS) expect(s).toContain(`"${d.path}`);
    for (const v of ["rsc", "next-router-state-tree", "next-router-prefetch", "x-payment", "payment-signature", "pct:", "pct2f:", "case:", "upper:", "%2F", "/API/PACKAGE/CHECK", "/api/%70ackage/check"]) expect(s.toLowerCase()).toContain(v.toLowerCase());
    expect(s).toMatch(/function unknownTwin\(/);
    expect(s).toMatch(/withVariant\(unknownTwin\(u\), v\)/);
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
    vi.stubEnv("HP_TRADE_GATE_ENABLED", "true");
    vi.stubEnv("HP_AAVE_EQUITIES_ENABLED", "true");
    vi.stubEnv("HP_REPO_PRESSURE_ENABLED", "true");
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
    const opt = await call(optOutRoute as Record<string, unknown>, "OPTIONS", ROUTES.find((x) => x.name === "/web-checks/opt-out")!.url);
    expect(opt.status).toBe(404);
    expect(opt.headers.get("allow")).toBeNull();
  });
});
