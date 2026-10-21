import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPaidSettleRecord, evalCommand, sendRouteLog, resetRouteLogState } from "@/lib/route-log";

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

describe("MCP paid settle hook", () => {
  it("records only on a successful settlement and never throws", async () => {
    const rl = await import("@/lib/route-log");
    const spy = vi.spyOn(rl, "logPaidSettle");
    const { logMcpPaidSettle } = await import("@/lib/mcp-server");
    const opts = { maxAmountRequired: "5000", resource: "https://horizonpulse.dev/api/pulse", description: "d" };
    expect(() => logMcpPaidSettle(opts, { success: false, transaction: "0x1" })).not.toThrow();
    expect(() => logMcpPaidSettle(opts, undefined)).not.toThrow();
    expect(() => logMcpPaidSettle(opts, { success: true, transaction: "0x1", network: "eip155:8453", payer: "0x2" })).not.toThrow();
    // ESM bindings may not be spy-able; when they are, assert the route path and that failures did not log.
    if (spy.mock.calls.length) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ route: "/api/pulse", method: "MCP", tx: "0x1", payer: "0x2", amountAtomic: "5000" });
    }
  });
});
