/**
 * Odin re-review of d8a9e2a (2026-10-08, PASS WITH 1 FIX):
 *   R1  PayAI free text never reaches our logs (reason codes only)
 *   N1  cross-instance replay check — wall-clock version REMOVED (Odin 1:19); now start slot + binding, see
 *       tests/solana-ambiguous-settle.test.ts "delta 2 … (b)" and "delta 3 … 503"
 *   N3  cold start: token-account check and rail init in parallel
 * (N2 — tinypool override — is asserted in tests/solana-review-fixes.test.ts "(4/N2) …".)
 * Mocked / stubbed only: no network, no keys, no wallets, no money.
 */
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  __flushSolanaBackgroundForTests,
  __setSolanaRpcForTests,
  resetSolanaRailForTests,
  safeCode,
} from "@/lib/solana-rail";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/solana-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { ATA_ACCOUNT_VALUE, PAYAI_SUPPORTED, SOL_PAYER, installBothFacilitators, installRpc, setCdp, stubSolanaOn, parseableSolanaTx} from "./helpers/solana-env";
import { setSolanaSharedStoreForTests as __v4SetSolanaStore } from "@/lib/solana-rail";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";

const PAYAI = "https://facilitator.payai.network";
const SOL_SIG = "5".repeat(87);
/** Not a reason code (upper case, hyphens), not base58-redactable (short runs): must never be logged. */
const MARKER = "PAYAI-FREETEXT-MARKER-Zq9";
const MARKER_REASON = `Reason ${MARKER}`;

let txSeq = 1;
// Odin 1:39 N2: parseable message + a non-zero buyer slot (an all-zero tx is refused before PayAI now).
const freshTx = () => parseableSolanaTx(txSeq++ % 250);

let now = 1_800_000_000_000;
function useClock() {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
}

function handler() {
  const ran = { count: 0 };
  return {
    ran,
    handler: createX402GetHandler(async () => {
      ran.count++;
      return NextResponse.json({ ok: true });
    }, pulseRouteConfig(), pulseOpts),
  };
}
async function accepts(): Promise<PaymentRequirements[]> {
  const res = await handler().handler(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
}
const solPayload = (accept: PaymentRequirements, tx = freshTx()) =>
  ({ x402Version: 2, accepted: accept, payload: { transaction: tx } }) as PaymentPayload;
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });

/** Every console channel, every argument, fully inspected (incl. Error causes). */
const CHANNELS = ["warn", "error", "log", "info", "debug"] as const;
function allLogText(): string {
  return CHANNELS.flatMap((c) =>
    vi.mocked(console[c]).mock.calls.flatMap((args) => args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 })))),
  ).join("\n");
}

beforeEach(() => {
  resetSolanaRailForTests();
  for (const c of CHANNELS) vi.spyOn(console, c).mockImplementation(() => {});
});
afterEach(async () => {
  await __flushSolanaBackgroundForTests();
  __setSolanaRpcForTests(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ===========================================================================
describe("R1: PayAI free text never reaches the logs (reason codes only)", () => {
  type Reply = () => Response;
  const json = (status: number, body: unknown): Reply => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const text = (status: number, body: string): Reply => () => new Response(body, { status });
  const okVerify = json(200, { isValid: true, payer: SOL_PAYER });
  const NET = SOLANA_MAINNET_CAIP2;

  const cases: [string, { verify?: Reply; settle?: Reply; supported?: Reply }][] = [
    // verify phase
    ["verify 200 isValid:false, reason+message = marker", { verify: json(200, { isValid: false, invalidReason: MARKER_REASON, invalidMessage: MARKER }) }],
    ["verify 200 isValid:false, real reason code + marker message", { verify: json(200, { isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_simulation_failed", invalidMessage: MARKER }) }],
    ["verify 400 VerifyError, reason+message = marker", { verify: json(400, { isValid: false, invalidReason: MARKER_REASON, invalidMessage: MARKER }) }],
    ["verify 500 text/plain marker", { verify: text(500, `upstream exploded ${MARKER}`) }],
    ["verify 500 JSON without isValid (marker)", { verify: json(500, { error: MARKER }) }],
    ["verify 200 non-JSON marker (FacilitatorResponseError)", { verify: text(200, `<html>${MARKER}</html>`) }],
    ["verify 200 JSON failing the schema (FacilitatorResponseError)", { verify: json(200, { surprise: MARKER }) }],
    // settle phase (verify ok)
    ["settle 200 success:false, reason+message = marker (definitive)", { verify: okVerify, settle: json(200, { success: false, errorReason: MARKER_REASON, errorMessage: MARKER, transaction: "", network: NET }) }],
    ["settle 200 success:false, real code + marker message (definitive)", { verify: okVerify, settle: json(200, { success: false, errorReason: "transaction_failed", errorMessage: MARKER, transaction: "", network: NET }) }],
    ["settle 200 success:false + tx + marker message (AMBIGUOUS, P2e)", { verify: okVerify, settle: json(200, { success: false, errorReason: "settlement_pending", errorMessage: MARKER, transaction: SOL_SIG, network: NET }) }],
    ["settle 400 SettleError, reason+message = marker", { verify: okVerify, settle: json(400, { success: false, errorReason: MARKER_REASON, errorMessage: MARKER, transaction: "", network: NET }) }],
    ["settle 500 SettleError with marker message (ambiguous)", { verify: okVerify, settle: json(500, { success: false, errorReason: "unexpected_settle_error", errorMessage: MARKER, transaction: "", network: NET }) }],
    ["settle 403 free_tier_exhausted + marker", { verify: okVerify, settle: json(403, { success: false, errorReason: `free_tier_exhausted: ${MARKER}`, errorMessage: MARKER, transaction: "", network: NET }) }],
    ["settle 500 text/plain marker", { verify: okVerify, settle: text(500, `upstream exploded ${MARKER}`) }],
    ["settle 200 non-JSON marker (FacilitatorResponseError)", { verify: okVerify, settle: text(200, `<html>${MARKER}</html>`) }],
    ["settle 200 JSON failing the schema (FacilitatorResponseError)", { verify: okVerify, settle: json(200, { surprise: MARKER }) }],
    // rail init: PayAI /supported (fee payer list)
    ["supported 500 text/plain marker", { supported: text(500, `upstream exploded ${MARKER}`) }],
    ["supported 200 non-JSON marker", { supported: text(200, `<html>${MARKER}</html>`) }],
    ["supported 200 JSON failing the schema", { supported: json(200, { kinds: MARKER }) }],
  ];

  for (const [name, replies] of cases) {
    it(`(R1) marker never logged — ${name}`, async () => {
      // Real HTTPFacilitatorClient for PayAI; CDP's /supported stays mocked.
      installBothFacilitators();
      vi.mocked(HTTPFacilitatorClient.prototype.verify).mockRestore();
      vi.mocked(HTTPFacilitatorClient.prototype.settle).mockRestore();
      if (replies.supported) vi.mocked(HTTPFacilitatorClient.prototype.getSupported).mockRestore();
      const hits: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        hits.push(u);
        if (u === `${PAYAI}/verify` && replies.verify) return replies.verify();
        if (u === `${PAYAI}/settle` && replies.settle) return replies.settle();
        if (u === `${PAYAI}/supported`) return replies.supported ? replies.supported() : Response.json(PAYAI_SUPPORTED);
        throw new Error(`unexpected fetch ${u}`);
      });
      stubSolanaOn();
      if (replies.supported) setCdp(false); // CDP client never runs (its /supported would hit fetch)

      let sol: PaymentRequirements | undefined;
      if (replies.supported) {
        const acc = await accepts();
        expect(acc).toHaveLength(1); // PayAI unusable → Base-only (fail closed)
        expect(hits).toContain(`${PAYAI}/supported`);
        sol = { scheme: "exact", network: SOLANA_MAINNET_CAIP2 } as unknown as PaymentRequirements;
        const res = await handler().handler(paid(solPayload(sol)));
        expect(res.status).toBe(402);
      } else {
        sol = (await accepts())[1];
        const res = await handler().handler(paid(solPayload(sol)));
        expect([402, 502, 504]).toContain(res.status);
        expect(await res.text()).not.toContain(MARKER);
        expect(hits).toContain(replies.settle ? `${PAYAI}/settle` : `${PAYAI}/verify`);
      }
      const logs = allLogText();
      expect(logs).toContain("[solana-rail]"); // the path did log something
      expect(logs).not.toContain(MARKER);
      expect(logs).not.toContain("Zq9");
    });
  }

  it("(R1) safeCode keeps only plain reason codes", () => {
    expect(safeCode("invalid_exact_svm_payload_transaction_simulation_failed")).toBe("invalid_exact_svm_payload_transaction_simulation_failed");
    for (const bad of [MARKER, MARKER_REASON, "free_tier_exhausted: buy", "Reason", "a b", "", undefined, 42, "x".repeat(81)]) {
      expect(safeCode(bad)).toBe("unrecognized");
    }
  });
});

// ===========================================================================
describe("N1 (Odin 1:19): the wall-clock check is gone; a settle success is ordered by the request-start slot", () => {
  it("(N1) genuine payment → 200; getSlot was read BEFORE PayAI settle; no wall-clock (json blockTime) lookup", async () => {
    const order: string[] = [];
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true } : { isValid: true, payer: SOL_PAYER }),
      settle: (url: string, _p: unknown, r: PaymentRequirements) =>
        url.startsWith(CDP_URL_PREFIX) ? { success: true } : (order.push("settle"), { success: true, transaction: SOL_SIG, network: r.network, payer: SOL_PAYER }),
    } as never);
    const rpc = stubSolanaOn();
    const push = rpc.push.bind(rpc);
    rpc.push = (...c) => (c.forEach((x) => order.push(x.method)), push(...c));
    const [, sol] = await accepts();
    expect((await handler().handler(paid(solPayload(sol)))).status).toBe(200);
    expect(order.indexOf("getSlot")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("getSlot")).toBeLessThan(order.indexOf("settle"));
    expect(rpc.filter((c) => c.method === "getTransaction" && (c.opts as { encoding?: string })?.encoding === "json")).toEqual([]);
  });
});

// ===========================================================================
describe("N3: cold start runs the token-account check and rail init in parallel", () => {
  function gatedColdStart() {
    let ataPending = false;
    const overlap = { supportedWhileAtaPending: false };
    installBothFacilitators({
      supported: async () => {
        overlap.supportedWhileAtaPending = ataPending;
        await new Promise((r) => setTimeout(r, 50));
        return PAYAI_SUPPORTED;
      },
    });
    stubSolanaOn({}, true, () => {
      ataPending = true;
      return new Promise((r) =>
        setTimeout(() => {
          ataPending = false;
          r({ context: { slot: 1 }, value: ATA_ACCOUNT_VALUE });
        }, 100),
      );
    });
    return overlap;
  }

  it("(N3) unpaid 402: PayAI /supported is fetched while the token-account RPC is still in flight", async () => {
    const overlap = gatedColdStart();
    const acc = await accepts();
    expect(overlap.supportedWhileAtaPending).toBe(true);
    expect(acc).toHaveLength(2);
  });

  it("(N3) paid path cold start: same parallel init, payment still settles", async () => {
    const overlap = gatedColdStart();
    const [, sol] = await (async () => {
      // Learn the Solana accept on a warm rail, then go cold again.
      const a = await accepts();
      resetSolanaRailForTests();
      __v4SetSolanaStore(new MemoryReplayStore()); // v4 F2: Solana needs the shared claim store (fail closed without)
      return a;
    })();
    overlap.supportedWhileAtaPending = false;
    installBothFacilitators({
      supported: async () => PAYAI_SUPPORTED,
      verify: () => ({ isValid: true, payer: SOL_PAYER }),
      settle: (_u: string, _p: unknown, r: PaymentRequirements) => ({ success: true, transaction: SOL_SIG, network: r.network, payer: SOL_PAYER }),
    } as never);
    let ataPending = false;
    let sawOverlap = false;
    vi.mocked(HTTPFacilitatorClient.prototype.getSupported).mockImplementation(async function (this: { url: string }) {
      if (this.url === PAYAI) sawOverlap = ataPending;
      return (this.url === PAYAI ? PAYAI_SUPPORTED : { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: ["bazaar"], signers: {} }) as never;
    });
    installRpc(() => {
      ataPending = true;
      return new Promise((r) => setTimeout(() => { ataPending = false; r({ context: { slot: 1 }, value: ATA_ACCOUNT_VALUE }); }, 100));
    });
    const res = await handler().handler(paid(solPayload(sol)));
    expect(res.status).toBe(200);
    expect(sawOverlap).toBe(true);
  });
});
