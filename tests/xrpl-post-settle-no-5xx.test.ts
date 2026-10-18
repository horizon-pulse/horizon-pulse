/**
 * XRPL post-settle: never a 5xx after funds moved (Odin 11:22 AM ET 10/18, pre-existing bug at
 * lib/xrpl-rail.ts self-check, 54149ea:1731-1735). Mainnet settles in-process (submitAndWait →
 * validated tesSUCCESS) BEFORE our independent `tx` re-read; a lagging/unreachable public node
 * then made a charged buyer get 502 settlement_unconfirmed with no response. Now:
 *   - re-read confirms the exact payment → deliver (as before);
 *   - re-read unreadable / mismatched, settle said validated tesSUCCESS → deliver + ALERT + XRPL_RECONCILE (status 200);
 *   - re-read proves the tx FAILED on the validated ledger (not tesSUCCESS) → nothing moved: Base-only 402;
 *   - ambiguous settle (throw/timeout) + ledger shows the exact payment closed in this request → deliver;
 *     ledger proves failure → Base-only 402; otherwise unchanged 502/504 (genuinely unknown).
 * Offline: the self-facilitation scheme and the read-only RPC are stubbed; nothing is signed or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  __setXrplFacilitatorSchemeLoaderForTests,
  __setXrplTxLookupDelaysForTests,
  resetXrplRailForTests,
  setXrplAlertHook,
  setXrplReplayStoreForTests,
  type XrplAlert,
} from "@/lib/xrpl-rail";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";
import { RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER, XRPL_PAYTO, XRPL_SELF_FACILITATOR } from "@/lib/xrpl-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { installXrplFacilitators, installXrplRpc, XRPL_PAYER, XRPL_TX_HASH, xrplPayload } from "./helpers/xrpl-env";

const MAIN_ENV = {
  HP_XRPL_ENABLED: "true",
  HP_XRPL_NETWORK: "xrpl:0",
  HP_XRPL_PAYTO: XRPL_PAYTO,
  HP_XRPL_FACILITATOR_URL: XRPL_SELF_FACILITATOR,
  XRPL_MAINNET_ALLOWED: "true",
  UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "t",
};
const rippleNow = (offsetS = 0) => Math.floor((Date.now() - 946_684_800_000) / 1000) + offsetS;

type SchemeSettle = () => Promise<unknown>;
let settleImpl: SchemeSettle;
const okSettle: SchemeSettle = async () => ({ success: true, transaction: XRPL_TX_HASH, network: "xrpl:0", payer: XRPL_PAYER });

let store: MemoryReplayStore;
function freshInstance() {
  resetXrplRailForTests();
  resetSolanaRailForTests();
  store = new MemoryReplayStore();
  setXrplReplayStoreForTests({ kind: "upstash", claim: (k, t) => store.claim(k, t), set: (k, s, t) => store.set(k, s, t), release: (k) => store.release(k) });
}

let alerts: XrplAlert[];
let ran: number;
const handler = () =>
  createX402GetHandler(
    async () => {
      ran++;
      return NextResponse.json({ ok: true, paid: "body" });
    },
    pulseRouteConfig(),
    pulseOpts,
  );
const unpaid = () => new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } });
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });

async function xrplAccept(): Promise<PaymentRequirements> {
  const res = await handler()(unpaid());
  const a = decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts.find((x) => x.network === "xrpl:0");
  expect(a).toBeDefined();
  return a!;
}

/** A validated `tx` answer for the settled hash. */
const ledgerTx = (accept: PaymentRequirements, over: { result?: string; value?: string; date?: number; meta?: boolean } = {}) => ({
  validated: true,
  status: "success",
  hash: XRPL_TX_HASH,
  date: over.date ?? rippleNow(),
  tx_json: { TransactionType: "Payment", Account: XRPL_PAYER, Destination: XRPL_PAYTO },
  ...(over.meta === false
    ? {}
    : { meta: { TransactionResult: over.result ?? "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_MAINNET_ISSUER, value: over.value ?? accept.amount } } }),
});

const reconcile = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map((c) => String(c[0]))
    .filter((l) => l.includes("XRPL_RECONCILE "))
    .map((l) => JSON.parse(l.slice(l.indexOf("{"))));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  freshInstance();
  for (const [k, v] of Object.entries(MAIN_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("CDP_API_KEY_ID", "");
  vi.stubEnv("CDP_API_KEY_SECRET", "");
  installXrplFacilitators();
  settleImpl = okSettle;
  __setXrplFacilitatorSchemeLoaderForTests(async () => ({
    getExtra: () => ({ areFeesSponsored: false }),
    verify: async () => ({ isValid: true, payer: XRPL_PAYER }),
    settle: () => settleImpl(),
  }) as never);
  __setXrplTxLookupDelaysForTests([0, 1, 1, 1]);
  alerts = [];
  setXrplAlertHook((a) => alerts.push(a));
  ran = 0;
});
afterEach(() => {
  __setXrplFacilitatorSchemeLoaderForTests(null);
  __setXrplTxLookupDelaysForTests(null);
  setXrplReplayStoreForTests(null);
  setXrplAlertHook(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function expectDelivered(res: Response) {
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, paid: "body" });
  const prh = res.headers.get("payment-response");
  expect(prh).toBeTruthy();
  expect(JSON.parse(Buffer.from(prh!, "base64").toString())).toMatchObject({ success: true, transaction: XRPL_TX_HASH, network: "xrpl:0" });
  expect(res.headers.get("cache-control") ?? "").toContain("private");
}

describe("settle reported validated tesSUCCESS (funds moved): the ledger re-read can no longer turn it into a 5xx", () => {
  it("control: re-read confirms the exact payment → 200, no ALERT, no reconcile line", async () => {
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ledgerTx(accept));
    await expectDelivered(await handler()(paid(xrplPayload(accept))));
    expect(ran).toBe(1);
    expect(alerts.filter((a) => a.kind === "xrpl_settled_unverified")).toEqual([]);
    expect(reconcile()).toEqual([]);
  });

  it("control: lagging node (txnNotFound, then not validated, then validated) within the bounded retry → 200, no ALERT", async () => {
    const accept = await xrplAccept();
    const answers: unknown[] = [{ status: "error", error: "txnNotFound" }, { status: "success", validated: false }, ledgerTx(accept)];
    installXrplRpc("ready", () => answers.shift());
    await expectDelivered(await handler()(paid(xrplPayload(accept))));
    expect(alerts.filter((a) => a.kind === "xrpl_settled_unverified")).toEqual([]);
  });

  for (const [name, tx, reason] of [
    ["RPC unreachable on every try", () => { throw new Error("fetch failed"); }, "self_check_missing"],
    ["txnNotFound on every try (node behind)", () => ({ status: "error", error: "txnNotFound" }), "self_check_missing"],
    ["validated:false on every try", () => ({ status: "success", validated: false }), "self_check_missing"],
    ["validated but no meta", (a: PaymentRequirements) => ledgerTx(a, { meta: false }), "self_check_missing"],
    ["validated tesSUCCESS, delivered amount differs", (a: PaymentRequirements) => ledgerTx(a, { value: "0.001" }), "self_check_delivered_amount_mismatch"],
  ] as const) {
    it(`${name} → 200 paid response + ALERT xrpl_settled_unverified + XRPL_RECONCILE status 200 (was 502)`, async () => {
      const accept = await xrplAccept();
      installXrplRpc("ready", () => (tx as (a: PaymentRequirements) => unknown)(accept));
      const p = xrplPayload(accept);
      await expectDelivered(await handler()(paid(p)));
      expect(ran).toBe(1);
      expect(alerts).toContainEqual({ kind: "xrpl_settled_unverified", reason });
      const rec = reconcile();
      expect(rec).toHaveLength(1);
      expect(rec[0]).toMatchObject({ tag: "XRPL_RECONCILE", status: 200, reason, network: "xrpl:0", route: "/api/pulse", payer: XRPL_PAYER, txHash: XRPL_TX_HASH });
      // The slot is consumed: the same payment again is a duplicate, never a second delivery or a 402.
      const again = await handler()(paid(p));
      expect(again.status).toBe(409);
      expect(ran).toBe(1);
    });
  }

  it("validated ledger says the tx FAILED (tecPATH_PARTIAL): nothing moved → Base-only 402 settle failure, no 5xx, no body", async () => {
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ledgerTx(accept, { result: "tecPATH_PARTIAL" }));
    const res = await handler()(paid(xrplPayload(accept)));
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain('"paid"');
    expect(res.headers.get("payment-required")).toBeTruthy();
    expect(res.headers.get("payment-response")).toBeNull();
  });
});

describe("ambiguous settle (throw / timeout): confirm on the ledger before answering", () => {
  beforeEach(() => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
  });

  it("ledger shows the exact payment, closed during this request → 200 paid response + PAYMENT-RESPONSE (was 504)", async () => {
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ledgerTx(accept));
    const p = xrplPayload(accept);
    await expectDelivered(await handler()(paid(p)));
    expect(ran).toBe(1);
    expect(reconcile()).toEqual([expect.objectContaining({ status: 200, reason: "settle_unconfirmed_ledger_confirmed" })]);
    expect((await handler()(paid(p))).status).toBe(409);
  });

  it("ledger proves the tx failed (validated, not tesSUCCESS) → Base-only 402, not charged (was 504)", async () => {
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ledgerTx(accept, { result: "tecUNFUNDED_PAYMENT" }));
    const res = await handler()(paid(xrplPayload(accept)));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("ledger can't see it (not found / unreachable) → unchanged 504 settlement_unconfirmed + reconcile (genuinely unknown)", async () => {
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ({ status: "error", error: "txnNotFound" }));
    const res = await handler()(paid(xrplPayload(accept)));
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "settlement_unconfirmed" });
    expect(reconcile()).toEqual([expect.objectContaining({ status: 504 })]);
  });

  it("ledger shows the payment but it closed BEFORE this request (replayed slot) → 409, never delivered", async () => {
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ledgerTx(accept, { date: rippleNow(-3600) }));
    const res = await handler()(paid(xrplPayload(accept)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_payment" });
  });
});
