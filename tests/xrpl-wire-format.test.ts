/**
 * Spec wire format (x402 specs/schemes/exact/scheme_exact_xrpl.md): our
 * offline preflight accepts a spec-shaped RLUSD payment and rejects non-spec
 * variants (incl. t54-style Memos binding the spec forbids) BEFORE anything is
 * forwarded to the facilitator. Blobs are binary-encoded but UNSIGNED.
 */
import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER, RLUSD_TESTNET_ISSUER, XRPL_PAYTO } from "@/lib/xrpl-config";
import { checkXrplPaymentWireFormat, xrplPaymentKeyFromTx } from "@/lib/xrpl-rail";
import { XRPL_PAYER, fillerAddress, rlusd, specTx, xrplPayload, blobOf } from "./helpers/xrpl-env";

const requirement: PaymentRequirements = {
  scheme: "exact",
  network: "xrpl:1",
  amount: "0.005",
  asset: RLUSD_CURRENCY_HEX,
  payTo: XRPL_PAYTO,
  maxTimeoutSeconds: 300,
  extra: { issuer: RLUSD_TESTNET_ISSUER, areFeesSponsored: false },
};

const check = (tx: Record<string, unknown> = {}, accepted: Partial<PaymentRequirements> = {}, req = requirement) =>
  checkXrplPaymentWireFormat(xrplPayload(req, tx, accepted), req);

describe("XRPL exact wire format preflight", () => {
  it("accepts a spec-shaped RLUSD payment (sequence method)", async () => {
    const r = await check();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tx.Destination).toBe(XRPL_PAYTO);
      expect(r.tx.Amount).toEqual(rlusd("0.005"));
    }
  });

  it("exact decimal compare (0.0050 == 0.005); SendMax ≥ amount allowed (issuer transfer fee)", async () => {
    expect((await check({ Amount: rlusd("0.0050"), SendMax: rlusd("0.006") })).ok).toBe(true);
  });

  it("ticketSequence: Sequence 0 + TicketSequence required when the requirement pins it", async () => {
    const req = { ...requirement, extra: { ...requirement.extra, assetTransferMethod: "ticketSequence" } };
    expect((await check({ Sequence: 0, TicketSequence: 7 }, {}, req)).ok).toBe(true);
    expect((await check({ Sequence: 5 }, {}, req)).ok).toBe(false);
    expect((await check({ Sequence: 0 }, {}, req)).ok).toBe(false);
  });

  for (const [name, tx, accepted] of [
    ["Memos (t54-style binding)", { Memos: [{ Memo: { MemoData: "AA" } }] }, {}],
    ["Paths", { Paths: [[{ currency: "USD", issuer: fillerAddress(3) }]] }, {}],
    ["DeliverMin", { DeliverMin: rlusd("0.004") }, {}],
    ["tfPartialPayment", { Flags: 0x00020000 }, {}],
    ["wrong Destination", { Destination: fillerAddress(4) }, {}],
    ["Account == payTo (self-payment)", { Account: XRPL_PAYTO, Destination: XRPL_PAYTO }, {}],
    ["NetworkID on a standard network", { NetworkID: 1 }, {}],
    ["value too low", { Amount: rlusd("0.004"), SendMax: rlusd("0.004") }, {}],
    ["wrong issuer (mainnet issuer on testnet)", { Amount: rlusd("0.005", RLUSD_MAINNET_ISSUER), SendMax: rlusd("0.005", RLUSD_MAINNET_ISSUER) }, {}],
    ["XRP instead of RLUSD", { Amount: "5000", SendMax: undefined }, {}],
    ["missing SendMax", { SendMax: undefined }, {}],
    ["SendMax below amount", { SendMax: rlusd("0.001") }, {}],
    ["missing LastLedgerSequence", { LastLedgerSequence: undefined }, {}],
    ["TicketSequence with sequence method", { TicketSequence: 3 }, {}],
    ["not a Payment", { TransactionType: "TrustSet", LimitAmount: rlusd("1"), Amount: undefined, SendMax: undefined, Destination: undefined }, {}],
    ["accepted.areFeesSponsored true", {}, { extra: { issuer: RLUSD_TESTNET_ISSUER, areFeesSponsored: true } }],
    ["accepted.payTo swapped", {}, { payTo: fillerAddress(5) }],
    ["accepted.amount lowered", {}, { amount: "0.001" }],
    ["accepted.network mainnet", {}, { network: "xrpl:0" }],
  ] as const) {
    it(`rejects: ${name}`, async () => {
      expect((await check(tx as Record<string, unknown>, accepted as Partial<PaymentRequirements>)).ok).toBe(false);
    });
  }

  it("rejects non-hex / oversized / undecodable blobs", async () => {
    for (const blob of ["zz", "", "ABC", "00".repeat(5000), "DEADBEEF"]) {
      const r = await checkXrplPaymentWireFormat(xrplPayload(requirement, {}, {}, blob), requirement);
      expect(r.ok, blob.slice(0, 10)).toBe(false);
    }
  });

  it("replay key = payment slot (network, payer, Sequence/TicketSequence), independent of the other fields", () => {
    const a = specTx(requirement, { Sequence: 77 });
    const b = { ...a, Fee: "15", LastLedgerSequence: 999 };
    expect(xrplPaymentKeyFromTx("xrpl:1", a)).toBe(xrplPaymentKeyFromTx("xrpl:1", b));
    expect(xrplPaymentKeyFromTx("xrpl:1", a)).not.toBe(xrplPaymentKeyFromTx("xrpl:1", { ...a, Sequence: 78 }));
    expect(xrplPaymentKeyFromTx("xrpl:1", a)).not.toBe(xrplPaymentKeyFromTx("xrpl:0", a));
    expect(xrplPaymentKeyFromTx("xrpl:1", { ...a, Sequence: 0, TicketSequence: 77 })).not.toBe(xrplPaymentKeyFromTx("xrpl:1", a));
    expect(xrplPaymentKeyFromTx("xrpl:1", { ...a, Account: "nope" })).toBeNull();
    expect(blobOf(a)).toMatch(/^[0-9A-F]+$/);
    expect(a.Account).toBe(XRPL_PAYER);
  });
});
