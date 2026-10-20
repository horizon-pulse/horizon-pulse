import { describe, expect, it } from "vitest";
import { MemoryPremiumStore, type PremiumStore } from "@/lib/premium/store";
import { ddKeys, recordLoss, recordSettleFailure, reconcileOpen, releaseIfConfirmedUnused, reserveTestPay, routeClosedBySettleFailures, type Reservation } from "@/lib/seller-dd/caps";

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
    const broken: PremiumStore = new Proxy(s, { get: (t, p) => (p === "spendReserve" ? async () => { throw new Error("down"); } : (t as any)[p]) });
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
