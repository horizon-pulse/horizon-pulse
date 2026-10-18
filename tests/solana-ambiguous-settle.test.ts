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
import { FacilitatorTimeoutError, SettleError } from "@x402/core/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  __flushSolanaBackgroundForTests,
  __setSolanaLedgerCheckDelaysForTests,
  __setSolanaRpcForTests,
  payloadSignatures,
  resetSolanaRailForTests,
  setSolanaAlertHook,
  type SolanaAlert,
} from "@/lib/solana-rail";
import { SOLANA_MAINNET_CAIP2, SOLANA_PAYTO, SOLANA_PAYTO_USDC_ATA, USDC_SOLANA_MINT, base58Decode, base58Encode } from "@/lib/solana-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { SOL_PAYER, installBothFacilitators, installRpc, stubSolanaOn, type RpcCall } from "./helpers/solana-env";

const PAYAI = "https://facilitator.payai.network";
const BASE_PAYER = `0x${"11".repeat(20)}`;
const FEE_PAYER_SIG = base58Encode(new Uint8Array(64).fill(0x77));
const OTHER_SIG = base58Encode(new Uint8Array(64).fill(0x66));

let seq = 1;
const START_SLOT = 300_000_000;
const SOL_PAYER_BYTES = Buffer.from(base58Decode(SOL_PAYER)!);
/**
 * Wire-shaped tx (NOT valid on-chain, nothing is signed): [2 sigs][slot 0][slot 1 = buyer][legacy message:
 * header 2/0/1, 4 keys (fee payer, buyer=SOL_PAYER, ATA-ish, program-ish), 32-byte blockhash, filler]. `feeFill` 0 =
 * the payload shape (fee-payer slot empty); chain copies carry a fee-payer signature.
 */
function msgBytes(tag: number): Buffer {
  return Buffer.concat([Buffer.from([2, 0, 1, 4]), Buffer.alloc(32, 0x31), SOL_PAYER_BYTES, Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x34), Buffer.alloc(32, tag), Buffer.alloc(60, tag ^ 0x5a)]);
}
function wire(buyerFill: number, msg: Buffer, feeFill = 0): string {
  return Buffer.concat([Buffer.from([2]), Buffer.alloc(64, feeFill), Buffer.alloc(64, buyerFill), msg]).toString("base64");
}
/** A payload tx + its message (unique per call). */
function payTx(buyerFill: number) {
  const msg = msgBytes(seq++ % 250);
  return { tx: wire(buyerFill, msg), msg };
}
const buyerSigOf = (fill: number) => base58Encode(new Uint8Array(64).fill(fill));
/** Legacy fixture for the payloadSignatures unit test. */
function wireTx(buyerFill: number): string {
  return payTx(buyerFill).tx;
}

let ran = 0;
let settleCalls = 0;
let settle: () => unknown;
let order: string[] = [];
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

/** A getTransaction result (base64 encoding) for the wire tx `b64`, crediting payTo with `amount` USDC (atomic). */
function chainTx(b64: string, amount: string, over: { err?: unknown; slot?: number; blockTime?: number } = {}) {
  return {
    slot: over.slot ?? START_SLOT + 5,
    blockTime: over.blockTime ?? Math.floor(Date.now() / 1000),
    transaction: [b64, "base64"],
    meta: {
      err: over.err ?? null,
      preTokenBalances: [{ accountIndex: 2, mint: USDC_SOLANA_MINT, owner: SOLANA_PAYTO, uiTokenAmount: { amount: "1000" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_SOLANA_MINT, owner: SOLANA_PAYTO, uiTokenAmount: { amount: String(1000 + Number(amount)) } }],
    },
  };
}

function setup(chain: { list?: () => unknown; tx?: (sig: string, opts?: Record<string, unknown>) => unknown; slot?: () => unknown }): RpcCall[] {
  // The same chain tx in whichever encoding is asked for (json for the pre-fix code, base64 for the fix), so the
  // before-fix run exercises the real old matching logic.
  const txFn = (sig: string, opts?: Record<string, unknown>) => {
    const r = (chain.tx ?? (() => null))(sig, opts) as { transaction?: unknown } | null;
    if (!r || opts?.encoding !== "json" || !Array.isArray(r.transaction)) return r;
    const b = Buffer.from(String(r.transaction[0]), "base64");
    const n = b[0];
    const sigs = Array.from({ length: n }, (_, j) => base58Encode(Uint8Array.from(b.subarray(1 + 64 * j, 1 + 64 * (j + 1)))));
    const m = b.subarray(1 + 64 * n);
    const keys = Array.from({ length: m[3] }, (_, j) => base58Encode(Uint8Array.from(m.subarray(4 + 32 * j, 4 + 32 * (j + 1)))));
    return { ...r, transaction: { signatures: sigs, message: { accountKeys: keys } } };
  };
  const calls = installRpc("present", chain.list ?? (() => []), txFn, chain.slot ?? (() => START_SLOT));
  const push = calls.push.bind(calls);
  calls.push = (...c: RpcCall[]) => {
    for (const x of c) order.push(x.method);
    return push(...c);
  };
  return calls;
}
const reconcileLines = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map((c) => String(c[0]))
    .filter((l) => l.includes("SOLANA_RECONCILE "))
    .map((l) => JSON.parse(l.slice(l.indexOf("{"))));

beforeEach(() => {
  resetSolanaRailForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  ran = 0;
  settleCalls = 0;
  order = [];
  settle = () => {
    throw new FacilitatorTimeoutError("settle", 12_000);
  };
  installBothFacilitators({
    verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : { isValid: true, payer: SOL_PAYER }),
    settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
      settleCalls++;
      order.push("SETTLE");
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

const FEE = 0x77; // fee-payer signature fill on chain copies
const txidOf = () => buyerSigOf(FEE); // chain tx id = slot-0 signature (fee payer)

describe("ambiguous PayAI settle → look for OUR message on-chain (Odin 12:31 S1/S2)", () => {
  it("timeout, no PayAI signature; the ATA history has OUR message (bound), slot > request-start slot → 200 paid, payer from OUR message", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xaa);
    const ours = wire(0xaa, msg, FEE);
    const other = wire(0x01, msgBytes(0xee), 0x66);
    const calls = setup({
      list: () => [{ signature: buyerSigOf(0x66), slot: START_SLOT + 3 }, { signature: txidOf(), slot: START_SLOT + 5 }],
      tx: (sig) => (sig === txidOf() ? chainTx(ours, accept.amount) : chainTx(other, accept.amount)),
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paid: "sol" });
    const pr = JSON.parse(Buffer.from(res.headers.get("payment-response")!, "base64").toString());
    expect(pr).toMatchObject({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
    expect(res.headers.get("cache-control") ?? "").toContain("private");
    expect(calls.filter((c) => c.method === "getTransaction").every((c) => (c.opts as { encoding?: string }).encoding === "base64")).toBe(true);
    expect(calls.some((c) => c.method === "getSignaturesForAddress" && c.account === SOLANA_PAYTO_USDC_ATA)).toBe(true);
    // The start slot is read BEFORE settle, with confirmed commitment.
    expect(order.indexOf("getSlot")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("getSlot")).toBeLessThan(order.indexOf("SETTLE"));
    expect(calls.find((c) => c.method === "getSlot")!.account).toEqual({ commitment: "confirmed" });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(409);
    expect(ran).toBe(1);
  });

  it("S2: a candidate carrying the buyer's SIGNATURE but a DIFFERENT message (copied-signature attack) is never accepted → unchanged 504, nothing delivered", async () => {
    const accept = await solAccept();
    const { tx } = payTx(0xab);
    // The victim's real tx: same signature bytes in slot 1 (copied into the attacker's payload), other message.
    const victim = wire(0xab, msgBytes(0xdd), FEE);
    setup({ list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }], tx: () => chainTx(victim, accept.amount) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(504);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("S2: PayAI's signature is only a hint: it is fetched first and accepted once bound to OUR message → 200", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xac);
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: txidOf(), network: SOLANA_MAINNET_CAIP2 });
    const calls = setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xac, msg, FEE), accept.amount) : null) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === "getTransaction").map((c) => c.account)[0]).toBe(txidOf());
  });

  it("S2: a PayAI-named tx that is NOT our message is ignored (even if it pays exactly and carries the buyer signature) → unchanged 502", async () => {
    const accept = await solAccept();
    const { tx } = payTx(0xad);
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: txidOf(), network: SOLANA_MAINNET_CAIP2 });
    setup({ tx: () => chainTx(wire(0xad, msgBytes(0xcc), FEE), accept.amount) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
  });

  it("S2: same message but a different signature in the buyer slot → not ours → unchanged 504", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xae);
    setup({ list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }], tx: () => chainTx(wire(0xaf, msg, FEE), accept.amount) });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(504);
  });

  it("S1: PayAI duplicate_settlement → NEVER delivered even though our message is on-chain and fresh; main's 502; no on-chain lookup; reconcile line", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb0);
    settle = () => ({ success: false, errorReason: "duplicate_settlement", transaction: "", network: SOLANA_MAINNET_CAIP2 });
    const calls = setup({ list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }], tx: () => chainTx(wire(0xb0, msg, FEE), accept.amount) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(502);
    expect(res.headers.get("payment-response")).toBeNull();
    // (the background PayAI-usage counter also lists the ATA, with a large limit; the on-chain search uses limit 10)
    expect(calls.filter((c) => c.method === "getTransaction" || (c.method === "getSignaturesForAddress" && (c.opts as { limit?: number })?.limit === 10))).toEqual([]);
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 502, reason: "duplicate_settlement", payer: SOL_PAYER, amount: accept.amount, buyerSignature: buyerSigOf(0xb0) })]);
  });

  it("S1: freshness is by chain SLOT: our message at slot ≤ request-start slot (block time 'now') → 409 + reconcile line, never delivered", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb1);
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: txidOf(), network: SOLANA_MAINNET_CAIP2 });
    setup({ tx: () => chainTx(wire(0xb1, msg, FEE), accept.amount, { slot: START_SLOT, blockTime: Math.floor(Date.now() / 1000) }) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('{"error":"duplicate_payment"}');
    expect(ran).toBe(1); // handler ran before settle; its response was withheld
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 409, reason: "ambiguous_settle_landed_before_request", payer: SOL_PAYER, txid: txidOf() })]);
  });

  it("S1: slot > request-start slot delivers even with an old block time (wall clock is not used)", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb2);
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: txidOf(), network: SOLANA_MAINNET_CAIP2 });
    setup({ tx: () => chainTx(wire(0xb2, msg, FEE), accept.amount, { slot: START_SLOT + 1, blockTime: Math.floor(Date.now() / 1000) - 3600 }) });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(200);
  });

  it("S1: no request-start slot, even with a bound fresh PayAI hint → never delivered, unchanged 502 + reconcile, nothing fetched", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xbe);
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: txidOf(), network: SOLANA_MAINNET_CAIP2 });
    const calls = setup({
      tx: () => chainTx(wire(0xbe, msg, FEE), accept.amount, { slot: START_SLOT + 5 }),
      slot: () => {
        throw new Error("rpc down");
      },
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(502);
    expect(res.headers.get("payment-response")).toBeNull();
    expect(calls.filter((c) => c.method === "getTransaction")).toEqual([]);
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 502, reason: "ambiguous_settle_no_start_slot", payer: SOL_PAYER })]);
  });

  it("S1: no request-start slot (getSlot failed) → never delivered from chain: unchanged 504 + reconcile", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb3);
    setup({
      list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }],
      tx: () => chainTx(wire(0xb3, msg, FEE), accept.amount),
      slot: () => {
        throw new Error("rpc down");
      },
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(504);
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 504, reason: "ambiguous_settle_no_start_slot" })]);
  });

  it("ATA entries at slot ≤ request-start slot are not even fetched", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb4);
    const calls = setup({ list: () => [{ signature: txidOf(), slot: START_SLOT }], tx: () => chainTx(wire(0xb4, msg, FEE), accept.amount) });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(504);
    expect(calls.filter((c) => c.method === "getTransaction")).toEqual([]);
  });

  it("failed on-chain at confirmed AND finalized → Base-only 402 (terminal), finalized was read", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb5);
    const calls = setup({
      list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }],
      tx: () => chainTx(wire(0xb5, msg, FEE), "0", { err: { InstructionError: [0, "Custom"] } }),
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-response")).toBeNull();
    expect(calls.filter((c) => c.method === "getTransaction").map((c) => (c.opts as { commitment: string }).commitment)).toEqual(["confirmed", "finalized"]);
  });

  it("failed at confirmed but NOT (yet) finalized → no terminal 402: unchanged 504 + reconcile", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb6);
    setup({
      list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }],
      tx: (_s, o) => ((o as { commitment: string }).commitment === "finalized" ? null : chainTx(wire(0xb6, msg, FEE), "0", { err: { InstructionError: [0, "Custom"] } })),
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(504);
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 504, reason: "ambiguous_settle_not_found" })]);
  });

  it("found but payTo received a different amount → not confirmable → unchanged 504", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xb7);
    setup({ list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }], tx: () => chainTx(wire(0xb7, msg, FEE), String(Number(accept.amount) - 1)) });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(504);
  });

  it("not on-chain / RPC down → unchanged 504, bounded, ONE reconcile line with payer (our message), amount, our buyer signature, outcome; no facilitator text", async () => {
    const accept = await solAccept();
    const { tx } = payTx(0xb8);
    setup({
      list: () => {
        throw new Error("rpc down");
      },
    });
    const t0 = Date.now();
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(504);
    expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
    expect(Date.now() - t0).toBeLessThan(5_000);
    const lines = reconcileLines();
    expect(lines).toEqual([
      { status: 504, reason: "ambiguous_settle_not_found", fp: expect.stringMatching(/^[0-9a-f]{16}$/), payer: SOL_PAYER, amount: accept.amount, asset: USDC_SOLANA_MINT, payTo: SOLANA_PAYTO, buyerSignature: buyerSigOf(0xb8) },
    ]);
  });

  it("unit: ourPayment / parseWireTx read OUR message, buyer slot, signature and payer (key of that slot)", async () => {
    const { ourPayment, parseWireTx } = await import("@/lib/solana-rail");
    const { tx, msg } = payTx(0xb9);
    const o = ourPayment(tx)!;
    expect(Buffer.from(o.message).equals(msg)).toBe(true);
    expect(o).toMatchObject({ slot: 1, signature: buyerSigOf(0xb9), payer: SOL_PAYER });
    expect(parseWireTx(Buffer.from([1]))).toBeNull();
    expect(ourPayment(wire(0, msg))).toBeNull(); // no buyer signature at all
    // v0 message: version prefix byte then the same layout.
    const v0 = Buffer.concat([Buffer.from([0x80]), msg]);
    expect(ourPayment(wire(0xb9, v0))!.payer).toBe(SOL_PAYER);
  });
});

// ===========================================================================
// Odin 12:51 PM ET delta 2: C1 (any facilitator 409 = duplicate), (b) success path on slot + binding, reconcile ALERT.
// ===========================================================================
describe("delta 2 (Odin 12:51): C1 any 409 = duplicate; (b) settle-success path on the start slot + S2 binding; reconcile ALERT", () => {
  let alerts: SolanaAlert[] = [];
  beforeEach(() => {
    alerts = [];
    setSolanaAlertHook((a) => alerts.push(a));
  });
  afterEach(() => setSolanaAlertHook(null));
  const searchCalls = (calls: RpcCall[]) =>
    calls.filter((c) => c.method === "getTransaction" || (c.method === "getSignaturesForAddress" && (c.opts as { limit?: number })?.limit === 10));
  const reconcileAlerts = () => alerts.filter((a) => a.kind === "solana_reconcile");
  const settleOk = () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });

  for (const [name, thrower] of [
    ["SettleError 409 with a DIFFERENT reason (settlement_in_flight)", () => new SettleError(409, { success: false, errorReason: "settlement_in_flight", transaction: "", network: SOLANA_MAINNET_CAIP2 } as never)],
    ["SettleError 409 with an unknown reason and a tx signature", () => new SettleError(409, { success: false, errorReason: "conflict", transaction: buyerSigOf(FEE), network: SOLANA_MAINNET_CAIP2 } as never)],
    ["non-JSON 409 body (SDK plain Error, status kept in the message)", () => new Error("Facilitator settle failed (409): <html>conflict</html>")],
  ] as const) {
    it(`C1: ${name} → 502, never searched / delivered, reconcile line + ALERT (our message is on-chain and fresh)`, async () => {
      const accept = await solAccept();
      const { tx, msg } = payTx(0xc0);
      settle = () => {
        throw thrower();
      };
      const calls = setup({ list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }], tx: () => chainTx(wire(0xc0, msg, FEE), accept.amount) });
      const res = await handler()(paid(solPayload(accept, tx)));
      expect(res.status).toBe(502);
      expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
      expect(res.headers.get("payment-response")).toBeNull();
      expect(searchCalls(calls)).toEqual([]);
      expect(reconcileLines()).toEqual([expect.objectContaining({ status: 502, reason: "facilitator_duplicate", payer: SOL_PAYER, buyerSignature: buyerSigOf(0xc0) })]);
      expect(reconcileAlerts()).toEqual([expect.objectContaining({ kind: "solana_reconcile", status: 502, reason: "facilitator_duplicate", payer: SOL_PAYER })]);
    });
  }

  it("C1: a 200 success:false with a duplicate-shaped reason and no signature (already_settled) → 502 + reconcile, never a 402, never searched", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xc1);
    settle = () => ({ success: false, errorReason: "already_settled", transaction: "", network: SOLANA_MAINNET_CAIP2 });
    const calls = setup({ list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }], tx: () => chainTx(wire(0xc1, msg, FEE), accept.amount) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(502);
    expect(searchCalls(calls)).toEqual([]);
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 502, reason: "facilitator_duplicate" })]);
  });

  it("reconcile goes through the alert sink too: default sink writes one [solana-rail][ALERT] console.error line per occurrence", async () => {
    setSolanaAlertHook(null);
    const accept = await solAccept();
    for (const fill of [0xc2, 0xc3]) {
      const { tx } = payTx(fill);
      setup({
        list: () => {
          throw new Error("rpc down");
        },
      });
      expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(504);
    }
    const lines = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .filter((l) => l.startsWith("[solana-rail][ALERT] ") && l.includes('"kind":"solana_reconcile"'));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toMatchObject({ kind: "solana_reconcile", status: 504, reason: "ambiguous_settle_not_found", payer: SOL_PAYER, buyerSignature: buyerSigOf(0xc2) });
  });

  it("Odin LOW: a bound candidate whose meta is not served yet is retried within the deadline (not given up) → 200", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xcc);
    settle = () => ({ success: false, errorReason: "confirmation_timeout", transaction: txidOf(), network: SOLANA_MAINNET_CAIP2 });
    let n = 0;
    setup({ tx: () => (++n === 1 ? { ...chainTx(wire(0xcc, msg, FEE), accept.amount), meta: null } : chainTx(wire(0xcc, msg, FEE), accept.amount)) });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(200);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("(b) success: PayAI's signature bound to OUR message at slot > start slot → 200 (no wall clock used: old block time is fine)", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xc4);
    settle = settleOk;
    const calls = setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xc4, msg, FEE), accept.amount, { slot: START_SLOT + 1, blockTime: Math.floor(Date.now() / 1000) - 3600 }) : null) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).not.toBeNull();
    const gt = calls.filter((c) => c.method === "getTransaction");
    expect(gt[0]).toMatchObject({ account: txidOf(), opts: expect.objectContaining({ encoding: "base64" }) });
    expect(reconcileLines()).toEqual([]);
  });

  it("(b) success but OUR message landed at slot ≤ start slot (replay on another instance; block time 'now') → 409, paid body withheld, no reconcile", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xc5);
    settle = settleOk;
    setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xc5, msg, FEE), accept.amount, { slot: START_SLOT, blockTime: Math.floor(Date.now() / 1000) }) : null) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('{"error":"duplicate_payment"}');
    expect(res.headers.get("payment-response")).toBeNull();
    expect(reconcileLines()).toEqual([]);
  });

  it("(b) success but PayAI's signature is NOT our message (and ours is not in the recent history) → 502 + reconcile + ALERT, never delivered", async () => {
    const accept = await solAccept();
    const { tx } = payTx(0xc6);
    settle = settleOk;
    setup({ tx: () => chainTx(wire(0xc6, msgBytes(0xee), FEE), accept.amount) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
    expect(res.headers.get("payment-response")).toBeNull();
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 502, reason: "settle_success_unbound", payer: SOL_PAYER })]);
    expect(reconcileAlerts()).toHaveLength(1);
  });

  it("(b) success, PayAI's signature foreign, but OUR message is in the ATA history at slot > start → 200 (hint only)", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xc7);
    settle = settleOk;
    const mine = buyerSigOf(0x55);
    setup({
      list: () => [{ signature: mine, slot: START_SLOT + 4 }],
      tx: (sig) => (sig === mine ? chainTx(wire(0xc7, msg, 0x55), accept.amount, { slot: START_SLOT + 4 }) : chainTx(wire(0xc7, msgBytes(0xed), FEE), accept.amount)),
    });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(200);
  });

  it("(b) success but OUR tx failed on-chain → 502 + reconcile (never a 402), never delivered", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xc8);
    settle = settleOk;
    setup({ tx: () => chainTx(wire(0xc8, msg, FEE), accept.amount, { err: { InstructionError: [0, "Custom"] } }) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(502);
    expect(reconcileLines()).toEqual([expect.objectContaining({ status: 502, reason: "settle_success_failed_on_chain" })]);
  });

  it("(b) success, RPC down / not indexed within the deadline → paid response served (fail open: PayAI settled; no charge without delivery)", async () => {
    const accept = await solAccept();
    const { tx } = payTx(0xc9);
    settle = settleOk;
    setup({
      tx: () => {
        throw new Error("rpc down");
      },
    });
    const t0 = Date.now();
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("could not bind the settled tx on-chain"))).toBe(true);
    expect(reconcileLines()).toEqual([]);
  });

  it("(b) success, NO start slot → fallback to the wall-clock check: old block time → 409; fresh → 200 (documented tradeoff)", async () => {
    const accept = await solAccept();
    const noSlot = () => {
      throw new Error("getSlot down");
    };
    settle = settleOk;
    const a = payTx(0xca);
    setup({ slot: noSlot, tx: () => chainTx(wire(0xca, a.msg, FEE), accept.amount, { blockTime: Math.floor(Date.now() / 1000) - 3600 }) });
    expect((await handler()(paid(solPayload(accept, a.tx)))).status).toBe(409);
    const b = payTx(0xcb);
    setup({ slot: noSlot, tx: () => chainTx(wire(0xcb, b.msg, FEE), accept.amount, { blockTime: Math.floor(Date.now() / 1000) }) });
    expect((await handler()(paid(solPayload(accept, b.tx)))).status).toBe(200);
  });
});
