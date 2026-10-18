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
  SETTLEMENT_UNCONFIRMED_BODY,
  XRPL_REDEEM_LEASE_MS,
  __setXrplAfterDeliveryMarkHookForTests,
  __setXrplFacilitatorSchemeLoaderForTests,
  __setXrplRpcForTests,
  __setXrplTxLookupDelaysForTests,
  XRPL_EVAL_FAIL_RECHECK_MS,
  XRPL_IN_FLIGHT_STALE_MS,
  provablyNeverLanded,
  resetXrplRailForTests,
  xrplSignedTxHash,
  xrplReplayEvalOk,
  xrplReplayEvalStatus,
  setXrplAlertHook,
  setXrplReplayStoreForTests,
  type XrplAlert,
} from "@/lib/xrpl-rail";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { CAS_ANY_SCRIPT, EVAL_PROBE_SCRIPT, MemoryReplayStore, UpstashReplayStore, encodeReplayValue, parseReplayValue } from "@/lib/xrpl-replay-store";
import { RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER, XRPL_PAYTO, XRPL_SELF_FACILITATOR } from "@/lib/xrpl-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { installXrplFacilitators, installXrplRpc, makeXrplRpc, XRPL_PAYER, XRPL_TX_HASH, xrplPayload } from "./helpers/xrpl-env";

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
let settleCalls = 0;
const okSettle: SchemeSettle = async () => ({ success: true, transaction: XRPL_TX_HASH, network: "xrpl:0", payer: XRPL_PAYER });

let store: MemoryReplayStore;
function freshInstance() {
  resetXrplRailForTests();
  resetSolanaRailForTests();
  store = new MemoryReplayStore();
  setXrplReplayStoreForTests({
    kind: "upstash",
    claim: (k, t, v) => store.claim(k, t, v),
    set: (k, s, t) => store.set(k, s, t),
    release: (k) => store.release(k),
    get: (k) => store.get(k),
    cas: (k, e, n, t) => store.cas(k, e, n, t),
    casAny: (k, e, n, t) => store.casAny(k, e, n, t),
  });
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
    settle: () => (settleCalls++, settleImpl()),
  }) as never);
  __setXrplTxLookupDelaysForTests([0, 1, 1, 1]);
  alerts = [];
  setXrplAlertHook((a) => alerts.push(a));
  ran = 0;
  settleCalls = 0;
});
afterEach(() => {
  __setXrplAfterDeliveryMarkHookForTests(null);
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

  for (const [name, tx, reason, field] of [
    ["RPC unreachable on every try", () => { throw new Error("fetch failed"); }, "self_check_missing", "unreadable"],
    ["txnNotFound on every try (node behind)", () => ({ status: "error", error: "txnNotFound" }), "self_check_missing", "unreadable"],
    ["validated:false on every try", () => ({ status: "success", validated: false }), "self_check_missing", "unreadable"],
    ["validated but no meta", (a: PaymentRequirements) => ledgerTx(a, { meta: false }), "self_check_missing", "unreadable"],
  ] as const) {
    it(`${name} (re-read MISSING / unreadable) → 200 paid response + ALERT xrpl_settled_unverified + XRPL_RECONCILE status 200 (was 502)`, async () => {
      const accept = await xrplAccept();
      installXrplRpc("ready", () => (tx as (a: PaymentRequirements) => unknown)(accept));
      const p = xrplPayload(accept);
      await expectDelivered(await handler()(paid(p)));
      expect(ran).toBe(1);
      // Odin 11:34: HIGH severity + which field differed, so Sentinel can act fast.
      expect(alerts).toContainEqual({ kind: "xrpl_settled_unverified", severity: "high", field, reason });
      const rec = reconcile();
      expect(rec).toHaveLength(1);
      expect(rec[0]).toMatchObject({ tag: "XRPL_RECONCILE", status: 200, reason, network: "xrpl:0", route: "/api/pulse", payer: XRPL_PAYER, txHash: XRPL_TX_HASH });
      // The slot is consumed: the same payment again is a duplicate, never a second delivery or a 402.
      const again = await handler()(paid(p));
      expect(again.status).toBe(409);
      expect(ran).toBe(1);
    });
  }

  // N1 (Odin 11:56): a validated re-read that CONTRADICTS the payment is never delivered on.
  for (const [name, tx, reason, field] of [
    ["validated tesSUCCESS, delivered amount differs", (a: PaymentRequirements) => ledgerTx(a, { value: "0.001" }), "self_check_delivered_amount_mismatch", "amount"],
    ["validated tesSUCCESS, delivered issuer differs", (a: PaymentRequirements) => ({ ...ledgerTx(a), meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: XRPL_PAYER, value: a.amount } } }), "self_check_delivered_issuer_mismatch", "issuer"],
    ["validated tesSUCCESS, destination differs", (a: PaymentRequirements) => ({ ...ledgerTx(a), tx_json: { TransactionType: "Payment", Account: XRPL_PAYER, Destination: XRPL_PAYER } }), "self_check_destination_mismatch", "destination"],
    ["validated tesSUCCESS, another payer (transaction field)", (a: PaymentRequirements) => ({ ...ledgerTx(a), tx_json: { TransactionType: "Payment", Account: XRPL_PAYTO, Destination: XRPL_PAYTO } }), "self_check_payer_mismatch", "transaction"],
    ["validated tesSUCCESS, not a Payment (transaction field)", (a: PaymentRequirements) => ({ ...ledgerTx(a), tx_json: { TransactionType: "OfferCreate", Account: XRPL_PAYER } }), "self_check_not_payment", "transaction"],
  ] as const) {
    it(`${name} (re-read CONTRADICTS) → 502 + HIGH ALERT, NOT delivered; slot undelivered; a retry re-checks and stays 502 (never 409/402)`, async () => {
      const accept = await xrplAccept();
      installXrplRpc("ready", () => (tx as (a: PaymentRequirements) => unknown)(accept));
      const p = xrplPayload(accept);
      const res = await handler()(paid(p));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
      expect(res.headers.get("payment-response")).toBeNull();
      expect(alerts).toContainEqual({ kind: "xrpl_settled_unverified", severity: "high", field, reason });
      expect(reconcile()).toEqual([expect.objectContaining({ status: 502, reason, txHash: XRPL_TX_HASH })]);
      expect(slotStates()[0]).toMatch(/^settle_unconfirmed@\d+#[0-9A-F]{64}:\d+$/);
      const again = await handler()(paid(p));
      expect(again.status).toBe(502);
      expect(settleCalls).toBe(1);
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
    expect(await res.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
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

describe("delivered vs not delivered (Odin 11:34): an undelivered payment is redeemed once from the ledger; 409 only = already delivered", () => {
  /** First request: settle throws and the ledger can't see the tx yet → 504, slot left UNDELIVERED. */
  async function ambiguousFirst(accept: PaymentRequirements, p: PaymentPayload) {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
    installXrplRpc("ready", () => ({ status: "error", error: "txnNotFound" }));
    const res = await handler()(paid(p));
    expect(res.status).toBe(504);
    expect(ran).toBe(1);
    expect(settleCalls).toBe(1);
    const raw = [...((store as unknown as { m: Map<string, { state: string }> }).m.values())].map((e) => e.state);
    expect(raw).toHaveLength(1);
    // undelivered + firstSeen + the SUBMITTED tx hash and its LastLedgerSequence (public ledger data, no payer data)
    expect(raw[0]).toMatch(/^settle_unconfirmed@\d+#[0-9A-F]{64}:1000000$/);
  }

  it("504, then the ledger shows it closed to us → the retry DELIVERS once (route re-run, nothing re-submitted); the next retry is 409", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    installXrplRpc("ready", () => ledgerTx(accept));
    await expectDelivered(await handler()(paid(p)));
    expect(ran).toBe(2);
    expect(settleCalls).toBe(1); // ledger-only redemption: never submitted again
    expect(reconcile().map((r) => r.reason)).toContain("redeemed_after_undelivered");
    const again = await handler()(paid(p));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "duplicate_payment" });
    expect(ran).toBe(2);
  });

  it("already delivered (normal settle success) → retry is 409, route not re-run", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    installXrplRpc("ready", () => ledgerTx(accept));
    await expectDelivered(await handler()(paid(p)));
    expect((await handler()(paid(p))).status).toBe(409);
    expect(ran).toBe(1);
  });

  it("concurrent retries of an undelivered payment → exactly ONE delivery; the others get 503 payment_in_progress (Retry-After), never 409/402", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    installXrplRpc("ready", () => ledgerTx(accept));
    const h = handler();
    const rs = await Promise.all([h(paid(p)), h(paid(p)), h(paid(p)), h(paid(p))]);
    const st = rs.map((r) => r.status).sort();
    expect(st.filter((x) => x === 200)).toHaveLength(1);
    expect(st.filter((x) => x !== 200).every((x) => x === 503 || x === 409)).toBe(true);
    for (const r of rs.filter((x) => x.status === 503)) {
      expect(r.headers.get("retry-after")).toBe("5");
      expect(await r.json()).toEqual({ error: "payment_in_progress" });
    }
    expect(ran).toBe(2); // first ambiguous run + exactly one redemption
    expect((await h(paid(p))).status).toBe(409);
  });

  it("the ledger shows the payment closed BEFORE we first saw it → 409, never delivered (not paid through our flow: a replay of a consumed blob)", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    installXrplRpc("ready", () => ledgerTx(accept, { date: rippleNow(-3600) }));
    const res = await handler()(paid(p));
    expect(res.status).toBe(409);
    expect(ran).toBe(1);
    expect((await handler()(paid(p))).status).toBe(409);
    expect(ran).toBe(1);
  });

  it("the ledger still can't see it → 502 again, slot stays undelivered (a later retry can still deliver)", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    const r2 = await handler()(paid(p));
    expect(r2.status).toBe(502);
    expect(await r2.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
    installXrplRpc("ready", () => ledgerTx(accept));
    await expectDelivered(await handler()(paid(p)));
  });

  it("the ledger shows the tx failed (validated, not tesSUCCESS) → Base-only 402, not charged; later retries also 402", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    installXrplRpc("ready", () => ledgerTx(accept, { result: "tecPATH_DRY" }));
    expect((await handler()(paid(p))).status).toBe(402);
    expect((await handler()(paid(p))).status).toBe(402);
    expect(ran).toBe(1);
  });

  it("settle succeeded but delivery failed right AFTER the delivered mark → 502 (not 402, not 409), mark undone; the retry delivers once, then 409", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    installXrplRpc("ready", () => ledgerTx(accept));
    let boom = true;
    __setXrplAfterDeliveryMarkHookForTests(() => {
      if (boom) {
        boom = false;
        throw new Error("response lost after mark");
      }
    });
    const r1 = await handler()(paid(p));
    expect(r1.status).toBe(502);
    expect(await r1.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
    expect(reconcile().map((r) => r.reason)).toContain("post_settle_error");
    await expectDelivered(await handler()(paid(p)));
    expect(settleCalls).toBe(1);
    expect((await handler()(paid(p))).status).toBe(409);
  });

  it("redemption fails right after ITS delivered mark → back to undelivered (502); the next retry delivers", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    installXrplRpc("ready", () => ledgerTx(accept));
    let boom = true;
    __setXrplAfterDeliveryMarkHookForTests(() => {
      if (boom) {
        boom = false;
        throw new Error("lost");
      }
    });
    expect((await handler()(paid(p))).status).toBe(502);
    await expectDelivered(await handler()(paid(p)));
    expect((await handler()(paid(p))).status).toBe(409);
  });

  it("a live redemption lease blocks others (503); a stale lease (owner crashed) is taken over by CAS and delivers", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    const m = (store as unknown as { m: Map<string, { state: string; until: number }> }).m;
    const [k, e] = [...m.entries()][0];
    const first = Number(e.state.split("@")[1].split("#")[0]);
    const sub = e.state.slice(e.state.indexOf("#"));
    m.set(k, { ...e, state: `redeeming@${first}@${Date.now()}${sub}` });
    installXrplRpc("ready", () => ledgerTx(accept));
    expect((await handler()(paid(p))).status).toBe(503);
    m.set(k, { ...e, state: `redeeming@${first}@${Date.now() - XRPL_REDEEM_LEASE_MS - 1}${sub}` });
    await expectDelivered(await handler()(paid(p)));
    expect((await handler()(paid(p))).status).toBe(409);
  });

  it("the route errors during redemption → its own error, slot back to undelivered; a later retry delivers", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    await ambiguousFirst(accept, p);
    installXrplRpc("ready", () => ledgerTx(accept));
    let fail = true;
    const h = createX402GetHandler(
      async () => {
        ran++;
        if (fail) return NextResponse.json({ error: "upstream_down" }, { status: 502 });
        return NextResponse.json({ ok: true, paid: "body" });
      },
      pulseRouteConfig(),
      pulseOpts,
    );
    expect((await h(paid(p))).status).toBe(502);
    fail = false;
    await expectDelivered(await h(paid(p)));
    expect((await h(paid(p))).status).toBe(409);
  });
});

it("default alert sink tags xrpl_settled_unverified as [ALERT][HIGH] (Sentinel triage)", async () => {
  setXrplAlertHook(null);
  const accept = await xrplAccept();
  installXrplRpc("ready", () => ({ status: "error", error: "txnNotFound" }));
  await expectDelivered(await handler()(paid(xrplPayload(accept))));
  const lines = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[ALERT][HIGH]"));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toEqual({ kind: "xrpl_settled_unverified", severity: "high", field: "unreadable", reason: "self_check_missing" });
});

// ---------------------------------------------------------------------------
// Odin 11:44 AM ET (b)(d)(e)
// ---------------------------------------------------------------------------

describe("(b) the 502/504 body tells the buyer to retry with the SAME signed payment", () => {
  it("body: error + retry:same_payment + a message naming PAYMENT-SIGNATURE; no facilitator text, no-store", async () => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ({ status: "error", error: "txnNotFound" }));
    const res = await handler()(paid(xrplPayload(accept)));
    expect(res.status).toBe(504);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("payment-required")).toBeNull();
    const body = await res.json();
    expect(body).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
    expect(body).toMatchObject({ error: "settlement_unconfirmed", retry: "same_payment" });
    expect(body.message).toContain("SAME PAYMENT-SIGNATURE");
    expect(body.message).not.toContain("ws closed");
  });
});

/** RPC with the never-landed endpoints: `ledger` (validated index) and `tx` restricted by min/max_ledger. */
function llsRpc(o: { validated?: unknown; ledgerValidated?: boolean; ledgerThrows?: boolean; search?: unknown; lookup?: () => unknown } = {}) {
  const base = makeXrplRpc("ready", o.lookup ?? (() => ({ status: "error", error: "txnNotFound" })));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  __setXrplRpcForTests(async (url, method, params, t) => {
    if (method === "ledger") {
      calls.push({ method, params });
      if (o.ledgerThrows) throw new Error("rpc down");
      return { status: "success", validated: o.ledgerValidated ?? true, ledger_index: o.validated ?? 1_000_001, ledger_hash: "AB".repeat(32) };
    }
    if (method === "tx" && params.max_ledger !== undefined) {
      calls.push({ method: "tx_range", params });
      return o.search ?? { status: "error", error: "txnNotFound", searched_all: true };
    }
    return base.fn(url, method, params, t);
  });
  return calls;
}
const LLS = 1_000_000; // specTx LastLedgerSequence
const slotStates = () => [...((store as unknown as { m: Map<string, { state: string }> }).m.values())].map((e) => e.state);

describe("(d) LastLedgerSequence: past it and not found ⇒ provably never landed ⇒ Base-only 402 transaction_failed", () => {
  beforeEach(() => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
  });

  it("ambiguous settle, validated ledger past LLS, tx search over [LLS-999, LLS] says txnNotFound searched_all → 402, slot settle_failed, retries 402", async () => {
    const accept = await xrplAccept();
    const calls = llsRpc();
    const p = xrplPayload(accept);
    const res = await handler()(paid(p));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
    expect(res.headers.get("payment-response")).toBeNull();
    expect(await res.text()).not.toContain('"paid"');
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.error).toBe("transaction_failed");
    expect(pr.accepts.some((a) => a.network === "xrpl:0")).toBe(false); // Base-only
    // Order: validated index FIRST, then the bounded search.
    expect(calls.map((c) => c.method)).toEqual(["ledger", "tx_range"]);
    expect(calls[0].params).toEqual({ ledger_index: "validated" });
    expect(calls[1].params).toMatchObject({ min_ledger: LLS - 999, max_ledger: LLS, binary: false });
    expect(slotStates()).toEqual(["settle_failed"]);
    expect(reconcile()).toEqual([expect.objectContaining({ status: 402, reason: "never_landed_past_last_ledger" })]);
    expect((await handler()(paid(p))).status).toBe(402);
    expect(settleCalls).toBe(1);
  });

  it("validated index as a string (rippled ledger.ledger_index) is parsed → 402", async () => {
    const accept = await xrplAccept();
    llsRpc({ validated: String(LLS + 5) });
    expect((await handler()(paid(xrplPayload(accept)))).status).toBe(402);
  });

  for (const [name, o, searched] of [
    ["validated ledger == LLS (not past yet)", { validated: LLS }, false],
    ["validated ledger below LLS", { validated: LLS - 10 }, false],
    ["ledger answer not validated", { ledgerValidated: false }, false],
    ["ledger RPC down", { ledgerThrows: true }, false],
    ["unparseable ledger index", { validated: "abc" }, false],
    ["search: searched_all false (node lacks the range)", { search: { status: "error", error: "txnNotFound", searched_all: false } }, true],
    ["search: searched_all missing", { search: { status: "error", error: "txnNotFound" } }, true],
    ["search: other error", { search: { status: "error", error: "tooBusy", searched_all: true } }, true],
    ["search: found (not yet visible to the lookup)", { search: { status: "success", validated: true, hash: XRPL_TX_HASH } }, true],
  ] as const) {
    it(`${name} → unchanged 504 settlement_unconfirmed (unknown, never a 402)`, async () => {
      const accept = await xrplAccept();
      const calls = llsRpc(o as never);
      const res = await handler()(paid(xrplPayload(accept)));
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
      expect(calls.some((c) => c.method === "tx_range")).toBe(searched);
      expect(slotStates()[0]).toMatch(/^settle_unconfirmed@\d+#[0-9A-F]{64}:\d+$/);
    });
  }

  it("redeem path: first 504 (ledger not past LLS); later retry once past LLS and still not found → 402, slot settle_failed, never delivered", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    llsRpc({ validated: LLS - 3 });
    expect((await handler()(paid(p))).status).toBe(504);
    llsRpc({ validated: LLS + 1 });
    const r2 = await handler()(paid(p));
    expect(r2.status).toBe(402);
    expect(r2.headers.get("payment-response")).toBeNull();
    expect(decodePaymentRequiredHeader(r2.headers.get("payment-required")!).error).toBe("transaction_failed");
    expect(slotStates()).toEqual(["settle_failed"]);
    expect(reconcile().map((r) => r.reason)).toContain("redeem_never_landed_past_last_ledger");
    expect((await handler()(paid(p))).status).toBe(402);
    expect(ran).toBe(1);
    expect(settleCalls).toBe(1);
  });

  it("the ledger shows the payment → it is delivered, the never-landed check is not consulted", async () => {
    const accept = await xrplAccept();
    const calls = llsRpc({ lookup: () => ledgerTx(accept) });
    await expectDelivered(await handler()(paid(xrplPayload(accept))));
    expect(calls).toEqual([]);
  });

  it("provablyNeverLanded: bad hash / missing or non-integer LLS → false without any RPC", async () => {
    const calls = llsRpc();
    const cfg = { rpcUrl: "https://xrplcluster.com", initTimeoutMs: 2500 } as never;
    expect(await provablyNeverLanded(cfg, "zz", LLS)).toBe(false);
    expect(await provablyNeverLanded(cfg, null, LLS)).toBe(false);
    expect(await provablyNeverLanded(cfg, XRPL_TX_HASH, undefined)).toBe(false);
    expect(await provablyNeverLanded(cfg, XRPL_TX_HASH, 1.5)).toBe(false);
    expect(await provablyNeverLanded(cfg, XRPL_TX_HASH, 0)).toBe(false);
    expect(calls).toEqual([]);
    expect(await provablyNeverLanded(cfg, XRPL_TX_HASH, LLS)).toBe(true);
  });
});

describe("(e) BLOCKER: replay-store EVAL probe, fail closed", () => {
  let probes: number;
  let probeImpl: () => Promise<void>;
  /** The test store plus probeEval (the real UpstashReplayStore always has it). */
  function withProbe() {
    probes = 0;
    setXrplReplayStoreForTests({
      kind: "upstash",
      claim: (k, t, v) => store.claim(k, t, v),
      set: (k, st, t) => store.set(k, st, t),
      release: (k) => store.release(k),
      get: (k) => store.get(k),
      cas: (k, e, n, t) => store.cas(k, e, n, t),
      casAny: (k, e, n, t) => store.casAny(k, e, n, t),
      probeEval: () => (probes++, probeImpl()),
    });
  }
  const evalAlerts = () => alerts.filter((a) => a.kind === "xrpl_replay_eval_unavailable");
  const xrplIn402 = async () => {
    const res = await handler()(unpaid());
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.accepts.some((a) => a.network.startsWith("eip155:"))).toBe(true); // Base always stays
    return pr.accepts.some((a) => a.network === "xrpl:0");
  };

  beforeEach(() => {
    installXrplRpc("ready", () => ({ status: "error", error: "txnNotFound" }));
  });

  it("probe passes → XRPL in the 402; probed once per instance (cached), no ALERT", async () => {
    probeImpl = async () => {};
    withProbe();
    expect(await xrplIn402()).toBe(true);
    expect(await xrplIn402()).toBe(true);
    expect(probes).toBe(1);
    expect(evalAlerts()).toEqual([]);
    expect(await xrplReplayEvalStatus()).toBe("ok");
  });

  it("probe errors → XRPL falls off the 402 (confirmed absent), HIGH ALERT once; an XRPL payment gets the Base-only 402 with nothing claimed/verified/settled", async () => {
    const accept = await xrplAccept(); // the entry a buyer saw before the probe started failing
    probeImpl = async () => {
      throw new Error("ERR unknown command 'EVAL'");
    };
    withProbe();
    expect(await xrplIn402()).toBe(false);
    expect(await xrplIn402()).toBe(false);
    expect(probes).toBe(1); // failure cached (recheck after XRPL_EVAL_FAIL_RECHECK_MS)
    expect(evalAlerts()).toEqual([{ kind: "xrpl_replay_eval_unavailable", severity: "high", reason: "Error" }]);
    const res = await handler()(paid(xrplPayload(accept)));
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.error).toBe("rail_unavailable");
    expect(pr.accepts.some((a) => a.network === "xrpl:0")).toBe(false);
    expect(settleCalls).toBe(0);
    expect(slotStates()).toEqual([]); // never claimed
    expect(ran).toBe(0);
    expect(await xrplReplayEvalStatus()).toBe("unavailable");
  });

  it("failure is rechecked after XRPL_EVAL_FAIL_RECHECK_MS; recovery brings XRPL back; a new failure episode alerts again", async () => {
    let fail = true;
    probeImpl = async () => {
      if (fail) throw new Error("timeout");
    };
    withProbe();
    expect(await xrplIn402()).toBe(false);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(t0 + XRPL_EVAL_FAIL_RECHECK_MS - 1000);
    expect(await xrplReplayEvalOk()).toBe(false);
    expect(probes).toBe(1);
    now.mockReturnValue(t0 + XRPL_EVAL_FAIL_RECHECK_MS + 1);
    expect(await xrplReplayEvalOk()).toBe(false); // rechecked, still failing: same episode, no second ALERT
    expect(probes).toBe(2);
    expect(evalAlerts()).toHaveLength(1);
    fail = false;
    now.mockReturnValue(t0 + 2 * XRPL_EVAL_FAIL_RECHECK_MS + 2);
    expect(await xrplReplayEvalOk()).toBe(true);
    expect(probes).toBe(3);
    fail = true;
    now.mockReturnValue(t0 + 2 * XRPL_EVAL_FAIL_RECHECK_MS + 11 * 60_000);
    expect(await xrplReplayEvalOk()).toBe(false);
    expect(probes).toBe(4);
    expect(evalAlerts()).toHaveLength(2);
  });

  it("concurrent first use shares ONE probe", async () => {
    let release!: () => void;
    probeImpl = () => new Promise<void>((r) => (release = r));
    withProbe();
    const all = Promise.all([xrplReplayEvalOk(), xrplReplayEvalOk(), xrplReplayEvalOk()]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await all).toEqual([true, true, true]);
    expect(probes).toBe(1);
  });

  it("memory store (no shared store; testnet only) is not probed: status not_applicable", async () => {
    setXrplReplayStoreForTests(new MemoryReplayStore());
    expect(await xrplReplayEvalOk()).toBe(true);
    expect(await xrplReplayEvalStatus()).toBe("not_applicable");
  });

  it("UpstashReplayStore.probeEval sends EVAL \"return 1\" 0 (no keys, no data) and throws on an error / wrong answer / HTTP failure", async () => {
    const sent: unknown[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { result: 1 } };
    const fetchFn = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as unknown as typeof fetch;
    const s = new UpstashReplayStore("https://x.upstash.io", "t", fetchFn);
    await expect(s.probeEval()).resolves.toBeUndefined();
    expect(sent).toEqual([["EVAL", EVAL_PROBE_SCRIPT, "0"]]);
    expect(EVAL_PROBE_SCRIPT).toBe("return 1");
    answer = { status: 200, body: { error: "ERR unknown command 'EVAL'" } };
    await expect(s.probeEval()).rejects.toThrow();
    answer = { status: 200, body: { result: 0 } };
    await expect(s.probeEval()).rejects.toThrow();
    answer = { status: 403, body: { error: "NOPERM" } };
    await expect(s.probeEval()).rejects.toThrow();
  });

  it("default alert sink tags xrpl_replay_eval_unavailable as [ALERT][HIGH]", async () => {
    setXrplAlertHook(null);
    probeImpl = async () => {
      throw new Error("x");
    };
    withProbe();
    expect(await xrplReplayEvalOk()).toBe(false);
    const lines = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[ALERT][HIGH]"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toMatchObject({ kind: "xrpl_replay_eval_unavailable", severity: "high" });
  });
});

// ---------------------------------------------------------------------------
// Delta 3: Odin Class A 11:56 AM ET (H1 blocker, N1, M1, L1/N5, N3, N4, L3)
// ---------------------------------------------------------------------------

const hashOf = (p: PaymentPayload) => xrplSignedTxHash(String((p.payload as { signedTxBlob: string }).signedTxBlob))!;
const slotRaw = () => [...((store as unknown as { m: Map<string, { state: string }> }).m.values())].map((e) => e.state)[0];

/** Ledger keyed by hash: `landed` = the hashes validated on-ledger; `validated` = validated ledger index. */
function slotRpc(accept: PaymentRequirements, st: { landed: Set<string>; validated: number }) {
  const lookups: string[] = [];
  const ranges: Record<string, unknown>[] = [];
  const base = makeXrplRpc("ready", (h) => {
    lookups.push(h);
    return st.landed.has(h) ? { ...ledgerTx(accept), hash: h } : { status: "error", error: "txnNotFound" };
  });
  __setXrplRpcForTests(async (url, method, params, t) => {
    if (method === "ledger") return { status: "success", validated: true, ledger_index: st.validated };
    if (method === "tx" && params.max_ledger !== undefined) {
      ranges.push(params);
      return st.landed.has(String(params.transaction)) ? { status: "success", validated: true } : { status: "error", error: "txnNotFound", searched_all: true };
    }
    return base.fn(url, method, params, t);
  });
  return { lookups, ranges };
}

describe("H1 (BLOCKER): the retry blob only LOCATES the slot; lookups and the never-landed proof use the STORED submitted tx", () => {
  beforeEach(() => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
  });

  it("REGRESSION (fails on 9ec0b71): forged unsigned blob (same Account+Sequence, other hash, old LLS) leaves the slot unchanged and gets no 402; the real buyer's retry then delivers", async () => {
    const accept = await xrplAccept();
    const S = 77_001;
    const b1 = xrplPayload(accept, { Sequence: S });
    const h1 = hashOf(b1);
    const st = { landed: new Set<string>(), validated: 950_000 }; // past the forged LLS, not past B1's (1_000_000)
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    const before = slotRaw();
    expect(before).toMatch(new RegExp(`^settle_unconfirmed@\\d+#${h1}:1000000$`));
    const forged = xrplPayload(accept, { Sequence: S, LastLedgerSequence: 900_000 });
    const hf = hashOf(forged);
    expect(hf).not.toBe(h1);
    const r = await handler()(paid(forged));
    expect(r.status).toBe(502);
    expect(r.headers.get("payment-required")).toBeNull();
    expect(slotRaw()).toBe(before); // unchanged
    expect(rpc.lookups).not.toContain(hf); // the forged hash is never looked up
    expect(rpc.ranges.every((x) => x.transaction === h1 && x.max_ledger === 1_000_000)).toBe(true);
    st.landed.add(h1);
    const r2 = await handler()(paid(b1));
    expect(r2.status).toBe(200);
    expect(JSON.parse(Buffer.from(r2.headers.get("payment-response")!, "base64").toString())).toMatchObject({ success: true, transaction: h1 });
    expect(settleCalls).toBe(1);
    expect((await handler()(paid(b1))).status).toBe(409);
  });

  it("forged blob AFTER the real tx landed: never a 402, the slot is never failed (redemption is by the stored hash; same exposure as the accepted public-blob race, N2)", async () => {
    const accept = await xrplAccept();
    const S = 77_002;
    const b1 = xrplPayload(accept, { Sequence: S });
    const h1 = hashOf(b1);
    const st = { landed: new Set<string>(), validated: 999_000 };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    st.landed.add(h1);
    st.validated = 1_000_001; // past BOTH LLS values
    const forged = xrplPayload(accept, { Sequence: S, LastLedgerSequence: 900_000 });
    const r = await handler()(paid(forged));
    expect(r.status).not.toBe(402);
    expect(r.status).toBe(200);
    expect(rpc.lookups).not.toContain(hashOf(forged));
    expect(rpc.ranges).toEqual([]);
    expect(slotRaw()).toMatch(/^settled@/);
    expect((await handler()(paid(b1))).status).toBe(409);
  });

  it("honest client RE-SIGNS (same Sequence, new LLS/Fee) after the original landed → the retry delivers the ORIGINAL (stored) tx once", async () => {
    const accept = await xrplAccept();
    const S = 77_003;
    const b1 = xrplPayload(accept, { Sequence: S });
    const h1 = hashOf(b1);
    const st = { landed: new Set<string>(), validated: 999_000 };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    st.landed.add(h1);
    const b2 = xrplPayload(accept, { Sequence: S, LastLedgerSequence: 1_000_050, Fee: "15" });
    expect(hashOf(b2)).not.toBe(h1);
    const r = await handler()(paid(b2));
    expect(r.status).toBe(200);
    expect(JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString())).toMatchObject({ transaction: h1 });
    expect(rpc.lookups).not.toContain(hashOf(b2));
    expect(settleCalls).toBe(1);
    expect((await handler()(paid(b2))).status).toBe(409);
    expect((await handler()(paid(b1))).status).toBe(409);
  });

  it("honest client RE-SIGNS and the original NEVER landed → the never-landed proof runs on the ORIGINAL hash + LLS: 402 once past the ORIGINAL's LLS (even though the re-signed LLS is later)", async () => {
    const accept = await xrplAccept();
    const S = 77_004;
    const b1 = xrplPayload(accept, { Sequence: S });
    const h1 = hashOf(b1);
    const st = { landed: new Set<string>(), validated: 999_000 };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    const b2 = xrplPayload(accept, { Sequence: S, LastLedgerSequence: 1_000_050, Fee: "15" });
    expect((await handler()(paid(b2))).status).toBe(502); // original's LLS not passed yet
    st.validated = 1_000_001; // past B1's LLS (1_000_000), NOT past B2's (1_000_050)
    const r = await handler()(paid(b2));
    expect(r.status).toBe(402);
    expect(decodePaymentRequiredHeader(r.headers.get("payment-required")!).error).toBe("transaction_failed");
    expect(rpc.ranges.at(-1)).toMatchObject({ transaction: h1, min_ledger: 1_000_000 - 999, max_ledger: 1_000_000 });
    expect(rpc.lookups).not.toContain(hashOf(b2));
    expect(slotRaw()).toMatch(/^settle_failed/);
  });

  it("legacy undelivered value without a stored tx → 502 bare body, slot unchanged, nothing looked up (never the retry blob)", async () => {
    const accept = await xrplAccept();
    const S = 77_005;
    const b1 = xrplPayload(accept, { Sequence: S });
    const st = { landed: new Set<string>([hashOf(b1)]), validated: 2_000_000 };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(200); // lands normally... reuse its slot key
    const m = (store as unknown as { m: Map<string, { state: string; until: number }> }).m;
    const [k, e] = [...m.entries()][0];
    m.set(k, { ...e, state: `settle_unconfirmed@${Date.now()}` });
    rpc.lookups.length = 0;
    const r = await handler()(paid(b1));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "settlement_unconfirmed" });
    expect(rpc.lookups).toEqual([]);
    expect(rpc.ranges).toEqual([]);
    expect(m.get(k)!.state).toMatch(/^settle_unconfirmed@\d+$/);
  });

  it("the claim itself writes in_flight@firstSeen#<submitted hash>:<LLS>", async () => {
    const accept = await xrplAccept();
    const b1 = xrplPayload(accept, { Sequence: 77_006 });
    let during: string | undefined;
    settleImpl = async () => {
      during = slotRaw();
      throw new Error("ws closed");
    };
    slotRpc(accept, { landed: new Set(), validated: 1 });
    await handler()(paid(b1));
    expect(during).toBe(`in_flight@${parseReplayValue(during)!.firstSeen}#${hashOf(b1)}:1000000`);
  });
});

describe("M1: a stale in_flight (owner died after submit) is redeemable; a live one is busy", () => {
  async function deadOwner(ageMs: number) {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
    const accept = await xrplAccept();
    const b1 = xrplPayload(accept, { Sequence: 78_000 + Math.floor(ageMs / 1000) });
    const st = { landed: new Set<string>(), validated: 999_000 };
    slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    // Rewrite the slot as the claim of a request that died after submit, `ageMs` ago.
    const m = (store as unknown as { m: Map<string, { state: string; until: number }> }).m;
    const [k, e] = [...m.entries()][0];
    const firstSeen = Date.now() - ageMs;
    m.set(k, { ...e, state: encodeReplayValue({ state: "in_flight", firstSeen, hash: hashOf(b1), lls: 1_000_000 }) });
    return { accept, b1, st, m, k };
  }

  it("in_flight younger than the lease → 503 payment_in_progress (Retry-After 5)", async () => {
    const { b1 } = await deadOwner(10_000);
    const r = await handler()(paid(b1));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
  });

  it("legacy bare in_flight (no timestamp) → 503, never taken over", async () => {
    const { b1, m, k } = await deadOwner(10_000);
    const e = m.get(k)!;
    m.set(k, { ...e, state: "in_flight" });
    expect((await handler()(paid(b1))).status).toBe(503);
    expect(m.get(k)!.state).toBe("in_flight");
  });

  it("stale in_flight (> XRPL_IN_FLIGHT_STALE_MS) and the stored tx is on the ledger → the retry delivers once, then 409", async () => {
    const { b1, st } = await deadOwner(XRPL_IN_FLIGHT_STALE_MS + 1_000);
    st.landed.add(hashOf(b1));
    // ledgerTx date = now ≥ firstSeen − skew → fresh
    const r = await handler()(paid(b1));
    expect(r.status).toBe(200);
    expect((await handler()(paid(b1))).status).toBe(409);
  });

  it("stale in_flight, concurrent retries → atomic takeover: exactly ONE delivery, others 503", async () => {
    const { b1, st } = await deadOwner(XRPL_IN_FLIGHT_STALE_MS + 1_000);
    st.landed.add(hashOf(b1));
    const h = handler();
    const rs = await Promise.all([h(paid(b1)), h(paid(b1)), h(paid(b1))]);
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c !== 200).every((c) => c === 503 || c === 409)).toBe(true);
  });

  it("stale in_flight, stored tx never landed and the ledger is past its LLS → Base-only 402, slot settle_failed", async () => {
    const { b1, st } = await deadOwner(XRPL_IN_FLIGHT_STALE_MS + 1_000);
    st.validated = 1_000_001;
    const r = await handler()(paid(b1));
    expect(r.status).toBe(402);
    expect(slotRaw()).toMatch(/^settle_failed/);
  });

  it("stale in_flight, not visible yet → 502 (redeemable body), slot becomes undelivered with the stored tx", async () => {
    const { b1 } = await deadOwner(XRPL_IN_FLIGHT_STALE_MS + 1_000);
    const r = await handler()(paid(b1));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
    expect(slotRaw()).toMatch(new RegExp(`^settle_unconfirmed@\\d+#${hashOf(b1)}:1000000$`));
  });
});

describe("L1/N5: after an ambiguous settle we look up OUR blob hash and require the facilitator's hash to match", () => {
  it("facilitator names a DIFFERENT tx → 502 + HIGH ALERT xrpl_settle_hash_mismatch, NOT delivered even if our tx is on the ledger; slot undelivered without a stored tx (manual reconcile)", async () => {
    const accept = await xrplAccept();
    const b1 = xrplPayload(accept, { Sequence: 79_001 });
    const other = "D".repeat(64);
    settleImpl = async () => ({ success: false, errorReason: "tec_path_dry", transaction: other, network: "xrpl:0" });
    const rpc = slotRpc(accept, { landed: new Set([hashOf(b1), other]), validated: 2_000_000 });
    const r = await handler()(paid(b1));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "settlement_unconfirmed" });
    expect(r.headers.get("payment-response")).toBeNull();
    expect(alerts).toContainEqual({ kind: "xrpl_settle_hash_mismatch", severity: "high" });
    expect(reconcile()).toEqual([expect.objectContaining({ status: 502, reason: "settle_hash_mismatch", txHash: other })]);
    expect(rpc.lookups).toEqual([]); // neither hash is trusted on this request
    expect(slotRaw()).toMatch(/^settle_unconfirmed@\d+$/);
    const again = await handler()(paid(b1));
    expect(again.status).toBe(502);
    expect(ran).toBe(1);
  });

  it("facilitator names OUR tx (any case) → normal: looked up by our hash and delivered", async () => {
    const accept = await xrplAccept();
    const b1 = xrplPayload(accept, { Sequence: 79_002 });
    settleImpl = async () => ({ success: false, errorReason: "tec_path_dry", transaction: hashOf(b1).toLowerCase(), network: "xrpl:0" });
    const rpc = slotRpc(accept, { landed: new Set([hashOf(b1)]), validated: 2_000_000 });
    const r = await handler()(paid(b1));
    expect(r.status).toBe(200);
    expect(rpc.lookups[0]).toBe(hashOf(b1));
  });

  it("no facilitator hash (throw/timeout) → our blob hash is looked up", async () => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
    const accept = await xrplAccept();
    const b1 = xrplPayload(accept, { Sequence: 79_003 });
    const rpc = slotRpc(accept, { landed: new Set([hashOf(b1)]), validated: 2_000_000 });
    expect((await handler()(paid(b1))).status).toBe(200);
    expect(new Set(rpc.lookups)).toEqual(new Set([hashOf(b1)]));
  });
});

describe("N3: the redeem failure reset is ONE atomic compare-and-set against exactly our own values", () => {
  it("a delivered mark written by someone else (bare 'settled') is never reset by our failure → stays 409", async () => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
    const accept = await xrplAccept();
    const b1 = xrplPayload(accept, { Sequence: 79_101 });
    const st = { landed: new Set<string>(), validated: 999_000 };
    slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    st.landed.add(hashOf(b1));
    const m = (store as unknown as { m: Map<string, { state: string; until: number }> }).m;
    __setXrplAfterDeliveryMarkHookForTests(() => {
      const [k, e] = [...m.entries()][0];
      m.set(k, { ...e, state: "settled" }); // another owner's delivered mark (e.g. after a lease takeover)
      throw new Error("lost after mark");
    });
    expect((await handler()(paid(b1))).status).toBe(502);
    expect(slotRaw()).toBe("settled");
    __setXrplAfterDeliveryMarkHookForTests(null);
    expect((await handler()(paid(b1))).status).toBe(409);
  });

  it("our OWN owner-tagged delivered mark is reset to undelivered (with the stored tx) → the next retry delivers", async () => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
    const accept = await xrplAccept();
    const b1 = xrplPayload(accept, { Sequence: 79_102 });
    const st = { landed: new Set<string>(), validated: 999_000 };
    slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    st.landed.add(hashOf(b1));
    let marked: string | undefined;
    __setXrplAfterDeliveryMarkHookForTests(() => {
      marked = slotRaw();
      throw new Error("lost after mark");
    });
    expect((await handler()(paid(b1))).status).toBe(502);
    expect(marked).toMatch(new RegExp(`^settled@\\d+![0-9a-f]{16}#${hashOf(b1)}:1000000$`));
    expect(slotRaw()).toMatch(new RegExp(`^settle_unconfirmed@\\d+#${hashOf(b1)}:1000000$`));
    __setXrplAfterDeliveryMarkHookForTests(null);
    expect((await handler()(paid(b1))).status).toBe(200);
  });

  it("store: casAny (memory) swaps only on an exact match; Upstash sends ONE EVAL with CAS_ANY_SCRIPT", async () => {
    const mem = new MemoryReplayStore();
    await mem.set("k", "a", 1000);
    expect(await mem.casAny("k", ["x", "y"], "n", 1000)).toBe(false);
    expect(await mem.get("k")).toBe("a");
    expect(await mem.casAny("k", ["x", "a"], "n", 1000)).toBe(true);
    expect(await mem.get("k")).toBe("n");
    expect(await mem.casAny("missing", ["n"], "z", 1000)).toBe(false);
    const sent: unknown[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const up = new UpstashReplayStore("https://x.upstash.io", "t", fetchFn);
    expect(await up.casAny("k", ["m1", "m2"], "next", 5000)).toBe(true);
    expect(sent).toEqual([["EVAL", CAS_ANY_SCRIPT, "1", "hp:xrpl:replay:k", "next", "5000", "m1", "m2"]]);
    expect(CAS_ANY_SCRIPT).toContain("for i = 3, #ARGV");
  });

  it("store values: encode/parse round trip incl. owner + submitted tx; legacy forms still parse; junk → null", () => {
    const h = "AB".repeat(32);
    const full = { state: "redeeming" as const, firstSeen: 1, lease: 2, owner: "0123456789abcdef", hash: h, lls: 99 };
    expect(encodeReplayValue(full)).toBe(`redeeming@1@2!0123456789abcdef#${h}:99`);
    expect(parseReplayValue(encodeReplayValue(full))).toEqual(full);
    expect(parseReplayValue("settle_unconfirmed@5")).toEqual({ state: "settle_unconfirmed", firstSeen: 5 });
    expect(parseReplayValue("settled")).toEqual({ state: "settled" });
    expect(parseReplayValue(`in_flight@7#${h}:1`)).toEqual({ state: "in_flight", firstSeen: 7, hash: h, lls: 1 });
    expect(parseReplayValue(`in_flight@7#${h.toLowerCase()}:1`)).toBeNull();
    expect(parseReplayValue("in_flight@7#XYZ:1")).toBeNull();
  });
});

it("L3: the redeemable 502/504 body says to retry within 24 hours", () => {
  expect(SETTLEMENT_UNCONFIRMED_BODY.message).toContain("retry within 24 hours");
});
