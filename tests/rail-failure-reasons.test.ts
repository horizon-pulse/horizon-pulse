/**
 * Odin 1b (2026-10-13): Polygon paid path — a refused verify or a failed settle
 * never serves the handler body and never charges twice; the client gets the
 * golden Base-only 402 with PAYMENT-REQUIRED.error = a machine-readable code
 * (same place Base puts it). Unpaid 402s stay byte-identical with the rail on.
 * (Solana / XRPL reason codes: solana-isolation / xrpl-isolation tests.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { resetPolygonRailForTests } from "@/lib/polygon-rail";
import { reasonFromRailResponse, sanitizeReason, settleFailReason, withRejectReason } from "@/lib/rail-reject";
import { CDP_ENV, type Captured } from "./helpers/capture";
import { CDP_URL_PREFIX, installFacilitatorMock, type FacilitatorCall } from "./helpers/facilitator-mock";
import { expectRejectedGolden } from "./helpers/reject-header";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));
const goldenPulseHeader = (golden.cdp["GET /api/pulse json"] as Captured).headers.find(([k]) => k === "payment-required")![1];
const PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const PAYER = "0x" + "ab".repeat(20);
const POLY = "eip155:137";
const BODY_MARK = "PAID-DATA-MARKER";

type Beh = { verify?: () => unknown; settle?: () => unknown };
function install(b: Beh = {}): FacilitatorCall[] {
  return installFacilitatorMock({
    supported: (url) => {
      if (!url.startsWith(CDP_URL_PREFIX)) throw new Error(`unexpected ${url}`);
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: POLY }], extensions: ["bazaar"], signers: {} };
    },
    verify: (_u, _p, r) => (r.network === POLY && b.verify ? b.verify() : { isValid: true, payer: PAYER }),
    settle: (_u, _p, r) => (r.network === POLY && b.settle ? b.settle() : { success: true, transaction: "0x" + "11".repeat(32), network: r.network, payer: PAYER }),
  });
}

function on() {
  vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
  vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
  vi.stubEnv("HP_POLYGON_ENABLED", "true");
  vi.stubEnv("HP_POLYGON_PAYTO", PAYTO);
  vi.stubEnv("HP_POLYGON_NETWORK", POLY);
}

function makeHandler() {
  const ran = { count: 0 };
  const handler = createX402GetHandler(async () => {
    ran.count++;
    return NextResponse.json({ ok: true, data: BODY_MARK });
  }, pulseRouteConfig(), pulseOpts);
  return { handler, ran };
}
const unpaid = () => new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } });
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });
function evmPayload(a: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: a,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: { from: PAYER, to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  } as PaymentPayload;
}
async function accepts() {
  const res = await makeHandler().handler(unpaid());
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts as PaymentRequirements[];
}

describe("rail-reject helpers", () => {
  it("sanitizes codes; no free text passes", () => {
    expect(sanitizeReason("insufficient_funds")).toBe("insufficient_funds");
    expect(sanitizeReason("Insufficient funds")).toBeNull();
    expect(sanitizeReason("a".repeat(81))).toBeNull();
    expect(settleFailReason("unknown")).toBe("settlement_failed");
    expect(settleFailReason("unrecognized")).toBe("settlement_failed");
    expect(settleFailReason("tef_past_seq")).toBe("tef_past_seq");
    expect(reasonFromRailResponse(null, "verification_failed")).toBe("verification_failed");
  });
  it("F1: codes carrying a 0x address or a long hex run fall back to our own code", async () => {
    const addr = "0x" + "ab".repeat(20);
    for (const bad of [addr, `bad_payto_${addr}`, "x0x1", "a".repeat(16), "deadbeefdeadbeef", `tx_${"0f".repeat(32)}`]) {
      expect(sanitizeReason(bad)).toBeNull();
      expect(settleFailReason(bad)).toBe("settlement_failed");
    }
    // Ordinary codes (short hex-ish fragments) still pass.
    for (const ok of ["insufficient_funds", "tef_past_seq", "invalid_exact_evm_payload_signature", "deadbeef"]) expect(sanitizeReason(ok)).toBe(ok);
    const mk = (hdr: string) =>
      new Response("{}", { status: 402, headers: { "payment-required": hdr } });
    const pr = (await import("@x402/core/http")).decodePaymentRequiredHeader(goldenPulseHeader);
    const enc = (await import("@x402/core/http")).encodePaymentRequiredHeader;
    expect(reasonFromRailResponse(mk(enc({ ...pr, error: addr })), "verification_failed")).toBe("verification_failed");
    expect(reasonFromRailResponse(mk(enc({ ...pr, error: "f".repeat(40) })), "verification_failed")).toBe("verification_failed");
    const r402 = new NextResponse("{}", { status: 402, headers: { "PAYMENT-REQUIRED": goldenPulseHeader, "content-type": "application/json" } });
    expect(await withRejectReason(r402, addr)).toBe(r402);
  });
  it("withRejectReason: non-402 / no reason → same object; 402 → only error changes, body kept", async () => {
    const ok = NextResponse.json({ x: 1 });
    expect(await withRejectReason(ok, "insufficient_funds")).toBe(ok);
    const r402 = new NextResponse("{}", { status: 402, headers: { "PAYMENT-REQUIRED": goldenPulseHeader, "content-type": "application/json" } });
    expect(await withRejectReason(r402, null)).toBe(r402);
    expect(await withRejectReason(r402, "Free text!")).toBe(r402);
    const out = await withRejectReason(new NextResponse("{}", { status: 402, headers: { "PAYMENT-REQUIRED": goldenPulseHeader, "content-type": "application/json" } }), "insufficient_funds");
    expect(out.status).toBe(402);
    expect(await out.text()).toBe("{}");
    expectRejectedGolden(out.headers.get("payment-required"), goldenPulseHeader, "insufficient_funds");
  });
});

describe("Polygon paid path: reasons, and the body is withheld on failure", () => {
  beforeEach(() => {
    resetPolygonRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("unpaid 402 with Polygon on: Base golden entry unchanged, Polygon appended last, no error field change", async () => {
    install();
    on();
    const res = await makeHandler().handler(unpaid());
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    const g = decodePaymentRequiredHeader(goldenPulseHeader);
    expect(pr.error).toBe(g.error);
    expect(JSON.stringify(pr.accepts[0])).toBe(JSON.stringify(g.accepts[0]));
    expect(pr.accepts.at(-1)!.network).toBe(POLY);
  });

  it("Polygon payment settles → 200 with the body (control)", async () => {
    install();
    on();
    const a = (await accepts()).find((x) => x.network === POLY)!;
    const run = makeHandler();
    const res = await run.handler(paid(evmPayload(a)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(BODY_MARK);
  });

  for (const [name, beh, code, handlerRuns] of [
    ["verify insufficient_funds", { verify: () => ({ isValid: false, invalidReason: "insufficient_funds", payer: PAYER }) }, "insufficient_funds", 0],
    ["verify invalid signature", { verify: () => ({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer: PAYER }) }, "invalid_exact_evm_payload_signature", 0],
    ["verify free-text reason", { verify: () => ({ isValid: false, invalidReason: "Account has NO funds!", payer: PAYER }) }, "verification_failed", 0],
    ["settle fails (definitive)", { settle: () => ({ success: false, errorReason: "insufficient_funds", transaction: "", network: POLY }) }, "insufficient_funds", 1],
  ] as const) {
    it(`${name}: 402 + PAYMENT-REQUIRED.error=${code}; handler body never served`, async () => {
      const calls = install(beh as Beh);
      on();
      const a = (await accepts()).find((x) => x.network === POLY)!;
      calls.length = 0;
      const run = makeHandler();
      const res = await run.handler(paid(evmPayload(a)));
      expect(res.status).toBe(402);
      expect(run.ran.count).toBe(handlerRuns);
      const body = await res.text();
      expect(body).not.toContain(BODY_MARK);
      expect(res.headers.get("payment-response")).toBeNull();
      expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader, code);
      // settle ran at most once, only for the Polygon requirement
      expect(calls.filter((c) => c.op === "settle").every((c) => c.network === POLY)).toBe(true);
      expect(calls.filter((c) => c.op === "settle").length).toBe(handlerRuns);
    });
  }

  it("preflight mismatch (amount lowered): invalid_payload, no facilitator call", async () => {
    const calls = install();
    on();
    const a = (await accepts()).find((x) => x.network === POLY)!;
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(evmPayload({ ...a, amount: "1" })));
    expect(res.status).toBe(402);
    expect(run.ran.count).toBe(0);
    expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader, "invalid_payload");
    expect(calls.filter((c) => c.op !== "supported")).toEqual([]);
  });
});
