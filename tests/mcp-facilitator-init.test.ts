/**
 * MCP endpoint cold start (Odin follow-up to 283109f, 2026-10-09):
 * - lib/mcp-server.ts ensureFacilitatorReady cached a FAILED facilitator sync
 *   forever (the rejected promise stayed in initPromise), and app/mcp/route.ts
 *   had no error handling, so one transient CDP failure made every later MCP
 *   request on that instance throw (500) until it was recycled.
 * - Now the route calls the shared getResourceServer().initialize() (single-
 *   flight, retried, reset on failure) and serves a 503 if it still fails.
 * - The CDP facilitator client is built with a 10 s request timeout (library
 *   default 90 s).
 * Offline: facilitator stubbed at the HTTPFacilitatorClient prototype.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";
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

  it("is ~10 s (FACILITATOR_TIMEOUT_MS), not the 90 s library default", async () => {
    const seen: number[] = [];
    vi.spyOn(HTTPFacilitatorClient.prototype, "getSupported").mockImplementation(async function (this: unknown) {
      seen.push((this as { timeoutMs: number }).timeoutMs);
      return CDP_SUPPORTED as never;
    });
    coldInstance();
    const x402 = await import(path.join(ROOT, "lib", "x402-server.ts"));
    expect(x402.FACILITATOR_TIMEOUT_MS).toBe(10_000);
    await x402.getResourceServer().initialize();
    expect(seen).toEqual([10_000]);
  });
});
