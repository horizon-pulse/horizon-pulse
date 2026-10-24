/**
 * Aave V4 Equities collateral data (DARK, HP_AAVE_EQUITIES_ENABLED). Michael via Odin 11:37 AM ET 10/23.
 * RPC is faked: the fake answers each Multicall3 sub-call by function name. Values below are test values only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { AAVE_EQUITIES_DESCRIPTION, AAVE_EQUITIES_DISCLAIMER, AAVE_EQUITIES_UNTRUSTED, AAVE_V4_BASE, AAVE_V4_BASE_ASSETS, AAVE_V4_BASE_PRICE_FEEDS, EQUITY_SYMBOLS, RPC_DEADLINE_MS, feedSession, fixed, parseInput, readCollateralData, STALE_AFTER_SECONDS, US_MARKET_HOLIDAYS, V4_ABI, type Deps } from "@/lib/aave-equities";
import { aaveEquitiesHandler } from "@/app/api/aave-equities/collateral-data/handler";
import * as route from "@/app/api/aave-equities/collateral-data/route.aave";
import { AAVE_EQUITIES_TIERS, darkRouteConfig, resetRateLimitsForTests } from "@/lib/dark-routes";
import { DARK_PATHS, darkPageExtensions } from "@/lib/dark-paths";

const ROOT = path.resolve(__dirname, "..");
const MC = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
// Wed 2026-10-21 15:00 UTC = 11:00 ET (open session)
const NOW = Date.parse("2026-10-21T15:00:00Z");
const SYMS = [...EQUITY_SYMBOLS, "USDC"] as const;

type Over = { paused?: Record<string, boolean>; cf?: Record<string, number>; updatedAgo?: number; hubMismatch?: boolean; failFn?: string; rpcDown?: boolean; feedMismatch?: string; hang?: boolean; deadlineMs?: number; skewUrl?: string; downUrl?: string; urls?: string[] };
function fakeDeps(o: Over = {}, now = NOW): Deps & { calls: number; tags: string[] } {
  const st = { calls: 0, tags: [] as string[] };
  let curUrl = "";
  const answer = (target: string, fn: string, args: readonly unknown[]): unknown => {
    const id = Number(args[0] ?? 0);
    const sym = SYMS[id] ?? "USDC";
    switch (fn) {
      case "getReserveCount": return 8n;
      case "getLiquidationConfig": return { targetHealthFactor: 124n * 10n ** 16n, healthFactorForMaxBonus: 9n * 10n ** 17n, liquidationBonusFactor: 9000 };
      case "getBlockNumber": return 123n;
      case "getCurrentBlockTimestamp": return BigInt(Math.floor(now / 1000));
      case "getReserve": return { underlying: AAVE_V4_BASE_ASSETS[sym]!.toLowerCase(), hub: o.hubMismatch ? "0x000000000000000000000000000000000000dEaD" : AAVE_V4_BASE.EQUITIES_HUB, assetId: id, decimals: sym === "USDC" ? 6 : 8, collateralRisk: 0, flags: 0, dynamicConfigKey: 0 };
      case "getReserveConfig": return { collateralRisk: 0, paused: o.paused?.[sym] ?? false, frozen: false, borrowable: sym === "USDC", receiveSharesEnabled: true };
      case "getDynamicReserveConfig": return sym === "USDC" ? { collateralFactor: 0, maxLiquidationBonus: 10000, liquidationFee: 0 } : { collateralFactor: o.cf?.[sym] ?? 7000, maxLiquidationBonus: 10550, liquidationFee: 1000 };
      case "getReserveSuppliedAssets": if (o.skewUrl === curUrl) return 1n; return sym === "USDC" ? 6_000_000n * 10n ** 6n : 1000n * 10n ** 8n;
      case "getSpokeConfig": return { addCap: sym === "USDC" ? 32_000_000 : 4000, drawCap: sym === "USDC" ? 21_000_000 : 0, riskPremiumThreshold: 0, active: true, halted: false };
      case "getReservePrice": return sym === "USDC" ? 100_000_000n : 200n * 10n ** 8n;
      case "getReserveSource": return o.feedMismatch === sym ? "0x000000000000000000000000000000000000bEEF" : AAVE_V4_BASE_PRICE_FEEDS[sym]!;
      case "getAssetDrawnRate": return 4n * 10n ** 25n; // 4% in RAY
      case "getAssetLiquidity": return 1_000_000n * 10n ** 6n;
      case "getAssetOwed": return [4_000_000n * 10n ** 6n, 0n];
      case "getAssetSwept": return 0n;
      case "getSpokeTotalOwed": return 20_500_000n * 10n ** 6n;
      case "decimals": return 8;
      case "latestRoundData": { const u = BigInt(Math.floor(now / 1000) - (o.updatedAgo ?? 600)); return [1n, 200n * 10n ** 8n, u, u, 1n]; }
    }
    throw new Error(`unhandled ${fn} ${target}`);
  };
  const f = (async (url: string, init?: RequestInit) => {
    st.calls++;
    if (o.rpcDown || o.downUrl === url) return new Response("nope", { status: 503 });
    if (o.hang) return new Promise<Response>((_, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    const body = JSON.parse(String(init!.body)) as { params: [{ data: Hex }, string] };
    st.tags.push(body.params[1]);
    curUrl = url;
    const { args } = decodeFunctionData({ abi: MC, data: body.params[0].data });
    const results = (args![0] as unknown as { target: string; callData: Hex }[]).map((c) => {
      const d = decodeFunctionData({ abi: V4_ABI, data: c.callData });
      if (d.functionName === o.failFn) return { success: false, returnData: "0x" as Hex };
      const v = answer(c.target, d.functionName, (d.args ?? []) as readonly unknown[]);
      return { success: true, returnData: encodeFunctionResult({ abi: V4_ABI, functionName: d.functionName, result: v } as never) };
    });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi: MC, functionName: "aggregate3", result: results }) }), { status: 200 });
  }) as unknown as typeof fetch;
  return Object.assign(st, { fetch: f, now: () => now, rpcs: () => o.urls ?? ["https://rpc-a.test", "https://rpc-b.test"], ...(o.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {}) });
}
const ALL = { token: null, collateralAmount: null, debtUsdc: null };

afterEach(() => { vi.unstubAllEnvs(); resetRateLimitsForTests(); });

describe("addresses (official Aave address book AaveV4Base, checked onchain 10/23)", () => {
  it("hub, spoke, oracle and the 8 underlyings are pinned exactly", () => {
    expect(AAVE_V4_BASE).toEqual({ EQUITIES_HUB: "0xa4d5947Eb727A052bae69C593FfC84247EC9864E", MAG7_SPOKE: "0x17905Db0e4A3514467539956c084180616AE7B8D", MAG7_SPOKE_ORACLE: "0xaBaf048fD7675Ea34a84332371ffd5D55E322A47" });
    expect(Object.keys(AAVE_V4_BASE_ASSETS).sort()).toEqual([...EQUITY_SYMBOLS, "USDC"].sort());
    expect(AAVE_V4_BASE_ASSETS.USDC).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
  it("no risk parameter is hardcoded in the engine (no governance table values)", () => {
    const src = readFileSync(path.join(ROOT, "lib/aave-equities.ts"), "utf8");
    for (const v of ["7800", "7300", "7600", "6500", "7900", "15_000", "15000", "24000", "21_000_000", "21000000", "32000000", "10550"]) expect(src, v).not.toContain(v);
  });
});

describe("read engine (fake RPC)", () => {
  it("all 7 equities + USDC, values decoded from the chain", async () => {
    const r = await readCollateralData(ALL, fakeDeps());
    if (!r.ok) throw new Error(r.error);
    expect(r.equities.map((e) => e.token)).toEqual([...EQUITY_SYMBOLS]);
    const e = r.equities[0]!;
    expect(e).toEqual(expect.objectContaining({ collateral_factor_pct: "70", max_liquidation_bonus_pct: "5.5", liquidation_fee_pct: "10", add_cap_tokens: "4000", supplied_tokens: "1000", add_cap_used_pct: "25" }));
    expect(e.price).toEqual(expect.objectContaining({ usd: "200", market_session: "open", price_held: false, age_seconds: 600 }));
    expect(r.usdc).toEqual(expect.objectContaining({ drawn_apr_pct: "4", utilization_pct: "80", hub_liquidity_usdc: "1000000", available_usdc: "500000", spoke_draw_cap_usdc: "21000000" }));
    expect(r.liquidation).toEqual({ target_health_factor: "1.24", health_factor_for_max_bonus: "0.9", liquidation_bonus_factor_pct: "90" });
    expect(r.equities.some((x) => x.computed)).toBe(false);
  });
  it("params are read live: a changed collateral factor shows up", async () => {
    const r = await readCollateralData(ALL, fakeDeps({ cf: { TSLAc: 6450 } }));
    expect(r.ok && r.equities.find((e) => e.token === "TSLAc")!.collateral_factor_pct).toBe("64.5");
  });
  it("paused reserve is reported, not hidden", async () => {
    const r = await readCollateralData({ ...ALL, token: "AAPLc" }, fakeDeps({ paused: { AAPLc: true } }));
    expect(r.ok && r.equities[0]!.status.reserve_paused).toBe(true);
  });
  it("computed: max borrow + health factor + implied liquidation price, labeled", async () => {
    const r = await readCollateralData({ token: "NVDAc", collateralAmount: "10", debtUsdc: "1000" }, fakeDeps());
    if (!r.ok) throw new Error(r.error);
    const c = r.equities[0]!.computed!;
    expect(c).toEqual(expect.objectContaining({ collateral_value_usd: "2000", borrowing_level_usdc_at_collateral_factor: "1400", health_factor: "1.4", liquidation_level_price_usd: "142.8571" }));
    expect(c.label).toMatch(/Computed from current onchain parameters/);
    expect(c.price_held_warning).toBeUndefined();
  });
  it("held price: weekend session and stale timestamp flag price_held and warn on computed values", async () => {
    const sat = Date.parse("2026-10-24T16:00:00Z");
    const r = await readCollateralData({ token: "NVDAc", collateralAmount: "1", debtUsdc: null }, fakeDeps({ updatedAgo: 20 * 3600 }, sat));
    expect(r.ok && r.equities[0]!.price).toEqual(expect.objectContaining({ market_session: "weekend_closed", price_held: true }));
    expect(r.ok && r.equities[0]!.computed!.price_held_warning).toMatch(/holding its last value/);
    const stale = await readCollateralData(ALL, fakeDeps({ updatedAgo: 30 * 3600 }));
    expect(stale.ok && stale.equities[0]!.price.price_held).toBe(true);
  });
  it("staleness path A (calendar only): holiday session with a FRESH feed is held", async () => {
    const thanksgiving = Date.parse("2026-11-26T15:00:00Z"); // Thu 10:00 ET, NYSE holiday, weekday
    const r = await readCollateralData(ALL, fakeDeps({ updatedAgo: 60 }, thanksgiving));
    if (!r.ok) throw new Error(r.error);
    expect(r.equities[0]!.price.age_seconds).toBe(60);
    expect(r.equities[0]!.price).toEqual(expect.objectContaining({ market_session: "holiday_closed", price_held: true }));
  });
  it("staleness path B (feed age only): open session, age > 24h10m is held; at the limit it is not", async () => {
    const over = await readCollateralData(ALL, fakeDeps({ updatedAgo: STALE_AFTER_SECONDS + 1 }));
    if (!over.ok) throw new Error(over.error);
    expect(over.equities[0]!.price).toEqual(expect.objectContaining({ market_session: "open", price_held: true }));
    const at = await readCollateralData(ALL, fakeDeps({ updatedAgo: STALE_AFTER_SECONDS }));
    if (!at.ok) throw new Error(at.error);
    expect(at.equities[0]!.price).toEqual(expect.objectContaining({ market_session: "open", price_held: false }));
    expect(STALE_AFTER_SECONDS).toBe(24 * 3600 + 600);
  });
  it("holiday calendar refresh tripwire: fails on/after 2027-12-01 (real clock)", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(today < "2027-12-01", `US_MARKET_HOLIDAYS in lib/aave-equities.ts ends ${US_MARKET_HOLIDAYS[US_MARKET_HOLIDAYS.length - 1]}: REFRESH THE HOLIDAY CALENDAR (add 2028 NYSE holidays) and move this tripwire date forward.`).toBe(true);
    expect(US_MARKET_HOLIDAYS[US_MARKET_HOLIDAYS.length - 1]! >= "2027-12-01").toBe(true);
  });
  it("sessions: Fri 20:00 ET close, Sun 20:00 ET reopen, holidays", () => {
    expect(feedSession(Date.parse("2026-10-23T23:59:00Z"))).toBe("open"); // Fri 19:59 ET
    expect(feedSession(Date.parse("2026-10-24T00:00:00Z"))).toBe("weekend_closed"); // Fri 20:00 ET
    expect(feedSession(Date.parse("2026-10-25T23:59:00Z"))).toBe("weekend_closed"); // Sun 19:59 ET
    expect(feedSession(Date.parse("2026-10-26T00:00:00Z"))).toBe("open"); // Sun 20:00 ET
    expect(feedSession(Date.parse("2026-11-26T15:00:00Z"))).toBe("holiday_closed");
  });
  it("Sentinel LOW-1: overall RPC deadline trips -> 502 rpc_unavailable (not charged), well before the per-RPC 8 s timeout", async () => {
    expect(RPC_DEADLINE_MS).toBe(45_000);
    const t0 = Date.now();
    const r = await readCollateralData(ALL, fakeDeps({ hang: true, deadlineMs: 50 }));
    expect(r).toEqual(expect.objectContaining({ ok: false, status: 502, code: "rpc_unavailable" }));
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
  it("Sentinel NOTE-1: oracle source != address-book feed -> 502 (not charged); pinned feeds match the address book", async () => {
    expect(await readCollateralData(ALL, fakeDeps({ feedMismatch: "TSLAc" }))).toEqual(expect.objectContaining({ ok: false, status: 502, code: "unexpected_onchain_state" }));
    expect(await readCollateralData({ token: "NVDAc", collateralAmount: null, debtUsdc: null }, fakeDeps({ feedMismatch: "USDC" }))).toEqual(expect.objectContaining({ ok: false, code: "unexpected_onchain_state" }));
    expect(Object.keys(AAVE_V4_BASE_PRICE_FEEDS).sort()).toEqual([...EQUITY_SYMBOLS, "USDC"].sort());
    expect(AAVE_V4_BASE_PRICE_FEEDS.NVDAc).toBe("0x04689a41629776563E6822F76f2e57D148d28513");
  });
  it("hub mismatch, missing fields, RPC down: 502 (not charged)", async () => {
    expect(await readCollateralData(ALL, fakeDeps({ hubMismatch: true }))).toEqual(expect.objectContaining({ ok: false, status: 502, code: "unexpected_onchain_state" }));
    expect(await readCollateralData(ALL, fakeDeps({ failFn: "getDynamicReserveConfig" }))).toEqual(expect.objectContaining({ ok: false, code: "unexpected_onchain_state" }));
    expect(await readCollateralData(ALL, fakeDeps({ rpcDown: true }))).toEqual(expect.objectContaining({ ok: false, code: "rpc_unavailable" }));
  });
  it("fixed(): bigint formatting", () => {
    expect(fixed(123456789n, 8)).toBe("1.23456789");
    expect(fixed(123456789n, 8, 2)).toBe("1.23");
    expect(fixed(0n, 6)).toBe("0");
  });
});

describe("input", () => {
  it("token aliases and validation", () => {
    expect(parseInput({ token: "nvda" })).toEqual({ ok: true, input: { token: "NVDAc", collateralAmount: null, debtUsdc: null } });
    expect(parseInput({ token: "TSLAc", collateral_amount: "1.5" }).ok).toBe(true);
    for (const bad of [{ token: "CRCL" }, { collateral_amount: "1" }, { token: "AAPL", collateral_amount: "-1" }, { token: "AAPL", collateral_amount: "0" }, { token: "AAPL", collateral_amount: "1e9" }, { token: "AAPL", debt_usdc: "5" }, { token: ["AAPL"] }]) expect(parseInput(bad as never).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe("handler (paid path body)", () => {
  const tier = AAVE_EQUITIES_TIERS[0]!;
  const u = "https://horizonpulse.dev/api/aave-equities/collateral-data";
  it("200 GET: priced, receipt, data, sources, untrusted line, disclaimer", async () => {
    const res = await aaveEquitiesHandler(new NextRequest(`${u}?token=METAc&collateral_amount=2`), tier, "hpr_test", fakeDeps());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.receipt).toEqual(expect.objectContaining({ amountAtomic: "10000", route: "/api/aave-equities/collateral-data" }));
    expect(j.untrusted).toBe(AAVE_EQUITIES_UNTRUSTED);
    expect(j.disclaimer).toBe(AAVE_EQUITIES_DISCLAIMER);
    expect(j.equities).toHaveLength(1);
    expect(j.equities[0].computed.borrowing_level_usdc_at_collateral_factor).toBe("280");
  });
  it("200 POST JSON", async () => {
    const res = await aaveEquitiesHandler(new NextRequest(u, { method: "POST", body: JSON.stringify({ token: "AAPLc" }), headers: { "content-type": "application/json" } }), tier, "hpr_test", fakeDeps());
    expect(res.status).toBe(200);
  });
  it("errors are not charged and carry the disclaimer; bad input makes no RPC call", async () => {
    const d = fakeDeps();
    for (const [req, code] of [[new NextRequest(`${u}?token=XYZ`), 400], [new NextRequest(u, { method: "POST", body: "{nope" }), 400], [new NextRequest(u, { method: "POST", body: "[]" }), 400], [new NextRequest(u, { method: "POST", body: "x".repeat(5000) }), 413]] as const) {
      const res = await aaveEquitiesHandler(req, tier, "hpr_test", d);
      expect(res.status).toBe(code);
      const j = await res.json();
      expect(j.charged).toBe(false);
      expect(j.disclaimer).toBe(AAVE_EQUITIES_DISCLAIMER);
    }
    expect(d.calls).toBe(0);
    const down = await aaveEquitiesHandler(new NextRequest(u), tier, "hpr_test", fakeDeps({ rpcDown: true }));
    expect(down.status).toBe(502);
    expect((await down.json()).charged).toBe(false);
  });
  it("never stores or logs; no LLM step", () => {
    for (const f of ["lib/aave-equities.ts", "lib/aave-equities-body.ts", "app/api/aave-equities/collateral-data/handler.ts"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/console\.|redis|upstash|\bkv\b|writeFile|appendFile/i);
      expect(src, f).not.toMatch(/from ["'][^"']*(llm|premium|grok|openai|anthropic)/i);
    }
  });
});

describe("copy (market data only; Counsel review pending)", () => {
  const ALL_COPY = [AAVE_EQUITIES_DESCRIPTION, AAVE_EQUITIES_DISCLAIMER].join(" ");
  it("Reg S line, no-affiliation line, not-advice, description <= 500 chars", () => {
    expect(AAVE_EQUITIES_DESCRIPTION.length).toBeLessThanOrEqual(500);
    expect(AAVE_EQUITIES_DISCLAIMER).toMatch(/Regulation S/);
    expect(AAVE_EQUITIES_DISCLAIMER).toContain("are not available to U.S. persons or in other restricted jurisdictions; check your own eligibility");
    expect(AAVE_EQUITIES_DESCRIPTION).toContain("are not available to U.S. persons or in other restricted jurisdictions; check your own eligibility");
    expect(AAVE_EQUITIES_DISCLAIMER).toMatch(/or to the Aave market/);
    expect(ALL_COPY).not.toMatch(/eligible non-US persons/);
    expect(AAVE_EQUITIES_DISCLAIMER).toMatch(/not affiliated with Aave, Coinbase or Base/);
    expect(AAVE_EQUITIES_DESCRIPTION).toMatch(/Reg S/);
    expect(AAVE_EQUITIES_DESCRIPTION).toMatch(/not affiliated with Aave, Coinbase or Base/i);
  });
  it("no guidance / advice-shaped / 'you can borrow' wording", () => {
    expect(ALL_COPY).not.toMatch(/\bguidance\b|you can borrow|borrow against your|\brecommend(ed|s)?\b(?! *, offer)|\bshould\b|\bsafe\b|\bguarantee/i);
  });
});

describe("dark: flag + discovery absence", () => {
  it("single base tier $0.01", () => {
    expect(AAVE_EQUITIES_TIERS.map((t) => [t.id, t.usd, t.atomicStr])).toEqual([["base", "$0.01", "10000"]]);
  });
  it("not a page extension unless HP_AAVE_EQUITIES_ENABLED is exactly 'true'", () => {
    expect(DARK_PATHS.find((d) => d.path === "/api/aave-equities/collateral-data")).toEqual(expect.objectContaining({ flag: "HP_AAVE_EQUITIES_ENABLED", ext: "aave" }));
    expect(darkPageExtensions({})).not.toContain("aave.ts");
    expect(darkPageExtensions({ HP_AAVE_EQUITIES_ENABLED: "1" })).not.toContain("aave.ts");
    expect(darkPageExtensions({ HP_AAVE_EQUITIES_ENABLED: "true" })).toContain("aave.ts");
  });
  it("not in any public listing source (catalog, llms, openapi, well-known, MCP)", () => {
    const hits = execSync("git grep -l -i -e 'aave-equities' -e 'aave_equities' -e 'aaveequities' -- lib app public scripts mcp ':!lib/aave-equities.ts' ':!lib/aave-equities-body.ts' ':!app/api/aave-equities' ':!lib/dark-paths.ts' ':!lib/dark-routes.ts' ':!lib/route-metadata.ts' ':!scripts/smoke-dark-404.mjs' || true", { cwd: ROOT, encoding: "utf8" }).trim();
    expect(hits).toBe("");
  });
  it("flag unset: every method 404", async () => {
    vi.stubEnv("HP_AAVE_EQUITIES_ENABLED", "");
    for (const m of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await (route as unknown as Record<string, (r: NextRequest) => Promise<Response>>)[m]!(new NextRequest("https://horizonpulse.dev/api/aave-equities/collateral-data", { method: m }));
      expect(res.status, m).toBe(404);
      expect(res.headers.get("payment-required")).toBeNull();
    }
  });
  it("flag on: unpaid GET -> 402 at $0.01 with the Main payTo from config", async () => {
    vi.stubEnv("HP_AAVE_EQUITIES_ENABLED", "true");
    const res = await route.GET(new NextRequest("https://horizonpulse.dev/api/aave-equities/collateral-data?token=NVDAc"));
    expect(res.status).toBe(402);
    const { getPayTo } = await import("@/lib/config");
    const cfg = darkRouteConfig("/api/aave-equities/collateral-data", AAVE_EQUITIES_TIERS[0]!) as Record<string, { accepts: { payTo: string; price: string }[] }>;
    expect(cfg["/api/aave-equities/collateral-data"].accepts[0]).toEqual(expect.objectContaining({ price: "$0.01", payTo: getPayTo() }));
  });
});

describe("RPC quorum at a pinned block (Sentinel LOW-2)", () => {
  it("every round after the head read is pinned to head - 2 (123 -> 0x79)", async () => {
    const d = fakeDeps();
    const r = await readCollateralData(ALL, d);
    expect(r.ok).toBe(true);
    expect(d.tags[0]).toBe("latest");
    expect(new Set(d.tags.filter((t) => t !== "latest"))).toEqual(new Set(["0x79"]));
  });
  it("two RPCs that disagree -> 502 unexpected_onchain_state, not charged", async () => {
    const r = await readCollateralData(ALL, fakeDeps({ skewUrl: "https://rpc-b.test" }));
    expect(r).toMatchObject({ ok: false, status: 502, code: "unexpected_onchain_state" });
    expect((r as { error: string }).error).toContain("disagree");
  });
  it("only one RPC answering -> 502 rpc_unavailable (a single answer is never trusted)", async () => {
    const r = await readCollateralData(ALL, fakeDeps({ downUrl: "https://rpc-b.test" }));
    expect(r).toMatchObject({ ok: false, status: 502, code: "rpc_unavailable" });
    expect((await readCollateralData(ALL, fakeDeps({ urls: ["https://rpc-a.test"] }))).ok).toBe(false);
  });
  it("duplicate URLs count once", async () => {
    expect((await readCollateralData(ALL, fakeDeps({ urls: ["https://rpc-a.test", "https://rpc-a.test"] }))).ok).toBe(false);
  });
  it("3 RPCs, one down, two agree -> ok", async () => {
    const r = await readCollateralData(ALL, fakeDeps({ urls: ["https://x.test", "https://rpc-a.test", "https://rpc-b.test"], downUrl: "https://x.test" }));
    expect(r.ok).toBe(true);
  });
});

describe("Content-Length (Sentinel NOTE-3)", () => {
  it("an invalid Content-Length is rejected with 400 before any RPC", async () => {
    const d = fakeDeps();
    const req = new NextRequest("https://x.test/api/aave-equities/collateral-data", { method: "POST", body: "{}", headers: { "content-length": "abc", "content-type": "application/json" } });
    const res = await aaveEquitiesHandler(req, AAVE_EQUITIES_TIERS[0]!, "r1", d);
    expect(res.status).toBe(400);
    expect(d.calls).toBe(0);
  });
});
