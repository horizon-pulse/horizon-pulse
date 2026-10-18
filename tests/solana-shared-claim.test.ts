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
  SOLANA_REPLAY_PREFIX,
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
import { CAS_DELETE_SCRIPT, EVAL_PROBE_SCRIPT, UpstashReplayStore } from "@/lib/xrpl-replay-store";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/solana-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { SOL_PAYER, installBothFacilitators, stubSolanaOn } from "./helpers/solana-env";

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
    expect(atVerify).toMatch(/^in_flight@\d{13}$/);
    const claim = up.sent.find((a) => a[0] === "SET" && a[1] === k)!;
    expect(claim).toEqual(["SET", k, expect.stringMatching(/^in_flight@\d{13}$/), "NX", "PX", String(25 * 60 * 60_000)]);
    expect(k.startsWith("hp:solana:replay:")).toBe(true);
  });

  it("slot held in_flight by another instance (concurrent) → 409, no verify, no settle, nothing overwritten", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    const k = await slotKey(p);
    up.data.set(k, "in_flight@1800000000000");
    expect((await handler()(paid(p))).status).toBe(409);
    expect(facCalls).toEqual([]);
    expect(up.data.get(k)).toBe("in_flight@1800000000000");
  });

  it("ambiguous settle → slot = settle_unconfirmed@firstSeen (NOT delivered); a retry on another instance is refused (409) until redeem lands", async () => {
    const up = fakeUpstash();
    newInstance(up.store);
    const sol = (await accepts())[1];
    const p = solPayload(sol);
    settle = () => {
      throw new FacilitatorTimeoutError("settle", 12_000);
    };
    expect((await handler()(paid(p))).status).toBe(504);
    expect(up.data.get(await slotKey(p))).toMatch(/^settle_unconfirmed@\d{13}$/);
    newInstance(up.store);
    expect((await handler()(paid(p))).status).toBe(409);
    expect(facCalls.filter((x) => x === "settle")).toHaveLength(1);
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
