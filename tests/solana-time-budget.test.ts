/**
 * Odin 12:31 PM ET: Solana time budget, like tests/xrpl-time-budget.test.ts. The route list is DERIVED from the code:
 * every route.ts / dark route.<flag>.ts under app/ whose static import graph reaches lib/solana-rail.ts. Each must
 * give the Solana worst case at the LARGEST accepted HP_SOLANA_INIT_TIMEOUT_MS (Odin 12:51 C2: 2 × 7 + 10 + 12 + 4 = 40 s)
 * plus a 20 s handler margin, unless its payment path provably cannot take Solana
 * (only /mcp today: @x402/mcp wrapper with the Base-only accepts from buildPaymentRequirements, CDP resource server).
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SOLANA_DEFAULT_INIT_TIMEOUT_MS, SOLANA_MAX_INIT_TIMEOUT_MS, SOLANA_PAYTO, getSolanaRailConfig } from "@/lib/solana-config";
import {
  ATA_COLD_ATTEMPTS,
  SOLANA_MAX_WORST_CASE_MS,
  SOLANA_LEDGER_CHECK_DEADLINE_MS,
  SOLANA_SETTLE_TIMEOUT_MS,
  SOLANA_START_SLOT_TIMEOUT_MS,
  SOLANA_VERIFY_TIMEOUT_MS,
  SOLANA_WORST_CASE_MS,
  SOLANA_EVAL_PROBE_DEADLINE_MS,
} from "@/lib/solana-rail";
import { buildPaymentRequirements } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";

const ROOT = path.join(__dirname, "..");
/** Time left for the route handler itself after the Solana worst case. */
const HANDLER_MARGIN_MS = 20_000;
const ROUTE_FILE = /^route(\.[a-z]+)?\.ts$/;
/** Routes whose payment path cannot take Solana (proven below, not assumed). */
const NO_SOLANA_PAYMENT = new Set(["app/mcp/route.ts"]);

function routesReaching(targetRel: string): string[] {
  const target = path.join(ROOT, targetRel);
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
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
      else if (ROUTE_FILE.test(e.name) && reaches(p, new Set())) out.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "app"));
  return out.sort();
}
const maxDurationOf = (rel: string) => {
  const m = /export\s+const\s+maxDuration\s*=\s*(\d+)/.exec(readFileSync(path.join(ROOT, rel), "utf8"));
  return m ? Number(m[1]) : null;
};

describe("Solana time budget (Odin 12:31)", () => {
  it("worst case (cold: 2 token-account tries × init) = 2 × 2.5 + 10 + 12 + 4 = 31 s by default, 2 × 7 + 26 = 40 s at the max init; the start-slot read is capped below init", () => {
    expect([SOLANA_DEFAULT_INIT_TIMEOUT_MS, SOLANA_VERIFY_TIMEOUT_MS, SOLANA_SETTLE_TIMEOUT_MS, SOLANA_LEDGER_CHECK_DEADLINE_MS]).toEqual([2500, 10000, 12000, 4000]);
    expect(ATA_COLD_ATTEMPTS).toBe(2);
    expect(SOLANA_WORST_CASE_MS).toBe(31_000);
    expect(SOLANA_MAX_INIT_TIMEOUT_MS).toBe(7_000);
    expect(SOLANA_MAX_WORST_CASE_MS).toBe(ATA_COLD_ATTEMPTS * SOLANA_MAX_INIT_TIMEOUT_MS + SOLANA_VERIFY_TIMEOUT_MS + SOLANA_SETTLE_TIMEOUT_MS + SOLANA_LEDGER_CHECK_DEADLINE_MS);
    expect(SOLANA_MAX_WORST_CASE_MS).toBe(40_000);
    expect(SOLANA_START_SLOT_TIMEOUT_MS).toBeLessThanOrEqual(SOLANA_DEFAULT_INIT_TIMEOUT_MS);
    const src = readFileSync(path.join(ROOT, "lib", "solana-rail.ts"), "utf8");
    // Odin 2:12 F2: getSlot read uncounted (counted after validation). Odin 1:39 (3): the shared claim store probe
    // (≤ SOLANA_EVAL_PROBE_DEADLINE_MS) runs in the same parallel init phase and finishes inside the cold
    // token-account budget (2 × init), so the worst case is unchanged.
    expect(src).toContain("Promise.all([solanaTokenAccountReady(config), getRail(config), readStartSlot(config, false), solanaReplayEvalOk()])");
    expect(SOLANA_EVAL_PROBE_DEADLINE_MS).toBeLessThanOrEqual(ATA_COLD_ATTEMPTS * SOLANA_DEFAULT_INIT_TIMEOUT_MS);
  });

  it("every derived Solana-capable route (route.ts and dark route.<flag>.ts) has maxDuration ≥ worst case + handler margin", () => {
    const files = routesReaching("lib/solana-rail.ts");
    expect(files.length).toBeGreaterThanOrEqual(15);
    const dark = files.filter((f) => /route\.[a-z]+\.ts$/.test(f)).map((f) => path.basename(f));
    for (const ext of ["route.audit.ts", "route.pkg.ts", "route.inj.ts"]) expect(dark).toContain(ext);
    for (const f of files) {
      if (NO_SOLANA_PAYMENT.has(f)) continue;
      const s = maxDurationOf(f);
      expect(s, `${f} must export maxDuration`).not.toBeNull();
      expect(s! * 1000, f).toBeGreaterThanOrEqual(SOLANA_MAX_WORST_CASE_MS + HANDLER_MARGIN_MS);
    }
    expect(maxDurationOf("app/api/injection/scan/route.inj.ts")).toBe(60);
  });

  it("C2: HP_SOLANA_INIT_TIMEOUT_MS is clamped to SOLANA_MAX_INIT_TIMEOUT_MS (an operator env change cannot void the budget)", () => {
    const on = (t: string) => getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_INIT_TIMEOUT_MS: t });
    expect(on("7000")).toMatchObject({ config: { initTimeoutMs: 7000 } });
    expect(on("7001")).toMatchObject({ config: { initTimeoutMs: 7000 } });
    expect(on("30000")).toMatchObject({ config: { initTimeoutMs: 7000 } });
    expect(on("2500")).toMatchObject({ config: { initTimeoutMs: 2500 } });
    expect(on("")).toMatchObject({ config: { initTimeoutMs: SOLANA_DEFAULT_INIT_TIMEOUT_MS } });
  });

  it("/mcp (30 s) reaches the rail only through shared handler modules; its payment path cannot take Solana (Base-only accepts, CDP server)", () => {
    expect(routesReaching("lib/solana-rail.ts")).toContain("app/mcp/route.ts");
    expect(maxDurationOf("app/mcp/route.ts")).toBe(30);
    const mcp = readFileSync(path.join(ROOT, "lib", "mcp-server.ts"), "utf8");
    expect(mcp).toMatch(/createPaymentWrapper\(resourceServer, \{\s*accepts: pr\.accepts/);
    expect(mcp).toContain("const pr = buildPaymentRequirements(t.opts);");
    expect(mcp).not.toMatch(/solana-rail|handleSolanaPayment|createX402GetHandler|createX402PostHandler|withSolana/);
    const pr = buildPaymentRequirements(pulseOpts); // the same call mcp-server makes per tool
    expect(pr.accepts.map((a) => a.network)).toEqual(["eip155:8453"]);
  });
});
