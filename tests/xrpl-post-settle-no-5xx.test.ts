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
  XRPL_REDEEM_LEASE_MS,
  __setXrplAfterDeliveryMarkHookForTests,
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
let settleCalls = 0;
const okSettle: SchemeSettle = async () => ({ success: true, transaction: XRPL_TX_HASH, network: "xrpl:0", payer: XRPL_PAYER });

let store: MemoryReplayStore;
function freshInstance() {
  resetXrplRailForTests();
  resetSolanaRailForTests();
  store = new MemoryReplayStore();
  setXrplReplayStoreForTests({
    kind: "upstash",
    claim: (k, t) => store.claim(k, t),
    set: (k, s, t) => store.set(k, s, t),
    release: (k) => store.release(k),
    get: (k) => store.get(k),
    cas: (k, e, n, t) => store.cas(k, e, n, t),
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
    ["validated tesSUCCESS, delivered amount differs", (a: PaymentRequirements) => ledgerTx(a, { value: "0.001" }), "self_check_delivered_amount_mismatch", "amount"],
    ["validated tesSUCCESS, delivered issuer differs", (a: PaymentRequirements) => ({ ...ledgerTx(a), meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: XRPL_PAYER, value: a.amount } } }), "self_check_delivered_issuer_mismatch", "issuer"],
    ["validated tesSUCCESS, destination differs", (a: PaymentRequirements) => ({ ...ledgerTx(a), tx_json: { TransactionType: "Payment", Account: XRPL_PAYER, Destination: XRPL_PAYER } }), "self_check_destination_mismatch", "destination"],
  ] as const) {
    it(`${name} → 200 paid response + ALERT xrpl_settled_unverified + XRPL_RECONCILE status 200 (was 502)`, async () => {
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
    expect(raw[0]).toMatch(/^settle_unconfirmed@\d+$/); // undelivered + firstSeen (timestamp only, no payer data)
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
    expect(await r2.json()).toEqual({ error: "settlement_unconfirmed" });
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
    expect(await r1.json()).toEqual({ error: "settlement_unconfirmed" });
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
    const first = Number(e.state.split("@")[1]);
    m.set(k, { ...e, state: `redeeming@${first}@${Date.now()}` });
    installXrplRpc("ready", () => ledgerTx(accept));
    expect((await handler()(paid(p))).status).toBe(503);
    m.set(k, { ...e, state: `redeeming@${first}@${Date.now() - XRPL_REDEEM_LEASE_MS - 1}` });
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
