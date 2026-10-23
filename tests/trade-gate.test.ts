/**
 * Trade Gate (DARK, HP_TRADE_GATE_ENABLED). Spec v1 + Counsel E1-E8. All values below are test
 * fixtures. Example values only; not suggested limits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  canonicalJson, evaluateTradeGate, TRADE_GATE_DESCRIPTION, TRADE_GATE_DISCLAIMER, TRADE_GATE_HASH_NOTE, TRADE_GATE_ID_NOTE, TRADE_GATE_RULES_NOTE,
  type TradeGateOk,
} from "@/lib/trade-gate";
import { tradeGateHandler } from "@/app/api/trade-gate/handler";
import * as tgRoute from "@/app/api/trade-gate/route.tg";
import { TRADE_GATE_TIERS, darkDescription, darkRouteConfig, resetRateLimitsForTests } from "@/lib/dark-routes";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { DARK_PATHS, darkPageExtensions } from "@/lib/dark-paths";

const ROOT = path.resolve(__dirname, "..");
const E4 =
  "Checks only the rules you supplied, using the inputs you supplied, which are not verified. Not investment advice, a recommendation, a suitability determination or an approval to trade. Horizon Pulse is not a broker or investment adviser and is not affiliated with any broker.";
const ALL_RULES = {
  cash_only: true, long_premium_only: true, max_options_pct_nav: 50, max_option_positions: 3, max_single_position_pct_nav: 60,
  min_days_to_expiry: 10, limit_orders_only: true, no_averaging_down: true, require_thesis: true, require_preview: true, require_approval: true,
};
const base = () => ({
  order: { symbol: "AAA", asset_type: "option", side: "buy_to_open", option_type: "call", quantity: 1, limit_price: 2, multiplier: 100, expiration: "2026-12-18", order_type: "limit" },
  account: { nav: 1000, cash: 500, positions: [{ symbol: "BBB", asset_type: "option", market_value: 100, underlying: "BBB" }] },
  rules: { ...ALL_RULES } as Record<string, unknown>,
  attestations: { thesis_id: "t-1", preview_ok: true, approval_ref: "a-1", existing_cost_basis: null as number | null },
  as_of: "2026-10-22",
});
const NOW = new Date("2026-10-22T12:00:00Z");
const ok = (b: unknown) => {
  const r = evaluateTradeGate(b, NOW);
  if (!r.ok) throw new Error(r.error);
  return r as TradeGateOk;
};
const st = (r: TradeGateOk, id: string) => r.checks.find((c) => c.id === id)!.status;
const mod = <T,>(f: (b: ReturnType<typeof base>) => void) => { const b = base(); f(b); return b; };

describe("engine: R1-R11", () => {
  it("all rules met -> all_supplied_rules_met, 10 checked, 1 skipped (R8 no basis)", () => {
    const r = ok(base());
    expect(r.rules_result).toBe("all_supplied_rules_met");
    expect([r.checked, r.skipped, r.failed]).toEqual([10, 1, []]);
    expect(r.order_cost).toBe(200);
  });
  it("R1 cash_only: cost over cash fails", () => {
    const r = ok(mod((b) => (b.account.cash = 199)));
    expect(st(r, "R1")).toBe("fail");
    expect(r.rules_result).toBe("supplied_rule_not_met");
    expect(r.failed).toEqual(["R1"]);
  });
  it("R2 long_premium_only: sell_to_open option fails; equity buy passes", () => {
    expect(st(ok(mod((b) => (b.order.side = "sell_to_open"))), "R2")).toBe("fail");
    expect(st(ok(mod((b) => Object.assign(b.order, { asset_type: "equity", side: "buy", multiplier: undefined, expiration: null, option_type: null }))), "R2")).toBe("pass");
  });
  it("R3 options % of NAV: (100 + 200)/1000 = 30% vs limit", () => {
    const r = ok(mod((b) => (b.rules.max_options_pct_nav = 29.9)));
    expect(st(r, "R3")).toBe("fail");
    expect(r.checks.find((c) => c.id === "R3")!.detail).toBe("options 30% of NAV after order (300 / 1000), limit 29.9%");
    expect(st(ok(mod((b) => (b.rules.max_options_pct_nav = 30))), "R3")).toBe("pass");
  });
  it("R4 max option positions: new symbol at the limit fails; adding to an existing symbol passes", () => {
    expect(st(ok(mod((b) => (b.rules.max_option_positions = 1))), "R4")).toBe("fail");
    expect(st(ok(mod((b) => { b.rules.max_option_positions = 1; b.order.symbol = "BBB"; })), "R4")).toBe("pass");
  });
  it("R5 single position % of NAV uses the underlying", () => {
    const b = mod((x) => { x.order.symbol = "BBB"; x.rules.max_single_position_pct_nav = 25; });
    expect(st(ok(b), "R5")).toBe("fail"); // (100 + 200) / 1000 = 30%
    expect(st(ok(mod((x) => (x.rules.max_single_position_pct_nav = 25))), "R5")).toBe("pass"); // AAA: 20%
  });
  it("R6 min days to expiry: 57 days from 2026-10-22 to 2026-12-18", () => {
    expect(ok(base()).checks.find((c) => c.id === "R6")!.detail).toContain("57 days");
    expect(st(ok(mod((b) => (b.rules.min_days_to_expiry = 58))), "R6")).toBe("fail");
    expect(st(ok(mod((b) => (b.rules.min_days_to_expiry = 57))), "R6")).toBe("pass");
  });
  it("R7 limit orders only: market fails", () => {
    expect(st(ok(mod((b) => (b.order.order_type = "market"))), "R7")).toBe("fail");
  });
  it("R8 no averaging down: basis above limit_price fails", () => {
    expect(st(ok(mod((b) => (b.attestations.existing_cost_basis = 2.5))), "R8")).toBe("fail");
    expect(st(ok(mod((b) => (b.attestations.existing_cost_basis = 1.5))), "R8")).toBe("pass");
    expect(st(ok(base()), "R8")).toBe("skipped");
  });
  it("R9-R11 attestations: empty / not true fail", () => {
    const r = ok(mod((b) => (b.attestations = { thesis_id: "  ", preview_ok: false, approval_ref: null as unknown as string, existing_cost_basis: null })));
    expect(r.failed).toEqual(["R9", "R10", "R11"]);
  });
  it("a reducing sell is checked only against R2, R7, R10, R11", () => {
    const r = ok(mod((b) => { b.order.side = "sell_to_close"; b.account.cash = 0; }));
    expect(r.checks.filter((c) => c.status !== "skipped").map((c) => c.id)).toEqual(["R2", "R7", "R10", "R11"]);
    expect([r.checked, r.skipped]).toEqual([4, 7]);
    expect(r.rules_result).toBe("all_supplied_rules_met");
  });
});

describe("Counsel E2/E3: no defaults; every rule optional; no_rules_checked is never a pass", () => {
  it("no rules -> no_rules_checked, 0 checked, 11 skipped", () => {
    for (const rules of [undefined, {}, { cash_only: false, require_thesis: false }]) {
      const r = ok(mod((b) => (b.rules = rules as Record<string, unknown>)));
      expect(r.rules_result).toBe("no_rules_checked");
      expect([r.checked, r.skipped]).toEqual([0, 11]);
      expect(r.checks.every((c) => c.status === "skipped")).toBe(true);
    }
  });
  it("an omitted numeric rule is skipped, never filled with a value", () => {
    const r = ok(mod((b) => { b.rules = { max_options_pct_nav: 10 }; b.account.cash = 0; }));
    expect(r.checks.filter((c) => c.status !== "skipped").map((c) => c.id)).toEqual(["R3"]);
  });
  it("top-level field is rules_result (no 'result' or 'pass')", () => {
    const r = ok(base()) as Record<string, unknown>;
    expect(r).not.toHaveProperty("result");
    expect(r.journal).toEqual(expect.objectContaining({ rules_result: "all_supplied_rules_met" }));
  });
  it("source has no default thresholds (no `?? <number>` / `|| <number>` on a rule)", () => {
    const src = readFileSync(path.join(ROOT, "lib/trade-gate.ts"), "utf8");
    expect(src).not.toMatch(/rules\.[a-z_]+\s*(\?\?|\|\|)\s*\d/);
  });
});

describe("validation -> 400 (not a pass)", () => {
  const cases: [string, (b: ReturnType<typeof base>) => void][] = [
    ["no order", (b) => delete (b as Partial<typeof b>).order],
    ["bad side for option", (b) => (b.order.side = "buy")],
    ["zero quantity", (b) => (b.order.quantity = 0)],
    ["no nav", (b) => delete (b.account as Partial<typeof b.account>).nav],
    ["positions not array", (b) => ((b.account as Record<string, unknown>).positions = {})],
    ["unknown rule", (b) => (b.rules.max_leverage = 2)],
    ["string threshold", (b) => (b.rules.max_options_pct_nav = "30")],
    ["bad expiration", (b) => (b.order.expiration = "2026-13-01")],
    ["id too long", (b) => (b.attestations.thesis_id = "x".repeat(201))],
    ["bad as_of", (b) => (b.as_of = "yesterday")],
  ];
  for (const [name, f] of cases)
    it(name, () => {
      const r = evaluateTradeGate(mod(f), NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    });
  it("non-object body", () => expect(evaluateTradeGate([1], NOW).ok).toBe(false));
});

describe("Counsel E5: detail text is arithmetic / input facts only", () => {
  const BANNED = /\b(safe|unsafe|risky|risk|should|recommend\w*|consider|too large|too small|good|bad|ok to trade|approved)\b/i;
  it("no judgment words in any detail across pass / fail / skipped / sell / equity cases", () => {
    const variants = [base(), mod((b) => (b.account.cash = 1)), mod((b) => (b.order.side = "sell_to_close")), mod((b) => (b.order.side = "sell_to_open")), mod((b) => (b.rules = {})),
      mod((b) => Object.assign(b.order, { asset_type: "equity", side: "buy", expiration: null, option_type: null })), mod((b) => (b.attestations.existing_cost_basis = 9))];
    for (const v of variants) for (const c of ok(v).checks) expect(c.detail, c.detail).not.toMatch(BANNED);
  });
});

describe("Counsel E7: hashes", () => {
  it("sha256 of canonical order / rules JSON; key order does not change the hash", () => {
    const a = ok(base());
    const b = base();
    const reordered = { ...b, order: Object.fromEntries(Object.entries(b.order).reverse()) };
    expect(ok(reordered).journal.order_hash).toBe(a.journal.order_hash);
    expect(a.journal.order_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.journal.rules_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });
  it("copy never calls the hash 'anonymous'", () => {
    for (const s of [TRADE_GATE_DESCRIPTION, TRADE_GATE_HASH_NOTE, readFileSync(path.join(ROOT, "lib/trade-gate.ts"), "utf8")]) expect(s.toLowerCase()).not.toContain("anonymous");
  });
});

describe("Counsel E1/E4/E8 copy", () => {
  it("E4 disclaimer verbatim; in the description, the 402 config and the route metadata; description <= 500", () => {
    expect(TRADE_GATE_DISCLAIMER).toBe(E4);
    expect(TRADE_GATE_DESCRIPTION).toContain(E4);
    expect(TRADE_GATE_DESCRIPTION.length).toBeLessThanOrEqual(500);
    expect(darkDescription("/api/trade-gate")).toBe(TRADE_GATE_DESCRIPTION);
    expect((ROUTE_METADATA as Record<string, { description: string }>)["/api/trade-gate"].description).toContain(E4);
    const cfg = darkRouteConfig("/api/trade-gate", TRADE_GATE_TIERS[0]!) as Record<string, { description: string }>;
    expect(cfg["/api/trade-gate"].description).toContain(E4);
  });
  it("E1/E8/E7 lines verbatim", () => {
    expect(TRADE_GATE_RULES_NOTE).toBe("Rules are supplied by the caller; Trade Gate ships no default rule set.");
    expect(TRADE_GATE_ID_NOTE).toBe("Do not include personal data, account numbers or credentials.");
    expect(TRADE_GATE_HASH_NOTE).toBe("Hashes are returned to you and not stored by Horizon Pulse.");
  });
  it("E1: no broker name in any Trade Gate file", () => {
    const files = ["lib/trade-gate.ts", "app/api/trade-gate/handler.ts", "app/api/trade-gate/route.tg.ts"];
    const BROKERS = /schwab|fidelity|robinhood|interactive brokers|\bibkr\b|\be\*?trade\b|vanguard|webull|tastytrade|merrill|td ameritrade|704/i;
    for (const f of files) expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(BROKERS);
    expect(TRADE_GATE_DESCRIPTION).not.toMatch(BROKERS);
  });
});

describe("price + flag", () => {
  it("single base tier $0.01 (10000 atomic)", () => {
    expect(TRADE_GATE_TIERS.map((t) => [t.id, t.usd, t.atomicStr])).toEqual([["base", "$0.01", "10000"]]);
  });
  it("dark by default: not a page extension unless HP_TRADE_GATE_ENABLED is exactly 'true'", () => {
    expect(DARK_PATHS.find((d) => d.path === "/api/trade-gate")).toEqual(expect.objectContaining({ flag: "HP_TRADE_GATE_ENABLED", ext: "tg" }));
    expect(darkPageExtensions({})).not.toContain("tg.ts");
    expect(darkPageExtensions({ HP_TRADE_GATE_ENABLED: "1" })).not.toContain("tg.ts");
    expect(darkPageExtensions({ HP_TRADE_GATE_ENABLED: "true" })).toContain("tg.ts");
  });
  it("not in any public listing source (catalog, llms, openapi, well-known)", () => {
    const hits = execSync("git grep -l -e 'trade-gate' -- lib app public scripts mcp ':!lib/trade-gate.ts' ':!app/api/trade-gate' ':!lib/dark-paths.ts' ':!lib/dark-routes.ts' ':!lib/route-metadata.ts' ':!scripts/smoke-dark-404.mjs' || true", { cwd: ROOT, encoding: "utf8" }).trim();
    expect(hits).toBe("");
  });
});

afterEach(() => { vi.unstubAllEnvs(); resetRateLimitsForTests(); });

describe("route: flag off 404; flag on 402 unpaid", () => {
  it("flag unset: every method 404", async () => {
    vi.stubEnv("HP_TRADE_GATE_ENABLED", "");
    for (const m of ["GET", "POST", "OPTIONS"]) {
      const res = await (tgRoute as unknown as Record<string, (r: NextRequest) => Promise<Response>>)[m]!(new NextRequest("https://horizonpulse.dev/api/trade-gate", { method: m }));
      expect(res.status).toBe(404);
    }
  });
  it("flag on: unpaid POST -> 402 with $0.01 and the Main payTo from config", async () => {
    vi.stubEnv("HP_TRADE_GATE_ENABLED", "true");
    const res = await tgRoute.POST(new NextRequest("https://horizonpulse.dev/api/trade-gate", { method: "POST", body: JSON.stringify(base()), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(402);
    const { getPayTo } = await import("@/lib/config");
    const cfg = darkRouteConfig("/api/trade-gate", TRADE_GATE_TIERS[0]!) as Record<string, { accepts: { payTo: string; price: string }[] }>;
    expect(cfg["/api/trade-gate"].accepts[0]).toEqual(expect.objectContaining({ price: "$0.01", payTo: getPayTo() }));
  });
});

describe("handler (paid path body)", () => {
  const tier = TRADE_GATE_TIERS[0]!;
  const post = (body: string) => new NextRequest("https://horizonpulse.dev/api/trade-gate", { method: "POST", body, headers: { "content-type": "application/json" } });
  it("200: rules_result, counts, hashes, notes, E4 disclaimer; input never echoed", async () => {
    const b = base();
    b.attestations.thesis_id = "opaque-thesis-xyz";
    const res = await tradeGateHandler(post(JSON.stringify(b)), tier, "hpr_test", () => NOW);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.disclaimer).toBe(E4);
    expect(j.rules_result).toBe("all_supplied_rules_met");
    expect(j.notes).toEqual({ rules: TRADE_GATE_RULES_NOTE, hashes: TRADE_GATE_HASH_NOTE, ids: TRADE_GATE_ID_NOTE });
    expect(j.receipt.amountAtomic).toBe("10000");
    const s = JSON.stringify(j);
    expect(s).not.toContain("opaque-thesis-xyz");
    expect(j).not.toHaveProperty("account");
    expect(j).not.toHaveProperty("attestations");
  });
  it("errors are not charged and still carry the disclaimer", async () => {
    for (const [req, code] of [[post("{nope"), 400], [post(JSON.stringify({})), 400], [post("x".repeat(70_000)), 413], [new NextRequest("https://horizonpulse.dev/api/trade-gate"), 400]] as const) {
      const res = await tradeGateHandler(req, tier, "hpr_test", () => NOW);
      expect(res.status).toBe(code);
      const j = await res.json();
      expect(j.charged).toBe(false);
      expect(j.disclaimer).toBe(E4);
    }
  });
  it("E6: handler and engine never store or log (no console, KV, redis, fs writes)", () => {
    for (const f of ["lib/trade-gate.ts", "app/api/trade-gate/handler.ts"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/console\.|redis|upstash|kv\b|writeFile|appendFile|fetch\(/i);
    }
  });
});
