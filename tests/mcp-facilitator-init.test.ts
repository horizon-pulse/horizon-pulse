/**
 * MCP endpoint cold start (Odin follow-up to 283109f, 2026-10-09):
 * - lib/mcp-server.ts ensureFacilitatorReady cached a FAILED facilitator sync
 *   forever (the rejected promise stayed in initPromise), and app/mcp/route.ts
 *   had no error handling, so one transient CDP failure made every later MCP
 *   request on that instance throw (500) until it was recycled.
 * - Now the route calls the shared getResourceServer().initialize() (single-
 *   flight, retried, reset on failure) and serves a 503 if it still fails.
 * - The CDP facilitator client is built with a 20 s request timeout (library
 *   default 90 s; 10 s in ddcea2f, raised because it also bounds settle).
 * - Fatal capability/config errors are rethrown by the MCP route (no 503),
 *   matching the API routes; transient errors still get the 503.
 * - A settle that times out logs a 'settle timeout' warning with the route.
 * Offline: facilitator stubbed at the HTTPFacilitatorClient prototype.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FacilitatorCapabilityError,
  FacilitatorTimeoutError,
  HTTPFacilitatorClient,
  x402ResourceServer,
} from "@x402/core/server";
import { CDP_SUPPORTED, CDP_URL_PREFIX, installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV } from "./helpers/capture";

type McpRoute = { POST: (r: Request) => Promise<Response> };
const ROOT = path.resolve(__dirname, "..");
const loadMcp = async () => (await import(path.join(ROOT, "app", "mcp", "route.ts"))) as McpRoute;
const toolsList = () =>
  new Request("https://horizonpulse.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

function coldInstance(withCdp = true) {
  vi.resetModules();
  vi.stubEnv("CDP_API_KEY_ID", withCdp ? CDP_ENV.CDP_API_KEY_ID : "");
  vi.stubEnv("CDP_API_KEY_SECRET", withCdp ? CDP_ENV.CDP_API_KEY_SECRET : "");
  vi.stubEnv("HP_SOLANA_ENABLED", "");
}

const supportedCalls = (calls: { op: string; url: string }[]) =>
  calls.filter((c) => c.op === "supported" && c.url.startsWith(CDP_URL_PREFIX)).length;

describe("MCP endpoint: a failed facilitator sync is a 503 and is never cached", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("facilitator down: POST /mcp is a 503 + Retry-After + CORS (no throw / 500)", async () => {
    installFacilitatorMock({
      supported: () => {
        throw new TypeError("fetch failed");
      },
    });
    coldInstance();
    const mcp = await loadMcp();
    const res = await mcp.POST(toolsList());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json()).error).toMatch(/temporarily unavailable/i);
  });

  it("after a failed sync the next request re-syncs and succeeds; once synced it is not re-run", async () => {
    let down = true;
    const calls = installFacilitatorMock({
      supported: () => {
        if (down) throw new TypeError("fetch failed");
        return CDP_SUPPORTED;
      },
    });
    coldInstance();
    const mcp = await loadMcp();
    expect((await mcp.POST(toolsList())).status).toBe(503);
    const afterFailure = supportedCalls(calls);
    expect(afterFailure).toBeGreaterThanOrEqual(3); // first attempt + 2 backoff retries
    down = false;
    const ok = await mcp.POST(toolsList());
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(Array.isArray(body.result?.tools)).toBe(true);
    expect(body.result.tools.length).toBeGreaterThan(0);
    expect(supportedCalls(calls)).toBe(afterFailure + 1);
    expect((await mcp.POST(toolsList())).status).toBe(200);
    expect(supportedCalls(calls)).toBe(afterFailure + 1); // sticky after success
  });

  it("MCP and the paid API routes share ONE facilitator sync per instance", async () => {
    const calls = installFacilitatorMock();
    coldInstance();
    const mcp = await loadMcp();
    const pulse = (await import(path.join(ROOT, "app", "api", "pulse", "route.ts"))) as {
      GET: (r: Request) => Promise<Response>;
    };
    const [a, b] = await Promise.all([
      mcp.POST(toolsList()),
      pulse.GET(new Request("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }) as never),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(402);
    expect(supportedCalls(calls)).toBe(1);
  });

  it("fatal capability/config error: rethrown (no 503), not retried; a transient error still gets the 503", async () => {
    // The library throws FacilitatorCapabilityError from initialize() when the
    // facilitator's /supported answer is incompatible with a registered scheme.
    let fatal = true;
    const calls = installFacilitatorMock({
      supported: () => {
        if (fatal) return CDP_SUPPORTED;
        throw new TypeError("fetch failed");
      },
    });
    const proto = x402ResourceServer.prototype as unknown as { validateFacilitatorCapabilities(): void };
    vi.spyOn(proto, "validateFacilitatorCapabilities").mockImplementation(() => {
      if (fatal) throw new FacilitatorCapabilityError(["exact on eip155:8453: misconfigured"]);
    });
    coldInstance();
    const mcp = await loadMcp();
    await expect(mcp.POST(toolsList())).rejects.toBeInstanceOf(FacilitatorCapabilityError);
    expect(supportedCalls(calls)).toBe(1); // fatal: no backoff retries
    fatal = false;
    const res = await mcp.POST(toolsList());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
  });

  it("no CDP keys: no facilitator sync, MCP still answers", async () => {
    const calls = installFacilitatorMock({
      supported: () => {
        throw new Error("must not be called");
      },
    });
    coldInstance(false);
    const mcp = await loadMcp();
    const res = await mcp.POST(toolsList());
    expect(res.status).toBe(200);
    expect(supportedCalls(calls)).toBe(0);
  });
});

describe("CDP facilitator client timeout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is 20 s (FACILITATOR_TIMEOUT_MS), not the 90 s library default", async () => {
    const seen: number[] = [];
    vi.spyOn(HTTPFacilitatorClient.prototype, "getSupported").mockImplementation(async function (this: unknown) {
      seen.push((this as { timeoutMs: number }).timeoutMs);
      return CDP_SUPPORTED as never;
    });
    coldInstance();
    const x402 = await import(path.join(ROOT, "lib", "x402-server.ts"));
    expect(x402.FACILITATOR_TIMEOUT_MS).toBe(20_000);
    await x402.getResourceServer().initialize();
    expect(seen).toEqual([20_000]);
  });
});

describe("settle timeout warning", () => {
  const SECRET_HEADER = "c2VjcmV0LXBheW1lbnQtc2lnbmF0dXJl";
  const requirements = {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "5000",
    payTo: "0x5b32c973596078a967562ca652761404f19be0e9",
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
  const payload = {
    x402Version: 2,
    resource: { url: "https://horizonpulse.dev/api/pulse?x=1" },
    accepted: requirements,
    payload: { signature: "0xdeadbeefsig", authorization: { from: "0x1111111111111111111111111111111111111111" } },
  };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const warned = () => warn.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("settle timeout"));

  it("a CDP settle that times out logs 'settle timeout' + the route, nothing secret", async () => {
    installFacilitatorMock({
      settle: () => {
        throw new FacilitatorTimeoutError("settle", 20_000);
      },
    });
    coldInstance();
    const x402 = await import(path.join(ROOT, "lib", "x402-server.ts"));
    const server = x402.getResourceServer();
    await server.initialize();
    await expect(
      server.settlePayment(payload as never, requirements as never, undefined, {
        request: { method: "GET", path: "/api/pulse", routePattern: "/api/pulse", paymentHeader: SECRET_HEADER },
      }),
    ).rejects.toBeInstanceOf(FacilitatorTimeoutError);
    const lines = warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GET /api/pulse");
    expect(lines[0]).toContain("eip155:8453");
    expect(lines[0]).toContain("20000 ms");
    for (const secret of [SECRET_HEADER, "0xdeadbeefsig", "0x1111111111111111111111111111111111111111", CDP_ENV.CDP_API_KEY_ID, CDP_ENV.CDP_API_KEY_SECRET]) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  it("no transport context: falls back to the resource path (no query string)", async () => {
    coldInstance();
    const x402 = await import(path.join(ROOT, "lib", "x402-server.ts"));
    await x402.logSettleTimeout({
      paymentPayload: payload,
      requirements,
      declaredExtensions: {},
      phase: "after-handler",
      error: new FacilitatorTimeoutError("settle", 20_000),
    } as never);
    const lines = warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/api/pulse");
    expect(lines[0]).not.toContain("x=1");
  });

  it("other settle failures and verify timeouts do not log it", async () => {
    coldInstance();
    const x402 = await import(path.join(ROOT, "lib", "x402-server.ts"));
    const base = { paymentPayload: payload, requirements, declaredExtensions: {}, phase: "after-handler" };
    await x402.logSettleTimeout({ ...base, error: new Error("insufficient_funds") } as never);
    await x402.logSettleTimeout({ ...base, error: new FacilitatorTimeoutError("verify", 20_000) } as never);
    expect(warned()).toHaveLength(0);
  });
});
