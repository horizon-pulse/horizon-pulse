/**
 * /api/bazaar-check route: the unpaid 402 shape (CDP mode and local mode,
 * Solana flag off and on), OPTIONS, and the paid path (Base-paid report is
 * settled; a not-billed error is never settled). Facilitators and the Solana
 * RPC are mocked; lib/bazaar-check is stubbed so no seller is contacted.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { USDC_BASE } from "@/lib/config";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { installBothFacilitators, setCdp, stubSolanaOn } from "./helpers/solana-env";

const stub = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/bazaar-check", async (orig) => ({
  ...(await orig<object>()),
  checkBazaar: async () => stub.result,
}));

const ROOT = path.resolve(__dirname, "..");
const BASE_PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const SOLANA_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE_PAYER = `0x${"11".repeat(20)}`;

type RouteModule = { GET: (r: NextRequest) => Promise<Response>; OPTIONS: () => Promise<Response> };
const load = async () => (await import(path.join(ROOT, "app", "api", "bazaar-check", "route.ts"))) as RouteModule;

function req(payment?: PaymentPayload): NextRequest {
  const headers: Record<string, string> = { accept: "application/json" };
  if (payment) headers["payment-signature"] = encodePaymentSignatureHeader(payment);
  return new NextRequest("https://horizonpulse.dev/api/bazaar-check?url=example.com", { method: "GET", headers });
}
const basePayload = (a: PaymentRequirements): PaymentPayload =>
  ({
    x402Version: 2,
    accepted: a,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: { from: BASE_PAYER, to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  }) as PaymentPayload;

type PR = ReturnType<typeof decodePaymentRequiredHeader> & {
  resource: { url: string; description: string; serviceName: string; tags: string[] };
  extensions?: { bazaar: { info: { input: { method: string; queryParams: Record<string, string> } }; schema: { properties: { input: { properties: { method: { enum: string[] }; queryParams: { required: string[] } } } } } } };
};

describe("/api/bazaar-check 402", () => {
  beforeEach(() => {
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("CDP mode, flag off: $0.01 Base USDC only, v2 header, Bazaar metadata with explicit GET", async () => {
    installBothFacilitators();
    vi.unstubAllEnvs();
    setCdp(true);
    const res = await (await load()).GET(req());
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!) as PR;
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC_BASE, payTo: BASE_PAYTO, maxTimeoutSeconds: 300 });
    expect(pr.resource.url).toMatch(/^https:\/\/horizonpulse\.dev\/api\/bazaar-check(\?|$)/); // the SDK echoes the request URL
    expect(pr.resource.description).toBe(ROUTE_METADATA["/api/bazaar-check"].description);
    expect(pr.resource.description.length).toBeLessThanOrEqual(500);
    expect(pr.resource.serviceName).toBe("Horizon Pulse");
    expect(pr.resource.tags).toEqual(["developer-tools", "x402", "bazaar", "indexing", "lint"]);
    const bz = pr.extensions!.bazaar;
    expect(bz.info.input.method).toBe("GET");
    expect(bz.schema.properties.input.properties.method.enum).toEqual(["GET"]);
    expect(bz.schema.properties.input.properties.queryParams.required).toEqual(["url"]);
    expect(bz.info.input.queryParams).toEqual({ url: "horizonpulse.dev" });
  });

  it("CDP mode, flag on: Base first (unchanged), Solana second at the same price", async () => {
    installBothFacilitators();
    stubSolanaOn();
    const res = await (await load()).GET(req());
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.accepts.map((a) => a.network)).toEqual(["eip155:8453", SOLANA_NET]);
    expect(pr.accepts.map((a) => a.amount)).toEqual(["10000", "10000"]);
  });

  it("local mode (no CDP keys): v2 402 with PAYMENT-REQUIRED; OPTIONS 200 with the same challenge", async () => {
    installBothFacilitators();
    vi.unstubAllEnvs();
    setCdp(false);
    const mod = await load();
    const res = await mod.GET(req());
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.accepts[0]).toMatchObject({ network: "eip155:8453", amount: "10000", payTo: BASE_PAYTO });
    const opt = await mod.OPTIONS();
    expect(opt.status).toBe(200);
    expect(decodePaymentRequiredHeader(opt.headers.get("payment-required")!).accepts[0]!.amount).toBe("10000");
  });
});

describe("/api/bazaar-check paid", () => {
  beforeEach(() => {
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function challenge() {
    const res = await (await load()).GET(req());
    return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts[0]!;
  }

  it("Base-paid report → 200, settled on Base, priced block is Base $0.01", async () => {
    stub.result = { ok: true, verdict: "fully_indexed", routes: [] };
    const calls = installBothFacilitators({
      verify: () => ({ isValid: true, payer: BASE_PAYER }),
      settle: (_u, _p, r) => ({ success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER }),
    });
    vi.unstubAllEnvs();
    setCdp(true);
    const a = await challenge();
    const res = await (await load()).GET(req(basePayload(a)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("bazaar-check");
    expect(body.verdict).toBe("fully_indexed");
    expect(body.priced).toEqual({ amountUsd: "$0.01", amountAtomic: "10000", asset: USDC_BASE, network: "base", payTo: BASE_PAYTO });
    expect(calls.filter((c) => c.op === "settle" && c.url.startsWith(CDP_URL_PREFIX))).toHaveLength(1);
  });

  it("not-billed error (CDP discovery down) → 502, charged:false, never settled", async () => {
    stub.result = { ok: false, error: "CDP discovery unavailable", code: "cdp_unavailable", status: 502 };
    const calls = installBothFacilitators({
      verify: () => ({ isValid: true, payer: BASE_PAYER }),
      settle: () => {
        throw new Error("must not settle");
      },
    });
    vi.unstubAllEnvs();
    setCdp(true);
    const a = await challenge();
    const res = await (await load()).GET(req(basePayload(a)));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "cdp_unavailable", charged: false });
    expect(calls.some((c) => c.op === "settle")).toBe(false);
  });
});
