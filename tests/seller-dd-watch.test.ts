/** Sentinel L-5 watch + C3 reconcile cron: flag gating, auth, alerts, vercel.json schedule. No network. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { ddKeys, reserveTestPay } from "@/lib/seller-dd/caps";
import { APPROVAL_TOPIC, AUTH_USED_TOPIC, TRANSFER_TOPIC, runWatch, watchKeys, type Rpc } from "@/lib/seller-dd/watch";
import { PAUSE_KEY, readPause, judgePreflight, observeKillSwitch, setPause } from "@/lib/seller-dd/pause";
import { GET, setSellerDdCronForTests } from "@/app/api/seller-dd/cron/route";

const key = generatePrivateKey();
const TESTER = privateKeyToAccount(key).address;
const pad = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;
const FUNDER = "0x" + "f1".repeat(20);
const NONCE = "0x" + "ab".repeat(32);
type Logs = { balance?: bigint; head?: number; out?: any[]; in?: any[]; appr?: any[]; auth?: any[]; txCount?: string };
function rpcWith(l: Logs, calls: string[] = []): Rpc {
  return async (m, p: any) => {
    calls.push(m);
    if (m === "eth_blockNumber") return `0x${(l.head ?? 0x10000).toString(16)}`;
    if (m === "eth_getTransactionCount") return l.txCount ?? "0x0";
    if (m === "eth_call") return `0x${(l.balance ?? 3_000_000n).toString(16).padStart(64, "0")}`;
    const t = p[0].topics;
    if (t[0] === TRANSFER_TOPIC && t[1]) return l.out ?? [];
    if (t[0] === TRANSFER_TOPIC) return l.in ?? [];
    if (t[0] === APPROVAL_TOPIC) return l.appr ?? [];
    if (t[0] === AUTH_USED_TOPIC) return l.auth ?? [];
    return [];
  };
}
const log = (tx: string, topics: string[], data = "0x0") => ({ transactionHash: tx, blockNumber: "0xff00", topics, data });
const mk = () => new MemoryPremiumStore();
const env = { HP_DD_TESTPAY: "on", HP_DD_FUNDING_ALLOWLIST: FUNDER };

describe("L-5 watch", () => {
  it("clean window -> no alerts, cursor advances", async () => {
    const s = mk();
    const r = await runWatch(s, TESTER, rpcWith({}), env);
    expect(r).toMatchObject({ ok: true, alerts: [] });
    expect(await s.get(watchKeys.cursor())).toBe(String(0x10000));
  });
  it("outbound transfer matched to a reserved nonce -> no alert; unmatched -> HIGH", async () => {
    const s = mk();
    await reserveTestPay(s, { request_id: "r1", seller: "a.com", domain: "a.com", ip: "1.1.1.1", payTo: "0x" + "4e".repeat(20), value_usd: 0.01, nonce: NONCE, validBefore: 9e9, at: Date.now() }, Date.now());
    expect(await s.get(ddKeys.nonce(NONCE))).toBe("r1");
    const ok = await runWatch(s, TESTER, rpcWith({ out: [log("0x1", [TRANSFER_TOPIC, pad(TESTER)])], auth: [log("0x1", [AUTH_USED_TOPIC, pad(TESTER), NONCE])] }), env);
    expect(ok.alerts).toEqual([]);
    const bad = await runWatch(mk(), TESTER, rpcWith({ out: [log("0x2", [TRANSFER_TOPIC, pad(TESTER)])] }), env);
    expect(bad.alerts.map((a) => a.kind)).toEqual(["seller_dd_outbound_without_reservation", "seller_dd_auto_paused"]);
  });
  it("approve/permit (Approval event) -> HIGH", async () => {
    const r = await runWatch(mk(), TESTER, rpcWith({ appr: [log("0x3", [APPROVAL_TOPIC, pad(TESTER)])] }), env);
    expect(r.alerts.map((a) => a.kind)).toEqual(["seller_dd_approval_event"]);
  });
  it("inbound from an approved funder -> none; from anyone else -> HIGH; no allowlist -> every inbound alerts", async () => {
    const good = await runWatch(mk(), TESTER, rpcWith({ in: [log("0x4", [TRANSFER_TOPIC, pad(FUNDER), pad(TESTER)])] }), env);
    expect(good.alerts).toEqual([]);
    const bad = await runWatch(mk(), TESTER, rpcWith({ in: [log("0x5", [TRANSFER_TOPIC, pad("0x" + "99".repeat(20)), pad(TESTER)])] }), env);
    expect(bad.alerts.map((a) => a.kind)).toEqual(["seller_dd_inbound_from_unapproved"]);
    const none = await runWatch(mk(), TESTER, rpcWith({ in: [log("0x4", [TRANSFER_TOPIC, pad(FUNDER), pad(TESTER)])] }), { HP_DD_TESTPAY: "on" });
    expect(none.alerts.map((a) => a.kind)).toEqual(["seller_dd_inbound_from_unapproved"]);
  });
  it("tester sent its own tx (account nonce > 0) -> HIGH", async () => {
    const r = await runWatch(mk(), TESTER, rpcWith({ txCount: "0x1" }), env);
    expect(r.alerts.map((a) => a.kind)).toEqual(["seller_dd_tester_sent_own_tx", "seller_dd_auto_paused"]);
  });
  it("kill switch flip -> HIGH (both directions)", async () => {
    const s = mk();
    await runWatch(s, TESTER, rpcWith({}), env);
    const r = await runWatch(s, TESTER, rpcWith({}), { ...env, HP_DD_TESTPAY: "off" });
    expect(r.alerts.map((a) => a.kind)).toContain("seller_dd_kill_switch_flipped");
    const r2 = await runWatch(s, TESTER, rpcWith({}), env);
    expect(r2.alerts[0]).toMatchObject({ kind: "seller_dd_kill_switch_flipped", detail: "off->on" });
  });
  it("W1: starts 43,000 blocks behind -> catches up to head in one run, cursor saved per chunk, no behind alert", async () => {
    const s = mk();
    const head = 0x10000;
    await s.set(watchKeys.cursor(), String(head - 43_000), 100);
    const ranges: [number, number][] = [];
    const cursors: string[] = [];
    const origSet = s.set.bind(s);
    s.set = async (k: string, v: string, t: number) => { if (k === watchKeys.cursor()) cursors.push(v); return origSet(k, v, t); };
    const base = rpcWith({});
    const rpc: Rpc = async (m, p: any) => { if (m === "eth_getLogs" && p[0].topics[0] === AUTH_USED_TOPIC) ranges.push([parseInt(p[0].fromBlock, 16), parseInt(p[0].toBlock, 16)]); return base(m, p); };
    const r = await runWatch(s, TESTER, rpc, env);
    expect(r.alerts).toEqual([]);
    expect(ranges).toHaveLength(5);
    expect(ranges[0]![0]).toBe(head - 43_000 + 1);
    expect(ranges.at(-1)![1]).toBe(head);
    for (let k = 1; k < ranges.length; k++) expect(ranges[k]![0]).toBe(ranges[k - 1]![1] + 1);
    expect(ranges.every(([a, b]) => b - a + 1 <= 9_000)).toBe(true);
    expect(cursors).toHaveLength(5);
    expect(await s.get(watchKeys.cursor())).toBe(String(head));
  });
  it("W1: run ends behind (chunk cap / time budget) -> HIGH seller_dd_watch_behind, progress kept", async () => {
    const s = mk();
    const H = 1_000_000;
    await s.set(watchKeys.cursor(), String(H - 200_000), 100);
    const r = await runWatch(s, TESTER, rpcWith({ head: H }), env);
    expect(r.alerts.map((a) => a.kind)).toEqual(["seller_dd_watch_gap", "seller_dd_watch_behind"]);
    expect(Number(await s.get(watchKeys.cursor()))).toBe(H - 200_000 + 12 * 9_000);
    let t = 0;
    const s2 = mk();
    await s2.set(watchKeys.cursor(), String(0x10000 - 43_000), 100);
    const r2 = await runWatch(s2, TESTER, rpcWith({}), env, () => (t += 30_000));
    expect(r2.alerts.map((a) => a.kind)).toContain("seller_dd_watch_behind");
    expect(Number(await s2.get(watchKeys.cursor()))).toBeGreaterThan(0x10000 - 43_000);
  });
  it("LOW-2: cumulative inbound > $25 -> HIGH (across runs); balance > $10 -> HIGH; under both -> none", async () => {
    const s = mk();
    const fund = (usd: number) => log("0xf", [TRANSFER_TOPIC, pad(FUNDER), pad(TESTER)], `0x${(usd * 1_000_000).toString(16)}`);
    const r1 = await runWatch(s, TESTER, rpcWith({ in: [fund(10), fund(10)] }), env);
    expect(r1.alerts).toEqual([]);
    await s.del(watchKeys.cursor());
    const r2 = await runWatch(s, TESTER, rpcWith({ in: [fund(6)] }), env);
    expect(r2.alerts.map((a) => a.kind)).toEqual(["seller_dd_funding_over_cap"]);
    const r3 = await runWatch(mk(), TESTER, rpcWith({ balance: 10_000_001n }), env);
    expect(r3.alerts.map((a) => a.kind)).toEqual(["seller_dd_balance_over_float"]);
    const r4 = await runWatch(mk(), TESTER, rpcWith({ balance: 10_000_000n }), env);
    expect(r4.alerts).toEqual([]);
  });
  it("Odin round 4: first run (no cursor) starts at DD_WATCH_START_BLOCK and counts Michael's 3.000000 USDC deposit at 52869933", async () => {
    const { DD_WATCH_START_BLOCK } = await import("@/lib/seller-dd/config");
    expect(DD_WATCH_START_BLOCK).toBe(52_869_932);
    const s = mk();
    const head = 52_870_100;
    const ranges: number[] = [];
    const base = rpcWith({ head, in: [{ transactionHash: "0x1dd1", blockNumber: `0x${(52_869_933).toString(16)}`, topics: [TRANSFER_TOPIC, pad(FUNDER), pad(TESTER)], data: `0x${(3_000_000).toString(16)}` }] });
    const rpc: Rpc = async (m, p: any) => { if (m === "eth_getLogs" && p[0].topics[0] === AUTH_USED_TOPIC) ranges.push(parseInt(p[0].fromBlock, 16)); return base(m, p); };
    const r = await runWatch(s, TESTER, rpc, env);
    expect(ranges[0]).toBe(52_869_932);
    expect(r.alerts).toEqual([]);
    expect(Number(await s.get(watchKeys.inboundUsd()))).toBeCloseTo(3);
    expect(await s.get(watchKeys.cursor())).toBe(String(head));
    // a second run resumes from the cursor and does not count the deposit again
    await runWatch(s, TESTER, rpcWith({ head: head + 10 }), env);
    expect(Number(await s.get(watchKeys.inboundUsd()))).toBeCloseTo(3);
  });
  it("RPC down -> HIGH rpc_unavailable, cursor unchanged", async () => {
    const s = mk();
    await s.set(watchKeys.cursor(), "100", 100);
    const r = await runWatch(s, TESTER, async () => { throw new Error("down"); }, env);
    expect(r.alerts.map((a) => a.kind)).toEqual(["seller_dd_watch_rpc_unavailable"]);
    expect(await s.get(watchKeys.cursor())).toBe("100");
  });
});

describe("seller-dd cron route", () => {
  let store: MemoryPremiumStore;
  const calls: string[] = [];
  beforeEach(() => {
    store = mk(); setPremiumStoreForTests(store); calls.length = 0;
    setSellerDdCronForTests({ rpc: rpcWith({}, calls), nonceState: async () => "unused" });
    vi.stubEnv("HP_PREMIUM_ENABLED", "true"); vi.stubEnv("HP_SELLER_DD_ENABLED", "true");
    vi.stubEnv("CRON_SECRET", "s".repeat(24));
    vi.stubEnv("HP_DD_TESTER_KEY", key); vi.stubEnv("HP_DD_TESTER_ADDRESS", TESTER);
  });
  afterEach(() => { vi.unstubAllEnvs(); setPremiumStoreForTests(undefined); setSellerDdCronForTests(null); });
  const req = (auth?: string) => new NextRequest("https://horizonpulse.dev/api/seller-dd/cron", { headers: auth ? { authorization: auth } : {} });

  it("flag off -> 204, no store writes, no RPC (either flag)", async () => {
    vi.stubEnv("HP_SELLER_DD_ENABLED", "");
    expect((await GET(req(`Bearer ${"s".repeat(24)}`))).status).toBe(204);
    vi.stubEnv("HP_SELLER_DD_ENABLED", "true"); vi.stubEnv("HP_PREMIUM_ENABLED", "");
    expect((await GET(req(`Bearer ${"s".repeat(24)}`))).status).toBe(204);
    expect(store.writes).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("wrong/missing secret -> 401, no store access", async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
    expect(store.writes).toEqual([]);
  });
  it("authorised -> reconcile + watch run", async () => {
    const r = await GET(req(`Bearer ${"s".repeat(24)}`));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.reconcile).toMatchObject({ checked: 0 });
    expect(b.watch).toMatchObject({ ok: true, alerts: [] });
    expect(calls).toContain("eth_getLogs");
  });
  it("tester address mismatch -> 503 (HIGH)", async () => {
    vi.stubEnv("HP_DD_TESTER_ADDRESS", "0x" + "12".repeat(20));
    expect((await GET(req(`Bearer ${"s".repeat(24)}`))).status).toBe(503);
  });
  it("vercel.json schedules the cron once a day next to the premium cron", () => {
    const v = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(v.crons).toContainEqual({ path: "/api/seller-dd/cron", schedule: "41 13 * * *" });
    expect(v.crons).toContainEqual({ path: "/api/premium/cron", schedule: "17 13 * * *" });
  });
});

describe("Odin 10/21 #5: auto-pause", () => {
  it("outflow we did not make -> latch set (cause outflow_not_ours)", async () => {
    const s = mk();
    await runWatch(s, TESTER, rpcWith({ out: [log("0x2", [TRANSFER_TOPIC, pad(TESTER)])] }), env);
    const p = await readPause(s);
    expect(p.paused).toBe(true);
    expect(p.latch?.cause).toBe("outflow_not_ours");
  });
  it("our own reserved outflow -> no pause", async () => {
    const s = mk();
    await reserveTestPay(s, { request_id: "r1", seller: "a.com", domain: "a.com", ip: "1.1.1.1", payTo: "0x" + "4e".repeat(20), value_usd: 0.01, nonce: NONCE, validBefore: 9e9, at: Date.now() }, Date.now());
    await runWatch(s, TESTER, rpcWith({ out: [log("0x1", [TRANSFER_TOPIC, pad(TESTER)])], auth: [log("0x1", [AUTH_USED_TOPIC, pad(TESTER), NONCE])] }), env);
    expect((await readPause(s)).paused).toBe(false);
  });
  it("nonce above 0 -> pause (tester_nonce_above_zero); nonce unreadable -> alert only, no pause", async () => {
    const s = mk();
    await runWatch(s, TESTER, rpcWith({ txCount: "0x1" }), env);
    expect((await readPause(s)).latch?.cause).toBe("tester_nonce_above_zero");
    const u = mk();
    const r = await runWatch(u, TESTER, async (m, p) => (m === "eth_getTransactionCount" ? "zz" : rpcWith({})(m, p)), env);
    expect(r.alerts.map((a) => a.kind)).toContain("seller_dd_tester_sent_own_tx");
    expect((await readPause(u)).paused).toBe(false);
  });
  it("INFLOWS NEVER PAUSE: approved, unapproved, over funding cap, over float", async () => {
    const s = mk();
    const big = "0x" + (30_000_000).toString(16);
    const r = await runWatch(s, TESTER, rpcWith({ balance: 50_000_000n, in: [log("0x4", [TRANSFER_TOPIC, pad(FUNDER), pad(TESTER)], big), log("0x5", [TRANSFER_TOPIC, pad("0x" + "99".repeat(20)), pad(TESTER)], big)] }), env);
    expect(r.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(["seller_dd_inbound_from_unapproved", "seller_dd_funding_over_cap", "seller_dd_balance_over_float"]));
    expect(r.alerts.map((a) => a.kind)).not.toContain("seller_dd_auto_paused");
    expect(await s.get(PAUSE_KEY)).toBeNull();
  });
  it("recovery = kill switch cycle only: on (still paused) -> off (marked) -> on (cleared + HIGH alert)", async () => {
    const s = mk();
    await setPause(s, "outflow_not_ours", 1);
    expect(await observeKillSwitch(s, "on")).toBe("still_paused"); // never seen off
    const off = await runWatch(s, TESTER, rpcWith({}), { ...env, HP_DD_TESTPAY: "off" });
    expect(off.alerts.map((a) => a.kind)).not.toContain("seller_dd_auto_pause_cleared");
    expect((await readPause(s)).latch?.seen_off).toBe(true);
    const on = await runWatch(s, TESTER, rpcWith({}), env);
    expect(on.alerts.map((a) => a.kind)).toContain("seller_dd_auto_pause_cleared");
    expect((await readPause(s)).paused).toBe(false);
  });
  it("a new trigger in the same run re-arms the latch after a clear", async () => {
    const s = mk();
    await setPause(s, "outflow_not_ours", 1);
    await observeKillSwitch(s, "off");
    await runWatch(s, TESTER, rpcWith({ txCount: "0x2" }), env);
    const p = await readPause(s);
    expect(p.paused).toBe(true);
    expect(p.latch).toMatchObject({ cause: "tester_nonce_above_zero", seen_off: false });
  });
  it("unreadable latch -> treated as paused", async () => {
    const s = mk();
    s.get = async () => { throw new Error("down"); };
    expect((await readPause(s)).paused).toBe(true);
  });
});

describe("Odin 10/21 #5: pre-flight", () => {
  it("balance >= needed and nonce 0 -> ok; low balance / nonce > 0 / no answers -> refused", () => {
    expect(judgePreflight([{ bal: 10_000n, nonce: 0n }, { bal: 20_000n, nonce: 0n }], 10_000n)).toMatchObject({ ok: true, balance_atomic: "10000" });
    expect(judgePreflight([{ bal: 9_999n, nonce: 0n }, { bal: 20_000n, nonce: 0n }], 10_000n)).toEqual({ ok: false, code: "preflight_balance_low" });
    expect(judgePreflight([{ bal: 1_000_000n, nonce: 0n }, { bal: 1_000_000n, nonce: 1n }], 10_000n)).toEqual({ ok: false, code: "preflight_nonce_nonzero" });
    expect(judgePreflight([], 10_000n)).toEqual({ ok: false, code: "preflight_unavailable" });
  });
});
