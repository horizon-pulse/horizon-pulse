/**
 * Odin 12:51 PM ET (d): shared Upstash claim for Solana, modeled on the XRPL replay store. Atomic cross-instance claim
 * (SET NX) BEFORE verify; delivered tracking (settled = delivered, settle_unconfirmed@firstSeen = not delivered);
 * release when nothing was charged; fail closed on store errors and on a failing EVAL / self-test probe.
 * "Instances" are simulated by resetting the module's per-instance state while keeping the same shared store.
 * Offline: a fake Upstash REST double, stubbed facilitators / RPC; no network, no keys, no money.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { FacilitatorTimeoutError } from "@x402/core/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  SOLANA_REDEEM_LEASE_MS,
  SOLANA_REPLAY_PREFIX,
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
import { DEFAULT_START_SLOT, SOL_PAYER, installBothFacilitators, installRpc, stubSolanaOn } from "./helpers/solana-env";

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

let txSeq = 1;
const freshTx = () => Buffer.concat([Buffer.from([2]), Buffer.alloc(128, 0), Buffer.alloc(220, txSeq++ % 250)]).toString("base64");
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
  it("no shared store configured → 'none' (per-instance map only, previous behaviour)", () => {
    resetSolanaRailForTests();
    expect(solanaSharedStoreKind()).toBe("none");
  });

  it("delivered on instance A → the same payment on instance B is refused BEFORE PayAI (409), slot = settled", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(await slotKey(p))).toBe("settled");
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
    // Odin 1:39 (3): in_flight@<request-start SLOT>@<claim ms>
    expect(atVerify).toMatch(new RegExp(`^in_flight@${DEFAULT_START_SLOT}@\\d{13}$`));
    const claim = up.sent.find((a) => a[0] === "SET" && a[1] === k)!;
    expect(claim).toEqual(["SET", k, expect.stringMatching(/^in_flight@300000000@\d{13}$/), "NX", "PX", String(25 * 60 * 60_000)]);
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
    expect(up.data.get(await slotKey(p))).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    expect((await handler()(paid(p))).status).toBe(502);
    expect(up.data.get(await slotKey(p))).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
    expect(facCalls.filter((x) => x === "settle")).toHaveLength(1);
    expect(facCalls.filter((x) => x === "verify")).toHaveLength(1);
  });

  it("nothing charged (verify rejected) → slot released (DEL), so the buyer can retry on any instance", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    verifyOk = false;
    expect((await handler()(paid(p))).status).toBe(402);
    const k = await slotKey(p);
    expect(up.data.has(k)).toBe(false);
    expect(up.sent.some((a) => a[0] === "DEL" && a[1] === k)).toBe(true);
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

  it("post-settle state write fails → the paid response is still served (the claim stays in_flight: never a second delivery), logged", async () => {
    const up = fakeUpstash((a) => (a[0] === "SET" && !a.includes("NX") && a[1].startsWith("hp:solana:replay:") ? { status: 500, body: { error: "down" } } : undefined));
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(await slotKey(p))).toMatch(/^in_flight@/);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("Solana claim store set settled failed"))).toBe(true);
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
  return Buffer.concat([Buffer.from([2, 0, 1, 4]), Buffer.alloc(32, 0x31), SOL_PAYER_BYTES, Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x34), Buffer.alloc(32, tag), Buffer.alloc(60, tag ^ 0x5a)]);
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
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
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
    expect(up.data.get(k)).toBe("settled");
    // The lease was taken by CAS from the exact undelivered value, owner-tagged.
    const lease = up.sent.find((a) => a[0] === "EVAL" && a[1] === CAS_SCRIPT && a[3] === k)!;
    expect(lease[4]).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
    expect(lease[5]).toMatch(new RegExp(`^redeeming@${DEFAULT_START_SLOT}@\\d{13}![0-9a-f]{16}$`));
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
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
    expect(ran).toBe(1);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('"reason":"redeem_not_found"'))).toBe(true);
  });

  it("freshness bound is the FIRST request's stored start slot, not the retry's: chain tx at start+5, retry's own slot start+10 → still delivered", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount, { slot: DEFAULT_START_SLOT + 5, nowSlot: DEFAULT_START_SLOT + 10 });
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(k)).toBe("settled");
  });

  it("same instance: an undelivered slot remembered locally still goes to the shared slot (redeem), not a local 409", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    chain(msg, sol.amount);
    expect((await handler()(paid(p))).status).toBe(200); // instance A itself, local map says settle_unconfirmed
    expect(up.data.get(k)).toBe("settled");
    expect((await handler()(paid(p))).status).toBe(409); // now final locally
  });

  it("binding: a retry whose buyer signature is NOT the one on-chain (same message) → never delivered (502), slot back to undelivered", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount, { buyerFill: 0xbb }); // on-chain copy carries a different buyer signature
    expect((await handler()(paid(p))).status).toBe(502);
    expect(ran).toBe(1);
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
  });

  it("our tx failed on-chain (confirmed + finalized) → Base-only 402, slot = settle_failed, nothing delivered", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount, { err: { InstructionError: [0, "Custom"] } });
    const res = await handler()(paid(p));
    expect(res.status).toBe(402);
    expect(up.data.get(k)).toBe("settle_failed");
    expect(ran).toBe(1);
  });

  it("route error during redeem → 502, slot back to undelivered (a later retry can still redeem)", async () => {
    const up = fakeUpstash();
    const { sol, msg, p, k } = await undelivered(up);
    instanceB(up);
    chain(msg, sol.amount);
    const failing = createX402GetHandler(async () => NextResponse.json({ error: "upstream" }, { status: 500 }), pulseRouteConfig(), pulseOpts);
    expect((await failing(paid(p))).status).toBe(502);
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(k)).toBe("settled");
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
    up.data.set(k, `redeeming@${DEFAULT_START_SLOT}@${Date.now() - SOLANA_REDEEM_LEASE_MS - 1}!0123456789abcdef`);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(up.data.get(k)).toBe("settled");
  });

  it("stale in_flight (request died: claim older than 90 s) → redeemable; the start slot in the claim is the freshness bound", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    __setSolanaLedgerCheckDelaysForTests([0, 1, 1, 1]);
    const sol = (await accepts())[1];
    const msg = msgBytes(mseq++ % 250);
    const p = solPayload(sol, wire(0xaa, msg));
    const k = await slotKey(p);
    up.data.set(k, `in_flight@${DEFAULT_START_SLOT}@${Date.now() - SOLANA_REDEEM_LEASE_MS - 1}`);
    chain(msg, sol.amount);
    expect((await handler()(paid(p))).status).toBe(200);
    expect(facCalls).toEqual([]);
    expect(up.data.get(k)).toBe("settled");
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
    expect(up.data.get(k)).toBe(`settle_unconfirmed@${DEFAULT_START_SLOT}`);
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
    expect(up.sent.some((c) => c[0] === "EVAL" && c[1] === CAS_SCRIPT)).toBe(false); // no lease taken
    expect(ran).toBe(1);
  });
});

describe("/status meta hp-solana-replay-eval (Odin 1:39 (3))", () => {
  it("not_applicable without a shared store or with the rail off; ok when the probe passes; unavailable when it fails", async () => {
    resetSolanaRailForTests();
    stubSolanaOn();
    setSolanaSharedStoreForTests(null);
    expect(await solanaReplayEvalStatus()).toBe("not_applicable");
    const ok = fakeUpstash();
    setSolanaSharedStoreForTests(ok.store);
    expect(await solanaReplayEvalStatus()).toBe("ok");
    expect(await solanaReplayEvalStatus({ HP_SOLANA_ENABLED: "false" })).toBe("not_applicable");
    const bad = fakeUpstash((a) => (a[0] === "EVAL" && a[1] === EVAL_PROBE_SCRIPT ? { status: 200, body: { error: "NOSCRIPT" } } : undefined));
    setSolanaSharedStoreForTests(bad.store);
    expect(await solanaReplayEvalStatus()).toBe("unavailable");
  });
});
