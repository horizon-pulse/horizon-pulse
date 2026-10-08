/**
 * Spec wire format (x402 specs/schemes/exact/scheme_exact_xrpl.md): build an
 * XRPL exact PaymentPayload the way the spec/package types define it, and
 * check our preflight accepts it and rejects non-spec variants (including the
 * t54-style Memos binding the spec forbids).
 *
 * The tx blobs are binary-encoded but UNSIGNED: no key pair is created or
 * used anywhere. Signature checks are the facilitator's job (spec §10).
 */
import { describe, expect, it } from "vitest";
import { encode } from "xrpl";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ExactXrplPayload } from "@x402/xrpl";
import { RLUSD_TESTNET_ISSUER } from "@x402/xrpl";
import { RLUSD_CURRENCY_HEX } from "@/lib/xrpl-config";
import { checkXrplPaymentWireFormat } from "@/lib/xrpl-rail";
import { validTestAddress } from "./helpers/xrpl-addresses";

const PAYTO = validTestAddress(7);
const PAYER = validTestAddress(9);
const OTHER = validTestAddress(11);

const requirement: PaymentRequirements = {
  scheme: "exact",
  network: "xrpl:1",
  amount: "0.005",
  asset: RLUSD_CURRENCY_HEX,
  payTo: PAYTO,
  maxTimeoutSeconds: 300,
  extra: { issuer: RLUSD_TESTNET_ISSUER, areFeesSponsored: false },
};

const rlusd = (value: string, issuer = RLUSD_TESTNET_ISSUER, currency: string = RLUSD_CURRENCY_HEX) => ({ currency, issuer, value });

function baseTx(): Record<string, unknown> {
  return {
    TransactionType: "Payment",
    Account: PAYER,
    Destination: PAYTO,
    Amount: rlusd("0.005"),
    SendMax: rlusd("0.005"),
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_000_000,
    Flags: 0,
    SigningPubKey: "",
  };
}

function payloadFor(tx: Record<string, unknown>, acceptedOverride: Partial<PaymentRequirements> = {}): PaymentPayload {
  const inner: ExactXrplPayload = { signedTxBlob: encode(tx as never) };
  return {
    x402Version: 2,
    accepted: { ...requirement, ...acceptedOverride },
    payload: inner,
  } as PaymentPayload;
}

async function check(tx: Record<string, unknown>, accepted: Partial<PaymentRequirements> = {}, req = requirement) {
  return checkXrplPaymentWireFormat(payloadFor(tx, accepted), req);
}

describe("XRPL exact wire format", () => {
  it("accepts a spec-shaped RLUSD payment (sequence method)", async () => {
    const r = await check(baseTx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tx.TransactionType).toBe("Payment");
      expect(r.tx.Amount).toEqual(rlusd("0.005"));
      expect(r.tx.NetworkID).toBeUndefined();
    }
  });

  it("compares IOU values as exact decimals (0.0050 == 0.005), allows SendMax >= amount", async () => {
    expect((await check({ ...baseTx(), Amount: rlusd("0.0050"), SendMax: rlusd("0.006") })).ok).toBe(true);
  });

  it("accepts DeliverMax (API v2) instead of Amount", async () => {
    const tx = baseTx();
    // The binary codec stores DeliverMax as Amount; a decoded API-v2 tx_json can carry DeliverMax.
    // Exercise the validator directly with a decoded-shape object.
    const { validateXrplPaymentPayload } = await import("@/lib/xrpl-rail");
    const mods = {
      decodeSignedTransactionBlob: () => ({ ...tx, Amount: undefined, DeliverMax: rlusd("0.005") }),
      compareDecimalStrings: (await import("@x402/xrpl")).compareDecimalStrings,
    };
    expect(validateXrplPaymentPayload(payloadFor(tx), requirement, mods).ok).toBe(true);
    const both = { ...mods, decodeSignedTransactionBlob: () => ({ ...tx, DeliverMax: rlusd("0.005") }) };
    expect(validateXrplPaymentPayload(payloadFor(tx), requirement, both)).toMatchObject({ ok: false, reason: "both Amount and DeliverMax present" });
  });

  const rejects: [string, Record<string, unknown>, RegExp][] = [
    ["t54-style Memos binding", { Memos: [{ Memo: { MemoData: "AB", MemoType: "6E6F6E6365" } }] }, /Memos/],
    ["Paths", { Paths: [[{ currency: "XRP" }]] }, /Paths/],
    ["DeliverMin", { DeliverMin: rlusd("0.005") }, /DeliverMin/],
    ["tfPartialPayment", { Flags: 0x00020000 }, /tfPartialPayment/],
    ["missing SendMax", { SendMax: undefined }, /SendMax must be present/],
    ["SendMax other currency", { SendMax: rlusd("0.005", RLUSD_TESTNET_ISSUER, "USD") }, /same issued currency/],
    ["SendMax below amount", { SendMax: rlusd("0.004") }, /SendMax below/],
    ["wrong value", { Amount: rlusd("0.0051"), SendMax: rlusd("0.0051") }, /value does not match/],
    ["wrong issuer", { Amount: rlusd("0.005", OTHER), SendMax: rlusd("0.005", OTHER) }, /issuer does not match/],
    ["wrong currency", { Amount: rlusd("0.005", RLUSD_TESTNET_ISSUER, "USD"), SendMax: rlusd("0.005", RLUSD_TESTNET_ISSUER, "USD") }, /currency does not match/],
    ["native XRP amount", { Amount: "5000", SendMax: undefined }, /issued-currency object/],
    ["wrong destination", { Destination: OTHER }, /Destination/],
    ["NetworkID on a standard network", { NetworkID: 1 }, /NetworkID/],
    ["missing LastLedgerSequence", { LastLedgerSequence: undefined }, /LastLedgerSequence/],
    ["TicketSequence with sequence method", { TicketSequence: 7 }, /TicketSequence present/],
    ["not a Payment", { TransactionType: "AccountSet", Destination: undefined, Amount: undefined, SendMax: undefined }, /Payment/],
  ];
  it.each(rejects)("rejects %s", async (_name, patch, reason) => {
    const tx = { ...baseTx(), ...patch };
    for (const k of Object.keys(tx)) if (tx[k] === undefined) delete tx[k];
    const r = await check(tx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("rejects envelope deviations", async () => {
    expect(await check(baseTx(), { extra: { issuer: RLUSD_TESTNET_ISSUER } })).toMatchObject({ ok: false, reason: /areFeesSponsored/ });
    expect(await check(baseTx(), { amount: "0.004" })).toMatchObject({ ok: false, reason: /accepted.amount/ });
    expect(await check(baseTx(), { network: "xrpl:0" })).toMatchObject({ ok: false, reason: /accepted.network/ });
    const p = payloadFor(baseTx());
    expect(await checkXrplPaymentWireFormat({ ...p, x402Version: 1 } as PaymentPayload, requirement)).toMatchObject({ ok: false });
    expect(await checkXrplPaymentWireFormat({ ...p, payload: { signedTxBlob: "zz" } } as PaymentPayload, requirement)).toMatchObject({ ok: false, reason: /hex/ });
    expect(await checkXrplPaymentWireFormat({ ...p, payload: { signedTxBlob: "00" } } as PaymentPayload, requirement)).toMatchObject({ ok: false });
  });

  it("t54-style extra.sourceTag in accepted is tolerated (spec neither defines nor forbids it); we never emit it", async () => {
    expect((await check({ ...baseTx(), SourceTag: 1234 }, { extra: { ...requirement.extra, sourceTag: 1234 } })).ok).toBe(true);
    expect(requirement.extra).not.toHaveProperty("sourceTag");
  });

  it("ticketSequence method: Sequence 0 + TicketSequence required; cannot override a pinned method", async () => {
    const pinned = { ...requirement, extra: { ...requirement.extra, assetTransferMethod: "ticketSequence" } };
    const ticketAccepted = { extra: pinned.extra };
    expect((await check({ ...baseTx(), Sequence: 0, TicketSequence: 9 }, ticketAccepted, pinned)).ok).toBe(true);
    expect(await check({ ...baseTx(), Sequence: 42, TicketSequence: 9 }, ticketAccepted, pinned)).toMatchObject({ ok: false, reason: /Sequence must be 0/ });
    expect(await check({ ...baseTx(), Sequence: 0 }, ticketAccepted, pinned)).toMatchObject({ ok: false, reason: /TicketSequence missing/ });
    expect(
      await check(baseTx(), { extra: { ...requirement.extra, assetTransferMethod: "sequence" } }, pinned),
    ).toMatchObject({ ok: false, reason: /differs/ });
  });
});
