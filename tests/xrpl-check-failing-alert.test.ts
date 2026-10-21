/**
 * XRPL check_failing alert fix (2026-10-21 RCA; Odin approved). Helpers copied from the keep-present suite.
 * Original header: XRPL rail keep-present (Class A follow-up, 2026-10-17). Live fault 10/17 9:34 AM ET:
 * 33/108 prod 402s were missing the XRPL entry, because one failed or timed-out
 * readiness RPC (account_info/account_lines) or facilitator /supported refresh hid
 * the entry on that instance (cold: flat 60 s; confirmed: after 60 min stale; a
 * rail refresh error retired the rail at once). Modelled on the 10/8 Solana fix
 * (153d1f3 / 190f85c / e13a34c). Offline only: RPC and facilitators are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on Next's after() (background refreshes must be handed to it). Outside a request scope the real one throws.
const afterSpy = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (task: unknown) => { afterSpy.calls.push(task); } };
});
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

describe("XRPL check_failing alert fix (2026-10-21)", () => {
  let alerts: XrplAlert[];
  beforeEach(() => {
    resetXrplRailForTests();
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    alerts = [];
    afterSpy.calls = [];
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
  const failing = () => alerts.filter((a) => a.kind === "xrpl_check_failing") as Extract<XrplAlert, { kind: "xrpl_check_failing" }>[];

  it("(1) stale is measured from the first failure: idle 40 min then one failed check → NO alert (was a stale alert with failures:1)", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "ready";
    installStepRpc(() => mode);
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    mode = "error"; // fails on the attempt AND on the idle retry → one counted failure
    await tick(h, 40 * MIN);
    expect(failing()).toEqual([]);
    expect(await hasXrpl(h)).toBe(true); // entry kept
  });

  it("(2) background refreshes (payTo readiness + rail) are handed to Next's after()", async () => {
    installXrplFacilitators();
    on();
    installStepRpc(() => "ready");
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    expect(afterSpy.calls).toHaveLength(0); // cold checks run inline, nothing in the background
    await tick(h, 10 * MIN + 1); // both TTLs expired → two background refreshes
    expect(afterSpy.calls.length).toBe(2);
    for (const c of afterSpy.calls) expect(c).toBeInstanceOf(Promise);
    await Promise.all(afterSpy.calls as Promise<unknown>[]); // the handed promise never rejects
  });

  it("(3a) payTo readiness: after a long idle, the first failure is retried once inline and does not count", async () => {
    installXrplFacilitators();
    on();
    let n = 0;
    let script: Behaviour[] = [];
    const stats = installStepRpc(() => script[n++] ?? "ready");
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    const base = stats.checks;
    n = 0;
    script = ["error", "ready"];
    await tick(h, 40 * MIN);
    expect(stats.checks - base).toBe(2); // attempt + one retry
    // Streak was NOT incremented: two more failures (non-idle, single attempts) still don't reach 3.
    n = 0;
    script = ["error", "error"];
    const b2 = stats.checks;
    await tick(h, 10 * MIN + 1);
    await tick(h, 1 * MIN + 1);
    expect(stats.checks - b2).toBe(2); // not idle → no retry
    expect(failing()).toEqual([]);
  });

  it("(3b) not idle: a failed refresh is NOT retried (single attempt, unchanged behaviour)", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "ready";
    const stats = installStepRpc(() => mode);
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    const base = stats.checks;
    mode = "error";
    await tick(h, 10 * MIN + 1);
    expect(stats.checks - base).toBe(1);
  });

  it("(3c) rail: after a long idle, a failed /supported refresh is retried once and does not count", async () => {
    let failNext = 0;
    const calls = installXrplFacilitators({
      supported: (url) => {
        if (url !== XRPL_FAC) throw new Error(`unexpected ${url}`);
        if (failNext > 0) {
          failNext--;
          throw new Error("fetch failed: ECONNRESET");
        }
        return X402_ORG_SUPPORTED;
      },
    });
    on();
    installStepRpc(() => "ready");
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    const sup = () => calls.filter((c) => c.url === XRPL_FAC && c.op === "supported").length;
    const base = sup();
    failNext = 1;
    await tick(h, 40 * MIN);
    expect(sup() - base).toBe(2); // attempt + retry
    failNext = 99; // now two non-idle failures: a streak of 2, no alert (the idle one did not count)
    await tick(h, 10 * MIN + 1);
    await tick(h, 1 * MIN + 1);
    expect(failing().filter((a) => a.check === "rail")).toEqual([]);
  });

  it("(4) a real sustained outage still alerts within the window: consecutive at the 3rd failure, stale by 30 min of failing", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "ready";
    installStepRpc(() => mode);
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    mode = "error";
    const t0 = Date.now();
    await tick(h, 10 * MIN + 1); // fail 1 (outage starts)
    const firstFail = Date.now();
    await tick(h, 1 * MIN + 1); // fail 2
    expect(failing()).toEqual([]);
    await tick(h, 1 * MIN + 1); // fail 3
    expect(failing().map((a) => [a.check, a.reason, a.failures])).toEqual([["payto_ready", "consecutive_failures", 3]]);
    expect(Date.now() - firstFail).toBeLessThan(3 * MIN);
    while (failing().length < 2 && Date.now() - t0 < 60 * MIN) await tick(h, 1 * MIN + 1);
    expect(failing().map((a) => a.reason)).toEqual(["consecutive_failures", "stale"]);
    const stale = failing()[1];
    expect(stale.sinceMs).toBeGreaterThanOrEqual(30 * MIN);
    expect(Date.now() - firstFail).toBeLessThan(32 * MIN); // within the window (+ one 61 s tick)
  });

  it("(4b) outage that starts right after a long idle: the idle retry does not hide it, alert by the 3rd counted failure", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "ready";
    installStepRpc(() => mode);
    const h = handler();
    expect(await hasXrpl(h)).toBe(true);
    mode = "error";
    await tick(h, 40 * MIN); // idle: attempt + retry both fail → counted failure 1
    await tick(h, 1 * MIN + 1); // 2
    await tick(h, 1 * MIN + 1); // 3
    expect(failing().map((a) => a.reason)).toEqual(["consecutive_failures"]);
  });
});
