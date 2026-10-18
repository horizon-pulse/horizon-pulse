/**
 * Shared caller-IP helper (lib/caller-ip.ts; Odin 9:12 AM ET 10/18): Vercel ipAddress()
 * source (x-real-ip), used by the free tier, /mcp and money-market-rates. Offline: Upstash
 * and the facilitator are stubs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CALLER_IP_HEADER, callerIp, normalizeIp, platformIp } from "@/lib/caller-ip";
import { payerMarkerKey, resetFreeTierState } from "@/lib/free-tier";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV } from "./helpers/capture";

const ROOT = path.resolve(__dirname, "..");
const UP = { UPSTASH_REDIS_REST_URL: "https://example-upstash.test", UPSTASH_REDIS_REST_TOKEN: "t", HP_FREE_IP_HMAC_KEY: "test-only-fixture-not-a-secret-0123456789abcdef" };
const SPOOF = { "x-forwarded-for": "9.9.9.9, 10.0.0.1", "x-vercel-forwarded-for": "8.8.8.8" };

beforeEach(() => resetFreeTierState());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("helper: ipAddress() semantics, stricter", () => {
  it("reads the header Vercel's ipAddress() reads (@vercel/functions 3.10.1 IP_HEADER_NAME = x-real-ip)", () => {
    expect(CALLER_IP_HEADER).toBe("x-real-ip");
  });
  it("takes a Request or Headers, like ipAddress(input: Request | Headers)", () => {
    expect(platformIp(new Headers({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(platformIp(new Request("https://x.test/", { headers: { "x-real-ip": "1.2.3.4" } }))).toBe("1.2.3.4");
    expect(callerIp(new NextRequest("https://x.test/", { headers: { "x-real-ip": " 2001:DB8:1:2::9 " } }))).toBe("2001:db8:1:2::/64");
  });
  it("spoofed x-forwarded-for / x-vercel-forwarded-for are ignored, alone or next to x-real-ip", () => {
    expect(callerIp(new Headers({ "x-real-ip": "1.2.3.4", ...SPOOF }))).toBe("1.2.3.4");
    expect(platformIp(new Headers({ "x-real-ip": "1.2.3.4", ...SPOOF }))).toBe("1.2.3.4");
    expect(callerIp(new Headers(SPOOF))).toBeNull();
    expect(platformIp(new Headers({ "x-forwarded-for": "9.9.9.9" }))).toBeUndefined();
    expect(platformIp(new Headers({ "x-vercel-forwarded-for": "8.8.8.8" }))).toBeUndefined();
  });
  it("absent, empty, a list, or not an IP -> no IP", () => {
    for (const v of ["", "  ", "1.2.3.4, 5.6.7.8", "1.2.3.4,", "unknown", "999.1.1.1", "1.2.3", "a.b.c.d"]) {
      expect(platformIp(new Headers({ "x-real-ip": v })), v).toBeUndefined();
      expect(callerIp(new Headers({ "x-real-ip": v })), v).toBeNull();
    }
    expect(callerIp(new Headers())).toBeNull();
  });
  it("normalizeIp: same canonical forms as before the move (IPv4 forms fold, IPv6 /64)", () => {
    for (const v of ["1.2.3.4", "1.2.3.4:443", "::ffff:1.2.3.4", "::ffff:102:304"]) expect(normalizeIp(v), v).toBe("1.2.3.4");
    expect(normalizeIp("[2001:db8:1:2::5]:443")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("::1")).toBe("0:0:0:0:0:0:0:1");
  });
  it("one helper: no file under app/ or lib/ reads an IP header itself (only lib/caller-ip.ts; http-proxy only strips them)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(path.join(ROOT, "app"));
    walk(path.join(ROOT, "lib"));
    const readers = files.filter((f) => /\.get\(\s*["'`](x-real-ip|x-forwarded-for|x-vercel-forwarded-for)["'`]/i.test(readFileSync(f, "utf8")));
    expect(readers).toEqual([]);
    const own = readFileSync(path.join(ROOT, "lib", "caller-ip.ts"), "utf8");
    expect(own).toContain("headers.get(CALLER_IP_HEADER)");
    for (const f of ["lib/free-tier.ts", "lib/mcp-server.ts", "app/api/money-market-rates/route.ts"])
      expect(readFileSync(path.join(ROOT, f), "utf8"), f).toMatch(/from "(\.\/|@\/lib\/)caller-ip"/);
  });
});

describe("money-market-rates per-IP budget uses the helper (REST and /mcp)", () => {
  async function spentFor(ip: string) {
    const mod = await import("@/lib/money-market-rates");
    mod.resetMmrCachesForTests();
    mod.mmrSpendSlotsForTests(ip, mod.UPSTREAM_PER_IP_PER_WINDOW, Date.now());
    return mod;
  }
  it("REST: the budget follows x-real-ip; a spoofed x-forwarded-for does not get a fresh bucket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
    await spentFor("1.2.3.4");
    const { GET } = await import("@/app/api/money-market-rates/route");
    const res = await GET(new NextRequest("https://horizonpulse.dev/api/money-market-rates?rates=SOFR&last=1", { headers: { "x-real-ip": "1.2.3.4", ...SPOOF } }));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limited");
  });
  it("REST: clientIp is callerIp(req): x-real-ip canonical; XFF-only -> undefined (shared bucket)", async () => {
    const mod = await import("@/lib/money-market-rates");
    const seen: (string | undefined)[] = [];
    vi.spyOn(mod, "moneyMarketRates").mockImplementation(async (_q, d) => { seen.push(d.clientIp); return {} as never; });
    const { GET } = await import("@/app/api/money-market-rates/route");
    const url = "https://horizonpulse.dev/api/money-market-rates?rates=SOFR&last=1";
    await GET(new NextRequest(url, { headers: { "x-real-ip": "1.2.3.4", ...SPOOF } }));
    await GET(new NextRequest(url, { headers: SPOOF }));
    await GET(new NextRequest(url, { headers: { "x-real-ip": "2001:db8:1:2::7" } }));
    expect(seen).toEqual(["1.2.3.4", undefined, "2001:db8:1:2::/64"]);
  });
  it("/mcp: the money_market_rates tool hits the same per-IP budget as REST for the /mcp caller", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
    await spentFor("1.2.3.4");
    const { FREE_TOOLS, withMcpCaller } = await import("@/lib/mcp-server");
    const r = await withMcpCaller(new Request("https://horizonpulse.dev/mcp", { headers: { "x-real-ip": "1.2.3.4", ...SPOOF } }), () => FREE_TOOLS[0].call({ rates: "SOFR", last: 1 }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("rate_limited");
  });
});

describe("paid /mcp call marks the known payer (helper IP)", () => {
  const PAYER = `0x${"11".repeat(20)}`;
  function upstash() {
    const calls: string[][] = [];
    const fn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const cmd = JSON.parse(String(init?.body)) as string[];
      calls.push(cmd);
      return Response.json({ result: cmd[0] === "SET" ? "OK" : 0 });
    });
    return { fn, calls };
  }
  async function paidToolCall(headers: Record<string, string>, settleOk = true) {
    const { buildPaymentRequirements } = await import("@/lib/x402-server");
    const { TOOLS } = await import("@/lib/mcp-server");
    const tool = TOOLS.find((t) => t.name === "grocery_normalize")!;
    const a = buildPaymentRequirements(tool.opts).accepts[0] as { payTo: string; amount: string };
    const payment = {
      x402Version: 2,
      accepted: a,
      payload: {
        signature: `0x${"cd".repeat(65)}`,
        authorization: { from: PAYER, to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
      },
    };
    installFacilitatorMock({
      verify: () => ({ isValid: true, payer: PAYER }),
      settle: (_u, _p, r) =>
        settleOk ? { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: PAYER } : { success: false, errorReason: "insufficient_funds", transaction: "", network: r.network },
    });
    const { POST } = await import("@/app/mcp/route");
    const res = await POST(
      new Request("https://horizonpulse.dev/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "grocery_normalize", arguments: { ingredients: ["2 cups flour"] }, _meta: { "x402/payment": payment } },
        }),
      }),
    );
    const body = (await res.json()) as { result: { isError?: boolean; _meta?: Record<string, unknown> } };
    await new Promise((r) => setTimeout(r, 10));
    return body.result;
  }

  it("settled: SET payer marker for the x-real-ip caller (spoofed XFF ignored), 30 d; tool result unchanged", async () => {
    vi.stubEnv("HP_SOLANA_ENABLED", "");
    for (const [k, v] of Object.entries({ ...UP, ...CDP_ENV, HP_FREE_TIER: "optin" })) vi.stubEnv(k, v);
    const u = upstash();
    vi.stubGlobal("fetch", u.fn);
    const r = await paidToolCall({ "x-real-ip": "1.2.3.4", ...SPOOF });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.["x402/payment-response"]).toBeTruthy();
    expect(u.calls).toEqual([["SET", payerMarkerKey("1.2.3.4"), "1", "EX", String(14 * 86400)]]);
  });
  it("no x-real-ip (only spoofable headers): settles as today, marks nothing", async () => {
    for (const [k, v] of Object.entries({ ...UP, ...CDP_ENV, HP_FREE_TIER: "optin", HP_SOLANA_ENABLED: "" })) vi.stubEnv(k, v);
    const u = upstash();
    vi.stubGlobal("fetch", u.fn);
    const r = await paidToolCall(SPOOF);
    expect(r._meta?.["x402/payment-response"]).toBeTruthy();
    expect(u.calls).toEqual([]);
  });
  it("settlement failed: no marker", async () => {
    for (const [k, v] of Object.entries({ ...UP, ...CDP_ENV, HP_FREE_TIER: "optin", HP_SOLANA_ENABLED: "" })) vi.stubEnv(k, v);
    const u = upstash();
    vi.stubGlobal("fetch", u.fn);
    const r = await paidToolCall({ "x-real-ip": "1.2.3.4" }, false);
    expect(r.isError).toBe(true);
    expect(u.calls).toEqual([]);
  });
  it("tier off (code default) and no pre-seed: a settled paid MCP call writes nothing", async () => {
    for (const [k, v] of Object.entries({ ...UP, ...CDP_ENV, HP_FREE_TIER: "", HP_FREE_PAYER_MARK: "", HP_SOLANA_ENABLED: "" })) vi.stubEnv(k, v);
    const u = upstash();
    vi.stubGlobal("fetch", u.fn);
    const r = await paidToolCall({ "x-real-ip": "1.2.3.4" });
    expect(r._meta?.["x402/payment-response"]).toBeTruthy();
    expect(u.calls).toEqual([]);
  });
});
