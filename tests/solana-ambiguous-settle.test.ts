/**
 * Solana ambiguous settle: on-chain confirmation before answering (port of the XRPL ambiguous-settle ledger
 * check, Odin 11:34 AM ET 10/18). Before: any ambiguous PayAI settle → 502/504 even when the tx had landed
 * (charged, not delivered). Now: read-only, bounded search for THIS payment (a tx carrying the buyer's own
 * signature from the payload), then: paid exactly to payTo in this request → deliver the handler response with
 * PAYMENT-RESPONSE; failed on-chain → Base-only 402 (nothing moved); confirmed before this request → 409;
 * not found → unchanged 502/504. Stubbed facilitators / RPC only: no network, no keys, no money.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { FacilitatorTimeoutError } from "@x402/core/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  __flushSolanaBackgroundForTests,
  __setSolanaLedgerCheckDelaysForTests,
  __setSolanaRpcForTests,
  payloadSignatures,
  resetSolanaRailForTests,
} from "@/lib/solana-rail";
import { SOLANA_MAINNET_CAIP2, SOLANA_PAYTO, SOLANA_PAYTO_USDC_ATA, USDC_SOLANA_MINT, base58Encode } from "@/lib/solana-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { SOL_PAYER, installBothFacilitators, installRpc, stubSolanaOn, type RpcCall } from "./helpers/solana-env";

const PAYAI = "https://facilitator.payai.network";
const BASE_PAYER = `0x${"11".repeat(20)}`;
const FEE_PAYER_SIG = base58Encode(new Uint8Array(64).fill(0x77));
const OTHER_SIG = base58Encode(new Uint8Array(64).fill(0x66));

let seq = 1;
/** Wire-shaped (unsigned, not valid on-chain) tx: [2 sigs][fee-payer slot zeros][buyer sig][message]. */
function wireTx(buyerFill: number): string {
  return Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 0), Buffer.alloc(64, buyerFill), Buffer.alloc(220, seq++ % 250)]).toString("base64");
}
const buyerSigOf = (fill: number) => base58Encode(new Uint8Array(64).fill(fill));

let ran = 0;
let settleCalls = 0;
let settle: () => unknown;
const handler = () =>
  createX402GetHandler(
    async () => {
      ran++;
      return NextResponse.json({ ok: true, paid: "sol" });
    },
    pulseRouteConfig(),
    pulseOpts,
  );
async function solAccept(): Promise<PaymentRequirements> {
  const res = await handler()(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
}
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });
const solPayload = (accept: PaymentRequirements, tx: string) => ({ x402Version: 2, accepted: accept, payload: { transaction: tx } }) as PaymentPayload;

/** A confirmed getTransaction result carrying `sigs`, crediting payTo with `amount` USDC (atomic). */
function chainTx(sigs: string[], amount: string, over: { err?: unknown; blockTime?: number } = {}) {
  return {
    slot: 1,
    blockTime: over.blockTime ?? Math.floor(Date.now() / 1000),
    transaction: { signatures: sigs, message: { accountKeys: ["FeePayer1111111111111111111111111111111111", SOL_PAYER] } },
    meta: {
      err: over.err ?? null,
      preTokenBalances: [{ accountIndex: 2, mint: USDC_SOLANA_MINT, owner: SOLANA_PAYTO, uiTokenAmount: { amount: "1000" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_SOLANA_MINT, owner: SOLANA_PAYTO, uiTokenAmount: { amount: String(1000 + Number(amount)) } }],
    },
  };
}

function setup(chain: { list?: () => unknown; tx?: (sig: string) => unknown }): RpcCall[] {
  return installRpc("present", chain.list ?? (() => []), chain.tx ?? (() => null));
}

beforeEach(() => {
  resetSolanaRailForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  ran = 0;
  settleCalls = 0;
  settle = () => {
    throw new FacilitatorTimeoutError("settle", 12_000);
  };
  installBothFacilitators({
    verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : { isValid: true, payer: SOL_PAYER }),
    settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
      settleCalls++;
      return settle();
    },
  } as never);
  stubSolanaOn();
  __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
});
afterEach(async () => {
  await __flushSolanaBackgroundForTests();
  __setSolanaLedgerCheckDelaysForTests(null);
  __setSolanaRpcForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("payloadSignatures", () => {
  it("returns only the non-zero signature slots (the buyer's), base58", () => {
    expect(payloadSignatures(wireTx(0xaa))).toEqual([buyerSigOf(0xaa)]);
    expect(payloadSignatures(Buffer.from([1, ...new Array(64).fill(0)]).toString("base64"))).toEqual([]);
    expect(payloadSignatures("")).toEqual([]);
  });
});

describe("ambiguous PayAI settle → look for THIS payment on-chain", () => {
  it("timeout, no signature from PayAI; the payTo ATA shows a tx with the buyer's signature, exact amount, now → 200 paid + PAYMENT-RESPONSE (was 504)", async () => {
    const accept = await solAccept();
    const tx = wireTx(0xaa);
    const calls = setup({
      list: () => [{ signature: OTHER_SIG, blockTime: Math.floor(Date.now() / 1000) }, { signature: FEE_PAYER_SIG, blockTime: Math.floor(Date.now() / 1000) }],
      tx: (sig) => (sig === FEE_PAYER_SIG ? chainTx([FEE_PAYER_SIG, buyerSigOf(0xaa)], accept.amount) : chainTx([OTHER_SIG, buyerSigOf(0x01)], accept.amount)),
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paid: "sol" });
    const pr = JSON.parse(Buffer.from(res.headers.get("payment-response")!, "base64").toString());
    expect(pr).toMatchObject({ success: true, transaction: FEE_PAYER_SIG, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
    expect(res.headers.get("cache-control") ?? "").toContain("private");
    expect(ran).toBe(1);
    expect(settleCalls).toBe(1);
    expect(calls.some((c) => c.method === "getSignaturesForAddress" && c.account === SOLANA_PAYTO_USDC_ATA)).toBe(true);
    // Replay of the same payment afterwards: 409, never a second delivery.
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(409);
    expect(ran).toBe(1);
  });

  it("success:false WITH a signature (confirmation_timeout): that signature is checked directly → 200", async () => {
    const accept = await solAccept();
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: FEE_PAYER_SIG, network: SOLANA_MAINNET_CAIP2 });
    const calls = setup({ tx: (sig) => (sig === FEE_PAYER_SIG ? chainTx([FEE_PAYER_SIG, buyerSigOf(0xab)], accept.amount) : null) });
    const res = await handler()(paid(solPayload(accept, wireTx(0xab))));
    expect(res.status).toBe(200);
    // The ATA history is empty here, so the 200 can only come from the signature PayAI named.
    expect(calls.filter((c) => c.method === "getTransaction").map((c) => c.account)).toEqual([FEE_PAYER_SIG]);
  });

  it("a signature PayAI names that does NOT carry the buyer's signature is ignored → unchanged 502", async () => {
    const accept = await solAccept();
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: FEE_PAYER_SIG, network: SOLANA_MAINNET_CAIP2 });
    setup({ tx: () => chainTx([FEE_PAYER_SIG, buyerSigOf(0x02)], accept.amount) });
    const res = await handler()(paid(solPayload(accept, wireTx(0xac))));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
  });

  it("found but failed on-chain (meta.err) → Base-only 402, nothing moved (was 504)", async () => {
    const accept = await solAccept();
    setup({
      list: () => [{ signature: FEE_PAYER_SIG, blockTime: Math.floor(Date.now() / 1000) }],
      tx: () => chainTx([FEE_PAYER_SIG, buyerSigOf(0xad)], "0", { err: { InstructionError: [0, "Custom"] } }),
    });
    const res = await handler()(paid(solPayload(accept, wireTx(0xad))));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("found but payTo received a different amount → not confirmable → unchanged 504", async () => {
    const accept = await solAccept();
    setup({
      list: () => [{ signature: FEE_PAYER_SIG, blockTime: Math.floor(Date.now() / 1000) }],
      tx: () => chainTx([FEE_PAYER_SIG, buyerSigOf(0xae)], String(Number(accept.amount) - 1)),
    });
    expect((await handler()(paid(solPayload(accept, wireTx(0xae))))).status).toBe(504);
  });

  it("found but confirmed BEFORE this request → 409, never delivered", async () => {
    const accept = await solAccept();
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: FEE_PAYER_SIG, network: SOLANA_MAINNET_CAIP2 });
    setup({ tx: () => chainTx([FEE_PAYER_SIG, buyerSigOf(0xaf)], accept.amount, { blockTime: Math.floor(Date.now() / 1000) - 3600 }) });
    const res = await handler()(paid(solPayload(accept, wireTx(0xaf))));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('{"error":"duplicate_payment"}');
  });

  it("not on-chain (empty ATA history / RPC down) → unchanged 504 settlement_unconfirmed, bounded", async () => {
    const accept = await solAccept();
    setup({
      list: () => {
        throw new Error("rpc down");
      },
    });
    const t0 = Date.now();
    const res = await handler()(paid(solPayload(accept, wireTx(0xb0))));
    expect(res.status).toBe(504);
    expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("ATA entries older than the request (minus skew) are not even fetched", async () => {
    const accept = await solAccept();
    const calls = setup({
      list: () => [{ signature: FEE_PAYER_SIG, blockTime: Math.floor(Date.now() / 1000) - 3600 }],
      tx: () => chainTx([FEE_PAYER_SIG, buyerSigOf(0xb1)], accept.amount),
    });
    expect((await handler()(paid(solPayload(accept, wireTx(0xb1))))).status).toBe(504);
    expect(calls.filter((c) => c.method === "getTransaction")).toEqual([]);
  });
});
