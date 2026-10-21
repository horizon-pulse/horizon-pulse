import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, setSellerDdCountersClockForTests } from "@/app/api/seller-dd/counters/route";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { ddKeys, recordSettleFailure, resetSettleFailureLatchForTests } from "@/lib/seller-dd/caps";

const SECRET = "test-cron-secret-0123456789";
const NOW = Date.parse("2026-10-21T13:00:00Z");
const req = (auth?: string) => new NextRequest("https://horizonpulse.dev/api/seller-dd/counters", { headers: auth ? { authorization: auth } : {} });
let store: MemoryPremiumStore;
const saved = { ...process.env };

beforeEach(() => {
  process.env.HP_PREMIUM_ENABLED = "true"; process.env.HP_SELLER_DD_ENABLED = "true"; process.env.CRON_SECRET = SECRET;
  store = new MemoryPremiumStore(); setPremiumStoreForTests(store); setSellerDdCountersClockForTests(() => NOW); resetSettleFailureLatchForTests();
});
afterEach(() => { process.env = { ...saved }; setPremiumStoreForTests(undefined); setSellerDdCountersClockForTests(null); });

describe("seller-dd counters read", () => {
  it("flag off -> 204 before auth", async () => {
    process.env.HP_SELLER_DD_ENABLED = "false";
    expect((await GET(req())).status).toBe(204);
  });
  it("no / wrong / short secret -> 401", async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer wrong-secret-0123456789x"))).status).toBe(401);
    process.env.CRON_SECRET = "short";
    expect((await GET(req("Bearer short"))).status).toBe(401);
  });
  it("fresh day reads 0 of 3, open", async () => {
    const r = await GET(req(`Bearer ${SECRET}`));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = await r.json();
    expect(b).toMatchObject({ readable: true, utc_day: "2026-10-21", settle_fail: 0, settle_fail_limit: 3, settle_closed: false, spend_day_usd: 0 });
  });
  it("counts settle failures and reports closed at 3", async () => {
    for (let i = 0; i < 3; i++) await recordSettleFailure(store, NOW);
    const b = await (await GET(req(`Bearer ${SECRET}`))).json();
    expect(b.settle_fail).toBe(3); expect(b.settle_closed).toBe(true);
  });
  it("closed latch marker reported", async () => {
    await store.set(ddKeys.settleClosed(NOW), "1", 60);
    expect((await (await GET(req(`Bearer ${SECRET}`))).json()).settle_closed).toBe(true);
  });
  it("is read-only (no key written)", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(await store.get(ddKeys.settleFail(NOW))).toBeNull();
  });
  it("store missing or throwing -> 503 readable:false", async () => {
    setPremiumStoreForTests(null);
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(503);
    const bad = new MemoryPremiumStore(); (bad as any).get = async () => { throw new Error("down"); };
    setPremiumStoreForTests(bad);
    const r = await GET(req(`Bearer ${SECRET}`));
    expect(r.status).toBe(503); expect((await r.json()).readable).toBe(false);
  });
});
