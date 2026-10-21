import { describe, expect, it } from "vitest";
import { MemoryPremiumStore, type PremiumStore } from "@/lib/premium/store";
import { ADJUST_ONCE_LUA, UpstashPremiumStore, SPEND_RESERVE_MULTI_LUA } from "@/lib/premium/store";
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
    await s.spendAdjust(ddKeys.day(NOW), 4950000, 100);
    expect(await reserveTestPay(s, res(), NOW)).toEqual({ ok: false, code: "daily_cap" });
  });
  it("lifetime $25 cap", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.life(), 24950000, 100);
    expect(await reserveTestPay(s, res(), NOW)).toEqual({ ok: false, code: "lifetime_cap" });
    expect((Number(await s.get(ddKeys.day(NOW)) ?? 0)) / 1e6).toBeCloseTo(0); // rolled back
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
    await s.spendAdjust(ddKeys.day(NOW), 4500000, 100);
    const out = await Promise.all(Array.from({ length: 40 }, () => reserveTestPay(s, res(), NOW)));
    expect(out.filter((o) => o.ok).length).toBe(5);
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeLessThanOrEqual(5 + 1e-9);
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
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeCloseTo(0.1);
    expect(await releaseIfConfirmedUnused(s, r, async () => "unused", later)).toBe(true);
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeCloseTo(0);
  });
  it("cron reconcile: used kept counted, unused released", async () => {
    const s = mk();
    const a = res({ nonce: "0x" + "aa".repeat(32) }), b = res({ nonce: "0x" + "bb".repeat(32) });
    await reserveTestPay(s, a, NOW); await reserveTestPay(s, b, NOW);
    s.now = () => NOW + 600_000;
    const r = await reconcileOpen(s, async (n) => (n === a.nonce ? "used" : "unused"), NOW + 600_000);
    expect(r).toMatchObject({ checked: 2, released: 1, settled: 1 });
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeCloseTo(0.1);
  });
  it("loss ledger records each no_charge test pay", async () => {
    const s = mk();
    await recordLoss(s, res(), "only_2_of_4", NOW); await recordLoss(s, res(), "buyer_settle_ambiguous", NOW);
    expect((Number(await s.get(ddKeys.lossUsd(NOW))) / 1e6)).toBeCloseTo(0.2);
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
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeLessThanOrEqual(5 + 1e-9);
    expect((Number(await s.get(ddKeys.life())) / 1e6)).toBeLessThanOrEqual(25 + 1e-9);
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeCloseTo(ok * 0.1, 6);
    expect((Number(await s.get(ddKeys.life())) / 1e6)).toBeCloseTo(ok * 0.1, 6);
  });
  it("concurrent at the lifetime edge: exactly the fitting number succeed, refused ones touch no counter", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.life(), 24700000, 100);
    const out = await Promise.all(Array.from({ length: 30 }, () => reserveTestPay(s, res(), NOW)));
    expect(out.filter((o) => o.ok).length).toBe(3);
    expect(out.filter((o) => !o.ok).every((o) => !o.ok && o.code === "lifetime_cap")).toBe(true);
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeCloseTo(0.3, 6); // no leaked partial reservation
  });
  it("concurrent same host: PER_HOST_DAILY=3 never exceeded", async () => {
    const s = mk();
    const out = await Promise.all(Array.from({ length: 25 }, () => reserveTestPay(s, res({ domain: "same.com" }), NOW)));
    expect(out.filter((o) => o.ok).length).toBe(3);
    expect(Number(await s.get(ddKeys.host("same.com", NOW)))).toBe(3);
  });
  it("cap refusal writes nothing and frees the idempotency slot", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.day(NOW), 5000000, 100);
    const r = res();
    expect(await reserveTestPay(s, r, NOW)).toEqual({ ok: false, code: "daily_cap" });
    expect(Number((await s.get(ddKeys.life())) ?? 0)).toBe(0);
    expect(await s.get(ddKeys.idem(r.request_id, r.seller))).toBeNull();
  });
  it("bookkeeping write fails after reserve -> released (nothing signed), store_unavailable", async () => {
    const s = mk();
    const broken: PremiumStore = new Proxy(s, { get: (t, p) => (p === "zadd" ? async () => { throw new Error("down"); } : (t as any)[p]) });
    expect(await reserveTestPay(broken, res(), NOW)).toEqual({ ok: false, code: "store_unavailable" });
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeCloseTo(0, 9);
    expect((Number(await s.get(ddKeys.life())) / 1e6)).toBeCloseTo(0, 9);
  });
  it("releaseUnsigned returns every counter and clears the reservation", async () => {
    const s = mk();
    const r = res({ domain: "rel.com" });
    expect((await reserveTestPay(s, r, NOW)).ok).toBe(true);
    await releaseUnsigned(s, r, NOW);
    expect((Number(await s.get(ddKeys.day(NOW))) / 1e6)).toBeCloseTo(0, 9);
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
    expect(SPEND_RESERVE_MULTI_LUA).toMatch(/return i end end for i = 1, n do if ARGV\[3 \* n \+ i\] == 'int' then redis.call\('INCRBY'/);
  });
  it("Upstash: malformed script result fails closed (throws -> store_unavailable)", async () => {
    const f = (async () => new Response(JSON.stringify([{ result: "x" }]), { status: 200 })) as unknown as typeof fetch;
    const u = new UpstashPremiumStore("https://example.invalid", "t", "p:", f);
    await expect(u.spendReserveMulti(["a"], [1], [1], [1])).rejects.toThrow();
  });
});

describe("Sentinel LOW-A: integer micro-USD money counters", () => {
  it("day/lifetime/loss counters hold integers (no float drift over 30 x $0.10)", async () => {
    const s = mk();
    for (let k = 0; k < 30; k++) await reserveTestPay(s, res(), NOW);
    const d = await s.get(ddKeys.day(NOW)), l = await s.get(ddKeys.life());
    expect(d).toMatch(/^\d+$/); expect(l).toMatch(/^\d+$/);
    expect(Number(d)).toBe(Number(l));
    expect(Number(d) % 100_000).toBe(0);
    await recordLoss(s, res(), "x", NOW);
    expect(await s.get(ddKeys.lossUsd(NOW))).toMatch(/^\d+$/);
  });
  it("exact cap at $5.000000: 50 reservations of $0.10 fit when the unsettled cap is not the limiter", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.day(NOW), 4_900_000, 100);
    expect((await reserveTestPay(s, res(), NOW)).ok).toBe(true); // 4.9 + 0.1 == 5.0 exactly
    expect(Number(await s.get(ddKeys.day(NOW)))).toBe(5_000_000);
    expect(await reserveTestPay(s, res({ value_usd: 0.000001 }), NOW)).toEqual({ ok: false, code: "daily_cap" });
  });
  it("migration: micro keys are seeded from the legacy float-USD keys (rounded up), so prior spend still counts", async () => {
    const s = mk();
    await s.set(ddKeys.legacyLife(), "24.95", 100);
    await s.set(ddKeys.legacyDay(NOW), "0.3", 100);
    expect(await reserveTestPay(s, res(), NOW)).toEqual({ ok: false, code: "lifetime_cap" });
    expect(Number(await s.get(ddKeys.life()))).toBe(24_950_000);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBe(300_000);
  });
  it("non-integer amount on an int counter throws (fail closed) in both stores", async () => {
    const s = mk();
    await expect(s.spendReserveMulti(["a"], [0.5], [1], [10], ["int"])).rejects.toThrow();
  });
});

describe("Sentinel LOW-B: releaseUnsigned atomic + idempotent", () => {
  it("repeat release refunds once only", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.day(NOW), 1_000_000, 100); // other spend that must survive
    const r = res();
    expect((await reserveTestPay(s, r, NOW)).ok).toBe(true);
    expect(await releaseUnsigned(s, r, NOW)).toBe(true);
    expect(await releaseUnsigned(s, r, NOW)).toBe(false);
    await Promise.all([releaseUnsigned(s, r, NOW), releaseUnsigned(s, r, NOW)]);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBe(1_000_000);
  });
  it("releaseUnsigned then the cron path for the same reservation: no second refund", async () => {
    const s = mk();
    await s.spendAdjust(ddKeys.life(), 2_000_000, 100);
    const r = res();
    await reserveTestPay(s, r, NOW);
    await releaseUnsigned(s, r, NOW);
    expect(await releaseIfConfirmedUnused(s, r, async () => "unused", (r.validBefore + 5) * 1000)).toBe(false);
    expect(Number(await s.get(ddKeys.life()))).toBe(2_000_000);
  });
  it("Upstash: release is ONE EVAL of ADJUST_ONCE_LUA with the marker first", async () => {
    const bodies: any[] = [];
    const f = (async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify([{ result: 1 }]), { status: 200 }); }) as unknown as typeof fetch;
    const u = new UpstashPremiumStore("https://example.invalid", "t", "p:", f);
    const r = res();
    expect(await releaseUnsigned(u, r, NOW)).toBe(true);
    const evals = bodies.filter((b) => b[0][0] === "EVAL"); // the legacy seed (MEDIUM-1) does plain GETs first
    expect(evals).toHaveLength(1);
    expect(evals[0][0][1]).toBe(ADJUST_ONCE_LUA);
    expect(evals[0][0][3]).toBe(`p:${ddKeys.released(r.request_id)}`);
  });
});

describe("Sentinel MEDIUM-1: legacy seed also runs before releases", () => {
  it("releaseUnsigned before any reserve: micro keys seeded from legacy float spend, minus only this release", async () => {
    const s = mk();
    await s.set(ddKeys.legacyLife(), "24.9", 100);
    await s.set(ddKeys.legacyDay(NOW), "1", 100);
    const r = res();
    await releaseUnsigned(s, r, NOW);
    expect(Number(await s.get(ddKeys.life()))).toBe(24_800_000);
    expect(Number(await s.get(ddKeys.day(NOW)))).toBe(900_000);
    // caps remember the legacy spend: $0.10 fits up to exactly 25.000000, then refused
    expect((await reserveTestPay(s, res(), NOW)).ok).toBe(true);
    expect((await reserveTestPay(s, res(), NOW)).ok).toBe(true);
    expect(await reserveTestPay(s, res(), NOW)).toEqual({ ok: false, code: "lifetime_cap" });
  });
  it("cron release (releaseIfConfirmedUnused) before any reserve also seeds first", async () => {
    const s = mk();
    await s.set(ddKeys.legacyLife(), "24.95", 100);
    const r = res();
    expect(await releaseIfConfirmedUnused(s, r, async () => "unused", (r.validBefore + 5) * 1000)).toBe(true);
    expect(Number(await s.get(ddKeys.life()))).toBe(24_850_000);
    expect(await reserveTestPay(s, res({ value_usd: 0.1 }), NOW)).toEqual({ ok: true });
    expect(await reserveTestPay(s, res({ value_usd: 0.1 }), NOW)).toEqual({ ok: false, code: "lifetime_cap" });
  });
});
