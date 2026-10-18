import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRouteLogRecord,
  classifyOutcome,
  DEFAULT_DAILY_CAP,
  etDate,
  atomicOrZero,
  evalCommand,
  logRouteRequest,
  resetRouteLogState,
  RECORDS_PER_DAY_CAP,
  ROUTE_LOG_COUNTER_TTL_S,
  ROUTE_LOG_RECORD_TTL_S,
  sendRouteLog,
  settleFields,
} from "@/lib/route-log";

const settle = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString("base64");
const PAYER = `0x${"11".repeat(20)}`;
const TX = `0x${"AB".repeat(32)}`;
const paidRes = () =>
  new Response("{}", { status: 200, headers: { "payment-response": settle({ success: true, transaction: TX, network: "eip155:8453", payer: PAYER }) } });
const ENV = { UPSTASH_REDIS_REST_URL: "https://example-upstash.test", UPSTASH_REDIS_REST_TOKEN: "t" };
const NOW = new Date("2026-10-17T13:30:00.000Z");

describe("route log: record shape", () => {
  it("paid_settled carries exactly ts, route, method, outcome, rail, amount, tx, payer", () => {
    const r = buildRouteLogRecord({ route: "/api/pulse", method: "GET", res: paidRes(), paidHeader: true, amountAtomic: "2000", now: NOW });
    expect(r).toEqual({ ts: NOW.toISOString(), route: "/api/pulse", method: "GET", outcome: "paid_settled", rail: "eip155:8453", amount: "2000", tx: TX, payer: PAYER });
    expect(Object.keys(r).sort()).toEqual(["amount", "method", "outcome", "payer", "rail", "route", "ts", "tx"]);
  });
  it("unpaid 402 / rejected 402 / free 200 / error carry no rail, amount, tx or payer", () => {
    for (const [status, paidHeader, outcome] of [
      [402, false, "402_unpaid"],
      [402, true, "402_rejected"],
      [200, false, "free_200"],
      [503, true, "error"],
      [400, true, "error"],
    ] as const) {
      const r = buildRouteLogRecord({ route: "/api/gas", method: "GET", res: new Response("{}", { status }), paidHeader, amountAtomic: "2000", now: NOW });
      expect(r.outcome).toBe(outcome);
      expect([r.rail, r.amount, r.tx, r.payer]).toEqual([null, null, null, null]);
    }
  });
  it("never records headers, query, IP or body", () => {
    const res = new Response(JSON.stringify({ secret: "body" }), {
      status: 200,
      headers: { "payment-response": settle({ transaction: TX, network: "eip155:8453", payer: PAYER, extra: "x" }), "x-forwarded-for": "1.2.3.4" },
    });
    const r = buildRouteLogRecord({ route: "/api/pulse", method: "GET", res, paidHeader: true, amountAtomic: "2000", now: NOW });
    const s = JSON.stringify(r);
    for (const bad of ["1.2.3.4", "secret", "body", "extra"]) expect(s).not.toContain(bad);
  });
  it("classifyOutcome + settleFields edge cases", () => {
    expect(classifyOutcome(201, false, true)).toBe("paid_settled");
    expect(settleFields(new Response("", { headers: { "payment-response": "%%%" } }))).toEqual({});
    expect(etDate(new Date("2026-10-17T03:00:00Z"))).toBe("2026-10-16"); // 11 PM ET
  });
});

describe("route log: Upstash sink", () => {
  beforeEach(() => resetRouteLogState());
  afterEach(() => vi.restoreAllMocks());

  it("one EVAL (one billed command): counters 90 days; daily list (cap 5k) and tx->route key 30 days", async () => {
    const rec = buildRouteLogRecord({ route: "/api/pulse", method: "GET", res: paidRes(), paidHeader: true, amountAtomic: "2000", now: NOW });
    const cmd = evalCommand(rec);
    expect(cmd[0]).toBe("EVAL");
    expect(cmd[2]).toBe("4");
    expect(cmd.slice(3, 7)).toEqual(["hp:rl:d:2026-10-17", "hp:rl:r:2026-10-17", "hp:rl:p:2026-10-17", `hp:rl:tx:${TX.toLowerCase()}`]);
    expect(cmd[7]).toBe("/api/pulse|GET|paid_settled");
    expect(JSON.parse(cmd[8])).toEqual(rec);
    expect(cmd[9]).toBe(String(ROUTE_LOG_COUNTER_TTL_S));
    expect(cmd[10]).toBe(String(RECORDS_PER_DAY_CAP - 1));
    expect(cmd[11]).toBe(String(ROUTE_LOG_RECORD_TTL_S));
    // Per-route paid counter (payer-free): calls + atomic sum per route and rail.
    expect(cmd.slice(12)).toEqual(["/api/pulse|eip155:8453|calls", "/api/pulse|eip155:8453|atomic", "2000"]);
    // Payer appears only inside the record (ARGV[2]); never in keys or counter fields.
    expect(cmd.slice(0, 8).concat(cmd.slice(9)).join("\n")).not.toContain(PAYER);
    expect(ROUTE_LOG_COUNTER_TTL_S).toBe(90 * 86400);
    expect(ROUTE_LOG_RECORD_TTL_S).toBe(30 * 86400);
    expect(RECORDS_PER_DAY_CAP).toBe(5000);
    // Lua: counters expire on ARGV[3]; the record list and tx key on ARGV[5].
    expect(cmd[1]).toContain("redis.call('EXPIRE', KEYS[1], ARGV[3])");
    expect(cmd[1]).toContain("redis.call('EXPIRE', KEYS[2], ARGV[5])");
    expect(cmd[1]).toContain("redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[5])");
    expect(cmd[1]).toContain("redis.call('HINCRBY', KEYS[3], ARGV[6], 1)");
    expect(cmd[1]).toContain("redis.call('HINCRBY', KEYS[3], ARGV[7], ARGV[8])");
    expect(cmd[1]).toContain("redis.call('EXPIRE', KEYS[3], ARGV[3])");
    const unpaid = evalCommand(buildRouteLogRecord({ route: "/api/pulse", method: "GET", res: new Response("", { status: 402 }), paidHeader: false, amountAtomic: "2000", now: NOW }));
    expect(unpaid[2]).toBe("2");
    expect(unpaid.some((a) => a.startsWith("hp:rl:tx:") || a.startsWith("hp:rl:p:"))).toBe(false);
    expect(unpaid.slice(10)).toEqual(["", "", ""]);

    const f = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    expect(await sendRouteLog(rec, ENV, f as unknown as typeof fetch)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENV.UPSTASH_REDIS_REST_URL);
    expect(JSON.parse(String(init.body))).toEqual(cmd);
  });

  it("failures never throw: network error, 500, upstash error body, no creds, HP_ROUTE_LOG=off", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = buildRouteLogRecord({ route: "/api/pulse", method: "GET", res: paidRes(), paidHeader: true, amountAtomic: "2000", now: NOW });
    const boom = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await sendRouteLog(rec, ENV, boom as unknown as typeof fetch)).toBe(false);
    expect(await sendRouteLog(rec, ENV, (async () => new Response("x", { status: 500 })) as unknown as typeof fetch)).toBe(false);
    expect(await sendRouteLog(rec, ENV, (async () => new Response(JSON.stringify({ error: "ERR" }), { status: 200 })) as unknown as typeof fetch)).toBe(false);
    const never = vi.fn();
    expect(await sendRouteLog(rec, {}, never as unknown as typeof fetch)).toBe(false);
    expect(await sendRouteLog(rec, { ...ENV, HP_ROUTE_LOG: "off" }, never as unknown as typeof fetch)).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  it("daily cap stops unpaid records per instance but never paid_settled", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    const env = { ...ENV, HP_ROUTE_LOG_DAILY_CAP: "2" };
    const unpaid = buildRouteLogRecord({ route: "/api/gas", method: "GET", res: new Response("", { status: 402 }), paidHeader: false, amountAtomic: "2000", now: NOW });
    const paid = buildRouteLogRecord({ route: "/api/gas", method: "GET", res: paidRes(), paidHeader: true, amountAtomic: "2000", now: NOW });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await sendRouteLog(unpaid, env, ok as unknown as typeof fetch));
    expect(results).toEqual([true, true, false, false]);
    expect(await sendRouteLog(paid, env, ok as unknown as typeof fetch)).toBe(true);
    expect(DEFAULT_DAILY_CAP).toBe(3000);
  });

  it("logRouteRequest returns synchronously and never throws, even on a hostile response", () => {
    const hostile = { status: 200, headers: { get: () => { throw new Error("x"); } } } as unknown as Response;
    expect(() => logRouteRequest({ route: "/api/pulse", method: "GET", res: hostile, paidHeader: true, amountAtomic: "2000" })).not.toThrow();
    vi.stubEnv("HP_ROUTE_LOG_IN_TESTS", "true");
    expect(logRouteRequest({ route: "/api/pulse", method: "GET", res: hostile, paidHeader: true, amountAtomic: "2000" })).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("route log: per-route paid counter (hp:rl:p)", () => {
  it("paid without a tx still counts (numkeys 3, no tx key); rail falls back to 'unknown'", () => {
    const noTx = new Response("{}", { status: 200, headers: { "payment-response": settle({ success: true, payer: PAYER }) } });
    const cmd = evalCommand(buildRouteLogRecord({ route: "/api/gas", method: "GET", res: noTx, paidHeader: true, amountAtomic: "5000", now: NOW }));
    expect(cmd[2]).toBe("3");
    expect(cmd.slice(3, 6)).toEqual(["hp:rl:d:2026-10-17", "hp:rl:r:2026-10-17", "hp:rl:p:2026-10-17"]);
    expect(cmd.slice(11)).toEqual(["/api/gas|unknown|calls", "/api/gas|unknown|atomic", "5000"]);
  });
  it("ET day boundary: 11:30 PM ET lands on that ET day", () => {
    const late = new Date("2026-10-18T03:30:00.000Z");
    const cmd = evalCommand(buildRouteLogRecord({ route: "/api/pulse", method: "GET", res: paidRes(), paidHeader: true, amountAtomic: "2000", now: late }));
    expect(cmd[5]).toBe("hp:rl:p:2026-10-17");
  });
  it("atomicOrZero only passes plain integers to HINCRBY", () => {
    expect(atomicOrZero("2000")).toBe("2000");
    expect(atomicOrZero("0010")).toBe("10");
    for (const bad of [null, "", "1.5", "-1", "1e3", "abc", "9".repeat(19)]) expect(atomicOrZero(bad)).toBe("0");
  });
});
