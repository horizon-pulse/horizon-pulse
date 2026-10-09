/**
 * Cold-start 500s (Odin 3-hit pattern, 2026-10-08/09): the first unpaid
 * request to a fresh instance returned HTTP 500 {"error":"Internal Server Error"}
 * and the immediate retry returned the normal 402.
 *
 * That exact body is @x402/next's createInternalErrorResponse(). On the
 * CDP-keyed path every unpaid challenge goes through withX402, whose lazy
 * per-route init() calls x402ResourceServer.initialize() -> CDP GET /supported
 * ONCE (the client only retries a 429). A transient non-timeout failure
 * (5xx, "fetch failed", socket reset on a just-thawed instance) makes that one
 * request a 500; init() then resets, so the retry succeeds. Separately, every
 * route's first request re-ran initialize() on the ONE shared resource server,
 * which clears its supported-kinds map before refetching: a request on an
 * already-initialized route that lands in that window 500s too.
 *
 * Each test simulates a cold instance (fresh module graph, CDP keys present,
 * Solana flag off) with an offline facilitator stub. No network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FacilitatorTimeoutError } from "@x402/core/server";
import { CDP_SUPPORTED, CDP_URL_PREFIX, installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV } from "./helpers/capture";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

type RouteModule = { GET: (r: NextRequest) => Promise<Response> };
const ROOT = path.resolve(__dirname, "..");
const loadRoute = async (route: string) =>
  (await import(path.join(ROOT, "app", "api", route, "route.ts"))) as RouteModule;
const jsonReq = (route: string) =>
  new NextRequest(`https://horizonpulse.dev/api/${route}`, { method: "GET", headers: { accept: "application/json" } });

async function snap(res: Response) {
  const headers = [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { status: res.status, headers, body: await res.text() };
}

/** A cold instance: fresh module graph, CDP keys present, Solana rail off. */
function coldInstance() {
  vi.resetModules();
  vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
  vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
  vi.stubEnv("HP_SOLANA_ENABLED", "");
}

const supportedCalls = (calls: { op: string; url: string }[]) =>
  calls.filter((c) => c.op === "supported" && c.url.startsWith(CDP_URL_PREFIX)).length;

describe("cold start: first unpaid request never 500s on a transient /supported failure", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("first /supported attempt fails ('fetch failed'): first request is the exact main 402, not a 500", async () => {
    let n = 0;
    const calls = installFacilitatorMock({
      supported: () => {
        n += 1;
        if (n === 1) throw new TypeError("fetch failed");
        return CDP_SUPPORTED;
      },
    });
    coldInstance();
    const pulse = await loadRoute("pulse");
    const first = await snap(await pulse.GET(jsonReq("pulse")));
    expect(first.body).not.toBe('{"error":"Internal Server Error"}');
    expect(first.status).toBe(402);
    expect(JSON.stringify(first)).toBe(JSON.stringify(golden.cdp["GET /api/pulse json"]));
    const second = await snap(await pulse.GET(jsonReq("pulse")));
    expect(JSON.stringify(second)).toBe(JSON.stringify(golden.cdp["GET /api/pulse json"]));
    expect(supportedCalls(calls)).toBe(2); // 1 failure + 1 retry, then cached
  });

  it("first /supported attempt is a CDP 5xx: same, the first request is the exact 402", async () => {
    let n = 0;
    installFacilitatorMock({
      supported: () => {
        n += 1;
        if (n === 1) throw new Error("Facilitator getSupported failed (503): upstream connect error");
        return CDP_SUPPORTED;
      },
    });
    coldInstance();
    const portfolio = await loadRoute("portfolio");
    const res = await snap(await portfolio.GET(jsonReq("portfolio")));
    expect(res.status).toBe(402);
    expect(JSON.stringify(res)).toBe(JSON.stringify(golden.cdp["GET /api/portfolio json"]));
  });

  it("a second route's first request does not wipe the shared facilitator state under an in-flight request", async () => {
    let n = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = installFacilitatorMock({
      supported: async () => {
        n += 1;
        if (n >= 2) await gate; // any re-sync hangs until released
        return CDP_SUPPORTED;
      },
    });
    coldInstance();
    const pulse = await loadRoute("pulse");
    const search = await loadRoute("search");
    expect((await pulse.GET(jsonReq("pulse"))).status).toBe(402);
    // search's first request (cold route, same process) + a concurrent pulse request
    const searchP = search.GET(jsonReq("search"));
    const pulseRes = await snap(await pulse.GET(jsonReq("pulse")));
    release();
    const searchRes = await snap(await searchP);
    expect(pulseRes.status).toBe(402);
    expect(JSON.stringify(pulseRes)).toBe(JSON.stringify(golden.cdp["GET /api/pulse json"]));
    expect(JSON.stringify(searchRes)).toBe(JSON.stringify(golden.cdp["GET /api/search json"]));
    expect(supportedCalls(calls)).toBe(1); // one shared sync per instance
  });

  it("concurrent cold first requests across routes share ONE /supported call", async () => {
    const calls = installFacilitatorMock();
    coldInstance();
    const mods = await Promise.all(["pulse", "search", "screenshot", "portfolio"].map(loadRoute));
    const res = await Promise.all(
      mods.map((m, i) => m.GET(jsonReq(["pulse", "search", "screenshot", "portfolio"][i]))),
    );
    expect(res.map((r) => r.status)).toEqual([402, 402, 402, 402]);
    expect(supportedCalls(calls)).toBe(1);
  });

  it("facilitator down on every attempt: 503 + Retry-After (no 500), then recovers to the exact 402", async () => {
    let down = true;
    const calls = installFacilitatorMock({
      supported: () => {
        if (down) throw new TypeError("fetch failed");
        return CDP_SUPPORTED;
      },
    });
    coldInstance();
    const pulse = await loadRoute("pulse");
    const res = await pulse.GET(jsonReq("pulse"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("payment-required")).toBeNull();
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    expect(supportedCalls(calls)).toBeGreaterThanOrEqual(3);
    down = false;
    const ok = await snap(await pulse.GET(jsonReq("pulse")));
    expect(JSON.stringify(ok)).toBe(JSON.stringify(golden.cdp["GET /api/pulse json"]));
  });

  it("a facilitator timeout is not retried (no multi-minute stall): 503 after exactly one /supported call", async () => {
    // The import-time warm-up and the request share ONE in-flight sync: the
    // stub holds the call open until the request is waiting on it, then times out.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = installFacilitatorMock({
      supported: async () => {
        await gate;
        throw new FacilitatorTimeoutError("supported", 10_000);
      },
    });
    coldInstance();
    const pulse = await loadRoute("pulse");
    const resP = pulse.GET(jsonReq("pulse"));
    await new Promise((r) => setTimeout(r, 0));
    release();
    const res = await resP;
    expect(res.status).toBe(503);
    expect(supportedCalls(calls)).toBe(1);
    const retried = vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("facilitator sync attempt"));
    expect(retried).toBe(false);
  });
});
