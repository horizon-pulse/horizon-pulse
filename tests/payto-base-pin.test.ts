/**
 * Base payTo pin (branch payto-pin-base, Sentinel baseline 2026-10-09 finding 3).
 *
 * The Base payTo is pinned in lib/config.ts the way SOLANA_PAYTO is pinned in
 * lib/solana-config.ts. PAY_TO (Vercel env) may be unset/empty or equal to the
 * pinned address (case-insensitive); any other value must refuse to serve 402s.
 *
 * LITERAL TRIPWIRE: the address is spelled out here on purpose. Changing the
 * Base payTo needs lib/config.ts AND this file edited in the same commit, Class
 * A review and Michael's approval. Do not "fix" this test to make CI green.
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PAID_ROUTES } from "./helpers/capture";

const PINNED = "0x5b32c973596078a967562ca652761404f19be0e9";
const OTHER = "0x3300000000000000000000000000000000000001";
const RETIRED = "0xe16A1b12404cB2EbC6e783beCA6E2A9253c3dC7E";
const ROOT = path.resolve(__dirname, "..");

type RouteModule = { GET: (r: NextRequest) => Promise<Response>; OPTIONS: () => Promise<Response> };
const loadRoute = async (route: string) =>
  (await import(path.join(ROOT, "app", "api", route, "route.ts"))) as RouteModule;
const unpaid = (route: string) =>
  new NextRequest(`https://horizonpulse.dev/api/${route}`, { headers: { accept: "application/json" } });

function noCdp() {
  vi.stubEnv("CDP_API_KEY_ID", "");
  vi.stubEnv("CDP_API_KEY_SECRET", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getPayTo: Base payTo is pinned", () => {
  it("exports the pinned literal", async () => {
    const { DEFAULT_PAY_TO } = await import("@/lib/config");
    expect(DEFAULT_PAY_TO).toBe(PINNED);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["exact match", PINNED],
    ["checksum/upper-case match + whitespace", `  ${PINNED.toUpperCase().replace(/^0X/, "0x")}\n`],
  ])("PAY_TO %s -> the pinned address", async (_label, value) => {
    if (value !== undefined) vi.stubEnv("PAY_TO", value);
    else delete process.env.PAY_TO;
    const { getPayTo } = await import("@/lib/config");
    expect(getPayTo()).toBe(PINNED);
  });

  it.each([
    ["a different valid address", OTHER],
    ["the retired v1 address", RETIRED],
    ["a near-miss (one hex digit off)", PINNED.slice(0, -1) + "f"],
    ["garbage", "not-an-address"],
  ])("PAY_TO = %s -> throws (fail closed)", async (_label, value) => {
    vi.stubEnv("PAY_TO", value);
    const { getPayTo } = await import("@/lib/config");
    expect(() => getPayTo()).toThrow(/pinned Base payTo/);
  });
});

describe("a different PAY_TO refuses to serve 402s", () => {
  it("every paid route module fails to load (startup error), so no 402 handler exists", async () => {
    vi.stubEnv("PAY_TO", OTHER);
    noCdp();
    expect(PAID_ROUTES).toHaveLength(14);
    for (const route of PAID_ROUTES) {
      vi.resetModules();
      await expect(loadRoute(route), route).rejects.toThrow(/pinned Base payTo/);
    }
  });

  it("request-time paths (local 402 builder, OPTIONS discovery) also refuse; no 402 is returned", async () => {
    noCdp();
    vi.stubEnv("PAY_TO", PINNED);
    const mod = await loadRoute("pulse"); // loads fine with the pinned value
    vi.stubEnv("PAY_TO", OTHER); // env drifts after load
    await expect(mod.GET(unpaid("pulse"))).rejects.toThrow(/pinned Base payTo/);
    await expect(mod.OPTIONS()).rejects.toThrow(/pinned Base payTo/);
    const { paymentRequiredResponse } = await import("@/lib/x402-server");
    expect(() =>
      paymentRequiredResponse({ maxAmountRequired: "5000", resource: "https://horizonpulse.dev/api/pulse", description: "x" }),
    ).toThrow(/pinned Base payTo/);
  });
});

describe("unset and matching PAY_TO serve the normal 402 with the pinned payTo", () => {
  it.each([
    ["unset", undefined],
    ["matching (upper-case)", PINNED.toUpperCase().replace(/^0X/, "0x")],
  ])("PAY_TO %s: every paid route returns 402 whose only Base accept pays the pinned address", async (_l, value) => {
    noCdp();
    if (value !== undefined) vi.stubEnv("PAY_TO", value);
    else delete process.env.PAY_TO;
    for (const route of PAID_ROUTES) {
      vi.resetModules();
      const mod = await loadRoute(route);
      const res = await mod.GET(unpaid(route));
      expect(res.status, route).toBe(402);
      const body = (await res.json()) as { accepts: { network: string; payTo: string }[] };
      const base = body.accepts.filter((a) => a.network === "eip155:8453");
      expect(base, route).toHaveLength(1);
      expect(base[0].payTo, route).toBe(PINNED);
      expect(JSON.stringify(body).toLowerCase(), route).not.toContain(OTHER);
    }
  });
});
