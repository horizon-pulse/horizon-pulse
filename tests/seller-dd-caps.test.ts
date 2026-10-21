import { describe, expect, it } from "vitest";
import { MemoryPremiumStore, type PremiumStore } from "@/lib/premium/store";
import { UpstashPremiumStore, SPEND_RESERVE_MULTI_LUA } from "@/lib/premium/store";
import { ddKeys, releaseUnsigned, recordLoss, recordSettleFailure, reconcileOpen, releaseIfConfirmedUnused, reserveTestPay, routeClosedBySettleFailures, type Reservation } from "@/lib/seller-dd/caps";

const NOW = Date.parse("2026-10-20T12:00:00Z");
let i = 0;
const res = (o: Partial<Reservation> = {}): Reservation => ({ request_id: `r${i++}`, seller: `s${i}.example.com`, domain: `d${i}.com`, ip: `1.2.3.${i % 250}`, payTo: "0x" + "ab".repeat(20), value_usd: 0.1, nonce: "0x" + "00".repeat(32), validBefore: Math.floor(NOW / 1000) + 240, at: NOW, ...o });
const mk = () => { const s = new MemoryPremiumStore(); s.now = () => NOW; return s; };

describe("C3 caps + reservation lifecycle", () => {
  it("daily $5 cap: 50 x $0.10 then refused", async () => {
    const s = mk();
    let ok = 0, last: any = null;
    for (let k = 0; k < 60; k++) { last = await reserveTestPay(s, res(), NOW); if (last.ok) ok++; else break; }
    // the $3 brief unsettled cap (shared, Odin C4) trips before the $5 daily cap; float step may stop at 29
    expect(ok).toBeGreaterThanOrEqual(29);
    expect(ok).toBeLessThanOrEqual(30);
    expect(last).toEqual({ ok: false, code: "unsettled_cap" });
  });
  it("daily cap refuses before unsettled when spend already at $5", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.day(NOW), 4.95, 100);
    expect(await reserveTestPay(s, res(), NOW)).toEqual({ ok: false, code: "daily_cap" });
  });
  it("lifetime $25 cap", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.life(), 24.95, 100);
    expect(await reserveTestPay(s, res(), NOW)).toEqual({ ok: false, code: "lifetime_cap" });
    expect(Number(await s.get(ddKeys.day(NOW)) ?? 0)).toBeCloseTo(0); // rolled back
  });
  it("per-host cap keyed by registrable domain AND by IP (L-2): 3/day", async () => {
    const s = mk();
    for (let k = 0; k < 3; k++) expect((await reserveTestPay(s, res({ domain: "x.com" }), NOW)).ok).toBe(true);
    expect(await reserveTestPay(s, res({ domain: "x.com" }), NOW)).toEqual({ ok: false, code: "host_cap" });
    for (let k = 0; k < 3; k++) expect((await reserveTestPay(s, res({ ip: "9.9.9.9" }), NOW)).ok).toBe(true);
    expect(await reserveTestPay(s, res({ ip: "9.9.9.9" }), NOW)).toEqual({ ok: false, code: "host_cap" });
  });
  it("idempotency: one payment per seller per request", async () => {
    const s = mk();
    const r = res();
    expect((await reserveTestPay(s, r, NOW)).ok).toBe(true);
    expect(await reserveTestPay(s, r, NOW)).toEqual({ ok: false, code: "already_paid" });
  });
  it("concurrent race at the cap edge never exceeds the cap", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.day(NOW), 4.5, 100);
    const out = await Promise.all(Array.from({ length: 40 }, () => reserveTestPay(s, res(), NOW)));
    expect(out.filter((o) => o.ok).length).toBe(5);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeLessThanOrEqual(5 + 1e-9);
  });
  it("store outage -> store_unavailable (no signing)", async () => {
    const s = mk();
    const broken: PremiumStore = new Proxy(s, { get: (t, p) => (p === "spendReserveMulti" ? async () => { throw new Error("down"); } : (t as any)[p]) });
    expect(await reserveTestPay(broken, res(), NOW)).toEqual({ ok: false, code: "store_unavailable" });
  });
  it("release only after validBefore AND nonce unused; errors/used/unknown never release", async () => {
    const s = mk();
    const r = res();
    await reserveTestPay(s, r, NOW);
    expect(await releaseIfConfirmedUnused(s, r, async () => "unused", NOW)).toBe(false); // before validBefore
    const later = (r.validBefore + 5) * 1000;
    expect(await releaseIfConfirmedUnused(s, r, async () => "unknown", later)).toBe(false);
    expect(await releaseIfConfirmedUnused(s, r, async () => "used", later)).toBe(false);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeCloseTo(0.1);
    expect(await releaseIfConfirmedUnused(s, r, async () => "unused", later)).toBe(true);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeCloseTo(0);
  });
  it("cron reconcile: used kept counted, unused released", async () => {
    const s = mk();
    const a = res({ nonce: "0x" + "aa".repeat(32) }), b = res({ nonce: "0x" + "bb".repeat(32) });
    await reserveTestPay(s, a, NOW); await reserveTestPay(s, b, NOW);
    s.now = () => NOW + 600_000;
    const r = await reconcileOpen(s, async (n) => (n === a.nonce ? "used" : "unused"), NOW + 600_000);
    expect(r).toMatchObject({ checked: 2, released: 1, settled: 1 });
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeCloseTo(0.1);
  });
  it("loss ledger records each no_charge test pay", async () => {
    const s = mk();
    await recordLoss(s, res(), "only_2_of_4", NOW); await recordLoss(s, res(), "buyer_settle_ambiguous", NOW);
    expect(Number(await s.get(ddKeys.lossUsd(NOW)))).toBeCloseTo(0.2);
  });
  it("3 settle failures/day -> closed; unreadable -> closed", async () => {
    const s = mk();
    for (let k = 0; k < 2; k++) await recordSettleFailure(s, NOW);
    expect(await routeClosedBySettleFailures(s, NOW)).toBe(false);
    await recordSettleFailure(s, NOW);
    expect(await routeClosedBySettleFailures(s, NOW)).toBe(true);
    const broken = new Proxy(mk(), { get: (t, p) => (p === "get" ? async () => { throw new Error("x"); } : (t as any)[p]) }) as PremiumStore;
    expect(await routeClosedBySettleFailures(broken, NOW)).toBe(true);
  });
});

describe("Odin 10/21 #3: atomic multi-counter reserve (no overshoot)", () => {
  it("200 concurrent reservations: day <= $5, lifetime <= $25, unsettled <= $3, and counters agree with successes", async () => {
    const s = mk();
    const out = await Promise.all(Array.from({ length: 200 }, () => reserveTestPay(s, res(), NOW)));
    const ok = out.filter((o) => o.ok).length;
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeLessThanOrEqual(5 + 1e-9);
    expect(Number(await s.get(ddKeys.life()))).toBeLessThanOrEqual(25 + 1e-9);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeCloseTo(ok * 0.1, 6);
    expect(Number(await s.get(ddKeys.life()))).toBeCloseTo(ok * 0.1, 6);
  });
  it("concurrent at the lifetime edge: exactly the fitting number succeed, refused ones touch no counter", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.life(), 24.7, 100);
    const out = await Promise.all(Array.from({ length: 30 }, () => reserveTestPay(s, res(), NOW)));
    expect(out.filter((o) => o.ok).length).toBe(3);
    expect(out.filter((o) => !o.ok).every((o) => !o.ok && o.code === "lifetime_cap")).toBe(true);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeCloseTo(0.3, 6); // no leaked partial reservation
  });
  it("concurrent same host: PER_HOST_DAILY=3 never exceeded", async () => {
    const s = mk();
    const out = await Promise.all(Array.from({ length: 25 }, () => reserveTestPay(s, res({ domain: "same.com" }), NOW)));
    expect(out.filter((o) => o.ok).length).toBe(3);
    expect(Number(await s.get(ddKeys.host("same.com", NOW)))).toBe(3);
  });
  it("cap refusal writes nothing and frees the idempotency slot", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.day(NOW), 5, 100);
    const r = res();
    expect(await reserveTestPay(s, r, NOW)).toEqual({ ok: false, code: "daily_cap" });
    expect(Number((await s.get(ddKeys.life())) ?? 0)).toBe(0);
    expect(await s.get(ddKeys.idem(r.request_id, r.seller))).toBeNull();
  });
  it("bookkeeping write fails after reserve -> released (nothing signed), store_unavailable", async () => {
    const s = mk();
    const broken: PremiumStore = new Proxy(s, { get: (t, p) => (p === "zadd" ? async () => { throw new Error("down"); } : (t as any)[p]) });
    expect(await reserveTestPay(broken, res(), NOW)).toEqual({ ok: false, code: "store_unavailable" });
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeCloseTo(0, 9);
    expect(Number(await s.get(ddKeys.life()))).toBeCloseTo(0, 9);
  });
  it("releaseUnsigned returns every counter and clears the reservation", async () => {
    const s = mk();
    const r = res({ domain: "rel.com" });
    expect((await reserveTestPay(s, r, NOW)).ok).toBe(true);
    await releaseUnsigned(s, r, NOW);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBeCloseTo(0, 9);
    expect(Number(await s.get(ddKeys.host("rel.com", NOW)))).toBe(0);
    expect(await s.get(ddKeys.res(r.request_id))).toBeNull();
    expect(await s.zrangeByScore(ddKeys.open(), Infinity, 10)).toEqual([]);
  });
  it("Upstash: the reserve is ONE EVAL of the multi-key Lua; a non-zero result maps to the refusing counter", async () => {
    const bodies: any[] = [];
    const f = (async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify([{ result: 3 }]), { status: 200 }); }) as unknown as typeof fetch;
    const u = new UpstashPremiumStore("https://example.invalid", "t", "p:", f);
    expect(await u.spendReserveMulti(["a", "b", "c"], [0.1, 0.1, 1], [5, 25, 3], [1, 2, 3])).toBe(3);
    expect(bodies).toHaveLength(1);
    expect(bodies[0][0].slice(0, 6)).toEqual(["EVAL", SPEND_RESERVE_MULTI_LUA, 3, "p:a", "p:b", "p:c"]);
    expect(SPEND_RESERVE_MULTI_LUA).toMatch(/return i end end for i = 1, n do redis.call\('INCRBYFLOAT'/);
  });
  it("Upstash: malformed script result fails closed (throws -> store_unavailable)", async () => {
    const f = (async () => new Response(JSON.stringify([{ result: "x" }]), { status: 200 })) as unknown as typeof fetch;
    const u = new UpstashPremiumStore("https://example.invalid", "t", "p:", f);
    await expect(u.spendReserveMulti(["a"], [1], [1], [1])).rejects.toThrow();
  });
});

import { recordSellerSettleFailure, sellerClosedBySettleFailures, resetSettleFailureLatchForTests } from "@/lib/seller-dd/caps";
describe("Odin 10/21 #4: per-seller settle-fail counter", () => {
  it("counts per seller domain per UTC day, case-insensitive; limit 2 closes only that seller", async () => {
    resetSettleFailureLatchForTests();
    const s = new MemoryPremiumStore(); s.now = () => NOW;
    expect(await sellerClosedBySettleFailures(s, "A.com", NOW)).toBe(false);
    expect((await recordSellerSettleFailure(s, "A.com", NOW)).count).toBe(1);
    expect(await sellerClosedBySettleFailures(s, "a.com", NOW)).toBe(false);
    expect((await recordSellerSettleFailure(s, "a.com", NOW)).count).toBe(2);
    expect(await sellerClosedBySettleFailures(s, "a.com", NOW)).toBe(true);
    expect(await sellerClosedBySettleFailures(s, "b.com", NOW)).toBe(false);
    expect(await sellerClosedBySettleFailures(s, "a.com", NOW + 86_400_000)).toBe(false); // next UTC day
    expect(await routeClosedBySettleFailures(s, NOW)).toBe(false); // per-seller counter alone never closes the route
  });
});
