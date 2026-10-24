import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OPTIONS } from "@/app/api/seller-dd/single/route";
import { EURC_BASE } from "@/lib/eurc-config";
import { DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";


const FRESH = new Date("2026-10-24T14:00:00Z");
const req = () => new NextRequest("https://example.test/api/seller-dd/single", { method: "OPTIONS" });
afterEach(() => vi.unstubAllEnvs());

describe("OPTIONS /api/seller-dd/single lists accepts like the standard routes", () => {
  it("200 + PAYMENT-REQUIRED; Base USDC accept is always present", async () => {
    vi.stubEnv("HP_PREMIUM_ENABLED", "true"); vi.stubEnv("HP_SELLER_DD_ENABLED", "true");
    const r = await OPTIONS(req());
    expect(r.status).toBe(200);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(r.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    const j = (await r.json()) as { accepts: { asset: string }[] };
    expect(j.accepts.length).toBeGreaterThanOrEqual(1);
  });
  it("still 404 when the route is off", async () => {
    vi.stubEnv("HP_PREMIUM_ENABLED", "false");
    expect((await OPTIONS(req())).status).toBe(404);
  });
  it("EURC flag on + fresh rate: OPTIONS lists [USDC, EURC] with payTo unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FRESH);
    vi.stubEnv("HP_PREMIUM_ENABLED", "true"); vi.stubEnv("HP_SELLER_DD_ENABLED", "true"); vi.stubEnv("HP_EURC_ENABLED", "true");
    const j = (await (await OPTIONS(req())).json()) as { accepts: { asset: string; payTo: string }[] };
    expect(j.accepts.map((a) => a.asset)).toEqual([USDC_BASE, EURC_BASE]);
    for (const a of j.accepts) expect(a.payTo).toBe(DEFAULT_PAY_TO);
    vi.useRealTimers();
  });
  it("EURC flag off: OPTIONS lists USDC only", async () => {
    vi.stubEnv("HP_PREMIUM_ENABLED", "true"); vi.stubEnv("HP_SELLER_DD_ENABLED", "true"); vi.stubEnv("HP_EURC_ENABLED", "");
    const j = (await (await OPTIONS(req())).json()) as { accepts: { asset: string }[] };
    expect(j.accepts.map((a) => a.asset)).toEqual([USDC_BASE]);
  });
});
