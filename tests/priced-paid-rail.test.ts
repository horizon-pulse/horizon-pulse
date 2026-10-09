/**
 * `priced` reflects the rail the caller actually paid on (Odin review fix,
 * branch fix-priced-block-network).
 *
 * Before: all 13 paid routes hard-coded network "base", Base USDC and the
 * Base payTo in their 200 body, even when the call was verified + settled on
 * the Solana rail. Now every handler builds the block with pricedBlock()
 * (lib/paid-rail.ts), which reads the rail of the x402 server that is running
 * the handler (Base/CDP server or Solana/PayAI server).
 *
 * Facilitators and the Solana RPC are mocked (no network, no funds, nothing
 * signed). Upstream data sources of the representative routes are stubbed.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { baseRail, currentPaidRail, pricedBlock, runOnPaidRail, solanaRail } from "@/lib/paid-rail";
import { USDC_BASE } from "@/lib/config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { PINNED_PAYTO, SOL_PAYER, installBothFacilitators, setCdp, stubSolanaOn } from "./helpers/solana-env";
import { PAID_ROUTES } from "./helpers/capture";

vi.mock("@/lib/spot-prices", async (orig) => ({
  ...(await orig<object>()),
  fetchSpotPricesWithFallback: async () => ({
    spots: [
      { symbol: "BTC", id: "bitcoin", priceUsd: 100000, change24hPct: 1.5 },
      { symbol: "ETH", id: "ethereum", priceUsd: 4000, change24hPct: -0.5 },
      { symbol: "SOL", id: "solana", priceUsd: 200, change24hPct: 2 },
    ],
    source: "coinbase",
    warnings: [],
  }),
}));
vi.mock("@/lib/defillama", async (orig) => ({
  ...(await orig<object>()),
  fetchRankedYields: async () => ({ scanned: 1, afterTvlFilter: 1, afterPreferenceFilter: 1, pools: [], methodology: {} }),
}));
vi.mock("@/lib/x402-check", async (orig) => ({
  ...(await orig<object>()),
  checkX402Endpoint: async () => ({ ok: true, target: "https://example.com/api", report: "stub" }),
}));

const SOLANA_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE_PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const ROOT = path.resolve(__dirname, "..");

const BASE_PAYER = `0x${"11".repeat(20)}`;
const BASE_TX = `0x${"ab".repeat(32)}`;
const SOL_SIG = "5".repeat(87);
const FAKE_TX_B64 = Buffer.alloc(400, 7).toString("base64");

function behaviour(sol: { settle?: () => unknown } = {}) {
  return {
    verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : { isValid: true, payer: SOL_PAYER }),
    settle: (url: string, _p: unknown, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: BASE_TX, network: r.network, payer: BASE_PAYER };
      if (sol.settle) return sol.settle();
      return { success: true, transaction: SOL_SIG, network: r.network, payer: SOL_PAYER };
    },
  };
}

function basePayload(a: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: a,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: { from: BASE_PAYER, to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  } as PaymentPayload;
}
const solanaPayload = (a: PaymentRequirements, tx = FAKE_TX_B64): PaymentPayload =>
  ({ x402Version: 2, accepted: a, payload: { transaction: tx } }) as PaymentPayload;

type RouteModule = { GET: (r: NextRequest) => Promise<Response>; POST?: (r: NextRequest) => Promise<Response> };
const loadRoute = async (route: string) => (await import(path.join(ROOT, "app", "api", route, "route.ts"))) as RouteModule;

function request(route: string, method: string, query: string, body: unknown, payment?: PaymentPayload): NextRequest {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (payment) headers["payment-signature"] = encodePaymentSignatureHeader(payment);
  return new NextRequest(`https://horizonpulse.dev/api/${route}${query}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const responseNetwork = (res: Response) =>
  JSON.parse(Buffer.from(res.headers.get("payment-response")!, "base64").toString()).network as string;

/** Representative routes: three GET (different handler shapes) + the POST-body route. */
const CASES = [
  { route: "pulse", method: "GET", query: "", body: undefined, usd: "$0.005", atomic: "5000" },
  { route: "yield", method: "GET", query: "", body: undefined, usd: "$0.02", atomic: "20000" },
  { route: "x402-check", method: "GET", query: "?url=https%3A%2F%2Fexample.com%2Fapi", body: undefined, usd: "$0.01", atomic: "10000" },
  { route: "extract", method: "POST", query: "", body: { html: "<html><head><title>t</title></head><body><h1>Hi</h1></body></html>" }, usd: "$0.015", atomic: "15000" },
] as const;

const basePriced = (usd: string, atomic: string) => ({ amountUsd: usd, amountAtomic: atomic, asset: USDC_BASE, network: "base", payTo: BASE_PAYTO });
const solPriced = (usd: string, atomic: string) => ({ amountUsd: usd, amountAtomic: atomic, asset: SOLANA_USDC, network: SOLANA_NET, payTo: PINNED_PAYTO });

describe("pricedBlock helper", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("no paid-rail context (demo samples, Base-only MCP): Base, byte-identical to the old hard-coded block", () => {
    expect(currentPaidRail()).toBeNull();
    const old = { amountUsd: "$0.005", amountAtomic: "5000", asset: USDC_BASE, network: "base", payTo: BASE_PAYTO };
    expect(JSON.stringify(pricedBlock("$0.005", "5000"))).toBe(JSON.stringify(old));
  });

  it("Base rail context: Base USDC + PAY_TO read at call time (as before)", async () => {
    vi.stubEnv("PAY_TO", "0x3300000000000000000000000000000000000001");
    const got = await runOnPaidRail(baseRail, async () => NextResponse.json(pricedBlock("$0.01", "10000")))(null);
    expect(await got.json()).toEqual({ amountUsd: "$0.01", amountAtomic: "10000", asset: USDC_BASE, network: "base", payTo: "0x3300000000000000000000000000000000000001" });
  });

  it("Solana rail context: Solana CAIP-2, canonical USDC mint, Solana payTo; key order unchanged", async () => {
    const rail = solanaRail({ network: SOLANA_NET, asset: SOLANA_USDC, payTo: PINNED_PAYTO });
    const got = await runOnPaidRail(() => rail, async () => NextResponse.json(pricedBlock("$0.01", "10000")))(null);
    const text = await got.text();
    expect(JSON.parse(text)).toEqual(solPriced("$0.01", "10000"));
    expect(Object.keys(JSON.parse(text))).toEqual(["amountUsd", "amountAtomic", "asset", "network", "payTo"]);
    expect(currentPaidRail()).toBeNull(); // context does not leak out of the handler
  });

  it("the Solana rail config is pinned to the canonical USDC mint and the approved payTo", async () => {
    const { USDC_SOLANA_MINT, SOLANA_PAYTO, SOLANA_MAINNET_CAIP2 } = await import("@/lib/solana-config");
    expect(USDC_SOLANA_MINT).toBe(SOLANA_USDC);
    expect(SOLANA_PAYTO).toBe(PINNED_PAYTO);
    expect(SOLANA_MAINNET_CAIP2).toBe(SOLANA_NET);
  });
});

describe("all 14 paid handlers build `priced` with the rail-aware helper", () => {
  it("no handler hard-codes the Base network / USDC / payTo in its priced block", () => {
    const dirs = readdirSync(path.join(ROOT, "app", "api"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "demo")
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...PAID_ROUTES].sort());
    expect(dirs).toHaveLength(14);
    for (const d of dirs) {
      const src = readFileSync(path.join(ROOT, "app", "api", d, "handler.ts"), "utf8");
      expect(src.match(/priced: pricedBlock\(\w+_PRICE_USD, \w+_PRICE_ATOMIC\)/g), d).toHaveLength(1);
      expect(src, d).not.toMatch(/priced: \{/);
      expect(src, d).not.toMatch(/network: "base"/);
      expect(src, d).not.toMatch(/USDC_BASE|getPayTo/);
    }
  });
});

describe("paid calls: `priced` names the rail the call was verified + settled on", () => {
  beforeEach(() => {
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function accepts(mod: RouteModule, c: (typeof CASES)[number]) {
    const fn = c.method === "POST" ? mod.POST! : mod.GET;
    const res = await fn(request(c.route, c.method, c.query, c.body));
    expect(res.status).toBe(402);
    return { fn, accepts: decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts };
  }

  for (const c of CASES) {
    it(`${c.method} /api/${c.route}: flag off, Base-paid → Base priced (unchanged)`, async () => {
      installBothFacilitators(behaviour());
      vi.unstubAllEnvs();
      setCdp(true);
      const mod = await loadRoute(c.route);
      const { fn, accepts: a } = await accepts(mod, c);
      expect(a.map((x) => x.network)).toEqual(["eip155:8453"]);
      const res = await fn(request(c.route, c.method, c.query, c.body, basePayload(a[0])));
      expect(res.status).toBe(200);
      expect(responseNetwork(res)).toBe("eip155:8453");
      expect((await res.json()).priced).toEqual(basePriced(c.usd, c.atomic));
    });

    it(`${c.method} /api/${c.route}: flag on + token account present, Base-paid → Base priced`, async () => {
      const calls = installBothFacilitators(behaviour());
      stubSolanaOn();
      const mod = await loadRoute(c.route);
      const { fn, accepts: a } = await accepts(mod, c);
      expect(a.map((x) => x.network)).toEqual(["eip155:8453", SOLANA_NET]);
      calls.length = 0;
      const res = await fn(request(c.route, c.method, c.query, c.body, basePayload(a[0])));
      expect(res.status).toBe(200);
      expect(responseNetwork(res)).toBe("eip155:8453");
      expect((await res.json()).priced).toEqual(basePriced(c.usd, c.atomic));
      expect(calls.filter((x) => x.op !== "supported").every((x) => x.url.startsWith(CDP_URL_PREFIX))).toBe(true);
    });

    it(`${c.method} /api/${c.route}: flag on + token account present, Solana-paid → Solana priced`, async () => {
      const calls = installBothFacilitators(behaviour());
      stubSolanaOn();
      const mod = await loadRoute(c.route);
      const { fn, accepts: a } = await accepts(mod, c);
      calls.length = 0;
      const res = await fn(request(c.route, c.method, c.query, c.body, solanaPayload(a[1])));
      expect(res.status).toBe(200);
      expect(responseNetwork(res)).toBe(SOLANA_NET);
      const priced = (await res.json()).priced;
      expect(priced).toEqual(solPriced(c.usd, c.atomic));
      // Same values as the accepts entry the client paid.
      expect(priced.network).toBe(a[1].network);
      expect(priced.asset).toBe(a[1].asset);
      expect(priced.payTo).toBe(a[1].payTo);
      expect(priced.amountAtomic).toBe(a[1].amount);
      expect(calls.filter((x) => x.op !== "supported").every((x) => x.url === "https://facilitator.payai.network")).toBe(true);
    });
  }

  it("Solana definitive settle failure: Base-only 402, no paid body (no priced) delivered", async () => {
    installBothFacilitators(
      behaviour({ settle: () => ({ success: false, errorReason: "settle_failed", transaction: "", network: SOLANA_NET }) }),
    );
    stubSolanaOn();
    const mod = await loadRoute("pulse");
    const { fn, accepts: a } = await accepts(mod, CASES[0]);
    const res = await fn(request("pulse", "GET", "", undefined, solanaPayload(a[1])));
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("priced");
  });

  it("concurrent Base- and Solana-paid calls each get their own rail (no cross-request leak)", async () => {
    installBothFacilitators(behaviour());
    stubSolanaOn();
    const handler = createX402GetHandler(
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return NextResponse.json({ priced: pricedBlock("$0.005", "5000") });
      },
      pulseRouteConfig(),
      pulseOpts,
    );
    const unpaid = await handler(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
    const a = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!).accepts;
    const paid = (p: PaymentPayload) =>
      handler(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } }));
    const [sol, base, sol2] = await Promise.all([
      paid(solanaPayload(a[1])),
      paid(basePayload(a[0])),
      paid(solanaPayload(a[1], Buffer.alloc(400, 8).toString("base64"))),
    ]);
    expect((await sol.json()).priced).toEqual(solPriced("$0.005", "5000"));
    expect((await base.json()).priced).toEqual(basePriced("$0.005", "5000"));
    expect((await sol2.json()).priced).toEqual(solPriced("$0.005", "5000"));
  });
});
