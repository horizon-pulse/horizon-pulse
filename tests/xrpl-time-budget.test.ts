/** Odin C1: XRPL worst-case deadlines fit inside the maxDuration of every route that can take XRPL. */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { XRPL_MAX_INIT_TIMEOUT_MS, getXrplRailConfig } from "@/lib/xrpl-config";
import {
  XRPL_ROUTE_MAX_DURATION_S,
  XRPL_SETTLE_TIMEOUT_MS,
  XRPL_TX_LOOKUP_DEADLINE_MS,
  XRPL_LLS_CHECK_DEADLINE_MS,
  XRPL_TX_LOOKUP_DELAYS_MS,
  XRPL_VERIFY_TIMEOUT_MS,
  XRPL_WORST_CASE_MS,
  XRPL_IN_FLIGHT_STALE_MS,
  XRPL_REDEEM_LEASE_MS,
  XRPL_MASTER_CHECK_DEADLINE_MS,
  XRPL_REDEEM_WORST_CASE_MS,
} from "@/lib/xrpl-rail";

/** Time left for the route handler itself after the XRPL worst case. */
const HANDLER_MARGIN_MS = 20_000;

function paidRouteFiles(): string[] {
  const root = path.join(__dirname, "..", "app", "api");
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts" && /createX402|withXrpl|x402-server/.test(readFileSync(p, "utf8"))) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

describe("XRPL time budget", () => {
  it("deadlines: verify 6 s, settle 20 s, lookup 4 s, never-landed check 2.5 s, init cap 5 s; sum = XRPL_WORST_CASE_MS", () => {
    expect([XRPL_VERIFY_TIMEOUT_MS, XRPL_SETTLE_TIMEOUT_MS, XRPL_TX_LOOKUP_DEADLINE_MS, XRPL_LLS_CHECK_DEADLINE_MS, XRPL_MAX_INIT_TIMEOUT_MS]).toEqual([6000, 20000, 4000, 2500, 5000]);
    expect(XRPL_WORST_CASE_MS).toBe(XRPL_MAX_INIT_TIMEOUT_MS + XRPL_VERIFY_TIMEOUT_MS + XRPL_SETTLE_TIMEOUT_MS + XRPL_TX_LOOKUP_DEADLINE_MS + XRPL_LLS_CHECK_DEADLINE_MS);
    expect(XRPL_TX_LOOKUP_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(XRPL_TX_LOOKUP_DEADLINE_MS);
  });

  it("sum of deadlines + handler margin < XRPL_ROUTE_MAX_DURATION_S", () => {
    expect(XRPL_WORST_CASE_MS + HANDLER_MARGIN_MS).toBeLessThan(XRPL_ROUTE_MAX_DURATION_S * 1000);
  });

  it("HP_XRPL_INIT_TIMEOUT_MS cannot exceed the cap", () => {
    const base = { HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ" };
    expect(getXrplRailConfig({ ...base, HP_XRPL_INIT_TIMEOUT_MS: "5000" })).toMatchObject({ config: { initTimeoutMs: 5000 } });
    expect(getXrplRailConfig({ ...base, HP_XRPL_INIT_TIMEOUT_MS: "5001" })).toMatchObject({ config: { initTimeoutMs: 2500 } });
  });

  it("every paid route exports maxDuration >= XRPL_ROUTE_MAX_DURATION_S (and > the worst case)", () => {
    const files = paidRouteFiles();
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) {
      const m = /export const maxDuration\s*=\s*(\d+)/.exec(readFileSync(f, "utf8"));
      expect(m, f).not.toBeNull();
      const s = Number(m![1]);
      expect(s, f).toBeGreaterThanOrEqual(XRPL_ROUTE_MAX_DURATION_S);
      expect(XRPL_WORST_CASE_MS, f).toBeLessThan(s * 1000);
    }
  });
});

/**
 * Delta 4 C1 (Odin 12:07): the route list is DERIVED from the code, not hand-listed: every route.ts under app/
 * whose static import graph (from / import(), "@/", relative, .ts/.tsx/index.ts) reaches lib/xrpl-rail.ts.
 */
/** route.ts plus the dark-route flag extensions route.<flag>.ts (next.config.ts pageExtensions). */
const ROUTE_FILE = /^route(\.[a-z]+)?\.ts$/;
function xrplCapableRouteFiles(): string[] {
  const root = path.join(__dirname, "..");
  const target = path.join(root, "lib", "xrpl-rail.ts");
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
    else return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
  };
  const memo = new Map<string, boolean>();
  const reaches = (f: string, stack: Set<string>): boolean => {
    if (f === target) return true;
    if (memo.has(f)) return memo.get(f)!;
    if (stack.has(f)) return false;
    stack.add(f);
    let hit = false;
    for (const m of readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const r = resolveSpec(f, m[1]);
      if (r && reaches(r, stack)) {
        hit = true;
        break;
      }
    }
    stack.delete(f);
    memo.set(f, hit);
    return hit;
  };
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      // Delta 5 (Odin 12:19): dark-route extensions (route.audit.ts / route.pkg.ts / route.inj.ts ...) count too.
      else if (ROUTE_FILE.test(e.name) && reaches(p, new Set())) out.push(p);
    }
  };
  walk(path.join(root, "app"));
  return out.sort();
}

describe("C1: every XRPL-capable route finishes before an in_flight slot can be taken over", () => {
  it("each route (route.ts and dark route.<flag>.ts) whose import graph reaches lib/xrpl-rail.ts exports maxDuration < XRPL_IN_FLIGHT_STALE_MS (90 s) and < XRPL_REDEEM_LEASE_MS", () => {
    const files = xrplCapableRouteFiles();
    expect(files.length).toBeGreaterThanOrEqual(15);
    // Dark routes are derived too (not hand-listed): at least audit / pkg / inj reach the XRPL rail today.
    const dark = files.filter((f) => /route\.[a-z]+\.ts$/.test(f)).map((f) => path.basename(f));
    expect(dark.length).toBeGreaterThanOrEqual(3);
    for (const ext of ["route.audit.ts", "route.pkg.ts", "route.inj.ts"]) expect(dark).toContain(ext);
    for (const f of paidRouteFiles()) expect(files).toContain(f); // superset of the regex-based paid list
    expect(XRPL_IN_FLIGHT_STALE_MS).toBe(90_000);
    for (const f of files) {
      const m = /export\s+const\s+maxDuration\s*=\s*(\d+)/.exec(readFileSync(f, "utf8"));
      expect(m, `${path.relative(path.join(__dirname, ".."), f)} must export maxDuration`).not.toBeNull();
      const ms = Number(m![1]) * 1000;
      expect(ms, f).toBeLessThan(XRPL_IN_FLIGHT_STALE_MS);
      expect(ms, f).toBeLessThan(XRPL_REDEEM_LEASE_MS);
    }
  });
});

describe("Delta 5: the F1(b) master-key account_info read fits the existing budget", () => {
  it("master check 2 s; redeem worst case (init + master check + lookup + never-landed) ≤ XRPL_WORST_CASE_MS, + margin < maxDuration", () => {
    expect(XRPL_MASTER_CHECK_DEADLINE_MS).toBe(2_000);
    expect(XRPL_REDEEM_WORST_CASE_MS).toBe(XRPL_MAX_INIT_TIMEOUT_MS + XRPL_MASTER_CHECK_DEADLINE_MS + XRPL_TX_LOOKUP_DEADLINE_MS + XRPL_LLS_CHECK_DEADLINE_MS);
    expect(XRPL_REDEEM_WORST_CASE_MS).toBeLessThanOrEqual(XRPL_WORST_CASE_MS);
    expect(XRPL_REDEEM_WORST_CASE_MS + HANDLER_MARGIN_MS).toBeLessThan(XRPL_ROUTE_MAX_DURATION_S * 1000);
  });
});
