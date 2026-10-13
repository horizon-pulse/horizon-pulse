/**
 * F2 (2026-10-13 pre-pay audit): a HEAD request that carries a payment header
 * (PAYMENT-SIGNATURE or X-PAYMENT) is served exactly like an unpaid HEAD — the
 * same 402 challenge — and NEVER reaches a facilitator verify/settle, a rail's
 * on-ledger lookup, or the route handler, on any of the four rails
 * (Base, Solana, Polygon, XRPL). The GET controls prove the same payloads DO
 * reach the paid path, so the HEAD assertions are not vacuous.
 * Offline only: facilitators and RPCs are stubbed; nothing is signed or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { resetXrplRailForTests } from "@/lib/xrpl-rail";
import { resetPolygonRailForTests } from "@/lib/polygon-rail";
import { installRpc as installSolanaRpc, SOL_PAYER } from "./helpers/solana-env";
import { installXrplFacilitators, stubXrplOn, xrplPayload, XRPL_PAYER, XRPL_TX_HASH, type XrplRpcCall } from "./helpers/xrpl-env";
import { CDP_URL_PREFIX, type FacilitatorCall } from "./helpers/facilitator-mock";
import { PAID_ROUTES } from "./helpers/capture";

// Count entries into each non-Base rail's paid handler (real implementation still runs).
const railEntries = vi.hoisted(() => ({ solana: 0, xrpl: 0, polygon: 0 }));
vi.mock("@/lib/solana-rail", async (orig) => {
  const m = await orig<typeof import("@/lib/solana-rail")>();
  return { ...m, handleSolanaPayment: (...a: Parameters<typeof m.handleSolanaPayment>) => (railEntries.solana++, m.handleSolanaPayment(...a)) };
});
vi.mock("@/lib/xrpl-rail", async (orig) => {
  const m = await orig<typeof import("@/lib/xrpl-rail")>();
  return { ...m, handleXrplPayment: (...a: Parameters<typeof m.handleXrplPayment>) => (railEntries.xrpl++, m.handleXrplPayment(...a)) };
});
vi.mock("@/lib/polygon-rail", async (orig) => {
  const m = await orig<typeof import("@/lib/polygon-rail")>();
  return { ...m, handlePolygonPayment: (...a: Parameters<typeof m.handlePolygonPayment>) => (railEntries.polygon++, m.handlePolygonPayment(...a)) };
});

const EVM_PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const EVM_PAYER = `0x${"11".repeat(20)}`;
const URL_ = "https://horizonpulse.dev/api/pulse";

let calls: FacilitatorCall[];
let xrplRpc: XrplRpcCall[];
let solRpc: { method: string }[];

/** All four rails on (Solana + Polygon mainnet via CDP + XRPL testnet), CDP keys set. */
function allRailsOn() {
  vi.unstubAllEnvs();
  vi.stubEnv("HP_SOLANA_ENABLED", "true");
  vi.stubEnv("HP_SOLANA_PAYTO", "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz");
  vi.stubEnv("HP_POLYGON_ENABLED", "true");
  vi.stubEnv("HP_POLYGON_PAYTO", EVM_PAYTO);
  solRpc = installSolanaRpc("present");
  xrplRpc = stubXrplOn({}, true, "ready", true);
  calls = installXrplFacilitators({
    verify: (url, _p, r) => ({ isValid: true, payer: r.network?.startsWith("solana") ? SOL_PAYER : r.network?.startsWith("xrpl") ? XRPL_PAYER : EVM_PAYER }),
    settle: (url, _p, r) => ({ success: true, transaction: r.network?.startsWith("xrpl") ? XRPL_TX_HASH : `0x${"ab".repeat(32)}`, network: r.network, payer: EVM_PAYER }),
  });
}

function makeHandler() {
  const ran = { count: 0 };
  const handler = createX402GetHandler(
    async () => {
      ran.count++;
      return NextResponse.json({ ok: true });
    },
    pulseRouteConfig(),
    pulseOpts,
  );
  return { handler, ran };
}

const req = (method: string, extra: Record<string, string> = {}) =>
  new NextRequest(URL_, { method, headers: { accept: "application/json", ...extra } });

function payloadFor(a: PaymentRequirements): PaymentPayload {
  if (a.network.startsWith("xrpl:")) return xrplPayload(a);
  if (a.network.startsWith("solana:")) {
    return { x402Version: 2, accepted: a, payload: { transaction: Buffer.from("not-a-real-tx").toString("base64") } } as PaymentPayload;
  }
  return {
    x402Version: 2,
    accepted: a,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: { from: EVM_PAYER, to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  } as PaymentPayload;
}

const prHeader = (r: Response) => r.headers.get("payment-required");
const paidPathTouched = () =>
  railEntries.solana + railEntries.xrpl + railEntries.polygon +
  calls.filter((c) => c.op === "verify" || c.op === "settle").length +
  xrplRpc.filter((c) => c.method === "tx" || c.method === "submit").length +
  solRpc.filter((c) => c.method === "getTransaction" || c.method === "sendTransaction").length;

describe("paid HEAD never verifies or settles (F2)", () => {
  beforeEach(() => {
    resetSolanaRailForTests();
    resetXrplRailForTests();
    resetPolygonRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    allRailsOn();
    railEntries.solana = railEntries.xrpl = railEntries.polygon = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function accepts(): Promise<PaymentRequirements[]> {
    const { handler } = makeHandler();
    const res = await handler(req("GET"));
    expect(res.status).toBe(402);
    return decodePaymentRequiredHeader(prHeader(res)!).accepts as PaymentRequirements[];
  }

  it("all four rails are on in this fixture", async () => {
    const nets = (await accepts()).map((a) => a.network.split(":")[0] + ":" + a.network.split(":")[1]);
    expect(nets).toEqual(["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "xrpl:1", "eip155:137"]);
  });

  for (const headerName of ["payment-signature", "x-payment"] as const) {
    for (const rail of ["eip155:8453", "solana:", "xrpl:", "eip155:137"]) {
      it(`HEAD + ${headerName} on ${rail}: same 402 as unpaid HEAD, no verify/settle, handler never runs`, async () => {
        const accept = (await accepts()).find((a) => a.network.startsWith(rail))!;
        expect(accept, rail).toBeTruthy();
        const sig = encodePaymentSignatureHeader(payloadFor(accept));

        const { handler: h0 } = makeHandler();
        const unpaidHead = await h0(req("HEAD"));
        const before = paidPathTouched();

        const { handler, ran } = makeHandler();
        const res = await handler(req("HEAD", { [headerName]: sig }));
        expect(res.status).toBe(402);
        expect(prHeader(res)).toBe(prHeader(unpaidHead));
        expect(res.headers.get("payment-response")).toBeNull();
        expect(ran.count).toBe(0);
        expect(paidPathTouched()).toBe(before);
        expect(calls.filter((c) => c.op === "verify" || c.op === "settle")).toEqual([]);
      });
    }
  }

  // Controls: the same PAYMENT-SIGNATURE on GET does reach each rail's paid path.
  for (const rail of ["eip155:8453", "solana:", "xrpl:", "eip155:137"]) {
    it(`control: GET + payment-signature on ${rail} reaches the paid path`, async () => {
      const accept = (await accepts()).find((a) => a.network.startsWith(rail))!;
      const before = paidPathTouched();
      const { handler } = makeHandler();
      await handler(req("GET", { "payment-signature": encodePaymentSignatureHeader(payloadFor(accept)) }));
      expect(paidPathTouched()).toBeGreaterThan(before);
      if (rail === "solana:") expect(railEntries.solana).toBeGreaterThan(0);
      if (rail === "xrpl:") expect(railEntries.xrpl).toBeGreaterThan(0);
      if (rail === "eip155:137") expect(railEntries.polygon).toBeGreaterThan(0);
      if (rail === "eip155:8453") expect(calls.some((c) => c.op === "verify" && c.url.startsWith(CDP_URL_PREFIX))).toBe(true);
    });
  }

  it("unpaid HEAD still returns the same 402 accepts as GET on every paid route", async () => {
    const path = await import("node:path");
    for (const route of PAID_ROUTES) {
      const mod = (await import(path.join(__dirname, "..", "app", "api", route, "route.ts"))) as {
        GET: (r: NextRequest) => Promise<Response>;
      };
      const u = `https://horizonpulse.dev/api/${route}`;
      const g = await mod.GET(new NextRequest(u, { headers: { accept: "application/json" } }));
      const h = await mod.GET(new NextRequest(u, { method: "HEAD", headers: { accept: "application/json" } }));
      expect(h.status, route).toBe(402);
      expect(g.status, route).toBe(402);
      const gd = decodePaymentRequiredHeader(prHeader(g)!);
      const hd = decodePaymentRequiredHeader(prHeader(h)!);
      expect(JSON.stringify(hd.accepts), route).toBe(JSON.stringify(gd.accepts));
      expect(hd.resource, route).toEqual(gd.resource);
    }
  });
});
