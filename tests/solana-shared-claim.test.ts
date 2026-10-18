/**
 * Odin 12:51 PM ET (d): shared Upstash claim for Solana, modeled on the XRPL replay store. Atomic cross-instance claim
 * (SET NX) BEFORE verify; delivered tracking (settled = delivered, settle_unconfirmed@firstSeen = not delivered);
 * release when nothing was charged; fail closed on store errors and on a failing EVAL / self-test probe.
 * "Instances" are simulated by resetting the module's per-instance state while keeping the same shared store.
 * Offline: a fake Upstash REST double, stubbed facilitators / RPC; no network, no keys, no money.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { FacilitatorTimeoutError } from "@x402/core/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  SOLANA_FP_ALERT_COOLDOWN_MS,
  SOLANA_STORE_CALLS_PAID_PATH,
  SOLANA_STORE_CALLS_REDEEM_PATH,
  SOLANA_REDEEM_LEASE_MS,
  SOLANA_REPLAY_PREFIX,
  __initSolanaSharedStoreFromEnvForTests,
  __setSolanaLedgerCheckDelaysForTests,
  solanaReplayEvalStatus,
  SOLANA_SELFTEST_KEY_PREFIX,
  __flushSolanaBackgroundForTests,
  __setSolanaRpcForTests,
  resetSolanaRailForTests,
  setSolanaAlertHook,
  setSolanaSharedStoreForTests,
  solanaPaymentKey,
  solanaSharedStoreKind,
  type SolanaAlert,
} from "@/lib/solana-rail";
import { CAS_DELETE_SCRIPT, CAS_SCRIPT, EVAL_PROBE_SCRIPT, UpstashReplayStore } from "@/lib/xrpl-replay-store";
import { SOLANA_MAINNET_CAIP2, SOLANA_PAYTO, USDC_SOLANA_MINT, base58Decode, base58Encode } from "@/lib/solana-config";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { requestFingerprint } from "@/lib/request-fingerprint";
import { DEFAULT_START_SLOT, PAYAI_FEE_PAYER_BYTES, SOL_PAYER, installBothFacilitators, installRpc, parseableSolanaTx, stubSolanaOn } from "./helpers/solana-env";

type UpCmd = string[];
function fakeUpstash(override?: (args: UpCmd) => { status: number; body: unknown } | undefined) {
  const data = new Map<string, string>();
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
    }
    return { __error: true };
  };
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const args = JSON.parse(String(init.body)) as UpCmd;
    sent.push(args);
    const o = override?.(args);
    if (o) return new Response(JSON.stringify(o.body), { status: o.status });
    const r = run(args);
    if (r && typeof r === "object") return new Response(JSON.stringify({ error: "ERR" }), { status: 200 });
    return new Response(JSON.stringify({ result: r }), { status: 200 });
  }) as unknown as typeof fetch;
  const store = new UpstashReplayStore("https://fake.upstash.io", "t", fetchFn, 1500, SOLANA_REPLAY_PREFIX, SOLANA_SELFTEST_KEY_PREFIX);
  return { store, sent, data };
}

/** v4 F1: every paid request below is GET https://horizonpulse.dev/api/pulse (no query, no body) → one fingerprint. */
let RQ = "";
beforeAll(async () => {
  RQ = await requestFingerprint(new Request("https://horizonpulse.dev/api/pulse"));
});
let txSeq = 1;
// delta4-6 on main: a parseable 2-signer tx (fee-payer slot unsigned, buyer signed) whose key 0 is PayAI's fee payer.
const freshTx = () => parseableSolanaTx(txSeq++ % 250);
const SOL_SIG = "5".repeat(87);
let ran = 0;
let facCalls: string[] = [];
let settle: () => unknown;
let verifyOk = true;
const handler = () =>
  createX402GetHandler(
    async () => {
      ran++;
      return NextResponse.json({ ok: true });
    },
    pulseRouteConfig(),
    pulseOpts,
  );
async function accepts(): Promise<PaymentRequirements[]> {
  const res = await handler()(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
}
const solPayload = (accept: PaymentRequirements, tx = freshTx()) => ({ x402Version: 2, accepted: accept, payload: { transaction: tx } }) as PaymentPayload;
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });
const slotKey = async (p: PaymentPayload) => SOLANA_REPLAY_PREFIX + (await solanaPaymentKey(String((p.payload as { transaction: string }).transaction)));
let alerts: SolanaAlert[] = [];
/** A fresh "instance": per-instance state reset, the SAME shared store re-attached. */
function newInstance(store: UpstashReplayStore) {
  resetSolanaRailForTests();
  setSolanaSharedStoreForTests(store);
  setSolanaAlertHook((a) => alerts.push(a));
  stubSolanaOn();
  installBothFacilitators({
    verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true } : (facCalls.push("verify"), verifyOk ? { isValid: true, payer: SOL_PAYER } : { isValid: false, invalidReason: "invalid_payload" })),
    settle: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { success: true } : (facCalls.push("settle"), settle())),
  } as never);
}

beforeEach(() => {
  for (const c of ["warn", "error", "log", "info"] as const) vi.spyOn(console, c).mockImplementation(() => {});
  ran = 0;
  facCalls = [];
  alerts = [];
  verifyOk = true;
  settle = () => ({ success: true, transaction: SOL_SIG, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
});
afterEach(async () => {
  await __flushSolanaBackgroundForTests();
  __setSolanaLedgerCheckDelaysForTests(null);
  setSolanaSharedStoreForTests(null);
  __setSolanaRpcForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Solana shared claim (Odin 12:51 (d))", () => {
  it("no shared store configured → 'none' (v4 F2: and Solana then fails closed, see the v4 block)", () => {
    resetSolanaRailForTests();
    expect(solanaSharedStoreKind()).toBe("none");
  });

  it("delivered on instance A → the same payment on instance B is refused BEFORE PayAI (409), slot = settled", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(await slotKey(p))).toBe(`settled~${RQ}`);
    expect(facCalls).toEqual(["verify", "settle"]);

    newInstance(up.store); // instance B: empty local map
    const res = await handler()(paid(p));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('{"error":"duplicate_payment"}');
    expect(facCalls).toEqual(["verify", "settle"]); // B never reached PayAI
    expect(ran).toBe(1);
  });

  it("claim is atomic SET NX with in_flight@firstSeen under hp:solana:replay:, BEFORE verify", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    let atVerify: string | undefined;
    const k = await slotKey(p);
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true } : ((atVerify = up.data.get(k)), { isValid: true, payer: SOL_PAYER })),
      settle: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { success: true } : settle()),
    } as never);
    expect((await handler()(paid(p))).status).toBe(200);
    // Odin 1:39 (3): in_flight@<request-start SLOT>@<claim ms>; v4: !<owner> (F3) ~<request fingerprint> (F1)
    expect(atVerify).toMatch(new RegExp(`^in_flight@${DEFAULT_START_SLOT}@\\d{13}![0-9a-f]{16}~${RQ}$`));
    const claim = up.sent.find((a) => a[0] === "SET" && a[1] === k)!;
    expect(claim).toEqual(["SET", k, expect.stringMatching(new RegExp(`^in_flight@300000000@\\d{13}![0-9a-f]{16}~${RQ}$`)), "NX", "PX", String(25 * 60 * 60_000)]);
    expect(k.startsWith("hp:solana:replay:")).toBe(true);
  });

  it("slot held in_flight by another live request (concurrent) → 503 payment_in_progress + Retry-After, no verify, no settle, nothing overwritten", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    const k = await slotKey(p);
    const v = `in_flight@${DEFAULT_START_SLOT}@${Date.now()}`;
    up.data.set(k, v);
    const res = await handler()(paid(p));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"payment_in_progress"}');
    expect(res.headers.get("retry-after")).toBe("5");
    expect(facCalls).toEqual([]);
    expect(up.data.get(k)).toBe(v);
  });

  it("ambiguous settle → slot = settle_unconfirmed@startSlot (NOT delivered); a retry on another instance redeems: not on-chain yet → 502, slot back to undelivered, PayAI never re-asked", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    settle = () => {
      throw new FacilitatorTimeoutError("settle", 12_000);
    };
    expect((await handler()(paid(p))).status).toBe(504);
    expect(up.data.get(await slotKey(p))).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    expect((await handler()(paid(p))).status).toBe(502);
    expect(up.data.get(await slotKey(p))).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
    expect(facCalls.filter((x) => x === "settle")).toHaveLength(1);
    expect(facCalls.filter((x) => x === "verify")).toHaveLength(1);
  });

  it("nothing charged (verify rejected) → slot released (v4 F3: compare-and-delete against OUR claim value), so the buyer can retry on any instance", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    verifyOk = false;
    expect((await handler()(paid(p))).status).toBe(402);
    const k = await slotKey(p);
    expect(up.data.has(k)).toBe(false);
    const claimed = up.sent.find((a) => a[0] === "SET" && a[1] === k && a.includes("NX"))![2];
    expect(up.sent.some((a) => a[0] === "EVAL" && a[1] === CAS_DELETE_SCRIPT && a[3] === k && a[4] === claimed)).toBe(true);
    expect(up.sent.some((a) => a[0] === "DEL" && a[1] === k)).toBe(false); // never an unconditional DEL
    verifyOk = true;
    newInstance(up.store);
    expect((await handler()(paid(p))).status).toBe(200);
  });

  it("claim store error → fail closed: Base-only 402, no verify / settle, nothing charged", async () => {
    const up = fakeUpstash((a) => (a[0] === "SET" && a.includes("NX") ? { status: 500, body: { error: "down" } } : undefined));
    newInstance(up.store);
    const sol = (await accepts())[1];
    const res = await handler()(paid(solPayload(sol)));
    expect(res.status).toBe(402);
    expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts.map((a) => a.network)).toEqual(["eip155:8453"]);
    expect(facCalls).toEqual([]);
  });

  it("post-settle state write fails → the paid response is still served (the claim stays in_flight: never a second delivery), logged + LOW alert", async () => {
    const up = fakeUpstash((a) => (a[0] === "EVAL" && a[1] === CAS_SCRIPT && String(a[3]).startsWith("hp:solana:replay:") ? { status: 500, body: { error: "down" } } : undefined));
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(await slotKey(p))).toMatch(/^in_flight@/);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("Solana claim store settled write failed"))).toBe(true);
    expect(alerts.filter((a) => a.kind === "solana_claim_write_failed")).toEqual([{ kind: "solana_claim_write_failed", severity: "low", write: "settled", reason: "error" }]);
  });

  for (const [name, override, reason] of [
    ["EVAL unavailable", (a: UpCmd) => (a[0] === "EVAL" && a[1] === EVAL_PROBE_SCRIPT ? { status: 200, body: { error: "NOSCRIPT" } } : undefined), "Error"],
    ["self-test: the wrong-value delete removed the key", (a: UpCmd) => (a[0] === "EVAL" && a[1] === CAS_DELETE_SCRIPT && a[4]?.endsWith(":wrong") ? { status: 200, body: { result: 1 } } : undefined), "selftest_wrong_value_deleted"],
    ["self-test: SET refused (e.g. a token restricted to another key pattern)", (a: UpCmd) => (a[0] === "SET" && a[1].startsWith(SOLANA_SELFTEST_KEY_PREFIX) ? { status: 200, body: { error: "NOPERM" } } : undefined), "Error"],
  ] as const) {
    it(`probe fails (${name}) → fail closed: Solana not advertised, paid Solana → Base-only 402, ONE high alert (reason ${reason})`, async () => {
      const up = fakeUpstash(override);
      newInstance(up.store);
      const acc = await accepts();
      expect(acc.map((a) => a.network)).toEqual(["eip155:8453"]);
      const ok = fakeUpstash();
      newInstance(ok.store);
      const sol = (await accepts())[1];
      expect(sol.network).toBe(SOLANA_MAINNET_CAIP2);
      alerts = [];
      newInstance(up.store);
      const res = await handler()(paid(solPayload(sol)));
      expect(res.status).toBe(402);
      expect(facCalls).toEqual([]);
      expect(alerts.filter((a) => a.kind === "solana_replay_eval_unavailable")).toEqual([{ kind: "solana_replay_eval_unavailable", severity: "high", reason }]);
      await accepts(); // cached failure: no second alert in the same episode
      expect(alerts.filter((a) => a.kind === "solana_replay_eval_unavailable")).toHaveLength(1);
    });
  }

  it("probe keeps failing after the 60 s recheck → still ONE alert for the episode; recovery then a new failure → a second alert", async () => {
    let failing = true;
    const up = fakeUpstash((a) => (failing && a[0] === "EVAL" && a[1] === EVAL_PROBE_SCRIPT ? { status: 200, body: { error: "NOSCRIPT" } } : undefined));
    newInstance(up.store);
    const real = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    const evalAlerts = () => alerts.filter((a) => a.kind === "solana_replay_eval_unavailable").length;
    expect((await accepts()).map((a) => a.network)).toEqual(["eip155:8453"]);
    offset += 61_000;
    expect((await accepts()).map((a) => a.network)).toEqual(["eip155:8453"]); // re-probed, still failing
    expect(up.sent.filter((a) => a[0] === "EVAL" && a[1] === EVAL_PROBE_SCRIPT)).toHaveLength(2);
    expect(evalAlerts()).toBe(1);
    failing = false;
    offset += 61_000;
    expect((await accepts())[1].network).toBe(SOLANA_MAINNET_CAIP2); // recovered
    failing = true;
    offset += 11 * 60_000;
    await accepts();
    expect(evalAlerts()).toBe(2); // new episode
  });

  it("probe passes: EVAL then the self-test on a random hp:solana:selftest: key (60 s TTL), cleaned up", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    expect((await accepts())[1].network).toBe(SOLANA_MAINNET_CAIP2);
    const set = up.sent.find((a) => a[0] === "SET" && a[1].startsWith(SOLANA_SELFTEST_KEY_PREFIX))!;
    expect(set[1]).toMatch(/^hp:solana:selftest:replay-eval:[0-9a-f]{32}$/);
    expect(set.slice(3)).toEqual(["PX", "60000"]);
    expect([...up.data.keys()].filter((k) => k.startsWith("hp:solana:selftest:"))).toEqual([]);
  });
});

// ===========================================================================
// Odin 1:39 PM ET (3): redeem-on-retry (XRPL model) + /status meta hp-solana-replay-eval.
// ===========================================================================
const SOL_PAYER_BYTES = Buffer.from(base58Decode(SOL_PAYER)!);
let mseq = 1;
/** Legacy message: header 2/0/1, 4 keys (fee payer, buyer = SOL_PAYER, ATA-ish, program-ish), unique filler. */
function msgBytes(tag: number): Buffer {
  return Buffer.concat([Buffer.from([2, 0, 1, 4]), PAYAI_FEE_PAYER_BYTES, SOL_PAYER_BYTES, Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x34), Buffer.alloc(32, tag), Buffer.alloc(60, tag ^ 0x5a)]);
}
function wire(buyerFill: number, msg: Buffer, feeFill = 0): string {
  return Buffer.concat([Buffer.from([2]), Buffer.alloc(64, feeFill), Buffer.alloc(64, buyerFill), msg]).toString("base64");
}
const sigOf = (fill: number) => base58Encode(new Uint8Array(64).fill(fill));
const FEE = 0x77;
const CHAIN_TXID = sigOf(FEE);
function chainTx(b64: string, amount: string, over: { err?: unknown; slot?: number } = {}) {
  return {
    slot: over.slot ?? DEFAULT_START_SLOT + 5,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: [b64, "base64"],
    meta: {
      err: over.err ?? null,
      preTokenBalances: [{ accountIndex: 2, mint: USDC_SOLANA_MINT, owner: SOLANA_PAYTO, uiTokenAmount: { amount: "1000" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_SOLANA_MINT, owner: SOLANA_PAYTO, uiTokenAmount: { amount: String(1000 + Number(amount)) } }],
    },
  };
}
/** Chain: our tx (fee-payer signed) visible in the payTo ATA history at `slot` (or nothing when slot is null). */
function chain(msg: Buffer, amount: string, o: { slot?: number | null; err?: unknown; buyerFill?: number; nowSlot?: number } = {}) {
  const slot = o.slot === undefined ? DEFAULT_START_SLOT + 5 : o.slot;
  const b64 = wire(o.buyerFill ?? 0xaa, msg, FEE);
  return installRpc(
    "present",
    () => (slot === null ? [] : [{ signature: CHAIN_TXID, slot, err: o.err ? {} : null }]),
    (sig) => (slot !== null && sig === CHAIN_TXID ? chainTx(b64, amount, { slot, err: o.err }) : null),
    () => o.nowSlot ?? DEFAULT_START_SLOT,
  );
}

/** v4: a slot delivered BY A REDEEM is owner-tagged (settled!<owner>~<rq>). */
const DELIVERED_BY_REDEEM = () => new RegExp(`^settled![0-9a-f]{16}~${RQ}$`);
describe("Solana redeem-on-retry (Odin 1:39 (3), modeled on XRPL)", () => {
  /** First request on instance A ends ambiguous (PayAI settle timeout, not visible on-chain): slot = undelivered. */
  async function undelivered(up: ReturnType<typeof fakeUpstash>) {
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    const sol = (await accepts())[1];
    const msg = msgBytes(mseq++ % 250);
    const p = solPayload(sol, wire(0xaa, msg));
    settle = () => {
      throw new FacilitatorTimeoutError("settle", 12_000);
    };
    chain(msg, sol.amount, { slot: null });
    expect((await handler()(paid(p))).status).toBe(504);
    const k = await slotKey(p);
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
    expect(ran).toBe(1);
    return { sol, msg, p, k };
  }
  function instanceB(up: ReturnType<typeof fakeUpstash>) {
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
  }

  it("retry on another instance after OUR tx landed (slot > first start slot) → delivered ONCE: 200 + PAYMENT-RESPONSE from the chain, no verify/settle, slot = settled; next retry 409", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    const calls = chain(msg, sol.amount);
    const res = await handler()(paid(p));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toEqual({ success: true, transaction: CHAIN_TXID, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
    expect(facCalls).toEqual(["verify", "settle"]); // only instance A's; B never asked PayAI
    expect(ran).toBe(2);
    expect(up.data.get(k)).toMatch(DELIVERED_BY_REDEEM());
    // The lease was taken by CAS from the exact undelivered value, owner-tagged.
    // (v4 F3: the first request's final write is a CAS too; the lease is the CAS that writes redeeming@…)
    const lease = up.sent.find((a) => a[0] === "EVAL" && a[1] === CAS_SCRIPT && a[3] === k && String(a[5]).startsWith("redeeming@"))!;
    expect(lease[4]).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
    expect(lease[5]).toMatch(new RegExp(`^redeeming@${DEFAULT_START_SLOT}@\\d{13}![0-9a-f]{16}~${RQ}$`));
    expect(calls.filter((c) => c.method === "getTransaction").every((c) => (c.opts as { encoding?: string }).encoding === "base64")).toBe(true);
    newInstance(up.store);
    expect((await handler()(paid(p))).status).toBe(409);
    expect(ran).toBe(2);
  });

  it("freshness: our tx at/before the FIRST request's start slot is never a candidate → not delivered (502), slot stays undelivered, reconcile redeem_not_found", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount, { slot: DEFAULT_START_SLOT });
    expect((await handler()(paid(p))).status).toBe(502);
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
    expect(ran).toBe(1);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('"reason":"redeem_not_found"'))).toBe(true);
  });

  it("freshness bound is the FIRST request's stored start slot, not the retry's: chain tx at start+5, retry's own slot start+10 → still delivered", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount, { slot: DEFAULT_START_SLOT + 5, nowSlot: DEFAULT_START_SLOT + 10 });
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(k)).toMatch(DELIVERED_BY_REDEEM());
  });

  it("same instance: an undelivered slot remembered locally still goes to the shared slot (redeem), not a local 409", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    chain(msg, sol.amount);
    expect((await handler()(paid(p))).status).toBe(200); // instance A itself, local map says settle_unconfirmed
    expect(up.data.get(k)).toMatch(DELIVERED_BY_REDEEM());
    expect((await handler()(paid(p))).status).toBe(409); // now final locally
  });

  it("binding: a retry whose buyer signature is NOT the one on-chain (same message) → never delivered (502), slot back to undelivered", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount, { buyerFill: 0xbb }); // on-chain copy carries a different buyer signature
    expect((await handler()(paid(p))).status).toBe(502);
    expect(ran).toBe(1);
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
  });

  it("our tx failed on-chain (confirmed + finalized) → Base-only 402, slot = settle_failed, nothing delivered", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount, { err: { InstructionError: [0, "Custom"] } });
    const res = await handler()(paid(p));
    expect(res.status).toBe(402);
    expect(up.data.get(k)).toBe(`settle_failed~${RQ}`);
    expect(ran).toBe(1);
  });

  it("route error during redeem → 502, slot back to undelivered (a later retry can still redeem)", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount);
    const failing = createX402GetHandler(async () => NextResponse.json({ error: "upstream" }, { status: 500 }), pulseRouteConfig(), pulseOpts);
    expect((await failing(paid(p))).status).toBe(502);
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(k)).toMatch(DELIVERED_BY_REDEEM());
  });

  it("live redemption lease → 503 payment_in_progress; an expired lease (> 90 s) is taken over and redeemed", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount);
    const live = `redeeming@${DEFAULT_START_SLOT}@${Date.now()}!0123456789abcdef`;
    up.data.set(k, live);
    const busy = await handler()(paid(p));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(up.data.get(k)).toBe(live);
    up.data.set(k, `redeeming@${DEFAULT_START_SLOT}@${Date.now() - SOLANA_REDEEM_LEASE_MS - 1}!0123456789abcdef~${RQ}`);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(k)).toMatch(DELIVERED_BY_REDEEM());
  });

  it("stale in_flight (request died: claim older than 90 s) → redeemable; the start slot in the claim is the freshness bound", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    const sol = (await accepts())[1];
    const msg = msgBytes(mseq++ % 250);
    const p = solPayload(sol, wire(0xaa, msg));
    const k = await slotKey(p);
    up.data.set(k, `in_flight@${DEFAULT_START_SLOT}@${Date.now() - SOLANA_REDEEM_LEASE_MS - 1}!0123456789abcdef~${RQ}`);
    chain(msg, sol.amount);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(facCalls).toEqual([]);
    expect(up.data.get(k)).toMatch(DELIVERED_BY_REDEEM());
  });

  it("lost the CAS race (value changed between read and swap) → 503, nothing looked up, nothing written", async () => {
    let up!: ReturnType<typeof fakeUpstash>;
    let lose = false;
    up = fakeUpstash((a) => (lose && a[0] === "EVAL" && a[1] === CAS_SCRIPT ? { status: 200, body: { result: 0 } } : undefined));
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    const calls = chain(msg, sol.amount);
    lose = true;
    expect((await handler()(paid(p))).status).toBe(503);
    expect(calls.filter((c) => c.method === "getTransaction" || c.method === "getSignaturesForAddress" && (c.opts as { limit?: number })?.limit !== 1000)).toEqual([]);
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${RQ}`);
    expect(ran).toBe(1);
  });

  it("store error while reading the held value → fail closed (Base-only 402), nothing looked up or delivered", async () => {
    // claim() itself does SET NX + GET (state) on the slot key; fail only the SECOND slot-key GET (the raw-value read
    // for the redeem CAS). Self-test keys stay healthy so the EVAL gate passes.
    let failGet = false;
    let gets = 0;
    const up = fakeUpstash((a) => (failGet && a[0] === "GET" && String(a[1]).startsWith(SOLANA_REPLAY_PREFIX) && ++gets >= 2 ? { status: 500, body: { error: "down" } } : undefined));
    const { sol, msg, p } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount);
    failGet = true;
    expect((await handler()(paid(p))).status).toBe(402);
    expect(gets).toBe(2);
    expect(up.sent.some((c) => c[0] === "EVAL" && c[1] === CAS_SCRIPT && String(c[5]).startsWith("redeeming@"))).toBe(false); // no lease taken
    expect(ran).toBe(1);
  });
});

describe("/status meta hp-solana-replay-eval (Odin 1:39 (3))", () => {
  it("v4 F2: unavailable without a shared store (fail closed); not_applicable with the rail off; ok when the probe passes; unavailable when it fails", async () => {
    resetSolanaRailForTests();
    stubSolanaOn();
    setSolanaSharedStoreForTests(null);
    expect(await solanaReplayEvalStatus()).toBe("unavailable");
    const ok = fakeUpstash();
    setSolanaSharedStoreForTests(ok.store);
    expect(await solanaReplayEvalStatus()).toBe("ok");
    expect(await solanaReplayEvalStatus({ HP_SOLANA_ENABLED: "false" })).toBe("not_applicable");
    const bad = fakeUpstash((a) => (a[0] === "EVAL" && a[1] === EVAL_PROBE_SCRIPT ? { status: 200, body: { error: "NOSCRIPT" } } : undefined));
    setSolanaSharedStoreForTests(bad.store);
    expect(await solanaReplayEvalStatus()).toBe("unavailable");
  });
});

// ===========================================================================
// Shared claim v4 (Odin 5:57 PM ET + 6:14 PM ET; Sentinel v3 review F1-F3, Class A C1/L1/L2).
// ===========================================================================
describe("v4", () => {
  const paidAt = (url: string, p: PaymentPayload) =>
    new NextRequest(url, { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });
  /** Chain reads made by a redeem (ledger search), excluding the init-phase token-account / getSlot reads. */
  const lookups = (calls: { method: string; opts?: unknown }[]) =>
    calls.filter((c) => c.method === "getTransaction" || (c.method === "getSignaturesForAddress" && (c.opts as { limit?: number })?.limit !== 1000));
  const fpAlerts = () => alerts.filter((a) => a.kind === "solana_redeem_fingerprint_mismatch").length;
  const reconcileOf = (reason: string) =>
    vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("SOLANA_RECONCILE ") && l.includes(`"reason":"${reason}"`));
  /** Victim's first request at `url` ends ambiguous (settle timeout, not visible yet): slot undelivered, bound to `url`. */
  async function victim(up: ReturnType<typeof fakeUpstash>, url = "https://horizonpulse.dev/api/pulse") {
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    const sol = (await accepts())[1];
    const msg = msgBytes(mseq++ % 250);
    const p = solPayload(sol, wire(0xaa, msg));
    settle = () => {
      throw new FacilitatorTimeoutError("settle", 12_000);
    };
    chain(msg, sol.amount, { slot: null });
    expect((await handler()(paidAt(url, p))).status).toBe(504);
    const k = await slotKey(p);
    const rq = await requestFingerprint(paidAt(url, p));
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}~${rq}`);
    // The tx then lands: it is PUBLIC (fee payer signed) on the payTo ATA history.
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    const calls = chain(msg, sol.amount);
    return { sol, msg, p, k, rq, calls };
  }

  it("Sentinel S-CONC (ported): two concurrent requests, same payload, one shared store → exactly one verify/settle/delivery", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    const [a, b] = await Promise.all([handler()(paid(p)), handler()(paid(p))]);
    expect([a.status, b.status].sort()).toEqual([200, 503]);
    expect(facCalls).toEqual(["verify", "settle"]);
    expect(ran).toBe(1);
    expect(up.data.get(await slotKey(p))).toBe(`settled~${RQ}`);
  });

  it("Sentinel S-HIJACK (ported, F1): a watcher rebuilds the landed tx from chain data and replays it on its OWN request → 409, SOLANA_RECONCILE, HIGH alert, route never run, NO chain read, slot untouched; the victim's retry then delivers once", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k, calls } = await victim(up);
    const before = up.data.get(k);
    // Attacker: the public landed tx (fee payer signed), fee-payer slot zeroed (same message → same slot key).
    const onChain = Buffer.from(wire(0xaa, msg, FEE), "base64");
    onChain.fill(0, 1, 65);
    const forged = { x402Version: 2, accepted: sol, payload: { transaction: onChain.toString("base64") } } as PaymentPayload;
    expect(await slotKey(forged)).toBe(k);
    const urls: string[] = [];
    const h = createX402GetHandler(async (r) => (urls.push(r.url), NextResponse.json({ ok: true })), pulseRouteConfig(), pulseOpts);
    calls.length = 0;
    const atk = await h(paidAt("https://horizonpulse.dev/api/pulse?who=attacker", forged));
    expect(atk.status).toBe(409);
    expect(await atk.text()).toBe('{"error":"duplicate_payment"}');
    expect(atk.headers.get("payment-response")).toBeNull();
    expect(urls).toEqual([]);
    expect(lookups(calls)).toEqual([]); // fingerprint checked before any ledger read
    expect(up.data.get(k)).toBe(before);
    expect(up.sent.some((a) => a[0] === "EVAL" && a[1] === CAS_SCRIPT && String(a[5]).startsWith("redeeming@"))).toBe(false);
    expect(reconcileOf("redeem_fingerprint_mismatch")).toHaveLength(1);
    expect(alerts).toContainEqual({ kind: "solana_redeem_fingerprint_mismatch", severity: "high" });
    expect(facCalls).toEqual(["verify", "settle"]); // only the victim's first request
    // The victim's honest retry (same request) redeems, once.
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    chain(msg, sol.amount);
    const ok = await handler()(paid(p));
    expect(ok.status).toBe(200);
    expect(up.data.get(k)).toMatch(DELIVERED_BY_REDEEM());
    // A later duplicate of a slot delivered BY A REDEEM: 409 + a reconcile line (Sentinel v3 F1 ask).
    newInstance(up.store);
    expect((await handler()(paid(p))).status).toBe(409);
    expect(reconcileOf("duplicate_after_redeem")).toHaveLength(1);
  });

  it("F1 dedupe (as XRPL C1): N mismatches on one slot → 1 HIGH alert + N SOLANA_RECONCILE lines; another slot alerts on its own; none inside 15 min; again after the cooldown", async () => {
    const up = fakeUpstash();
    const a = await victim(up);
    const b = await victim(up, "https://horizonpulse.dev/api/pulse?q=second"); // same store; this instance runs everything below
    expect(a.k).not.toBe(b.k);
    const N = 4;
    for (let i = 0; i < N; i++) expect((await handler()(paidAt(`https://horizonpulse.dev/api/pulse?atk=${i}`, a.p))).status).toBe(409);
    expect(fpAlerts()).toBe(1);
    expect(reconcileOf("redeem_fingerprint_mismatch")).toHaveLength(N);
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=x", b.p))).status).toBe(409); // slot B: its own alert
    expect(fpAlerts()).toBe(2);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(t0 + SOLANA_FP_ALERT_COOLDOWN_MS - 1_000);
      expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?late=1", a.p))).status).toBe(409);
      expect(fpAlerts()).toBe(2);
      now.mockReturnValue(t0 + SOLANA_FP_ALERT_COOLDOWN_MS + 1_000);
      expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?after=1", a.p))).status).toBe(409);
      expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?after=2", a.p))).status).toBe(409);
      expect(fpAlerts()).toBe(3);
      expect(reconcileOf("redeem_fingerprint_mismatch")).toHaveLength(N + 4);
    } finally {
      now.mockRestore();
    }
  });

  it("F1 legacy slot (no fingerprint) → never auto-redeemed: 502 + reconcile redeem_legacy_no_fingerprint, slot untouched, no chain read, no alert", async () => {
    const up = fakeUpstash();
    const { p, k, calls } = await victim(up);
    const legacy = up.data.get(k)!.replace(/~[0-9a-f]{64}$/, "");
    up.data.set(k, legacy);
    calls.length = 0;
    const r = await handler()(paid(p)); // even the genuine same request
    expect(r.status).toBe(502);
    expect(up.data.get(k)).toBe(legacy);
    expect(lookups(calls)).toEqual([]);
    expect(reconcileOf("redeem_legacy_no_fingerprint")).toHaveLength(1);
    expect(fpAlerts()).toBe(0);
  });

  it("F1 stable key-only sort (lib/request-fingerprint.ts): reordered VALUES of a repeated key → 409; reordered distinct keys → delivered", async () => {
    const up = fakeUpstash();
    const { p, k } = await victim(up, "https://horizonpulse.dev/api/pulse?t=b&q=1&t=a");
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?t=a&t=b&q=1", p))).status).toBe(409);
    expect((await handler()(paidAt("https://horizonpulse.dev/api/pulse?q=1&t=b&t=a", p))).status).toBe(200);
    expect(up.data.get(k)).toMatch(/^settled![0-9a-f]{16}~[0-9a-f]{64}$/);
  });

  // ------------------------------------------------------------------ F2
  async function goodSolAccept() {
    newInstance(fakeUpstash().store);
    return (await accepts())[1];
  }
  for (const [name, env, reason] of [
    ["no credentials", {}, "missing"],
    ["only UPSTASH_REDIS_REST_URL", { UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }, "half_set"],
    ["only UPSTASH_REDIS_REST_TOKEN", { UPSTASH_REDIS_REST_TOKEN: "t" }, "half_set"],
    ["only KV_REST_API_URL (+ the read-only token, never read)", { KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_READ_ONLY_TOKEN: "ro" }, "half_set"],
    ["only the read-only KV token", { KV_REST_API_READ_ONLY_TOKEN: "ro" }, "missing"],
    ["UPSTASH http:// URL", { UPSTASH_REDIS_REST_URL: "http://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }, "not_https"],
    ["KV http:// URL", { KV_REST_API_URL: "http://x.upstash.io", KV_REST_API_TOKEN: "t" }, "not_https"],
  ] as const) {
    it(`F2 fail closed (${name}) → Solana not advertised, paid Solana → Base-only 402 rail_unavailable, nothing claimed or verified, /status unavailable, ONE HIGH alert (${reason})`, async () => {
      const sol = await goodSolAccept();
      resetSolanaRailForTests();
      setSolanaAlertHook((a) => alerts.push(a));
      stubSolanaOn();
      __initSolanaSharedStoreFromEnvForTests(env as Record<string, string>);
      expect(solanaSharedStoreKind()).toBe("none");
      alerts = [];
      facCalls = [];
      expect((await accepts()).map((a) => a.network)).toEqual(["eip155:8453"]);
      const res = await handler()(paid(solPayload(sol)));
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(pr.accepts.map((a) => a.network)).toEqual(["eip155:8453"]);
      expect(pr.error).toBe("rail_unavailable");
      expect(facCalls).toEqual([]);
      expect(ran).toBe(0);
      expect(await solanaReplayEvalStatus()).toBe("unavailable");
      expect(alerts.filter((a) => a.kind === "solana_claim_store_unconfigured")).toEqual([{ kind: "solana_claim_store_unconfigured", severity: "high", reason }]);
    });
  }
  it("F2: a complete https pair builds the Upstash store (KV family uses KV_REST_API_TOKEN, never the read-only token); no alert", async () => {
    for (const env of [
      { UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" },
      { KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "rw", KV_REST_API_READ_ONLY_TOKEN: "ro" },
    ]) {
      resetSolanaRailForTests();
      alerts = [];
      setSolanaAlertHook((a) => alerts.push(a));
      const seen: string[] = [];
      __initSolanaSharedStoreFromEnvForTests(env, (async (_u: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      }) as unknown as typeof fetch);
      expect(solanaSharedStoreKind()).toBe("upstash");
      expect(alerts).toEqual([]);
      setSolanaSharedStoreForTests(null);
    }
  });

  // ------------------------------------------------------------------ C1
  it("C1: store calls on the slot key per request match the budget: paid paths (success / ambiguous / nothing charged) = SOLANA_STORE_CALLS_PAID_PATH; redeem = SOLANA_STORE_CALLS_REDEEM_PATH", async () => {
    const slotCalls = (up: ReturnType<typeof fakeUpstash>, from: number) =>
      up.sent.slice(from).filter((a) => (a[0] === "EVAL" ? String(a[3]) : String(a[1])).startsWith(SOLANA_REPLAY_PREFIX)).length;
    for (const mode of ["success", "ambiguous", "rejected"] as const) {
      const up = fakeUpstash();
      newInstance(up.store);
      const sol = (await accepts())[1];
      verifyOk = mode !== "rejected";
      settle =
        mode === "ambiguous"
          ? () => {
              throw new FacilitatorTimeoutError("settle", 12_000);
            }
          : () => ({ success: true, transaction: SOL_SIG, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
      __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
      const from = up.sent.length;
      await handler()(paid(solPayload(sol)));
      expect(slotCalls(up, from), mode).toBe(SOLANA_STORE_CALLS_PAID_PATH);
      verifyOk = true;
    }
    const up = fakeUpstash();
    const { p } = await victim(up);
    const from = up.sent.length;
    expect((await handler()(paid(p))).status).toBe(200);
    expect(slotCalls(up, from)).toBe(SOLANA_STORE_CALLS_REDEEM_PATH);
  });

  // ------------------------------------------------------------------ F3 + LOW
  it("F3: final write is an owner-checked CAS: a slot taken over meanwhile (another owner's lease) is NOT overwritten; response still served; LOW alert (settled, lost)", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    const k = await slotKey(p);
    const takeover = `redeeming@${DEFAULT_START_SLOT}@${Date.now()}!fedcba9876543210~${RQ}`;
    settle = () => {
      up.data.set(k, takeover); // e.g. our request outlived its 90 s lease and a redeemer took the slot
      return { success: true, transaction: SOL_SIG, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER };
    };
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(k)).toBe(takeover);
    expect(up.sent.some((a) => a[0] === "SET" && !a.includes("NX") && a[1] === k)).toBe(false); // never a blind SET
    expect(alerts.filter((a) => a.kind === "solana_claim_write_failed")).toEqual([{ kind: "solana_claim_write_failed", severity: "low", write: "settled", reason: "lost" }]);
  });

  it("F3: release is compare-and-delete: a slot that changed owner is NOT deleted; LOW alert (release, lost)", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    const k = await slotKey(p);
    const other = `in_flight@${DEFAULT_START_SLOT}@${Date.now()}!fedcba9876543210~${RQ}`;
    installBothFacilitators({
      verify: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { isValid: true } : (up.data.set(k, other), { isValid: false, invalidReason: "invalid_payload" })),
      settle: (url: string) => (url.startsWith(CDP_URL_PREFIX) ? { success: true } : settle()),
    } as never);
    expect((await handler()(paid(p))).status).toBe(402);
    expect(up.data.get(k)).toBe(other);
    expect(alerts.filter((a) => a.kind === "solana_claim_write_failed")).toEqual([{ kind: "solana_claim_write_failed", severity: "low", write: "release", reason: "lost" }]);
  });

  it("LOW: release write ERROR → LOW alert (release, error); the claim stays (TTL / reconcile), nothing delivered", async () => {
    const up = fakeUpstash((a) => (a[0] === "EVAL" && a[1] === CAS_DELETE_SCRIPT && String(a[3]).startsWith(SOLANA_REPLAY_PREFIX) ? { status: 500, body: { error: "down" } } : undefined));
    newInstance(up.store);
    const sol = (await accepts())[1];
    verifyOk = false;
    expect((await handler()(paid(solPayload(sol)))).status).toBe(402);
    expect(alerts.filter((a) => a.kind === "solana_claim_write_failed")).toEqual([{ kind: "solana_claim_write_failed", severity: "low", write: "release", reason: "error" }]);
  });

  it("LOW: a redeem's delivered mark lost (CAS refused) → still delivered (paid) + LOW alert (settled, lost)", async () => {
    let refuse = false;
    const up = fakeUpstash((a) => (refuse && a[0] === "EVAL" && a[1] === CAS_SCRIPT && String(a[4]).startsWith("redeeming@") ? { status: 200, body: { result: 0 } } : undefined));
    const { p } = await victim(up);
    refuse = true;
    alerts = [];
    expect((await handler()(paid(p))).status).toBe(200);
    expect(alerts.filter((a) => a.kind === "solana_claim_write_failed")).toEqual([{ kind: "solana_claim_write_failed", severity: "low", write: "settled", reason: "lost" }]);
  });
});
