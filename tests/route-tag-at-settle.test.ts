import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";

// Strict: replace only logPaidSettle with a mock so every call site's route tag is observable.
vi.mock("@/lib/route-log", async (orig) => ({ ...(await orig<typeof import("@/lib/route-log")>()), logPaidSettle: vi.fn() }));

import { buildPaidSettleRecord, evalCommand, logPaidSettle, sendRouteLog, resetRouteLogState } from "@/lib/route-log";
import { logMcpPaidSettle } from "@/lib/mcp-server";
import { resetPremiumFacilitatorForTests, settlePayment, type Decoded } from "@/lib/premium/payment";
import { PREMIUM_TIERS, tierPath } from "@/lib/premium/tiers";
import { DD_PATH, DD_TIER } from "@/lib/seller-dd/config";

const tagged = vi.mocked(logPaidSettle);

describe("route tag at payment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetRouteLogState();
  });

  it("builds a paid_settled record carrying the route path and only public settle fields", () => {
    const rec = buildPaidSettleRecord({
      route: "/api/pulse", method: "MCP", rail: "eip155:8453", amountAtomic: "5000",
      tx: "0xabc", payer: "0xdef", now: new Date("2026-10-21T12:00:00Z"),
    });
    expect(rec).toEqual({ ts: "2026-10-21T12:00:00.000Z", route: "/api/pulse", method: "MCP", outcome: "paid_settled", rail: "eip155:8453", amount: "5000", tx: "0xabc", payer: "0xdef" });
    expect(Object.keys(rec).sort()).toEqual(["amount", "method", "outcome", "payer", "rail", "route", "ts", "tx"]);
  });

  it("writes the tx -> route key for a paid settle", () => {
    const cmd = evalCommand(buildPaidSettleRecord({ route: "/api/research/brief", method: "POST", rail: "eip155:8453", amountAtomic: "1000000", tx: "0xABC", payer: "0x1" }));
    expect(cmd[2]).toBe("3");
    expect(cmd[5]).toBe("hp:rl:tx:0xabc");
    expect(cmd[6]).toBe("/api/research/brief|POST|paid_settled");
  });

  it("drops non-string or oversize fields instead of logging them", () => {
    const rec = buildPaidSettleRecord({ route: "/api/x", method: "MCP", rail: undefined, amountAtomic: "1", tx: "x".repeat(300), payer: null });
    expect(rec.rail).toBe("unknown");
    expect(rec.tx).toBeNull();
    expect(rec.payer).toBeNull();
  });

  it("sends nothing but the record to the sink", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    const env = { UPSTASH_REDIS_REST_URL: "https://example.invalid", UPSTASH_REDIS_REST_TOKEN: "t", KV_REST_API_URL: "https://example.invalid", KV_REST_API_TOKEN: "t" };
    const rec = buildPaidSettleRecord({ route: "/api/seller-dd/single", method: "POST", rail: "eip155:8453", amountAtomic: "5000000", tx: "0x9", payer: "0x8" });
    const ok = await sendRouteLog(rec, env, fetchFn as unknown as typeof fetch);
    if (ok) {
      const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as string[];
      expect(JSON.parse(body[body.length - 4])).toEqual(rec);
    }
  });
});

describe("MCP paid settle hook (strict)", () => {
  const opts = { maxAmountRequired: "5000", resource: "https://horizonpulse.dev/api/pulse", description: "d" };
  beforeEach(() => tagged.mockClear());

  it("tags the paid tool's route path on a successful settle", () => {
    logMcpPaidSettle(opts, { success: true, transaction: "0x1", network: "eip155:8453", payer: "0x2" });
    expect(tagged).toHaveBeenCalledTimes(1);
    expect(tagged.mock.calls[0][0]).toEqual({ route: "/api/pulse", method: "MCP", rail: "eip155:8453", amountAtomic: "5000", tx: "0x1", payer: "0x2" });
  });

  it("writes no tag on a failed or missing settlement, and never throws", () => {
    expect(() => logMcpPaidSettle(opts, { success: false, transaction: "0x1" })).not.toThrow();
    expect(() => logMcpPaidSettle(opts, undefined)).not.toThrow();
    expect(tagged).not.toHaveBeenCalled();
  });
});

describe("premium / seller DD settle tag", () => {
  const brief = PREMIUM_TIERS.find((t) => t.id === "brief")!;
  const d = { raw: {}, from: "0xpayer" } as unknown as Decoded;
  beforeEach(() => {
    tagged.mockClear();
    resetPremiumFacilitatorForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("tags the tier path on a successful premium settle", async () => {
    vi.spyOn(HTTPFacilitatorClient.prototype, "settle").mockResolvedValue({ success: true, transaction: "0xt", network: "eip155:8453", payer: "0xp" } as never);
    const r = await settlePayment(d, brief);
    expect(r.ok).toBe(true);
    expect(tagged).toHaveBeenCalledTimes(1);
    expect(tagged.mock.calls[0][0]).toMatchObject({ route: tierPath(brief), method: "POST", tx: "0xt", payer: "0xp", amountAtomic: brief.amount });
  });

  it("tags the seller DD path when passed", async () => {
    vi.spyOn(HTTPFacilitatorClient.prototype, "settle").mockResolvedValue({ success: true, transaction: "0xd", network: "eip155:8453", payer: "0xp" } as never);
    await settlePayment(d, DD_TIER, DD_PATH);
    expect(tagged.mock.calls[0][0]).toMatchObject({ route: "/api/seller-dd/single", tx: "0xd" });
  });

  it("writes no tag when the settle fails, has no tx, or throws (premium and seller DD)", async () => {
    const settle = vi.spyOn(HTTPFacilitatorClient.prototype, "settle");
    vi.spyOn(console, "error").mockImplementation(() => {});
    settle.mockResolvedValueOnce({ success: false, errorReason: "x" } as never);
    expect((await settlePayment(d, brief)).ok).toBe(false);
    settle.mockResolvedValueOnce({ success: true, transaction: "" } as never);
    expect((await settlePayment(d, DD_TIER, DD_PATH)).ok).toBe(false);
    settle.mockRejectedValueOnce(new Error("boom"));
    expect((await settlePayment(d, DD_TIER, DD_PATH)).ok).toBe(false);
    expect(tagged).not.toHaveBeenCalled();
  });
});
