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
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  __flushSolanaBackgroundForTests,
  __solanaReconcileForTests,
  ourPayment,
  validateSolanaPaymentPayload,
  SOLANA_SLOT_PROBE_INTERVAL_MS,
  SOLANA_SLOT_RATE_WINDOW_MS,
  SOLANA_SLOT_ALERT_COOLDOWN_MS,
  isSolanaSignature,
  validateSolanaPayloadLocal,
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
import { PAYAI_FEE_PAYER, PAYAI_FEE_PAYER_BYTES, SOL_PAYER, installBothFacilitators, installRpc, stubSolanaOn, type RpcCall } from "./helpers/solana-env";

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
  return Buffer.concat([Buffer.from([2, 0, 1, 4]), PAYAI_FEE_PAYER_BYTES, SOL_PAYER_BYTES, Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x34), Buffer.alloc(32, tag), Buffer.alloc(60, tag ^ 0x5a)]);
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
});

// ===========================================================================
// Odin 1:19 PM ET delta 3: no request-start slot → 503 + Retry-After BEFORE PayAI verify/settle (both settle paths).
// ===========================================================================
describe("delta 3 (Odin 1:19): no start slot → 503 before PayAI; slot present → normal flow", () => {
  let facilitator: string[] = [];
  beforeEach(() => {
    facilitator = [];
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : (facilitator.push("verify"), { isValid: true, payer: SOL_PAYER })),
      settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
        if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
        facilitator.push("settle");
        return settle();
      },
    } as never);
  });
  const settleModes = [
    ["settle would succeed", () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER })],
    ["settle would be ambiguous", () => {
      throw new FacilitatorTimeoutError("settle", 12_000);
    }],
  ] as const;
  for (const [mode, s] of settleModes) {
    it(`getSlot ERROR (${mode}) → 503 solana_rpc_unavailable + Retry-After 5, no PayAI verify/settle, handler not run, nothing claimed`, async () => {
      const accept = await solAccept();
      const { tx, msg } = payTx(0xd0);
      settle = s;
      const calls = setup({
        tx: () => chainTx(wire(0xd0, msg, FEE), accept.amount),
        slot: () => {
          throw new Error("rpc down");
        },
      });
      const res = await handler()(paid(solPayload(accept, tx)));
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('{"error":"solana_rpc_unavailable"}');
      expect(res.headers.get("retry-after")).toBe("5");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("payment-response")).toBeNull();
      expect(facilitator).toEqual([]);
      expect(ran).toBe(0);
      expect(calls.filter((c) => c.method === "getTransaction")).toEqual([]);
      expect(reconcileLines()).toEqual([]);
      // Nothing was claimed: the same payment goes through normally once getSlot answers.
      setup({ tx: () => chainTx(wire(0xd0, msg, FEE), accept.amount) });
      settle = settleModes[0][1];
      expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(200);
      expect(facilitator).toEqual(["verify", "settle"]);
    });
  }

  it("getSlot TIMEOUT (never answers, both tries) → 503 inside the init window (2.5 s), no PayAI call", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xd1);
    setup({ tx: () => chainTx(wire(0xd1, msg, FEE), accept.amount), slot: () => new Promise(() => {}) });
    const t0 = Date.now();
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(Date.now() - t0).toBeLessThan(3_500);
    expect(facilitator).toEqual([]);
  });

  it.each([["string", "300000000"], ["zero", 0], ["negative", -1], ["fraction", 1.5], ["unsafe", 2 ** 53], ["null", null]] as const)(
    "getSlot answers garbage (%s, not a positive safe integer) → 503, no PayAI call", async (_n, bad) => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xd2);
    setup({ tx: () => chainTx(wire(0xd2, msg, FEE), accept.amount), slot: () => bad });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(503);
    expect(facilitator).toEqual([]);
  });

  it("slot present → normal flow: verify + settle, 200 with PAYMENT-RESPONSE", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xd3);
    settle = settleModes[0][1];
    setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xd3, msg, FEE), accept.amount) : null) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).not.toBeNull();
    expect(facilitator).toEqual(["verify", "settle"]);
  });

  it("Odin 1:21: getSlot is retried ONCE: first try fails, second answers → normal flow (2 getSlot calls)", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xd4);
    settle = settleModes[0][1];
    let n = 0;
    const calls = setup({
      tx: (sig) => (sig === txidOf() ? chainTx(wire(0xd4, msg, FEE), accept.amount) : null),
      slot: () => {
        if (++n === 1) throw new Error("blip");
        return START_SLOT;
      },
    });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(200);
    expect(calls.filter((c) => c.method === "getSlot")).toHaveLength(2);
    expect(facilitator).toEqual(["verify", "settle"]);
  });

  it("Odin 1:21: getSlot error → exactly 2 tries, then the 503 (fixed body)", async () => {
    const accept = await solAccept();
    const { tx } = payTx(0xd5);
    const calls = setup({
      slot: () => {
        throw new Error("down");
      },
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"solana_rpc_unavailable"}');
    expect(calls.filter((c) => c.method === "getSlot")).toHaveLength(2);
  });

  it(`Odin 1:21: sustained getSlot failure → ONE high alert after 5 consecutive no-slot requests; 4 → none; a success resets the episode`, async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    const down = () => {
      throw new Error("down");
    };
    const slotAlerts = () => alerts.filter((a) => a.kind === "solana_start_slot_unavailable");
    for (let i = 0; i < 4; i++) {
      setup({ slot: down });
      expect((await handler()(paid(solPayload(accept, payTx(0xd6).tx)))).status).toBe(503);
    }
    expect(slotAlerts()).toEqual([]);
    setup({ slot: down });
    await handler()(paid(solPayload(accept, payTx(0xd6).tx)));
    expect(slotAlerts()).toEqual([{ kind: "solana_start_slot_unavailable", severity: "high", trigger: "consecutive", consecutive: 5, failed: 5, sample: 5, windowMs: 60_000, suppressedRetrips: 0 }]);
    setup({ slot: down });
    await handler()(paid(solPayload(accept, payTx(0xd6).tx)));
    expect(slotAlerts()).toHaveLength(1); // same episode
    settle = settleModes[0][1];
    const ok = payTx(0xd7);
    setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xd7, ok.msg, FEE), accept.amount) : null) });
    expect((await handler()(paid(solPayload(accept, ok.tx)))).status).toBe(200); // resets
    for (let i = 0; i < 4; i++) {
      setup({ slot: down });
      await handler()(paid(solPayload(accept, payTx(0xd6).tx)));
    }
    expect(slotAlerts()).toHaveLength(1); // streak restarted from 0: 4 after the reset → no new alert yet
    setup({ slot: down });
    const retrip = await handler()(paid(solPayload(accept, payTx(0xd6).tx)));
    // New episode: the breaker re-opens (Base-only 402 rail_unavailable), but Odin 2:12 F3: the re-trip ALERT is held
    // back by the 15 min cooldown (the alert after the cooldown is covered in the delta 5 tests).
    expect(retrip.status).toBe(402);
    expect(slotAlerts()).toHaveLength(1);
    setSolanaAlertHook(null);
  });
});

describe("delta 3 (Odin 1:21): PAYMENT-RESPONSE from the chain; reconcile alert deduped by buyer signature", () => {
  it("success, PayAI's signature is NOT ours but OUR tx is found on-chain → 200 with PAYMENT-RESPONSE tx id + payer from the CHAIN result", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xd8);
    const mine = buyerSigOf(0x56); // our chain tx id (slot-0 signature of the bound tx)
    settle = () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: "11111111111111111111111111111111" });
    setup({
      list: () => [{ signature: mine, slot: START_SLOT + 4 }],
      tx: (sig) => (sig === mine ? chainTx(wire(0xd8, msg, 0x56), accept.amount, { slot: START_SLOT + 4 }) : chainTx(wire(0xd8, msgBytes(0xec), FEE), accept.amount)),
    });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    const pr = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(pr).toMatchObject({ success: true, transaction: mine, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
    expect(await res.json()).toMatchObject({ ok: true, paid: "sol" });
  });

  it("success, PayAI's signature IS ours → PAYMENT-RESPONSE carries our tx id (rebuilt from the chain since Odin 1:39 LOW-1)", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xd9);
    settle = () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
    setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xd9, msg, FEE), accept.amount) : null) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toMatchObject({ transaction: txidOf() });
  });

  it("Odin 1:39 LOW-2: solana_reconcile ALERT deduped per payment MESSAGE: distinct messages with the same buyer signature → one alert each", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    const down = () => {
      throw new Error("rpc down");
    };
    for (const fill of [0xda, 0xda, 0xdb]) {
      setup({ list: down });
      expect((await handler()(paid(solPayload(accept, payTx(fill).tx)))).status).toBe(504); // distinct messages, so no replay 409
    }
    expect(reconcileLines().map((l) => l.buyerSignature)).toEqual([buyerSigOf(0xda), buyerSigOf(0xda), buyerSigOf(0xdb)]);
    // Before LOW-2 the two 0xda lines (same buyer signature, different messages) shared one alert.
    expect(alerts.filter((a) => a.kind === "solana_reconcile").map((a) => (a as { buyerSignature: string }).buyerSignature)).toEqual([buyerSigOf(0xda), buyerSigOf(0xda), buyerSigOf(0xdb)]);
    setSolanaAlertHook(null);
  });

  it("Odin 1:39 LOW-2 (unit): same message hash with different buyer signatures → 2 log lines, 1 alert; another message → its own alert", () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const m = payTx(0xdc);
    const oursA = ourPayment(wire(0xdc, m.msg))!;
    const oursB = ourPayment(wire(0xdd, m.msg))!; // same message, re-signed / tampered buyer slot
    const key1 = "a".repeat(64);
    const key2 = "a".repeat(63) + "b"; // same 16-hex fp as key1: the dedupe is on the FULL message hash
    __solanaReconcileForTests({ status: 504, reason: "ambiguous_settle_not_found", key: key1, ours: oursA, amount: "2000" });
    __solanaReconcileForTests({ status: 504, reason: "ambiguous_settle_not_found", key: key1, ours: oursB, amount: "2000" });
    __solanaReconcileForTests({ status: 504, reason: "ambiguous_settle_not_found", key: key2, ours: oursA, amount: "2000" });
    expect(reconcileLines()).toHaveLength(3);
    const rec = alerts.filter((a) => a.kind === "solana_reconcile") as Array<{ fp: string; buyerSignature: string }>;
    expect(rec.map((a) => [a.fp, a.buyerSignature])).toEqual([["a".repeat(16), buyerSigOf(0xdc)], ["a".repeat(16), buyerSigOf(0xdc)]]);
    setSolanaAlertHook(null);
  });
});

// ===========================================================================
// Odin 1:39 PM ET delta 4: getSlot breaker (N1), parse-before-verify (N2), PAYMENT-RESPONSE rebuild (LOW-1).
// ===========================================================================
describe("delta 4 (Odin 1:39) N1: getSlot breaker → Solana treated as absent until a good getSlot", () => {
  let facilitator: string[] = [];
  let clock = 0;
  const down = () => {
    throw new Error("down");
  };
  const okSettle = () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
  beforeEach(() => {
    facilitator = [];
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : (facilitator.push("verify"), { isValid: true, payer: SOL_PAYER })),
      settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
        if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
        facilitator.push("settle");
        return settle();
      },
    } as never);
    settle = okSettle;
    clock = 1_900_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  /** One paid request; slotOk=false → both getSlot tries fail. */
  async function paidOnce(accept: PaymentRequirements, slotOk: boolean) {
    const { tx, msg } = payTx(0xe0);
    const calls = setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xe0, msg, FEE), accept.amount) : null), slot: slotOk ? undefined : down });
    const res = await handler()(paid(solPayload(accept, tx)));
    return { res, calls };
  }
  async function unpaidNetworks() {
    const res = await handler()(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
    expect(res.status).toBe(402);
    return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts.map((a) => a.network);
  }
  const railError = (res: Response) => decodePaymentRequiredHeader(res.headers.get("payment-required")!).error;

  it("consecutive trigger: 5th no-slot request trips it → Base-only 402 rail_unavailable (no PayAI), Solana dropped from the unpaid 402; the next good paid getSlot recovers", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    for (let i = 0; i < 4; i++) expect((await paidOnce(accept, false)).res.status).toBe(503);
    const fifth = (await paidOnce(accept, false)).res;
    expect(fifth.status).toBe(402);
    expect(railError(fifth)).toBe("rail_unavailable");
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toHaveLength(1);
    const sixth = (await paidOnce(accept, false)).res;
    expect(sixth.status).toBe(402);
    expect(railError(sixth)).toBe("rail_unavailable");
    expect(facilitator).toEqual([]);
    expect(ran).toBe(0);
    setup({ slot: down });
    expect(await unpaidNetworks()).not.toContain(SOLANA_MAINNET_CAIP2);
    // Recovery: a paid request whose getSlot answers (read in parallel with init, as always) closes the breaker.
    const good = (await paidOnce(accept, true)).res;
    expect(good.status).toBe(200);
    expect(facilitator).toEqual(["verify", "settle"]);
    setup({});
    expect(await unpaidNetworks()).toContain(SOLANA_MAINNET_CAIP2);
    setSolanaAlertHook(null);
  });

  it("recovery via the unpaid-402 probe: at most one getSlot probe per 15 s while open; a good probe brings Solana back in that 402", async () => {
    const accept = await solAccept();
    for (let i = 0; i < 5; i++) await paidOnce(accept, false);
    // Healthy again, but the probe is not due yet → no getSlot on the unpaid path, Solana still absent.
    let calls = setup({});
    expect(await unpaidNetworks()).not.toContain(SOLANA_MAINNET_CAIP2);
    expect(calls.filter((c) => c.method === "getSlot")).toEqual([]);
    clock += SOLANA_SLOT_PROBE_INTERVAL_MS - 1;
    calls = setup({});
    expect(await unpaidNetworks()).not.toContain(SOLANA_MAINNET_CAIP2);
    expect(calls.filter((c) => c.method === "getSlot")).toEqual([]);
    // Due, but the RPC is still down: the probe fails, Solana stays absent, no new alert, not counted as a paid sample.
    clock += 1;
    calls = setup({ slot: down });
    expect(await unpaidNetworks()).not.toContain(SOLANA_MAINNET_CAIP2);
    expect(calls.filter((c) => c.method === "getSlot").length).toBeGreaterThan(0);
    // Next due probe answers → Solana back in that same 402.
    clock += SOLANA_SLOT_PROBE_INTERVAL_MS;
    calls = setup({});
    expect(await unpaidNetworks()).toContain(SOLANA_MAINNET_CAIP2);
    expect(calls.filter((c) => c.method === "getSlot").length).toBeGreaterThan(0);
    expect((await paidOnce(accept, true)).res.status).toBe(200);
  });

  /** fails at these request indexes (0-based), oks elsewhere, `n` paid requests total. */
  async function pattern(accept: PaymentRequirements, n: number, fails: number[]) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await paidOnce(accept, !fails.includes(i))).res.status);
    return out;
  }

  it("rate trigger: ≥25% of ≥20 paid requests in 60 s without a slot trips it (no 5 in a row needed); under 20 samples never", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    // 19 requests, 5 failures (26%, never 2 in a row): too few samples → no trip.
    const st = await pattern(accept, 19, [0, 4, 8, 12, 16]);
    expect(st.filter((x) => x === 503)).toHaveLength(5);
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    expect((await paidOnce(accept, true)).res.status).toBe(200); // 20 samples, 5/20, but only a failure can trip
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    const trip = (await paidOnce(accept, false)).res; // 6/21 = 28.6%
    expect(trip.status).toBe(402);
    expect(railError(trip)).toBe("rail_unavailable");
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([
      { kind: "solana_start_slot_unavailable", severity: "high", trigger: "rate", consecutive: 1, failed: 6, sample: 21, windowMs: 60_000, suppressedRetrips: 0 },
    ]);
    setup({ slot: down });
    expect(await unpaidNetworks()).not.toContain(SOLANA_MAINNET_CAIP2);
    setSolanaAlertHook(null);
  });

  it("rate trigger at exactly 25%: 5 failures in 20 samples, the 5th failure being the 20th sample → trips", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    const st = await pattern(accept, 20, [3, 7, 11, 15, 19]);
    expect(st[19]).toBe(402);
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toMatchObject([{ trigger: "rate", failed: 5, sample: 20 }]);
    setSolanaAlertHook(null);
  });

  it("aged-out failures are pruned on the failure path too: 4/20 at t0, then 61 s later 2 failures → no trip (window = 2 samples)", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    await pattern(accept, 20, [0, 5, 10, 15]);
    clock += SOLANA_SLOT_RATE_WINDOW_MS + 1_000;
    const st = await pattern(accept, 2, [0, 1]);
    expect(st).toEqual([503, 503]);
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    setSolanaAlertHook(null);
  });

  it("probes are not paid samples: after a probe recovery, 19 paid requests with 5 failures (fewer than 20 samples) do not trip", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    for (let i = 0; i < 5; i++) await paidOnce(accept, false);
    clock += SOLANA_SLOT_PROBE_INTERVAL_MS;
    setup({});
    expect(await unpaidNetworks()).toContain(SOLANA_MAINNET_CAIP2); // recovered by the probe
    const st = await pattern(accept, 19, [2, 6, 10, 14, 18]);
    expect(st[18]).toBe(503);
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toHaveLength(1); // only the first trip
    setSolanaAlertHook(null);
  });

  it("rate trigger stays quiet below 25% (5 of 21 = 23.8%) and when failures age out of the 60 s window", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    const st = await pattern(accept, 21, [0, 5, 10, 15, 20]);
    expect(st.filter((x) => x === 503)).toHaveLength(5);
    expect(st[20]).toBe(503);
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    // Window: 22 samples, 5 failed. 61 s later they are gone; 19 oks + 1 fail = 1/20 → no trip.
    clock += SOLANA_SLOT_RATE_WINDOW_MS + 1_000;
    const st2 = await pattern(accept, 20, [19]);
    expect(st2[19]).toBe(503);
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    setSolanaAlertHook(null);
  });

  it("window really is 60 s: the same 6/21 pattern spread so the early failures are older than 60 s → no trip", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    await pattern(accept, 9, [0, 4, 8]); // 3 failures at t0
    clock += SOLANA_SLOT_RATE_WINDOW_MS; // exactly 60 s later: those samples have aged out
    await pattern(accept, 12, [3, 7, 11]); // 3 failures in a 12-sample window
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    setSolanaAlertHook(null);
  });
});

describe("delta 4 (Odin 1:39) N2 + LOW-1: our payment parsed before verify; PAYMENT-RESPONSE rebuilt", () => {
  let facilitator: string[] = [];
  beforeEach(() => {
    facilitator = [];
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : (facilitator.push("verify"), { isValid: true, payer: SOL_PAYER })),
      settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
        if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
        facilitator.push("settle");
        return settle();
      },
    } as never);
  });

  const unsigned = () => wire(0, payTx(0xe1).msg); // parseable message, every signature slot empty
  const garbled = () => Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 0), Buffer.alloc(64, 0xaa), Buffer.alloc(20, 0xff)]).toString("base64");

  it("N2 (unit): validation refuses a payment we cannot parse (unsigned / garbled message)", async () => {
    const accept = await solAccept();
    // Odin 2:12 F1: an unsigned buyer slot now has its own reason (the message parses; the buyer slot is empty).
    expect(validateSolanaPaymentPayload(solPayload(accept, unsigned()), accept)).toEqual({ ok: false, reason: "payload.transaction buyer slot is not signed" });
    expect(validateSolanaPaymentPayload(solPayload(accept, garbled()), accept)).toEqual({ ok: false, reason: "payload.transaction is not a parseable signed transaction" });
    expect(validateSolanaPaymentPayload(solPayload(accept, payTx(0xe2).tx), accept)).toEqual({ ok: true });
  });

  for (const [name, mk] of [["unsigned", unsigned], ["garbled message", garbled]] as const) {
    it(`N2: ${name} payment → Base-only 402 invalid_payload BEFORE PayAI (no verify, no settle, no handler, no on-chain search)`, async () => {
      const accept = await solAccept();
      settle = () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
      const calls = setup({ tx: () => null });
      const res = await handler()(paid(solPayload(accept, mk())));
      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).error).toBe("invalid_payload");
      expect(facilitator).toEqual([]);
      expect(ran).toBe(0);
      expect(calls.filter((c) => c.method === "getTransaction")).toEqual([]); // (getSignaturesForAddress: background allowance count only)
    });
  }

  it("LOW-1: confirmed on-chain, PayAI's tx id is ours but its payer is not → PAYMENT-RESPONSE rebuilt exactly from chain + OUR message", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xe3);
    settle = () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: "11111111111111111111111111111111", extensions: { foo: 1 } });
    setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xe3, msg, FEE), accept.amount) : null) });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toEqual({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
  });

  it("LOW-1: fail-open (RPC down after a PayAI success) → 200, PAYMENT-RESPONSE rebuilt (payer from OUR message) and MARKED unverified (tx id from the facilitator)", async () => {
    const accept = await solAccept();
    const { tx } = payTx(0xe4);
    const payaiTx = buyerSigOf(0x44);
    settle = () => ({ success: true, transaction: payaiTx, network: SOLANA_MAINNET_CAIP2, payer: "11111111111111111111111111111111" });
    const down = () => {
      throw new Error("rpc down");
    };
    setup({ list: down, tx: down });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paid: "sol" });
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toEqual({
      success: true,
      transaction: payaiTx,
      network: SOLANA_MAINNET_CAIP2,
      payer: SOL_PAYER,
      // Odin 2:13 (2): marker under the spec's `extensions`, no `extra`.
      extensions: { settlementVerified: false, transactionSource: "facilitator" },
    });
  });
});

// ===========================================================================
// Odin 2:12 / 2:13 PM ET delta 5: F1 signer layout by index, F2 (= Sentinel LOW-A) local checks before getSlot +
// only validated requests count, F3 alert cooldown, `extensions` marker, validated facilitator tx id.
// ===========================================================================
describe("delta 5 (Odin 2:12/2:13): F1 fee-payer slot + buyer slot by index; F2 validate before getSlot; F3 alert cooldown; extensions + tx-id echo", () => {
  let facilitator: string[] = [];
  let clock = 0;
  const down = () => {
    throw new Error("down");
  };
  const okSettle = () => ({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
  const timeoutSettle = () => {
    throw new FacilitatorTimeoutError("settle", 12_000);
  };
  beforeEach(() => {
    facilitator = [];
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : (facilitator.push("verify"), { isValid: true, payer: SOL_PAYER })),
      settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
        if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
        facilitator.push("settle");
        return settle();
      },
    } as never);
    settle = okSettle;
    clock = 1_900_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  const railError = (res: Response) => decodePaymentRequiredHeader(res.headers.get("payment-required")!).error;
  const slotCalls = (calls: RpcCall[]) => calls.filter((c) => c.method === "getSlot");
  /** A wire tx with `n` signature slots and header numRequiredSignatures = `required`. */
  function wireN(fills: number[], required: number, tag: number): string {
    const keys = Array.from({ length: Math.max(4, fills.length + 2) }, (_, i) => (i === 0 ? PAYAI_FEE_PAYER_BYTES : Buffer.alloc(32, 0x31 + i)));
    const msg = Buffer.concat([Buffer.from([required, 0, 1, keys.length]), ...keys, Buffer.alloc(40, tag)]);
    return Buffer.concat([Buffer.from([fills.length]), ...fills.map((f) => Buffer.alloc(64, f)), msg]).toString("base64");
  }
  /** A paid request whose payload is locally valid; slotOk=false → both getSlot tries fail. */
  async function validOnce(accept: PaymentRequirements, slotOk: boolean) {
    const { tx, msg } = payTx(0xe8);
    const calls = setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xe8, msg, FEE), accept.amount) : null), slot: slotOk ? undefined : down });
    return { res: await handler()(paid(solPayload(accept, tx))), calls };
  }
  /**
   * Passes every LOCAL check (constants, layout, tx fee payer = accepted.extra.feePayer) but names a fee payer that is
   * not the facilitator's (Odin 2:32: the only requirement part checked after init): reaches getSlot, never PayAI.
   */
  const OTHER_FEE_PAYER = Buffer.alloc(32, 0x31);
  async function mismatchOnce(accept: PaymentRequirements, slotOk: boolean) {
    const calls = setup({ slot: slotOk ? undefined : down });
    const m = msgBytes(0xe9);
    OTHER_FEE_PAYER.copy(m, 4);
    const tx = wire(0xaa, m);
    return { res: await handler()(paid(solPayload({ ...accept, extra: { ...accept.extra, feePayer: base58Encode(OTHER_FEE_PAYER) } }, tx))), calls };
  }

  // ---- F1 ----
  for (const [mode, s] of [["settle would succeed", okSettle], ["settle would be ambiguous", timeoutSettle]] as const) {
    it(`F1 (${mode}): a NON-ZERO fee-payer placeholder slot → Base-only 402 invalid_payload before PayAI (no verify/settle, no handler, no getSlot); previously charged + 502/504`, async () => {
      const accept = await solAccept();
      settle = s;
      const { msg } = payTx(0xea);
      const tx = wire(0xaa, msg, 0x55); // fee-payer slot 0 non-zero (client-filled placeholder), buyer slot 1 signed
      const calls = setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xaa, msg, FEE), accept.amount) : null) });
      const res = await handler()(paid(solPayload(accept, tx)));
      expect(res.status).toBe(402);
      expect(railError(res)).toBe("invalid_payload");
      expect(facilitator).toEqual([]);
      expect(ran).toBe(0);
      expect(slotCalls(calls)).toEqual([]);
      expect(reconcileLines()).toEqual([]);
    });
    it(`F1 (${mode}): the buyer is slot 1 by INDEX (fee-payer slot 0 empty): bound + delivered with payer = key 1`, async () => {
      const accept = await solAccept();
      settle = s;
      const { tx, msg } = payTx(0xeb);
      setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xeb, msg, FEE), accept.amount) : null), list: () => [{ signature: txidOf(), slot: START_SLOT + 5 }] });
      const res = await handler()(paid(solPayload(accept, tx)));
      expect(res.status).toBe(200);
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toEqual({ success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
      expect(facilitator).toEqual(["verify", "settle"]);
    });
  }

  it("F1 (unit): signer layout — exactly 2 signers, slot 0 unsigned placeholder, slot 1 signed; buyer = slot 1 / key 1, never first-non-zero", () => {
    const { msg } = payTx(0xec);
    expect(ourPayment(wire(0xaa, msg))).toMatchObject({ slot: 1, signature: buyerSigOf(0xaa), payer: SOL_PAYER });
    expect(ourPayment(wire(0xaa, msg, 0x55))).toBeNull(); // fee-payer slot signed
    expect(ourPayment(wire(0, msg, 0x55))).toBeNull(); // old first-non-zero would have bound slot 0 as "the buyer"
    expect(ourPayment(wireN([0, 0, 0xaa], 3, 1))).toBeNull(); // 3 signers: old pick = slot 2
    expect(ourPayment(wireN([0, 0xaa], 1, 2))).toBeNull(); // header says 1 signer, 2 slots
    expect(ourPayment(wireN([0, 0xaa], 2, 3))).toMatchObject({ slot: 1 });
    const accepted = { scheme: "exact", network: SOLANA_MAINNET_CAIP2, payTo: SOLANA_PAYTO, asset: USDC_SOLANA_MINT, amount: "1000", maxTimeoutSeconds: 300, extra: { feePayer: PAYAI_FEE_PAYER } };
    const p = (tx: string) => ({ x402Version: 2, accepted, payload: { transaction: tx } }) as unknown as PaymentPayload;
    expect(validateSolanaPayloadLocal(p(wire(0xaa, msg, 0x55)), "1000")).toEqual({ ok: false, reason: "payload.transaction fee-payer slot must be the unsigned placeholder" });
    expect(validateSolanaPayloadLocal(p(wireN([0, 0, 0xaa], 3, 4)), "1000")).toEqual({ ok: false, reason: "payload.transaction must have exactly 2 signers (has 3, 3 slots)" });
    expect(validateSolanaPayloadLocal(p(wire(0, msg)), "1000")).toEqual({ ok: false, reason: "payload.transaction buyer slot is not signed" });
    expect(validateSolanaPayloadLocal(p(wire(0xaa, msg)), "1000")).toEqual({ ok: true });
  });

  // ---- F2 / Sentinel LOW-A ----
  it("F2: locally invalid payloads (garbled, unsigned, fee slot signed, 3 signers, not base64) → invalid_payload with NO getSlot and no PayAI", async () => {
    const accept = await solAccept();
    const { msg } = payTx(0xed);
    const junk = [
      Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 0), Buffer.alloc(64, 0xaa), Buffer.alloc(20, 0xff)]).toString("base64"),
      wire(0, msg),
      wire(0xaa, msg, 0x55),
      wireN([0, 0, 0xaa], 3, 5),
      "%%%not-base64%%%",
    ];
    for (const tx of junk) {
      const calls = setup({ slot: down });
      const res = await handler()(paid(solPayload(accept, tx)));
      expect(res.status).toBe(402);
      expect(railError(res)).toBe("invalid_payload");
      expect(slotCalls(calls)).toEqual([]);
    }
    expect(facilitator).toEqual([]);
  });

  it("F2 (streak): requests that fail validation never count — 20 requirement-mismatched requests with getSlot down do not trip; 5 VALID no-slot requests do", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    for (let i = 0; i < 20; i++) {
      const { res } = await mismatchOnce(accept, false);
      expect(res.status).toBe(402);
      expect(railError(res)).toBe("invalid_payload"); // not 503: validation answers first
    }
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    for (let i = 0; i < 4; i++) expect((await validOnce(accept, false)).res.status).toBe(503);
    const fifth = (await validOnce(accept, false)).res;
    expect(fifth.status).toBe(402);
    expect(railError(fifth)).toBe("rail_unavailable");
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toMatchObject([{ trigger: "consecutive", consecutive: 5, failed: 5, sample: 5 }]);
    expect(facilitator).toEqual([]);
    setSolanaAlertHook(null);
  });

  it("F2 (streak): an invalid request whose getSlot SUCCEEDS does not reset the streak of valid failures", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    for (let i = 0; i < 4; i++) expect((await validOnce(accept, false)).res.status).toBe(503);
    expect((await mismatchOnce(accept, true)).res.status).toBe(402); // junk, RPC answers: not counted either way
    const fifth = (await validOnce(accept, false)).res;
    expect(fifth.status).toBe(402);
    expect(railError(fifth)).toBe("rail_unavailable");
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toMatchObject([{ trigger: "consecutive", consecutive: 5 }]);
    setSolanaAlertHook(null);
  });

  it("F2 (rate window): invalid requests are not samples — 16 valid ok + 4 valid no-slot (20%) + 30 junk no-slot → no trip", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const accept = await solAccept();
    for (let i = 0; i < 20; i++) {
      const fail = i % 5 === 4;
      expect((await validOnce(accept, !fail)).res.status).toBe(fail ? 503 : 200);
      if (fail) for (let j = 0; j < 6; j++) expect((await mismatchOnce(accept, false)).res.status).toBe(402);
    }
    expect(alerts.filter((a) => a.kind === "solana_start_slot_unavailable")).toEqual([]);
    expect((await validOnce(accept, true)).res.status).toBe(200);
    setSolanaAlertHook(null);
  });

  it("F2: an invalid request's good getSlot still CLOSES an open breaker (recovery = any good getSlot; it is not a trigger)", async () => {
    const accept = await solAccept();
    for (let i = 0; i < 5; i++) await validOnce(accept, false);
    expect((await validOnce(accept, false)).res.status).toBe(402);
    expect((await mismatchOnce(accept, true)).res.status).toBe(402);
    expect((await validOnce(accept, false)).res.status).toBe(503); // breaker closed: back to the plain no-slot 503
  });

  // ---- F3 ----
  it("F3: re-trip within 15 min → breaker re-opens (402 rail_unavailable) but NO second alert; after the cooldown the next trip alerts with suppressedRetrips", async () => {
    const alerts: SolanaAlert[] = [];
    setSolanaAlertHook((a) => alerts.push(a));
    const slotAlerts = () => alerts.filter((a) => a.kind === "solana_start_slot_unavailable");
    const accept = await solAccept();
    const trip = async () => {
      for (let i = 0; i < 4; i++) expect((await validOnce(accept, false)).res.status).toBe(503);
      const r = (await validOnce(accept, false)).res;
      expect(r.status).toBe(402);
      expect(railError(r)).toBe("rail_unavailable");
    };
    await trip();
    expect(slotAlerts()).toHaveLength(1);
    expect((await validOnce(accept, true)).res.status).toBe(200); // recovery
    clock += SOLANA_SLOT_ALERT_COOLDOWN_MS - 1_000;
    await trip(); // breaker opens again; alert suppressed
    expect(slotAlerts()).toHaveLength(1);
    expect((await validOnce(accept, true)).res.status).toBe(200);
    clock += 1_000; // exactly 15 min after the first alert
    await trip();
    expect(slotAlerts()).toHaveLength(2);
    expect(slotAlerts()[1]).toMatchObject({ trigger: "consecutive", consecutive: 5, suppressedRetrips: 1 });
    expect(SOLANA_SLOT_ALERT_COOLDOWN_MS).toBe(15 * 60_000);
    setSolanaAlertHook(null);
  });

  // ---- extensions marker + facilitator tx-id echo ----
  const failOpen = async (payaiTx: unknown) => {
    const accept = await solAccept();
    const { tx } = payTx(0xee);
    settle = () => ({ success: true, transaction: payaiTx, network: SOLANA_MAINNET_CAIP2, payer: "11111111111111111111111111111111" });
    setup({ list: down, tx: down });
    const res = await handler()(paid(solPayload(accept, tx)));
    expect(res.status).toBe(200);
    return decodePaymentResponseHeader(res.headers.get("payment-response")!) as unknown as Record<string, unknown>;
  };
  it("extensions + tx id: fail-open marker under `extensions` (no `extra`); a valid Solana signature from PayAI is echoed", async () => {
    const h = await failOpen(buyerSigOf(0x44));
    expect(h).toEqual({ success: true, transaction: buyerSigOf(0x44), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER, extensions: { settlementVerified: false, transactionSource: "facilitator" } });
    expect("extra" in h).toBe(false);
  });
  for (const [name, bad] of [
    ["not base58", "0x" + "ab".repeat(32)],
    ["base58 that decodes to 65 bytes", "z".repeat(88)],
    ["base58 that decodes to 47 bytes", "2".repeat(64)],
    ["too short", buyerSigOf(0x44).slice(0, 40)],
    ["markup", "<script>alert(1)</script>"],
  ] as const) {
    it(`tx id: PayAI's transaction ${name} → omitted from the fail-open PAYMENT-RESPONSE (marker kept)`, async () => {
      const h = await failOpen(bad);
      expect("transaction" in h).toBe(false);
      expect(h).toEqual({ success: true, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER, extensions: { settlementVerified: false, transactionSource: "facilitator" } });
    });
  }
  it("isSolanaSignature (unit): base58 that decodes to exactly 64 bytes", () => {
    expect(isSolanaSignature(buyerSigOf(0x44))).toBe(true);
    expect(isSolanaSignature(base58Encode(new Uint8Array(64)))).toBe(true); // 64 zero bytes = "1"×64
    expect(isSolanaSignature(base58Encode(new Uint8Array(65).fill(1)))).toBe(false);
    expect(isSolanaSignature(base58Encode(new Uint8Array(63).fill(0xff)))).toBe(false);
    expect(isSolanaSignature("z".repeat(88))).toBe(false); // passes the regex, decodes to 65 bytes
    expect(isSolanaSignature("2".repeat(64))).toBe(false); // passes the regex, decodes to 47 bytes
    expect(isSolanaSignature(undefined)).toBe(false);
    expect(isSolanaSignature(42)).toBe(false);
  });
});

// ===========================================================================
// Odin 2:32 PM ET delta 6 (3) + (4): constant requirement checks before getSlot; tx fee payer checked locally.
// ===========================================================================
describe("delta 6 (Odin 2:32): constant payTo/amount/asset/network/timeout checks and the in-tx fee payer, before getSlot and PayAI", () => {
  let facilitator: string[] = [];
  beforeEach(() => {
    facilitator = [];
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true, payer: BASE_PAYER } : (facilitator.push("verify"), { isValid: true, payer: SOL_PAYER })),
      settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
        if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
        facilitator.push("settle");
        return { success: true, transaction: txidOf(), network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER };
      },
    } as never);
  });
  const railError = (res: Response) => decodePaymentRequiredHeader(res.headers.get("payment-required")!).error;
  const rpcMethods = (calls: RpcCall[]) => calls.map((c) => c.method);

  for (const [name, over] of [
    ["payTo swapped", { payTo: base58Encode(new Uint8Array(32).fill(8)) }],
    ["amount lowered", { amount: "1" }],
    ["asset swapped", { asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }],
    ["network devnet", { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }],
    ["maxTimeoutSeconds changed", { maxTimeoutSeconds: 60 }],
  ] as const) {
    it(`(3) accepted.${name} → invalid_payload with NO getSlot (no RPC at all) and no PayAI`, async () => {
      const accept = await solAccept();
      const calls = setup({});
      const res = await handler()(paid(solPayload({ ...accept, ...over } as PaymentRequirements, payTx(0xf0).tx)));
      expect(res.status).toBe(402);
      expect(railError(res)).toBe("invalid_payload");
      expect(rpcMethods(calls)).not.toContain("getSlot");
      expect(facilitator).toEqual([]);
      expect(ran).toBe(0);
    });
  }

  it("(4) tx fee payer (key 0) differs from accepted.extra.feePayer (= PayAI's) → invalid_payload before getSlot and PayAI", async () => {
    const accept = await solAccept();
    expect((accept.extra as { feePayer: string }).feePayer).toBe(PAYAI_FEE_PAYER);
    const m = msgBytes(0xf1);
    Buffer.alloc(32, 0x31).copy(m, 4); // a different fee payer inside the tx
    const calls = setup({});
    const res = await handler()(paid(solPayload(accept, wire(0xaa, m))));
    expect(res.status).toBe(402);
    expect(railError(res)).toBe("invalid_payload");
    expect(rpcMethods(calls)).not.toContain("getSlot");
    expect(facilitator).toEqual([]);
  });

  it("(4) tx fee payer = accepted.extra.feePayer but NOT PayAI's key → invalid_payload after init, still before PayAI", async () => {
    const accept = await solAccept();
    const other = Buffer.alloc(32, 0x31);
    const m = msgBytes(0xf2);
    other.copy(m, 4);
    setup({});
    const res = await handler()(paid(solPayload({ ...accept, extra: { ...accept.extra, feePayer: base58Encode(other) } }, wire(0xaa, m))));
    expect(res.status).toBe(402);
    expect(railError(res)).toBe("invalid_payload");
    expect(facilitator).toEqual([]);
  });

  it("(4) accepted.extra.feePayer missing / not a pubkey → invalid_payload before getSlot", async () => {
    const accept = await solAccept();
    for (const extra of [{}, { feePayer: "not-a-key" }]) {
      const calls = setup({});
      const res = await handler()(paid(solPayload({ ...accept, extra } as PaymentRequirements, payTx(0xf3).tx)));
      expect(railError(res)).toBe("invalid_payload");
      expect(rpcMethods(calls)).not.toContain("getSlot");
    }
    expect(facilitator).toEqual([]);
  });

  it("(4) unit: validateSolanaPayloadLocal checks key 0 against accepted.extra.feePayer; the matching tx passes", async () => {
    const accept = await solAccept();
    const ok = payTx(0xf4).tx;
    expect(validateSolanaPayloadLocal(solPayload(accept, ok), accept.amount)).toEqual({ ok: true });
    const m = msgBytes(0xf5);
    Buffer.alloc(32, 0x31).copy(m, 4);
    expect(validateSolanaPayloadLocal(solPayload(accept, wire(0xaa, m)), accept.amount)).toEqual({ ok: false, reason: "payload.transaction fee payer (key 0) does not match accepted.extra.feePayer" });
    expect(validateSolanaPayloadLocal(solPayload({ ...accept, payTo: base58Encode(new Uint8Array(32).fill(8)) }, ok), accept.amount)).toEqual({ ok: false, reason: "accepted.payTo does not match requirements" });
    expect(validateSolanaPayloadLocal(solPayload(accept, ok), "1")).toEqual({ ok: false, reason: "accepted.amount does not match requirements" });
    for (const extra of [{}, { feePayer: "not-a-key" }, { feePayer: 42 }])
      expect(validateSolanaPayloadLocal(solPayload({ ...accept, extra } as PaymentRequirements, ok), accept.amount)).toEqual({ ok: false, reason: "accepted.extra.feePayer is not a Solana public key" });
  });

  it("a fully valid payment still goes through (verify + settle + handler), fee payer = PayAI's key 0", async () => {
    const accept = await solAccept();
    const { tx, msg } = payTx(0xf6);
    setup({ tx: (sig) => (sig === txidOf() ? chainTx(wire(0xf6, msg, FEE), accept.amount) : null) });
    expect((await handler()(paid(solPayload(accept, tx)))).status).toBe(200);
    expect(facilitator).toEqual(["verify", "settle"]);
  });
});
