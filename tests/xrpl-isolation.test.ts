/**
 * Isolation: no XRPL failure may change the Base path.
 *   - unpaid 402 / OPTIONS: byte-identical to the main golden when the XRPL
 *     package fails to import, the facilitator is down / hangs / lacks xrpl
 *   - paid: Base payloads go only to CDP and settle exactly as with the flag
 *     off; XRPL payloads go only to the XRPL facilitator; an XRPL verify or
 *     settle throw never reaches the Base path.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { encode } from "xrpl";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { __setXrplModuleLoaderForTests, resetXrplRailForTests } from "@/lib/xrpl-rail";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { captureRoutes, captureDiscovery, type Captured } from "./helpers/capture";
import { CDP_URL_PREFIX, type FacilitatorCall } from "./helpers/facilitator-mock";
import { installBothFacilitators, setCdp, stubXrplOn, XRPL_PAYER, XRPL_PAYTO, DEFAULT_XRPL_FACILITATOR } from "./helpers/xrpl-env";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

async function captureAll() {
  setCdp(true);
  const cdp = await captureRoutes();
  setCdp(false);
  const local = await captureRoutes();
  return { cdp, local, discovery: await captureDiscovery() };
}

const warnSpy = () => vi.mocked(console.warn);
const xrplWarned = () => warnSpy().mock.calls.some((c) => String(c[0]).startsWith("[xrpl-rail]"));

describe("unpaid isolation: XRPL failures serve the exact main 402", () => {
  beforeEach(() => {
    resetXrplRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    __setXrplModuleLoaderForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("package import throws", async () => {
    installBothFacilitators();
    __setXrplModuleLoaderForTests(() => Promise.reject(new Error("Cannot find module '@x402/xrpl'")));
    stubXrplOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(xrplWarned()).toBe(true);
  });

  it("XRPL scheme constructor throws", async () => {
    installBothFacilitators();
    const real = await import("@x402/xrpl");
    __setXrplModuleLoaderForTests(async () => ({
      ExactXrplScheme: class {
        constructor() {
          throw new Error("ctor boom");
        }
      } as never,
      RLUSD_TESTNET_ISSUER: real.RLUSD_TESTNET_ISSUER,
      RLUSD_MAINNET_ISSUER: real.RLUSD_MAINNET_ISSUER,
      RLUSD_CURRENCY: real.RLUSD_CURRENCY,
      decodeSignedTransactionBlob: real.decodeSignedTransactionBlob,
      compareDecimalStrings: real.compareDecimalStrings,
    }));
    stubXrplOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("facilitator unreachable", async () => {
    const calls = installBothFacilitators({
      supported: () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    });
    stubXrplOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    // Failure is cached: one attempt for 82 requests, not one each.
    expect(calls.filter((c) => c.op === "supported" && c.url === DEFAULT_XRPL_FACILITATOR).length).toBe(1);
  });

  it("facilitator hangs: bounded by HP_XRPL_INIT_TIMEOUT_MS", async () => {
    installBothFacilitators({ supported: () => new Promise(() => {}) });
    stubXrplOn({ HP_XRPL_INIT_TIMEOUT_MS: "150" });
    const t0 = Date.now();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("facilitator does not list the configured XRPL network", async () => {
    installBothFacilitators({
      supported: () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} }),
    });
    stubXrplOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });
});

// ---------------------------------------------------------------------------
// Paid path
// ---------------------------------------------------------------------------

const BASE_PAYER = `0x${"11".repeat(20)}`;
const BASE_TX = `0x${"ab".repeat(32)}`;
const XRPL_TX = "C".repeat(64);

function cdpBehaviour(xrpl: { verify?: () => unknown; settle?: () => unknown } = {}) {
  return {
    verify: (url: string, _p: unknown, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { isValid: true, payer: BASE_PAYER };
      if (xrpl.verify) return xrpl.verify();
      return { isValid: true, payer: XRPL_PAYER };
    },
    settle: (url: string, _p: unknown, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: BASE_TX, network: r.network, payer: BASE_PAYER };
      if (xrpl.settle) return xrpl.settle();
      return { success: true, transaction: XRPL_TX, network: r.network, payer: XRPL_PAYER };
    },
  };
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

const unpaid = () => new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } });
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", {
    headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) },
  });

function basePayload(baseAccept: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: baseAccept,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: {
        from: BASE_PAYER,
        to: baseAccept.payTo,
        value: baseAccept.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"00".repeat(32)}`,
      },
    },
  } as PaymentPayload;
}

function xrplPayload(xrplAccept: PaymentRequirements, patch: Record<string, unknown> = {}): PaymentPayload {
  const amt = { currency: xrplAccept.asset, issuer: (xrplAccept.extra as { issuer: string }).issuer, value: xrplAccept.amount };
  const tx: Record<string, unknown> = {
    TransactionType: "Payment",
    Account: XRPL_PAYER,
    Destination: xrplAccept.payTo,
    Amount: amt,
    SendMax: amt,
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_000_000,
    Flags: 0,
    SigningPubKey: "",
    ...patch,
  };
  return { x402Version: 2, accepted: xrplAccept, payload: { signedTxBlob: encode(tx as never) } } as PaymentPayload;
}

async function snap(res: Response) {
  const headers = [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return { status: res.status, headers, body: await res.text() };
}

const goldenPulseHeader = () =>
  (golden.cdp["GET /api/pulse json"] as Captured).headers.find(([k]) => k === "payment-required")![1];

describe("paid isolation", () => {
  let calls: FacilitatorCall[];
  beforeEach(() => {
    resetXrplRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    __setXrplModuleLoaderForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function getAccepts() {
    const { handler } = makeHandler();
    const res = await handler(unpaid());
    return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
  }

  it("Base payment: identical response with flag off and on; only CDP sees it", async () => {
    calls = installBothFacilitators(cdpBehaviour());
    vi.unstubAllEnvs();
    setCdp(true);
    const [baseAccept] = await getAccepts();
    const offRun = makeHandler();
    const off = await snap(await offRun.handler(paid(basePayload(baseAccept))));
    expect(off.status).toBe(200);
    expect(offRun.ran.count).toBe(1);

    stubXrplOn();
    const accepts = await getAccepts();
    expect(accepts.map((a) => a.network)).toEqual(["eip155:8453", "xrpl:1"]);
    expect(JSON.stringify(accepts[0])).toBe(JSON.stringify(baseAccept));
    calls.length = 0;
    const onRun = makeHandler();
    const on = await snap(await onRun.handler(paid(basePayload(accepts[0]))));
    expect(on).toEqual(off);
    expect(onRun.ran.count).toBe(1);
    const payCalls = calls.filter((c) => c.op !== "supported");
    expect(payCalls.map((c) => c.op)).toEqual(["verify", "settle"]);
    expect(payCalls.every((c) => c.url.startsWith(CDP_URL_PREFIX) && c.network === "eip155:8453")).toBe(true);
  });

  it("XRPL payment: verified + settled only by the XRPL facilitator", async () => {
    calls = installBothFacilitators(cdpBehaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(200);
    expect(run.ran.count).toBe(1);
    expect(res.headers.get("payment-response")).toBeTruthy();
    const payCalls = calls.filter((c) => c.op !== "supported");
    expect(payCalls.map((c) => c.op)).toEqual(["verify", "settle"]);
    expect(payCalls.every((c) => c.url === DEFAULT_XRPL_FACILITATOR && c.network === "xrpl:1")).toBe(true);
  });

  it("XRPL verify throws: no charge, handler not run, CDP untouched, Base still settles after", async () => {
    calls = installBothFacilitators(cdpBehaviour({ verify: () => { throw new Error("xrpl verify exploded"); } }));
    stubXrplOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(run.ran.count).toBe(0);
    expect(calls.filter((c) => c.url.startsWith(CDP_URL_PREFIX) && c.op !== "supported")).toEqual([]);

    calls.length = 0;
    const base = await run.handler(paid(basePayload(accepts[0])));
    expect(base.status).toBe(200);
    expect(run.ran.count).toBe(1);
    expect(calls.filter((c) => c.op !== "supported").every((c) => c.url.startsWith(CDP_URL_PREFIX))).toBe(true);
  });

  it("XRPL settle throws: Base path unaffected afterwards", async () => {
    calls = installBothFacilitators(cdpBehaviour({ settle: () => { throw new Error("xrpl settle exploded"); } }));
    stubXrplOn();
    const accepts = await getAccepts();
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(run.ran.count).toBe(1); // handler ran, settle failed => library returns 402, nothing charged
    const pr = res.headers.get("payment-response");
    if (pr) expect(JSON.parse(Buffer.from(pr, "base64").toString()).success).toBe(false);
    expect(calls.filter((c) => c.url.startsWith(CDP_URL_PREFIX) && c.op !== "supported")).toEqual([]);
    const base = await run.handler(paid(basePayload(accepts[0])));
    expect(base.status).toBe(200);
    expect(run.ran.count).toBe(2);
  });

  it("XRPL payload with Memos (t54-style): rejected before any facilitator call, Base-only 402", async () => {
    calls = installBothFacilitators(cdpBehaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1], { Memos: [{ Memo: { MemoData: "AB" } }] })));
    expect(res.status).toBe(402);
    expect(run.ran.count).toBe(0);
    expect(res.headers.get("payment-required")).toBe(goldenPulseHeader());
    expect(calls.filter((c) => c.op !== "supported")).toEqual([]);
  });

  it("XRPL payload while the XRPL package is broken: Base-only 402; Base payment still settles", async () => {
    calls = installBothFacilitators(cdpBehaviour());
    stubXrplOn();
    const accepts = await getAccepts(); // capture a well-formed XRPL accept first
    __setXrplModuleLoaderForTests(() => Promise.reject(new Error("import boom")));
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(goldenPulseHeader());
    const base = await run.handler(paid(basePayload(accepts[0])));
    expect(base.status).toBe(200);
    expect(run.ran.count).toBe(1);
  });

  it("flag off: an XRPL-looking payload is never decoded as XRPL; it takes main's CDP path", async () => {
    calls = installBothFacilitators(cdpBehaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    vi.unstubAllEnvs();
    setCdp(true);
    resetXrplRailForTests();
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(run.ran.count).toBe(0);
    // No XRPL facilitator traffic at all with the flag off.
    expect(calls.some((c) => c.url === DEFAULT_XRPL_FACILITATOR)).toBe(false);
  });

  it("payTo sanity", () => {
    expect(XRPL_PAYTO).not.toBe(XRPL_PAYER);
  });
});
