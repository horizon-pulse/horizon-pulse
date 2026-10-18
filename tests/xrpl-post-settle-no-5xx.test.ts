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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  XRPL_EVAL_PROBE_DEADLINE_MS,
  XRPL_FP_ALERT_COOLDOWN_MS,
  XRPL_IN_FLIGHT_STALE_MS,
  LSF_DISABLE_MASTER,
  __setXrplMasterCheckDeadlineForTests,
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
import { Wallet, decode as decodeBlob, encode as encodeBlob } from "xrpl";
import {
  CAS_ANY_SCRIPT,
  CAS_DELETE_SCRIPT,
  CAS_SCRIPT,
  EVAL_PROBE_SCRIPT,
  MemoryReplayStore,
  ReplaySelfTestError,
  SELFTEST_KEY_PREFIX,
  UpstashReplayStore,
  encodeReplayValue,
  parseReplayValue,
} from "@/lib/xrpl-replay-store";
import { RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER, XRPL_PAYTO, XRPL_SELF_FACILITATOR } from "@/lib/xrpl-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { normalizeQuery, requestFingerprint } from "@/lib/request-fingerprint";
import { installXrplFacilitators, installXrplRpc, makeXrplRpc, specTx, XRPL_PAYER, XRPL_TX_HASH, xrplPayload } from "./helpers/xrpl-env";

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

type SchemeSettle = (p?: PaymentPayload) => Promise<unknown>;
let settleImpl: SchemeSettle;
let settleCalls = 0;
// Odin 12:07 F2: an honest facilitator reports the hash of the blob it submitted (ours).
const okSettle: SchemeSettle = async (p) => ({ success: true, transaction: p ? hashOf(p) : XRPL_TX_HASH, network: "xrpl:0", payer: XRPL_PAYER });

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
    casDelete: (k, e) => store.casDelete(k, e),
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
/** Odin 5:40 hotfix: the fingerprint of the standard paid request (GET /api/pulse, no query, no body). */
let RQ = "";
beforeAll(async () => {
  RQ = await requestFingerprint(unpaid());
});
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });

async function xrplAccept(): Promise<PaymentRequirements> {
  const res = await handler()(unpaid());
  const a = decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts.find((x) => x.network === "xrpl:0");
  expect(a).toBeDefined();
  return a!;
}

/** A validated `tx` answer for the settled hash. */
const ledgerTx = (accept: PaymentRequirements, over: { result?: string; value?: string; date?: number; meta?: boolean; account?: string } = {}) => ({
  validated: true,
  status: "success",
  hash: XRPL_TX_HASH,
  date: over.date ?? rippleNow(),
  tx_json: { TransactionType: "Payment", Account: over.account ?? XRPL_PAYER, Destination: XRPL_PAYTO },
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
    settle: (p: PaymentPayload) => (settleCalls++, settleImpl(p)),
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
  expect(JSON.parse(Buffer.from(prh!, "base64").toString())).toMatchObject({ success: true, transaction: expect.stringMatching(/^[0-9A-F]{64}$/), network: "xrpl:0" });
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
      expect(rec[0]).toMatchObject({ tag: "XRPL_RECONCILE", status: 200, reason, network: "xrpl:0", route: "/api/pulse", payer: XRPL_PAYER, txHash: hashOf(p) });
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
      expect(reconcile()).toEqual([expect.objectContaining({ status: 502, reason, txHash: hashOf(p) })]);
      expect(slotStates()[0]).toMatch(/^settle_unconfirmed@\d+#[0-9A-F]{64}:\d+~[0-9a-f]{64}$/);
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
    expect(raw[0]).toMatch(/^settle_unconfirmed@\d+#[0-9A-F]{64}:1000000~[0-9a-f]{64}$/);
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

  it("ambiguous settle, validated ledger past LLS, tx search over [LLS-999, LLS] says txnNotFound searched_all → 402, slot DELETED (N6); a re-signed payment with the same Sequence then pays and delivers", async () => {
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
    expect(slotStates()).toEqual([]); // N6: deleted, not settle_failed
    expect(reconcile()).toEqual([expect.objectContaining({ status: 402, reason: "never_landed_past_last_ledger" })]);
    // N6: the same Sequence, re-signed (new LLS), is a fresh payment: claim → verify → settle → delivered.
    settleImpl = okSettle;
    const seq = (decodeTx(p) as { Sequence: number }).Sequence;
    const p2 = xrplPayload(accept, { Sequence: seq, LastLedgerSequence: LLS + 50 });
    llsRpc({ lookup: () => ledgerTx(accept) });
    await expectDelivered(await handler()(paid(p2)));
    expect(settleCalls).toBe(2);
    expect((await handler()(paid(p2))).status).toBe(409);
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
      expect(slotStates()[0]).toMatch(/^settle_unconfirmed@\d+#[0-9A-F]{64}:\d+~[0-9a-f]{64}$/);
    });
  }

  it("redeem path: first 504 (ledger not past LLS); later retry once past LLS and still not found → 402, slot DELETED (N6), never delivered; then a re-signed same-Sequence payment pays", async () => {
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    llsRpc({ validated: LLS - 3 });
    expect((await handler()(paid(p))).status).toBe(504);
    llsRpc({ validated: LLS + 1 });
    const r2 = await handler()(paid(p));
    expect(r2.status).toBe(402);
    expect(r2.headers.get("payment-response")).toBeNull();
    expect(decodePaymentRequiredHeader(r2.headers.get("payment-required")!).error).toBe("transaction_failed");
    expect(slotStates()).toEqual([]); // N6
    expect(reconcile().map((r) => r.reason)).toContain("redeem_never_landed_past_last_ledger");
    expect(ran).toBe(1);
    expect(settleCalls).toBe(1);
    settleImpl = okSettle;
    const seq = (decodeTx(p) as { Sequence: number }).Sequence;
    const p2 = xrplPayload(accept, { Sequence: seq, LastLedgerSequence: LLS + 50 });
    llsRpc({ lookup: () => ledgerTx(accept) });
    await expectDelivered(await handler()(paid(p2)));
    expect(settleCalls).toBe(2);
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
      casDelete: (k, e) => store.casDelete(k, e),
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

  it("UpstashReplayStore.probeEval starts with EVAL \"return 1\" 0 (no keys, no data) and throws on an error / wrong answer / HTTP failure", async () => {
    const up = fakeUpstash();
    const s = new UpstashReplayStore("https://x.upstash.io", "t", up.fetchFn);
    await expect(s.probeEval()).resolves.toBeUndefined();
    expect(up.sent[0]).toEqual(["EVAL", EVAL_PROBE_SCRIPT, "0"]);
    expect(EVAL_PROBE_SCRIPT).toBe("return 1");
    for (const bad of [{ status: 200, body: { error: "ERR unknown command 'EVAL'" } }, { status: 200, body: { result: 0 } }, { status: 403, body: { error: "NOPERM" } }]) {
      const f = fakeUpstash((args) => (args[0] === "EVAL" && args[1] === EVAL_PROBE_SCRIPT ? bad : undefined));
      await expect(new UpstashReplayStore("https://x.upstash.io", "t", f.fetchFn).probeEval()).rejects.toThrow();
      expect(f.sent).toHaveLength(1); // nothing after a failed EVAL
    }
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

/**
 * Minimal in-memory Upstash REST double (SET [NX] [PX], GET, DEL, EVAL of the repo's scripts). `override(args)` may
 * return a canned {status, body} for one command to inject a fault; undefined = normal behaviour.
 */
type UpCmd = string[];
function fakeUpstash(override?: (args: UpCmd, n: number) => { status: number; body: unknown } | undefined, data = new Map<string, string>()) {
  const sent: UpCmd[] = [];
  const run = (a: UpCmd): unknown => {
    const [cmd] = a;
    if (cmd === "SET") {
      if (a.includes("NX") && data.has(a[1])) return null;
      data.set(a[1], a[2]);
      return "OK";
    }
    if (cmd === "GET") return data.get(a[1]) ?? null;
    if (cmd === "DEL") return data.delete(a[1]) ? 1 : 0;
    if (cmd === "EVAL") {
      const [, script, , k, ...argv] = a;
      if (script === EVAL_PROBE_SCRIPT) return 1;
      if (script === CAS_DELETE_SCRIPT) return data.get(k) === argv[0] ? (data.delete(k), 1) : 0;
      if (script === CAS_SCRIPT) return data.get(k) === argv[0] ? (data.set(k, argv[1]), 1) : 0;
      if (script === CAS_ANY_SCRIPT) return data.has(k) && argv.slice(2).includes(data.get(k)!) ? (data.set(k, argv[0]), 1) : 0;
    }
    return { __error: "ERR unknown" };
  };
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const args = JSON.parse(String(init.body)) as UpCmd;
    sent.push(args);
    const o = override?.(args, sent.length);
    if (o) return new Response(JSON.stringify(o.body), { status: o.status });
    const r = run(args);
    if (r && typeof r === "object" && "__error" in r) return new Response(JSON.stringify({ error: "ERR unknown" }), { status: 200 });
    return new Response(JSON.stringify({ result: r }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, sent, data };
}

const hashOf = (p: PaymentPayload) => xrplSignedTxHash(String((p.payload as { signedTxBlob: string }).signedTxBlob))!;
const decodeTx = (p: PaymentPayload) => decodeBlob(String((p.payload as { signedTxBlob: string }).signedTxBlob)) as Record<string, unknown>;
/** Odin 12:07 F1: REAL signatures (offline, xrpl Wallet). Nothing is submitted anywhere. */
const walletA = Wallet.generate();
const walletB = Wallet.generate();
type SigMode = "master" | "regular_key" | "multisig" | "unsigned" | "bad_signature";
function signedPayload(accept: PaymentRequirements, over: Record<string, unknown>, mode: SigMode = "master"): PaymentPayload {
  const tx = specTx(accept, { Account: walletA.classicAddress, ...over });
  delete tx.SigningPubKey;
  let blob: string;
  if (mode === "unsigned") blob = encodeBlob({ ...tx, SigningPubKey: "" } as never);
  else if (mode === "regular_key") blob = walletB.sign(tx as never).tx_blob; // Account = A, key = B
  else if (mode === "multisig") blob = walletB.sign(tx as never, true).tx_blob; // Signers array
  else {
    blob = walletA.sign(tx as never).tx_blob;
    if (mode === "bad_signature") {
      const d = decodeBlob(blob) as Record<string, unknown>;
      const sig = String(d.TxnSignature);
      d.TxnSignature = sig.slice(0, 10) + (sig[10] === "0" ? "1" : "0") + sig.slice(11);
      blob = encodeBlob(d as never);
    }
  }
  return xrplPayload(accept, {}, {}, blob);
}
const slotRaw = () => [...((store as unknown as { m: Map<string, { state: string }> }).m.values())].map((e) => e.state)[0];

/** Ledger keyed by hash: `landed` = the hashes validated on-ledger; `validated` = validated ledger index. */
type MasterMode = "enabled" | "disabled" | "rpc_error" | "throws" | "timeout" | "not_validated";
function slotRpc(accept: PaymentRequirements, st: { landed: Set<string>; validated: number; account?: string; master?: MasterMode }) {
  const lookups: string[] = [];
  const ranges: Record<string, unknown>[] = [];
  /** Delta 5: account_info reads for any account other than payTo (= the F1(b) master-key check). */
  const accountInfo: string[] = [];
  const base = makeXrplRpc("ready", (h) => {
    lookups.push(h);
    return st.landed.has(h) ? { ...ledgerTx(accept, { account: st.account }), hash: h } : { status: "error", error: "txnNotFound" };
  });
  __setXrplRpcForTests(async (url, method, params, t) => {
    if (method === "ledger") return { status: "success", validated: true, ledger_index: st.validated };
    if (method === "account_info" && params.account !== accept.payTo) {
      accountInfo.push(String(params.account));
      expect(params.ledger_index).toBe("validated");
      const mode = st.master ?? "enabled";
      if (mode === "throws") throw new Error("rpc down");
      if (mode === "timeout") return new Promise(() => {});
      if (mode === "rpc_error") return { status: "error", error: "tooBusy" };
      const flags = mode === "disabled" ? LSF_DISABLE_MASTER | 0x00010000 : 0x00010000; // + an unrelated flag
      return { status: "success", validated: mode !== "not_validated", account_data: { Account: params.account, Flags: flags } };
    }
    if (method === "tx" && params.max_ledger !== undefined) {
      ranges.push(params);
      return st.landed.has(String(params.transaction)) ? { status: "success", validated: true } : { status: "error", error: "txnNotFound", searched_all: true };
    }
    return base.fn(url, method, params, t);
  });
  return { lookups, ranges, accountInfo };
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
    expect(before).toMatch(new RegExp(`^settle_unconfirmed@\\d+#${h1}:1000000~${RQ}$`));
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

  it("forged unsigned blob AFTER the real tx landed: F1 → 502, slot untouched, nothing looked up; the real buyer's retry then delivers", async () => {
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
    const before = slotRaw();
    rpc.lookups.length = 0;
    const r = await handler()(paid(forged));
    expect(r.status).toBe(502);
    expect(slotRaw()).toBe(before);
    expect(rpc.lookups).toEqual([]);
    expect(rpc.ranges).toEqual([]);
    expect((await handler()(paid(b1))).status).toBe(200);
    expect((await handler()(paid(b1))).status).toBe(409);
  });

  it("F1: honest MASTER-KEY re-signer (real signature, same Sequence, new LLS/Fee) after the original landed → gets the ORIGINAL's delivery once", async () => {
    const accept = await xrplAccept();
    const S = 77_003;
    const b1 = signedPayload(accept, { Sequence: S });
    const h1 = hashOf(b1);
    const st = { landed: new Set<string>(), validated: 999_000, account: walletA.classicAddress };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    st.landed.add(h1);
    const b2 = signedPayload(accept, { Sequence: S, LastLedgerSequence: 1_000_050, Fee: "15" });
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
    const b1 = signedPayload(accept, { Sequence: S });
    const h1 = hashOf(b1);
    const st = { landed: new Set<string>(), validated: 999_000, account: walletA.classicAddress };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    const b2 = signedPayload(accept, { Sequence: S, LastLedgerSequence: 1_000_050, Fee: "15" });
    expect((await handler()(paid(b2))).status).toBe(502); // original's LLS not passed yet
    st.validated = 1_000_001; // past B1's LLS (1_000_000), NOT past B2's (1_000_050)
    const r = await handler()(paid(b2));
    expect(r.status).toBe(402);
    expect(decodePaymentRequiredHeader(r.headers.get("payment-required")!).error).toBe("transaction_failed");
    expect(rpc.ranges.at(-1)).toMatchObject({ transaction: h1, min_ledger: 1_000_000 - 999, max_ledger: 1_000_000 });
    expect(rpc.lookups).not.toContain(hashOf(b2));
    expect(slotRaw()).toBeUndefined(); // N6: deleted, not settle_failed
    // N6: a re-signed payment with the SAME Sequence then pays and delivers (fresh claim → settle).
    settleImpl = okSettle;
    const b3 = signedPayload(accept, { Sequence: S, LastLedgerSequence: 1_000_100 });
    st.landed.add(hashOf(b3));
    const r3 = await handler()(paid(b3));
    expect(r3.status).toBe(200);
    expect(JSON.parse(Buffer.from(r3.headers.get("payment-response")!, "base64").toString())).toMatchObject({ success: true, transaction: hashOf(b3) });
    expect(settleCalls).toBe(2);
    expect((await handler()(paid(b3))).status).toBe(409);
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
    expect(during).toBe(`in_flight@${parseReplayValue(during)!.firstSeen}#${hashOf(b1)}:1000000~${RQ}`);
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
    m.set(k, { ...e, state: encodeReplayValue({ state: "in_flight", firstSeen, hash: hashOf(b1), lls: 1_000_000, rq: RQ }) });
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

  it("stale in_flight, stored tx never landed and the ledger is past its LLS → Base-only 402, slot DELETED (N6)", async () => {
    const { b1, st } = await deadOwner(XRPL_IN_FLIGHT_STALE_MS + 1_000);
    st.validated = 1_000_001;
    const r = await handler()(paid(b1));
    expect(r.status).toBe(402);
    expect(slotRaw()).toBeUndefined();
  });

  it("stale in_flight, not visible yet → 502 (redeemable body), slot becomes undelivered with the stored tx", async () => {
    const { b1 } = await deadOwner(XRPL_IN_FLIGHT_STALE_MS + 1_000);
    const r = await handler()(paid(b1));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
    expect(slotRaw()).toMatch(new RegExp(`^settle_unconfirmed@\\d+#${hashOf(b1)}:1000000~${RQ}$`));
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
    expect(slotRaw()).toMatch(new RegExp(`^settle_unconfirmed@\\d+~${RQ}$`));
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
    expect(marked).toMatch(new RegExp(`^settled@\\d+![0-9a-f]{16}#${hashOf(b1)}:1000000~${RQ}$`));
    expect(slotRaw()).toMatch(new RegExp(`^settle_unconfirmed@\\d+#${hashOf(b1)}:1000000~${RQ}$`));
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
    // Odin 5:40 hotfix: the request fingerprint suffix round-trips; values without it (current prod) parse with rq undefined.
    const rq = "0f".repeat(32);
    expect(encodeReplayValue({ ...full, rq })).toBe(`redeeming@1@2!0123456789abcdef#${h}:99~${rq}`);
    expect(parseReplayValue(encodeReplayValue({ ...full, rq }))).toEqual({ ...full, rq });
    expect(parseReplayValue(`settle_unconfirmed@5~${rq}`)).toEqual({ state: "settle_unconfirmed", firstSeen: 5, rq });
    expect(parseReplayValue(`settle_unconfirmed@5#${h}:9`)!.rq).toBeUndefined();
    expect(parseReplayValue(`settle_unconfirmed@5~${rq.toUpperCase()}`)).toBeNull();
    expect(parseReplayValue(`settle_unconfirmed@5~abc`)).toBeNull();
    expect(encodeReplayValue({ state: "settled", rq: "not-hex" })).toBe("settled");
  });
});

it("L3: the redeemable 502/504 body says to retry within 24 hours", () => {
  expect(SETTLEMENT_UNCONFIRMED_BODY.message).toContain("retry within 24 hours");
});

// ---------------------------------------------------------------------------
// Delta 4: Odin 12:07 PM ET (F1 retry binding, F2 settle-hash mismatch, N6 delete on never-landed)
// ---------------------------------------------------------------------------

describe("F1: a retry with another hash may redeem ONLY when it is master-key signed by the same Account (verified)", () => {
  beforeEach(() => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
  });
  async function stuck(S: number) {
    const accept = await xrplAccept();
    const b1 = signedPayload(accept, { Sequence: S });
    const st = { landed: new Set<string>(), validated: 999_000, account: walletA.classicAddress };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    st.landed.add(hashOf(b1)); // even with the original ON the ledger, an unbound retry gets nothing
    st.validated = 1_000_001; // and past LLS (a never-landed proof would be reachable)
    return { accept, b1, st, rpc };
  }

  it("(a) exact blob (hash == stored hash) → redeems: 200 with the original", async () => {
    const { b1 } = await stuck(78_001);
    const r = await handler()(paid(b1));
    expect(r.status).toBe(200);
    expect(JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString())).toMatchObject({ transaction: hashOf(b1) });
  });

  for (const [mode, label] of [
    ["unsigned", "unsigned (empty SigningPubKey / no TxnSignature)"],
    ["regular_key", "regular-key signed (key does NOT derive to Account)"],
    ["multisig", "multisig (Signers)"],
    ["bad_signature", "master key but the signature does NOT verify (tampered)"],
  ] as const) {
    it(`${label} → 502 bare, slot UNTOUCHED, nothing looked up, no delivery; the genuine blob still redeems`, async () => {
      const S = 78_100 + mode.length;
      const { accept, b1, rpc } = await stuck(S);
      const before = slotRaw();
      rpc.lookups.length = 0;
      rpc.ranges.length = 0;
      const ranBefore = ran;
      const bad = signedPayload(accept, { Sequence: S, LastLedgerSequence: 1_000_050, Fee: "15" }, mode);
      expect(hashOf(bad)).not.toBe(hashOf(b1));
      const r = await handler()(paid(bad));
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: "settlement_unconfirmed" }); // Odin 12:28 (1): BARE body, not the redeemable one
      expect(r.headers.get("payment-response")).toBeNull();
      expect(r.headers.get("payment-required")).toBeNull();
      expect(slotRaw()).toBe(before);
      expect(rpc.lookups).toEqual([]);
      expect(rpc.ranges).toEqual([]);
      expect(ran).toBe(ranBefore); // the handler is not even run for an unbound retry
      expect(settleCalls).toBe(1);
      expect((await handler()(paid(b1))).status).toBe(200);
    });
  }

  it("unit: xrplMasterKeySigned classifies each class", async () => {
    const { xrplMasterKeySigned } = await import("@/lib/xrpl-rail");
    const accept = await xrplAccept();
    const blob = (m: SigMode) => String((signedPayload(accept, { Sequence: 78_200 }, m).payload as { signedTxBlob: string }).signedTxBlob);
    expect(await xrplMasterKeySigned(blob("master"))).toMatchObject({ ok: true });
    expect(await xrplMasterKeySigned(blob("unsigned"))).toMatchObject({ ok: false, reason: "unsigned" });
    expect(await xrplMasterKeySigned(blob("regular_key"))).toMatchObject({ ok: false, reason: "not_master_key" });
    expect(await xrplMasterKeySigned(blob("multisig"))).toMatchObject({ ok: false, reason: "multisig" });
    expect(await xrplMasterKeySigned(blob("bad_signature"))).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await xrplMasterKeySigned("zz")).toMatchObject({ ok: false });
  });
});

describe("F2: settle success whose facilitator hash differs from our blob hash → 502 + HIGH alert + manual reconcile (never 402/settle_failed)", () => {
  it("success with another hash → bare 502, xrpl_settle_hash_mismatch HIGH, reconcile, only OUR hash ever looked up, slot undelivered (no stored tx)", async () => {
    const accept = await xrplAccept();
    const other = "CD".repeat(32);
    const lookups: string[] = [];
    // If anything looked up the facilitator hash it would read as a validated FAILURE (tec) — must never become a 402.
    installXrplRpc("ready", (h: string) => (lookups.push(h), h === other ? { ...ledgerTx(accept, { result: "tecPATH_PARTIAL" }), hash: other } : { status: "error", error: "txnNotFound" }));
    settleImpl = async () => ({ success: true, transaction: other, network: "xrpl:0", payer: XRPL_PAYER });
    const p = xrplPayload(accept);
    const r = await handler()(paid(p));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "settlement_unconfirmed" });
    expect(r.headers.get("payment-required")).toBeNull();
    expect(r.headers.get("payment-response")).toBeNull();
    expect(lookups).not.toContain(other);
    expect(alerts.filter((a) => a.kind === "xrpl_settle_hash_mismatch")).toEqual([expect.objectContaining({ severity: "high" })]);
    expect(reconcile()).toEqual([expect.objectContaining({ status: 502, reason: "settle_hash_mismatch", txHash: other })]);
    expect(slotStates()).toHaveLength(1);
    expect(slotStates()[0]).toMatch(new RegExp(`^settle_unconfirmed@\\d+~${RQ}$`));
    expect(slotStates()[0]).not.toMatch(/settle_failed/);
    // A retry finds no stored tx → bare 502 (manual reconcile), never a 402.
    const r2 = await handler()(paid(p));
    expect(r2.status).toBe(502);
    expect(settleCalls).toBe(1);
  });

  it("control: success with OUR hash (any case) → normal delivery, no mismatch alert", async () => {
    const accept = await xrplAccept();
    installXrplRpc("ready", () => ledgerTx(accept));
    settleImpl = async (p) => ({ success: true, transaction: hashOf(p!).toLowerCase(), network: "xrpl:0", payer: XRPL_PAYER });
    const p = xrplPayload(accept);
    const r = await handler()(paid(p));
    expect(r.status).toBe(200);
    const pr = JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString());
    expect(String(pr.transaction).toUpperCase()).toBe(hashOf(p));
    expect(alerts.some((a) => a.kind === "xrpl_settle_hash_mismatch")).toBe(false);
  });
});

describe("N6: proven never-landed ⇒ atomic owner/value-checked DELETE (never settle_failed)", () => {
  it("store: casDelete (memory) deletes only on an exact match; Upstash sends ONE EVAL with CAS_DELETE_SCRIPT", async () => {
    const mem = new MemoryReplayStore();
    await mem.set("k", "a", 1000);
    expect(await mem.casDelete("k", "x")).toBe(false);
    expect(await mem.get("k")).toBe("a");
    expect(await mem.casDelete("k", "a")).toBe(true);
    expect(await mem.get("k")).toBeNull();
    expect(await mem.casDelete("missing", "a")).toBe(false);
    const sent: unknown[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const up = new UpstashReplayStore("https://x.upstash.io", "t", fetchFn);
    expect(await up.casDelete("k", "v1")).toBe(true);
    expect(sent).toEqual([["EVAL", CAS_DELETE_SCRIPT, "1", "hp:xrpl:replay:k", "v1"]]);
    expect(CAS_DELETE_SCRIPT).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(CAS_DELETE_SCRIPT).toContain("redis.call('DEL', KEYS[1])");
  });

  it("the delete loses when the slot changed underneath (value-checked): the newer value survives, still a 402 for this request", async () => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
    const accept = await xrplAccept();
    llsRpc();
    const orig = store.casDelete.bind(store);
    let swapped = "";
    store.casDelete = async (k: string, e: string) => {
      swapped = `settled@${Date.now()}`;
      (store as unknown as { m: Map<string, { state: string; until: number }> }).m.set(k, { state: swapped, until: Date.now() + 60_000 });
      return orig(k, e);
    };
    const r = await handler()(paid(xrplPayload(accept)));
    expect(r.status).toBe(402);
    expect(slotRaw()).toBe(swapped);
  });
});

describe("Delta 5 (Odin 12:17): F1(b) master-key re-sign also needs the master key ENABLED (validated account_info, fail closed)", () => {
  beforeEach(() => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
  });
  afterEach(() => __setXrplMasterCheckDeadlineForTests(null));
  async function stuckLanded(S: number, master: MasterMode) {
    const accept = await xrplAccept();
    const b1 = signedPayload(accept, { Sequence: S });
    const st = { landed: new Set<string>(), validated: 999_000, account: walletA.classicAddress, master };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    st.landed.add(hashOf(b1));
    const b2 = signedPayload(accept, { Sequence: S, LastLedgerSequence: 1_000_050, Fee: "15" });
    rpc.lookups.length = 0;
    rpc.ranges.length = 0;
    rpc.accountInfo.length = 0;
    return { accept, b1, b2, st, rpc };
  }

  it("master key enabled → the re-signer gets the ORIGINAL's delivery after exactly ONE account_info (validated) for the Account", async () => {
    const { b1, b2, rpc } = await stuckLanded(79_001, "enabled");
    const r = await handler()(paid(b2));
    expect(r.status).toBe(200);
    expect(JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString())).toMatchObject({ transaction: hashOf(b1) });
    expect(rpc.accountInfo).toEqual([walletA.classicAddress]);
  });

  for (const [mode, label] of [
    ["disabled", "lsfDisableMaster set"],
    ["rpc_error", "account_info answers an rpc error"],
    ["throws", "account_info read fails (network)"],
    ["timeout", "account_info read times out"],
    ["not_validated", "account_info answer not validated"],
  ] as const) {
    it(`${label} → bare 502, slot UNTOUCHED, no lease, no tx lookup, handler not run (fail closed); the exact blob still redeems`, async () => {
      if (mode === "timeout") __setXrplMasterCheckDeadlineForTests(25);
      const { b1, b2, st, rpc } = await stuckLanded(79_100 + mode.length, mode);
      const before = slotRaw();
      const ranBefore = ran;
      const t0 = Date.now();
      const r = await handler()(paid(b2));
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: "settlement_unconfirmed" }); // bare
      expect(r.headers.get("payment-response")).toBeNull();
      expect(r.headers.get("payment-required")).toBeNull();
      expect(slotRaw()).toBe(before);
      expect(rpc.accountInfo).toEqual([walletA.classicAddress]);
      expect(rpc.lookups).toEqual([]);
      expect(rpc.ranges).toEqual([]);
      expect(ran).toBe(ranBefore);
      expect(settleCalls).toBe(1);
      if (mode === "timeout") expect(Date.now() - t0).toBeLessThan(2_000);
      // F1(a): the exact blob makes NO account_info call and redeems.
      st.master = "throws";
      rpc.accountInfo.length = 0;
      expect((await handler()(paid(b1))).status).toBe(200);
      expect(rpc.accountInfo).toEqual([]);
    });
  }

  it("F1(a) exact-hash retry makes NO account_info call (even with account_info broken)", async () => {
    const { b1, rpc } = await stuckLanded(79_200, "throws");
    expect((await handler()(paid(b1))).status).toBe(200);
    expect(rpc.accountInfo).toEqual([]);
  });

  it("the read happens only after the signature check: an unsigned retry gets 502 without any account_info", async () => {
    const { accept, rpc } = await stuckLanded(79_300, "enabled");
    const bad = signedPayload(accept, { Sequence: 79_300, LastLedgerSequence: 1_000_050 }, "unsigned");
    expect((await handler()(paid(bad))).status).toBe(502);
    expect(rpc.accountInfo).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Odin 12:28 PM ET: (1) F1 bare 502 body; (2) replay-store self-test inside the first-use EVAL probe
// ---------------------------------------------------------------------------

describe("(1) F1 rejections answer the BARE 502 body", () => {
  beforeEach(() => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
  });
  it("undecodable retry blob (same slot) → bare 502, slot untouched, nothing looked up", async () => {
    const { xrplMasterKeySigned } = await import("@/lib/xrpl-rail");
    const accept = await xrplAccept();
    const S = 80_001;
    const b1 = signedPayload(accept, { Sequence: S });
    const st = { landed: new Set<string>(), validated: 999_000, account: walletA.classicAddress };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paid(b1))).status).toBe(504);
    const before = slotRaw();
    rpc.lookups.length = 0;
    // A blob that locates the same slot but carries a TxnSignature the signature check cannot parse.
    const d = decodeTx(signedPayload(accept, { Sequence: S, Fee: "15" }));
    d.SigningPubKey = "ED" + "00".repeat(32); // well-formed length, not a valid key for this Account
    const odd = xrplPayload(accept, {}, {}, encodeBlob(d as never));
    expect((await xrplMasterKeySigned(String((odd.payload as { signedTxBlob: string }).signedTxBlob))).ok).toBe(false);
    const r = await handler()(paid(odd));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "settlement_unconfirmed" });
    expect(slotRaw()).toBe(before);
    expect(rpc.lookups).toEqual([]);
  });
  it("the forged unsigned retry (H1 regression) also gets the bare body; the genuine blob's redeemable 504 keeps retry:same_payment", async () => {
    const accept = await xrplAccept();
    const S = 80_002;
    const b1 = xrplPayload(accept, { Sequence: S });
    slotRpc(accept, { landed: new Set<string>(), validated: 950_000 });
    const r0 = await handler()(paid(b1));
    expect(r0.status).toBe(504);
    expect(await r0.json()).toEqual(SETTLEMENT_UNCONFIRMED_BODY);
    const r = await handler()(paid(xrplPayload(accept, { Sequence: S, LastLedgerSequence: 900_000 })));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "settlement_unconfirmed" });
  });
});

describe("(2) replay-store self-test inside the first-use EVAL probe (fail closed)", () => {
  const evalAlerts = () => alerts.filter((a) => a.kind === "xrpl_replay_eval_unavailable");
  const xrplIn402 = async () => {
    const res = await handler()(unpaid());
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.accepts.some((a) => a.network.startsWith("eip155:"))).toBe(true);
    return pr.accepts.some((a) => a.network === "xrpl:0");
  };
  const selftestCmds = (sent: UpCmd[]) => sent.filter((a) => a.some((x) => x.startsWith("hp:xrpl:selftest:")));
  beforeEach(() => {
    installXrplRpc("ready", () => ({ status: "error", error: "txnNotFound" }));
  });
  afterEach(() => vi.useRealTimers());

  it("all steps pass: EVAL, SET (random value, 60 s TTL) → wrong-value CAS_DELETE keeps it → right-value CAS_DELETE removes it; only random hex, no request input; key gone", async () => {
    const up = fakeUpstash();
    await new UpstashReplayStore("https://x.upstash.io", "t", up.fetchFn).probeEval();
    expect(up.sent).toHaveLength(6);
    const [e, set, wrongDel, get1, rightDel, get2] = up.sent;
    expect(e).toEqual(["EVAL", EVAL_PROBE_SCRIPT, "0"]);
    const key = set[1];
    const value = set[2];
    expect(key).toMatch(/^hp:xrpl:selftest:replay-eval:[0-9a-f]{32}$/);
    expect(key.startsWith(SELFTEST_KEY_PREFIX)).toBe(true);
    expect(key.startsWith("hp:xrpl:replay:")).toBe(false); // never inside the replay keyspace
    expect(key.startsWith("hp:xrpl:")).toBe(true); // Odin 12:51: covered by a restricted token's hp:xrpl:* key pattern
    expect(SELFTEST_KEY_PREFIX).toBe("hp:xrpl:selftest:replay-eval:");
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(set).toEqual(["SET", key, value, "PX", "60000"]);
    expect(wrongDel).toEqual(["EVAL", CAS_DELETE_SCRIPT, "1", key, `${value}:wrong`]);
    expect(get1).toEqual(["GET", key]);
    expect(rightDel).toEqual(["EVAL", CAS_DELETE_SCRIPT, "1", key, value]);
    expect(get2).toEqual(["GET", key]);
    expect(up.data.size).toBe(0);
    // A second probe uses a fresh random key and value.
    await new UpstashReplayStore("https://x.upstash.io", "t", up.fetchFn).probeEval();
    expect(up.sent[7][1]).not.toBe(key);
    expect(up.sent[7][2]).not.toBe(value);
  });

  it("all pass via the rail → status ok, XRPL in the 402, no ALERT; the self-test commands carry no request data", async () => {
    const up = fakeUpstash();
    setXrplReplayStoreForTests(new UpstashReplayStore("https://x.upstash.io", "t", up.fetchFn));
    expect(await xrplIn402()).toBe(true);
    expect(await xrplReplayEvalStatus()).toBe("ok");
    expect(evalAlerts()).toEqual([]);
    const accept = await xrplAccept();
    const p = xrplPayload(accept);
    const blob = String((p.payload as { signedTxBlob: string }).signedTxBlob);
    for (const a of selftestCmds(up.sent)) {
      for (const x of a) {
        expect(x.includes(XRPL_PAYER) || x.includes(accept.payTo) || x.includes(blob.slice(0, 40)) || x.includes(hashOf(p))).toBe(false);
        expect(x === "SET" || x === "GET" || x === "EVAL" || x === "PX" || x === "60000" || x === "1" || x === CAS_DELETE_SCRIPT || /^[0-9a-f]{32}(:wrong)?$/.test(x) || /^hp:xrpl:selftest:replay-eval:[0-9a-f]{32}$/.test(x)).toBe(true);
      }
    }
  });

  const isEval = (a: UpCmd) => a[0] === "EVAL" && a[1] === EVAL_PROBE_SCRIPT;
  const isSet = (a: UpCmd) => a[0] === "SET" && a[1].startsWith("hp:xrpl:selftest:");
  const isWrongDel = (a: UpCmd) => a[0] === "EVAL" && a[1] === CAS_DELETE_SCRIPT && a[3].startsWith("hp:xrpl:selftest:") && a[4].endsWith(":wrong");
  const isRightDel = (a: UpCmd) => a[0] === "EVAL" && a[1] === CAS_DELETE_SCRIPT && a[3].startsWith("hp:xrpl:selftest:") && !a[4].endsWith(":wrong");
  const ok = (result: unknown) => ({ status: 200, body: { result } });
  let gets = 0;
  const cases: [string, string, (a: UpCmd, data: Map<string, string>) => { status: number; body: unknown } | undefined][] = [
    ["EVAL answers 0", "eval_result", (a) => (isEval(a) ? ok(0) : undefined)],
    ["EVAL errors", "Error", (a) => (isEval(a) ? { status: 200, body: { error: "ERR unknown command 'EVAL'" } } : undefined)],
    ["SET not OK", "selftest_set", (a) => (isSet(a) ? ok(null) : undefined)],
    ["SET HTTP failure", "Error", (a) => (isSet(a) ? { status: 500, body: {} } : undefined)],
    ["wrong-value CAS_DELETE deletes (answers 1)", "selftest_wrong_value_deleted", (a, d) => (isWrongDel(a) ? (d.delete(a[3]), ok(1)) : undefined)],
    ["wrong-value CAS_DELETE answers junk", "selftest_wrong_value_deleted", (a) => (isWrongDel(a) ? ok("x") : undefined)],
    ["value changed after the wrong-value delete", "selftest_value_changed", (a) => (a[0] === "GET" && a[1].startsWith("hp:xrpl:selftest:") && ++gets === 1 ? ok("other") : undefined)],
    ["right-value CAS_DELETE does not delete", "selftest_delete_failed", (a) => (isRightDel(a) ? ok(0) : undefined)],
    ["key still there after the right-value delete", "selftest_not_deleted", (a, d) => (isRightDel(a) ? ok(1) : undefined)],
    ["GET errors", "Error", (a) => (a[0] === "GET" && a[1].startsWith("hp:xrpl:selftest:") ? { status: 200, body: { error: "ERR" } } : undefined)],
  ];
  for (const [label, reason, fault] of cases) {
    it(`${label} → unavailable, fail closed (XRPL off the 402, XRPL payment → Base-only 402 rail_unavailable, nothing claimed), HIGH ALERT once, reason ${reason}`, async () => {
      gets = 0;
      const data = new Map<string, string>();
      const up = fakeUpstash((a) => fault(a, data), data);
      const s = new UpstashReplayStore("https://x.upstash.io", "t", up.fetchFn);
      const accept = await xrplAccept(); // the entry a buyer saw before the probe ran (default store)
      setXrplReplayStoreForTests(s);
      expect(await xrplIn402()).toBe(false);
      expect(await xrplIn402()).toBe(false);
      expect(await xrplReplayEvalStatus()).toBe("unavailable");
      expect(evalAlerts()).toEqual([{ kind: "xrpl_replay_eval_unavailable", severity: "high", reason }]);
      const probesSent = up.sent.filter(isEval).length;
      expect(probesSent).toBe(1); // failure cached, single probe
      const res = await handler()(paid(xrplPayload(accept)));
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(pr.error).toBe("rail_unavailable");
      expect(pr.accepts.some((a) => a.network === "xrpl:0")).toBe(false);
      expect(settleCalls).toBe(0);
      expect(ran).toBe(0);
      expect(up.sent.some((a) => a.some((x) => x.startsWith("hp:xrpl:replay:")))).toBe(false); // never claimed
      if (reason.startsWith("selftest_")) await expect(new UpstashReplayStore("https://x.upstash.io", "t", fakeUpstash((a) => (gets = 0, fault(a, data)), data).fetchFn).probeEval()).rejects.toBeInstanceOf(ReplaySelfTestError);
    });
  }

  it("the whole probe is bounded: a hung self-test → unavailable after XRPL_EVAL_PROBE_DEADLINE_MS (3 s), reason timeout, fail closed", async () => {
    expect(XRPL_EVAL_PROBE_DEADLINE_MS).toBe(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setXrplReplayStoreForTests({ ...new MemoryReplayStore(), kind: "upstash", claim: async () => null, set: async () => {}, release: async () => {}, probeEval: () => new Promise<void>(() => {}) } as never);
    const p = xrplReplayEvalOk();
    await vi.advanceTimersByTimeAsync(XRPL_EVAL_PROBE_DEADLINE_MS - 10);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await p).toBe(false);
    expect(evalAlerts()).toEqual([{ kind: "xrpl_replay_eval_unavailable", severity: "high", reason: "timeout" }]);
  });

  it("concurrent instances sharing ONE Upstash: interleaved probes never break each other (own random key + CAS on own value)", async () => {
    const data = new Map<string, string>();
    // Interleave: every command waits a tick so the two probes alternate on the shared data.
    const base = fakeUpstash(undefined, data);
    const slow = (async (u: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      return base.fetchFn(u, init);
    }) as unknown as typeof fetch;
    const a = new UpstashReplayStore("https://x.upstash.io", "t", slow);
    const b = new UpstashReplayStore("https://x.upstash.io", "t", slow);
    await expect(Promise.all([a.probeEval(), b.probeEval(), a.probeEval(), b.probeEval()])).resolves.toBeDefined();
    const keys = new Set(base.sent.filter((x) => x[0] === "SET").map((x) => x[1]));
    expect(keys.size).toBe(4); // each probe its own key
    expect(data.size).toBe(0);
  });
});

// ===========================================================================
// Odin 5:40 PM ET hotfix (Sentinel shared-claim-v3 F1, applied to XRPL): redeem is bound to the paying REQUEST.
// The stored blob / hash is public once validated, so a chain watcher could rebuild the payload and redeem the
// victim's undelivered payment on its OWN request. Now the first use stores a request fingerprint in the slot.
// ===========================================================================
describe("hotfix: XRPL redeem-on-retry requires the paying request's fingerprint", () => {
  const paidAt = (url: string, p: PaymentPayload, init: { method?: string; body?: string } = {}) =>
    new NextRequest(url, { method: init.method ?? "GET", body: init.body, headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });
  beforeEach(() => {
    settleImpl = async () => {
      throw new Error("ws closed");
    };
  });
  /** Victim's first request (at `url`) settles ambiguously → 504, slot undelivered; then its tx is on the ledger. */
  async function victimStuck(S: number, url: string) {
    const accept = await xrplAccept();
    const b1 = signedPayload(accept, { Sequence: S });
    const st = { landed: new Set<string>(), validated: 999_000, account: walletA.classicAddress };
    const rpc = slotRpc(accept, st);
    expect((await handler()(paidAt(url, b1))).status).toBe(504);
    expect(slotRaw()).toMatch(new RegExp(`^settle_unconfirmed@\\d+#${hashOf(b1)}:1000000~${await requestFingerprint(paidAt(url, b1))}$`));
    st.landed.add(hashOf(b1)); // the tx is now validated on the ledger: its blob is PUBLIC
    return { accept, b1, st, rpc };
  }

  it("SENTINEL HIJACK: a watcher replays the public blob on its OWN request → 409, HIGH alert, reconcile line, nothing run or looked up, slot untouched; the victim's retry then delivers once", async () => {
    const { b1, rpc } = await victimStuck(79_001, "https://horizonpulse.dev/api/pulse?q=victim");
    const before = slotRaw();
    rpc.lookups.length = 0;
    const ranBefore = ran;
    const urls: string[] = [];
    const spy = createX402GetHandler(
      async (r) => {
        urls.push(r.url);
        return NextResponse.json({ ok: true, paid: "body" });
      },
      pulseRouteConfig(),
      pulseOpts,
    );
    const atk = await spy(paidAt("https://horizonpulse.dev/api/pulse?who=attacker", b1));
    expect(atk.status).toBe(409);
    expect(await atk.json()).toEqual({ error: "duplicate_payment" });
    expect(atk.headers.get("payment-response")).toBeNull();
    expect(urls).toEqual([]); // the attacker's request never reaches the route
    expect(ran).toBe(ranBefore);
    expect(rpc.lookups).toEqual([]);
    expect(slotRaw()).toBe(before);
    expect(alerts).toContainEqual({ kind: "xrpl_redeem_fingerprint_mismatch", severity: "high" });
    expect(reconcile()).toContainEqual(expect.objectContaining({ status: 409, reason: "redeem_fingerprint_mismatch", txHash: hashOf(b1), slot: "redeem" }));
    // The victim's honest retry (same request) still redeems, once.
    await expectDelivered(await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=victim", b1)));
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=victim", b1))).status).toBe(409);
  });

  it("hijack with NO query on either side but another method/path is refused too (route + method are bound)", async () => {
    const { b1 } = await victimStuck(79_002, "https://horizonpulse.dev/api/pulse?q=v2");
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse", b1))).status).toBe(409); // query dropped
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=v2&x=1", b1))).status).toBe(409); // param added
    // delta1 C1: same slot → ONE HIGH alert, but a reconcile line per mismatching request.
    expect(alerts.filter((a) => a.kind === "xrpl_redeem_fingerprint_mismatch")).toHaveLength(1);
    expect(reconcile().filter((l) => l.reason === "redeem_fingerprint_mismatch")).toHaveLength(2);
  });

  it("delta1 C1: N mismatches on one slot → 1 HIGH alert + N reconcile lines; no re-alert inside 15 min; alerts again after the cooldown; another slot alerts on its own", async () => {
    const { accept, b1, st } = await victimStuck(79_010, "https://horizonpulse.dev/api/pulse?q=c1");
    const fpAlerts = () => alerts.filter((a) => a.kind === "xrpl_redeem_fingerprint_mismatch").length;
    const lines = () => reconcile().filter((l) => l.reason === "redeem_fingerprint_mismatch" && l.txHash === hashOf(b1)).length;
    const N = 5;
    for (let i = 0; i < N; i++) expect((await handler()(paidAt(`https://horizonpulse.dev/api/pulse?q=atk${i}`, b1))).status).toBe(409);
    expect(fpAlerts()).toBe(1);
    expect(lines()).toBe(N);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(t0 + XRPL_FP_ALERT_COOLDOWN_MS - 1_000); // still inside the cooldown
      expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=late", b1))).status).toBe(409);
      expect(fpAlerts()).toBe(1);
      expect(lines()).toBe(N + 1);
      now.mockReturnValue(t0 + XRPL_FP_ALERT_COOLDOWN_MS + 1_000); // cooldown over → alerts again (once)
      expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=after", b1))).status).toBe(409);
      expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=after2", b1))).status).toBe(409);
      expect(fpAlerts()).toBe(2);
      expect(lines()).toBe(N + 3);
    } finally {
      now.mockRestore();
    }
    // A different slot (another payment) has its own once-per-slot alert.
    const b2 = signedPayload(accept, { Sequence: 79_011 });
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=c1b", b2))).status).toBe(504);
    st.landed.add(hashOf(b2));
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=x", b2))).status).toBe(409);
    expect(fpAlerts()).toBe(3);
    // The victim's own retry is unaffected by the dedupe.
    await expectDelivered(await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=c1", b1)));
  });

  it("delta1 L1: a master-key re-sign on ANOTHER request is refused 409 with ZERO account_info calls (fingerprint checked first)", async () => {
    const { accept, rpc } = await victimStuck(79_012, "https://horizonpulse.dev/api/pulse?q=l1");
    const resigned = signedPayload(accept, { Sequence: 79_012, LastLedgerSequence: 1_000_050, Fee: "15" }, "master");
    rpc.accountInfo.length = 0;
    rpc.lookups.length = 0;
    const before = slotRaw();
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=other", resigned))).status).toBe(409);
    expect(rpc.accountInfo).toEqual([]);
    expect(rpc.lookups).toEqual([]);
    expect(slotRaw()).toBe(before);
    // On the paying request the master key is still checked (exactly one account_info), then delivered.
    await expectDelivered(await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=l1", resigned)));
    expect(rpc.accountInfo).toEqual([walletA.classicAddress]);
  });

  it("sort (Odin 6:08, stable by key only): reordered VALUES of a repeated key are a different request → 409; reordered distinct keys still redeem", async () => {
    const { b1 } = await victimStuck(79_013, "https://horizonpulse.dev/api/pulse?t=b&q=1&t=a");
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?t=a&t=b&q=1", b1))).status).toBe(409);
    expect(alerts.filter((a) => a.kind === "xrpl_redeem_fingerprint_mismatch")).toHaveLength(1);
    await expectDelivered(await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=1&t=b&t=a", b1)));
  });

  it("legitimate same-request retry: query order / percent-encoding differences normalize away → delivered once", async () => {
    const { b1 } = await victimStuck(79_003, "https://horizonpulse.dev/api/pulse?b=2&a=hello%20world");
    await expectDelivered(await handler()(paidAt("https://horizonpulse.dev/api/pulse?a=hello+world&b=2", b1)));
    expect(alerts.some((a) => a.kind === "xrpl_redeem_fingerprint_mismatch")).toBe(false);
  });

  it("F1(b) master-key re-sign by the payer is ALSO bound: on the paying request → delivered; on another request → 409", async () => {
    const { accept, b1, st } = await victimStuck(79_004, "https://horizonpulse.dev/api/pulse?q=resign");
    st.validated = 999_500;
    const resigned = signedPayload(accept, { Sequence: 79_004, LastLedgerSequence: 1_000_050, Fee: "15" }, "master");
    expect(hashOf(resigned)).not.toBe(hashOf(b1));
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=other", resigned))).status).toBe(409);
    await expectDelivered(await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=resign", resigned)));
  });

  it("LEGACY slot (written by the current prod code: no fingerprint) → never auto-redeemed: bare 502, reconcile line, slot untouched, nothing run or looked up, no alert", async () => {
    const { b1, rpc } = await victimStuck(79_005, "https://horizonpulse.dev/api/pulse");
    const m = (store as unknown as { m: Map<string, { state: string; until: number }> }).m;
    const [k, e] = [...m.entries()][0];
    const legacy = e.state.replace(/~[0-9a-f]{64}$/, ""); // exactly what 39bf241 writes: settle_unconfirmed@firstSeen#HASH:LLS
    expect(parseReplayValue(legacy)).toMatchObject({ state: "settle_unconfirmed", hash: hashOf(b1), lls: 1_000_000 });
    m.set(k, { ...e, state: legacy });
    rpc.lookups.length = 0;
    const ranBefore = ran;
    const r = await handler()(paid(b1)); // even the genuine same request
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "settlement_unconfirmed" });
    expect(m.get(k)!.state).toBe(legacy);
    expect(rpc.lookups).toEqual([]);
    expect(ran).toBe(ranBefore);
    expect(reconcile()).toContainEqual(expect.objectContaining({ status: 502, reason: "redeem_legacy_no_fingerprint", txHash: hashOf(b1) }));
    expect(alerts.some((a) => a.kind === "xrpl_redeem_fingerprint_mismatch")).toBe(false);
    // A legacy STALE in_flight claim (dead request) is not taken over either.
    m.set(k, { ...e, state: encodeReplayValue({ state: "in_flight", firstSeen: Date.now() - XRPL_IN_FLIGHT_STALE_MS - 1_000, hash: hashOf(b1), lls: 1_000_000 }) });
    expect((await handler()(paid(b1))).status).toBe(502);
    expect(parseReplayValue(m.get(k)!.state)!.state).toBe("in_flight");
  });

  it("every slot write keeps the fingerprint: claim, undelivered, redeeming lease, delivered mark", async () => {
    const { b1 } = await victimStuck(79_006, "https://horizonpulse.dev/api/pulse?q=keep");
    const rq = await requestFingerprint(paidAt("https://horizonpulse.dev/api/pulse?q=keep", b1));
    await expectDelivered(await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=keep", b1)));
    expect(parseReplayValue(slotRaw())).toMatchObject({ state: "settled", rq });
  });

  it("unit: requestFingerprint binds method, path, sorted query and body; headers do not matter", async () => {
    const f = (u: string, i: RequestInit = {}) => requestFingerprint(new Request(u, i));
    const base = await f("https://h.dev/api/x?a=1&b=2");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await f("https://h.dev/api/x?b=2&a=1")).toBe(base);
    // Odin 6:08: STABLE sort by key only. Reordered distinct keys match; reordered values of a repeated key do NOT.
    const dup = await f("https://h.dev/api/x?a=2&b=1&a=1");
    expect(await f("https://h.dev/api/x?b=1&a=2&a=1")).toBe(dup); // distinct keys moved, a's values in the same order
    expect(await f("https://h.dev/api/x?a=2&a=1&b=1")).toBe(dup);
    expect(await f("https://h.dev/api/x?a=1&a=2&b=1")).not.toBe(dup); // a's values reordered
    expect(await f("https://h.dev/api/x?b=1&a=1&a=2")).not.toBe(dup);
    expect(await f("https://h.dev/api/x?a=1&a=3&b=1")).not.toBe(dup);
    expect(await f("https://h.dev/api/x?a=1&b=1")).not.toBe(dup);
    expect(normalizeQuery("?t=b&q=1&t=a")).toBe("q=1&t=b&t=a");
    expect(await f("https://h.dev/api/x?b=2&a=1", { headers: { "x-anything": "1", "payment-signature": "zz" } })).toBe(base);
    expect(await f("https://other.host/api/x?a=1&b=2")).toBe(base); // host is not bound (same deployment, any alias)
    expect(await f("https://h.dev/api/X?a=1&b=2")).not.toBe(base);
    expect(await f("https://h.dev/api/x?a=1&b=3")).not.toBe(base);
    expect(await f("https://h.dev/api/x?a=1&b=2&free=1")).not.toBe(base); // no parameter is excluded
    expect(await f("https://h.dev/api/x?a=1&b=2", { method: "HEAD" })).not.toBe(base);
    const p1 = await f("https://h.dev/api/x?a=1&b=2", { method: "POST", body: '{"u":1}' });
    expect(p1).not.toBe(base);
    expect(await f("https://h.dev/api/x?a=1&b=2", { method: "POST", body: '{"u":1}' })).toBe(p1);
    expect(await f("https://h.dev/api/x?a=1&b=2", { method: "POST", body: '{"u":2}' })).not.toBe(p1);
    const req = new Request("https://h.dev/api/x", { method: "POST", body: "keep" });
    await requestFingerprint(req);
    expect(await req.text()).toBe("keep"); // the route still gets the original body
  });
});
