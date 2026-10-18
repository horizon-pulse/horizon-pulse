/**
 * XRPL rail keep-present (Class A follow-up, 2026-10-17). Live fault 10/17 9:34 AM ET:
 * 33/108 prod 402s were missing the XRPL entry, because one failed or timed-out
 * readiness RPC (account_info/account_lines) or facilitator /supported refresh hid
 * the entry on that instance (cold: flat 60 s; confirmed: after 60 min stale; a
 * rail refresh error retired the rail at once). Modelled on the 10/8 Solana fix
 * (153d1f3 / 190f85c / e13a34c). Offline only: RPC and facilitators are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  __flushXrplBackgroundForTests,
  __setXrplRpcForTests,
  resetXrplRailForTests,
  setXrplAlertHook,
  type XrplAlert,
  type XrplRpc,
} from "@/lib/xrpl-rail";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { X402_ORG_SUPPORTED, XRPL_FAC, installXrplFacilitators, makeXrplRpc, stubXrplOn, type ReadyMode } from "./helpers/xrpl-env";

const MIN = 60_000;
const TIMEOUT_MS = 150; // HP_XRPL_INIT_TIMEOUT_MS for these tests

type Behaviour = ReadyMode | "timeout";
/** RPC stub whose behaviour is chosen once per readiness check (on its account_info call). */
function installStepRpc(next: () => Behaviour) {
  const stats = { checks: 0 };
  const modes = new Map<ReadyMode, XrplRpc>();
  for (const m of ["ready", "unactivated", "no_trustline", "error"] as ReadyMode[]) modes.set(m, makeXrplRpc(m).fn);
  let current: Behaviour = "ready";
  const fn: XrplRpc = async (url, method, params, timeoutMs) => {
    if (method === "account_info") {
      stats.checks++;
      current = next();
    }
    if (current === "timeout") {
      await new Promise((r) => setTimeout(r, timeoutMs + 5));
      throw new Error(`XRPL RPC ${method} timed out after ${timeoutMs}ms`);
    }
    return modes.get(current as ReadyMode)!(url, method, params, timeoutMs);
  };
  __setXrplRpcForTests(fn);
  return stats;
}

function handler() {
  return createX402GetHandler(async () => NextResponse.json({ ok: true }), pulseRouteConfig(), pulseOpts);
}
const unpaid = () => new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } });
async function accepts(h: ReturnType<typeof handler>): Promise<string[]> {
  const res = await h(unpaid());
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts.map((a) => a.network);
}
const hasXrpl = async (h: ReturnType<typeof handler>) => (await accepts(h)).some((n) => n.startsWith("xrpl:"));
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** One request after the clock moved (may kick a background refresh), then let it finish. */
async function tick(h: ReturnType<typeof handler>, ms: number) {
  advance(ms);
  await accepts(h);
  await __flushXrplBackgroundForTests();
}

describe("XRPL rail keep-present (Odin Class A follow-up 2026-10-17)", () => {
  let alerts: XrplAlert[];
  beforeEach(() => {
    resetXrplRailForTests();
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    alerts = [];
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    setXrplAlertHook(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const on = () => {
    stubXrplOn({ HP_XRPL_INIT_TIMEOUT_MS: String(TIMEOUT_MS) });
    setXrplAlertHook((a) => alerts.push(a));
  };

  it("cold start: one readiness timeout is retried inside the same request, so the FIRST 402 already has XRPL", async () => {
    installXrplFacilitators();
    on();
    let n = 0;
    const stats = installStepRpc(() => (++n === 1 ? "timeout" : "ready"));
    const h = handler();
    const t0 = Date.now();
    expect(await hasXrpl(h)).toBe(true);
    expect(stats.checks).toBe(2);
    expect(Date.now() - t0).toBeLessThan(TIMEOUT_MS + 1_500 + 500); // bounded: initTimeoutMs + cold budget
  });

  it("cold start: a facilitator /supported failure is retried inside the same request (rail init)", async () => {
    let n = 0;
    const calls = installXrplFacilitators({
      supported: (url) => {
        if (url !== XRPL_FAC) throw new Error(`unexpected ${url}`);
        if (++n === 1) throw new Error("fetch failed: ECONNRESET");
        return X402_ORG_SUPPORTED;
      },
    });
    on();
    installStepRpc(() => "ready");
    expect(await hasXrpl(handler())).toBe(true);
    expect(calls.filter((c) => c.url === XRPL_FAC && c.op === "supported").length).toBe(2);
  });

  it("cold start: both attempts time out → hidden only until the first backoff (5 s), then recovers without a 60 s gap", async () => {
    installXrplFacilitators();
    on();
    let fail = true;
    const stats = installStepRpc(() => (fail ? "timeout" : "ready"));
    const h = handler();
    expect(await hasXrpl(h)).toBe(false);
    expect(stats.checks).toBe(2);
    fail = false;
    advance(4_000);
    expect(await hasXrpl(h)).toBe(false); // inside the 5 s backoff: no new RPC
    expect(stats.checks).toBe(2);
    advance(1_100);
    expect(await hasXrpl(h)).toBe(true); // backoff over: this request re-checks and recovers
    expect(stats.checks).toBe(3);
  });

  it("backoff timing: cold failures retry after 5 s, 10 s, 20 s, 40 s, then every 60 s (cap)", async () => {
    installXrplFacilitators();
    on();
    const stats = installStepRpc(() => "error");
    const h = handler();
    await accepts(h); // refresh #1 = 2 attempts
    expect(stats.checks).toBe(2);
    const early: number[] = [];
    const seen: number[] = [];
    for (const wait of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const last = stats.checks;
      advance(wait - 200);
      await accepts(h); // 200 ms before the scheduled retry: still backing off
      early.push(stats.checks - last);
      advance(400);
      await accepts(h); // 200 ms after it: one cold re-check (2 attempts)
      seen.push(stats.checks - last);
      advance(-200); // align the next window on the actual retry time
    }
    expect(early).toEqual([0, 0, 0, 0, 0, 0]);
    expect(seen).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("confirmed instance: later readiness RPC failures/timeouts NEVER hide XRPL (hours later still present)", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "ready";
    installStepRpc(() => mode);
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    mode = "error";
    for (let i = 0; i < 24; i++) {
      await tick(h, 10 * MIN + 1); // 4 h of failed refreshes
      expect(await hasXrpl(h)).toBe(true);
    }
    mode = "timeout";
    await tick(h, 10 * MIN + 1);
    expect(await hasXrpl(h)).toBe(true);
  });

  it("confirmed instance: a facilitator /supported refresh error NEVER retires the rail", async () => {
    let down = false;
    installXrplFacilitators({
      supported: (url) => {
        if (url !== XRPL_FAC) throw new Error(`unexpected ${url}`);
        if (down) throw new Error("fetch failed: ETIMEDOUT");
        return X402_ORG_SUPPORTED;
      },
    });
    on();
    installStepRpc(() => "ready");
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    down = true;
    for (let i = 0; i < 12; i++) {
      await tick(h, 10 * MIN + 1);
      expect(await hasXrpl(h)).toBe(true);
    }
  });

  it("confirmed absence hides XRPL at next check: trust line removed / account gone (+ one ALERT)", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "ready";
    installStepRpc(() => mode);
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    mode = "no_trustline";
    await tick(h, 10 * MIN + 1);
    expect(await hasXrpl(h)).toBe(false);
    expect(alerts.filter((a) => a.kind === "xrpl_entry_dropped")).toEqual([{ kind: "xrpl_entry_dropped", reason: "payto_not_ready" }]);
    mode = "ready";
    await tick(h, 10 * MIN + 1);
    expect(await hasXrpl(h)).toBe(true);
    mode = "unactivated";
    await tick(h, 10 * MIN + 1);
    expect(await hasXrpl(h)).toBe(false);
  });

  it("confirmed absence on the facilitator side (no exact xrpl kind any more) retires the rail (+ ALERT)", async () => {
    let gone = false;
    installXrplFacilitators({
      supported: (url) => {
        if (url !== XRPL_FAC) throw new Error(`unexpected ${url}`);
        return gone ? { kinds: [{ x402Version: 2, scheme: "exact", network: "xrpl:0" }], extensions: [], signers: {} } : X402_ORG_SUPPORTED;
      },
    });
    on();
    installStepRpc(() => "ready");
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    gone = true;
    await tick(h, 10 * MIN + 1);
    expect(await hasXrpl(h)).toBe(false);
    expect(alerts).toContainEqual({ kind: "xrpl_entry_dropped", reason: "facilitator_kind_absent" });
  });

  it("ALERT when checks keep failing: 3 in a row, then 30 min stale; each deduped per reason; re-armed after recovery", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "ready";
    installStepRpc(() => mode);
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    mode = "error";
    await tick(h, 10 * MIN + 1); // fail 1
    await tick(h, 1 * MIN + 1); // fail 2
    expect(alerts.filter((a) => a.kind === "xrpl_check_failing")).toHaveLength(0); // never on one or two failures
    await tick(h, 1 * MIN + 1); // fail 3
    const failing = () => alerts.filter((a) => a.kind === "xrpl_check_failing") as Extract<XrplAlert, { kind: "xrpl_check_failing" }>[];
    expect(failing().map((a) => [a.check, a.reason, a.entry])).toEqual([["payto_ready", "consecutive_failures", "kept"]]);
    for (let i = 0; i < 5; i++) await tick(h, 1 * MIN + 1); // more failures: deduped
    expect(failing()).toHaveLength(1);
    for (let i = 0; i < 20; i++) await tick(h, 1 * MIN + 1); // now > 30 min since last confirmation
    expect(failing().map((a) => a.reason)).toEqual(["consecutive_failures", "stale"]);
    for (let i = 0; i < 10; i++) await tick(h, 1 * MIN + 1);
    expect(failing()).toHaveLength(2);
    expect(await hasXrpl(h)).toBe(true); // the alert never hides the entry
    mode = "ready";
    await tick(h, 1 * MIN + 1); // recovered → re-armed
    mode = "error";
    await tick(h, 10 * MIN + 1);
    await tick(h, 1 * MIN + 1);
    await tick(h, 1 * MIN + 1);
    expect(failing().map((a) => a.reason)).toEqual(["consecutive_failures", "stale", "consecutive_failures"]);
  });
});
