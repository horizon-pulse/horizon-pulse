/** Odin C1: XRPL worst-case deadlines fit inside the maxDuration of every route that can take XRPL. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { XRPL_MAX_INIT_TIMEOUT_MS, getXrplRailConfig } from "@/lib/xrpl-config";
import {
  XRPL_ROUTE_MAX_DURATION_S,
  XRPL_SETTLE_TIMEOUT_MS,
  XRPL_TX_LOOKUP_DEADLINE_MS,
  XRPL_TX_LOOKUP_DELAYS_MS,
  XRPL_VERIFY_TIMEOUT_MS,
  XRPL_WORST_CASE_MS,
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
  it("deadlines: verify 6 s, settle 20 s, lookup 4 s, init cap 5 s; sum = XRPL_WORST_CASE_MS", () => {
    expect([XRPL_VERIFY_TIMEOUT_MS, XRPL_SETTLE_TIMEOUT_MS, XRPL_TX_LOOKUP_DEADLINE_MS, XRPL_MAX_INIT_TIMEOUT_MS]).toEqual([6000, 20000, 4000, 5000]);
    expect(XRPL_WORST_CASE_MS).toBe(XRPL_MAX_INIT_TIMEOUT_MS + XRPL_VERIFY_TIMEOUT_MS + XRPL_SETTLE_TIMEOUT_MS + XRPL_TX_LOOKUP_DEADLINE_MS);
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
