/**
 * XRPL cold-start accepts (Odin 11:08 AM ET 10/18). Prod fault: right after a deploy
 * (10:28 revert: 24/81; 11:04 deploy: 29/81, still 8/81 a minute later) cold-started
 * instances served 402s WITHOUT the XRPL entry. Cause: on an instance that had never
 * confirmed the rail, a failed/timed-out first check (payTo readiness RPC or rail init)
 * hid XRPL for the cold backoff (5, 10, 20, 40, 60 s), although nothing had confirmed
 * it absent. Now: XRPL is in the 402 on a cold start unless CONFIRMED absent (RPC says
 * account gone / no usable trust line / flags; facilitator lists no exact kind; SDK
 * cannot load), with an ALERT on real absence. payTo never changes. Offline only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import {
  __flushXrplBackgroundForTests,
  __setXrplModuleLoaderForTests,
  __setXrplFacilitatorSchemeLoaderForTests,
  __setXrplRpcForTests,
  getXrplAccept,
  resetXrplRailForTests,
  setXrplAlertHook,
  setXrplReplayStoreForTests,
  type XrplAlert,
  type XrplRpc,
} from "@/lib/xrpl-rail";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { getXrplRailConfig, type XrplRailConfig } from "@/lib/xrpl-config";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { X402_ORG_SUPPORTED, XRPL_FAC, installXrplFacilitators, makeXrplRpc, payToForNet, stubXrplOn, type ReadyMode } from "./helpers/xrpl-env";

const TIMEOUT_MS = 150;
type Behaviour = ReadyMode | "timeout";

function installStepRpc(next: () => Behaviour) {
  const stats = { checks: 0 };
  const modes = new Map<string, XrplRpc>();
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
    if (!modes.has(current)) modes.set(current, makeXrplRpc(current as ReadyMode).fn);
    return modes.get(current)!(url, method, params, timeoutMs);
  };
  __setXrplRpcForTests(fn);
  return stats;
}

const handler = () => createX402GetHandler(async () => NextResponse.json({ ok: true }), pulseRouteConfig(), pulseOpts);
const unpaid = () => new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } });
async function xrplEntry(h: ReturnType<typeof handler>): Promise<PaymentRequirements | undefined> {
  const res = await h(unpaid());
  expect(res.status).toBe(402);
  const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
  const body = (await res.json()) as { accepts?: PaymentRequirements[] };
  const fromHeader = pr.accepts.find((a) => a.network.startsWith("xrpl:"));
  const fromBody = body.accepts?.find((a) => a.network.startsWith("xrpl:"));
  if (Array.isArray(body.accepts)) expect(JSON.stringify(fromBody)).toBe(JSON.stringify(fromHeader)); // a v2 JSON body must agree with the header
  return fromHeader;
}
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("XRPL in the 402 on a cold start unless confirmed absent (Odin 11:08)", () => {
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
    __setXrplModuleLoaderForTests(null);
    setXrplAlertHook(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const on = (extra: Record<string, string> = {}) => {
    stubXrplOn({ HP_XRPL_INIT_TIMEOUT_MS: String(TIMEOUT_MS), ...extra });
    setXrplAlertHook((a) => alerts.push(a));
  };
  /** The entry a healthy instance builds through the SDK (reference for byte-identity). */
  async function healthyEntry(extra: Record<string, string> = {}): Promise<string> {
    installXrplFacilitators();
    on(extra);
    installStepRpc(() => "ready");
    const e = await xrplEntry(handler());
    expect(e).toBeDefined();
    resetXrplRailForTests();
    setXrplAlertHook((a) => alerts.push(a));
    return JSON.stringify(e);
  }

  it("readiness RPC times out on every cold attempt → the FIRST 402 still has XRPL, byte-identical to the healthy entry, same payTo", async () => {
    const ref = await healthyEntry();
    const stats = installStepRpc(() => "timeout");
    const e = await xrplEntry(handler());
    expect(stats.checks).toBe(2); // the in-request cold retry still runs
    expect(JSON.stringify(e)).toBe(ref);
    expect(e!.payTo).toBe(payToForNet(undefined));
    expect(alerts.filter((a) => a.kind === "xrpl_entry_dropped")).toEqual([]);
  });

  it("readiness RPC errors → present on every request through the cold backoff (no extra RPC), then re-checks and confirms", async () => {
    const ref = await healthyEntry();
    let mode: Behaviour = "error";
    const stats = installStepRpc(() => mode);
    const h = handler();
    expect(JSON.stringify(await xrplEntry(h))).toBe(ref);
    expect(stats.checks).toBe(2);
    advance(4_000);
    expect(JSON.stringify(await xrplEntry(h))).toBe(ref); // inside the 5 s backoff: present, no new RPC
    expect(stats.checks).toBe(2);
    mode = "ready";
    advance(1_100);
    expect(JSON.stringify(await xrplEntry(h))).toBe(ref);
    expect(stats.checks).toBe(3);
  });

  it("rail init fails on a cold start (facilitator /supported down) → XRPL present, byte-identical", async () => {
    const ref = await healthyEntry();
    installXrplFacilitators({
      supported: (url) => {
        if (url !== XRPL_FAC) throw new Error(`unexpected ${url}`);
        throw new Error("fetch failed: ECONNRESET");
      },
    });
    installStepRpc(() => "ready");
    expect(JSON.stringify(await xrplEntry(handler()))).toBe(ref);
  });

  it("rail init times out on a cold start (slow SDK load) → XRPL present, byte-identical", async () => {
    const ref = await healthyEntry();
    const { __loadRealXrplModulesForTests } = await import("@/lib/xrpl-rail");
    __setXrplModuleLoaderForTests(async () => {
      await new Promise((r) => setTimeout(r, 3 * TIMEOUT_MS + 2_000));
      return __loadRealXrplModulesForTests();
    });
    setXrplAlertHook((a) => alerts.push(a));
    installStepRpc(() => "ready");
    expect(JSON.stringify(await xrplEntry(handler()))).toBe(ref);
  }, 15_000);

  it("both checks failing at once on a cold start → still present", async () => {
    const ref = await healthyEntry();
    installXrplFacilitators({
      supported: () => {
        throw new Error("fetch failed: ETIMEDOUT");
      },
    });
    installStepRpc(() => "timeout");
    expect(JSON.stringify(await xrplEntry(handler()))).toBe(ref);
  });

  it("assetTransferMethod set: the cold entry is still byte-identical to the SDK-built one", async () => {
    const ref = await healthyEntry({ HP_XRPL_ASSET_TRANSFER_METHOD: "ticketSequence" });
    installStepRpc(() => "timeout");
    expect(JSON.stringify(await xrplEntry(handler()))).toBe(ref);
  });

  for (const mode of ["unactivated", "no_trustline", "frozen", "zero_limit", "dest_tag", "deposit_auth"] as ReadyMode[]) {
    it(`confirmed absence on a cold start (${mode}) → hidden + one ALERT xrpl_entry_dropped payto_not_ready`, async () => {
      installXrplFacilitators();
      on();
      installStepRpc(() => mode);
      const h = handler();
      expect(await xrplEntry(h)).toBeUndefined();
      advance(10 * 60_000 + 1);
      expect(await xrplEntry(h)).toBeUndefined();
      await __flushXrplBackgroundForTests();
      expect(alerts.filter((a) => a.kind === "xrpl_entry_dropped")).toEqual([{ kind: "xrpl_entry_dropped", reason: "payto_not_ready" }]);
    });
  }

  it("confirmed absence then RPC errors → stays hidden (last definitive answer wins)", async () => {
    installXrplFacilitators();
    on();
    let mode: Behaviour = "no_trustline";
    installStepRpc(() => mode);
    const h = handler();
    expect(await xrplEntry(h)).toBeUndefined();
    mode = "error";
    advance(10 * 60_000 + 1);
    await xrplEntry(h);
    await __flushXrplBackgroundForTests();
    expect(await xrplEntry(h)).toBeUndefined();
  });

  it("facilitator answers without the exact xrpl kind on a cold start → hidden + ALERT facilitator_kind_absent", async () => {
    installXrplFacilitators({
      supported: (url) => {
        if (url !== XRPL_FAC) throw new Error(`unexpected ${url}`);
        return { kinds: [{ x402Version: 2, scheme: "exact", network: "xrpl:0" }], extensions: [], signers: {} };
      },
    });
    on();
    installStepRpc(() => "ready");
    expect(await xrplEntry(handler())).toBeUndefined();
    expect(alerts).toContainEqual({ kind: "xrpl_entry_dropped", reason: "facilitator_kind_absent" });
  });

  it("the SDK cannot be loaded at all (import rejects) → hidden + ALERT (not shown on a guess)", async () => {
    installXrplFacilitators();
    on();
    __setXrplModuleLoaderForTests(async () => {
      throw new Error("Cannot find module '@x402/xrpl'");
    });
    setXrplAlertHook((a) => alerts.push(a));
    installStepRpc(() => "ready");
    expect(await xrplEntry(handler())).toBeUndefined();
    expect(alerts).toContainEqual({ kind: "xrpl_entry_dropped", reason: "sdk_unavailable" });
  });

  it("recovery: after a cold failure the first good check serves the SDK-built entry (identical) and no ALERT fires", async () => {
    const ref = await healthyEntry();
    let n = 0;
    installXrplFacilitators({
      supported: (url) => {
        if (url !== XRPL_FAC) throw new Error(`unexpected ${url}`);
        if (++n <= 2) throw new Error("fetch failed: ECONNRESET");
        return X402_ORG_SUPPORTED;
      },
    });
    installStepRpc(() => "ready");
    const h = handler();
    expect(JSON.stringify(await xrplEntry(h))).toBe(ref);
    advance(5_100);
    expect(JSON.stringify(await xrplEntry(h))).toBe(ref);
    expect(alerts.filter((a) => a.kind === "xrpl_entry_dropped")).toEqual([]);
  });
});

/**
 * Mainnet (xrpl:0) cold start, Sentinel note B / Odin 11:22 AM ET 10/18: the tests above run on xrpl:1. This pins
 * the money values on the cold path itself, as LITERALS (payTo copied from security/approved-addresses.md line 10;
 * issuer = Ripple's RLUSD mainnet issuer, docs.ripple.com token-addresses, = lib/xrpl-config.ts + @x402/xrpl).
 * Config comes from the real env parser (pinned-payTo gate), the store is shared-kind, the facilitator is "self".
 */
describe("XRPL mainnet cold start pins the literal payTo / issuer (Sentinel note B)", () => {
  const MAINNET_PAYTO_LITERAL = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
  const RLUSD_MAINNET_ISSUER_LITERAL = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
  const RLUSD_HEX_LITERAL = "524C555344000000000000000000000000000000";
  const MAIN_ENV = {
    HP_XRPL_ENABLED: "true",
    HP_XRPL_NETWORK: "xrpl:0",
    HP_XRPL_PAYTO: MAINNET_PAYTO_LITERAL,
    HP_XRPL_FACILITATOR_URL: "self",
    XRPL_MAINNET_ALLOWED: "true",
    UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "t",
    HP_XRPL_INIT_TIMEOUT_MS: String(TIMEOUT_MS),
  };
  const selfScheme = { getExtra: () => ({ areFeesSponsored: false }), verify: async () => ({ isValid: false }), settle: async () => ({ success: false }) };
  /** Fresh instance with a shared-kind replay store (resetXrplRailForTests resets the store to the env default). */
  const freshInstance = () => {
    resetXrplRailForTests();
    setXrplReplayStoreForTests(Object.assign(new MemoryReplayStore(), { kind: "upstash" as const }) as never);
  };
  beforeEach(() => {
    freshInstance();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    setXrplReplayStoreForTests(null);
    __setXrplFacilitatorSchemeLoaderForTests(null);
    __setXrplRpcForTests(null);
    setXrplAlertHook(null);
    vi.restoreAllMocks();
  });

  it("xrpl:0 cold entry (RPC + rail init both time out) = literal r3Fbir… / rMxCK… / RLUSD hex, byte-identical to the SDK-built mainnet entry", async () => {
    const alerts: XrplAlert[] = [];
    setXrplAlertHook((a) => alerts.push(a));
    const r = getXrplRailConfig(MAIN_ENV);
    expect(r.enabled).toBe(true);
    const config = (r as { config: XrplRailConfig }).config;

    // Reference: a healthy instance (RPC ready, self facilitator loads) builds the entry through the SDK.
    __setXrplFacilitatorSchemeLoaderForTests(async () => selfScheme as never);
    installStepRpc(() => "ready");
    const ref = await getXrplAccept(config, "5000");
    expect(ref).not.toBeNull();

    // Cold instance: payTo readiness RPC and rail init (self scheme load) both time out on every attempt.
    freshInstance();
    setXrplAlertHook((a) => alerts.push(a));
    __setXrplFacilitatorSchemeLoaderForTests(() => new Promise(() => {}));
    const coldStats = installStepRpc(() => "timeout");
    const cold = await getXrplAccept(config, "5000");
    expect(coldStats.checks).toBe(2); // really the cold path: in-request retry ran and failed

    expect(cold).not.toBeNull();
    expect(JSON.stringify(cold)).toBe(JSON.stringify(ref));
    expect(cold).toEqual({
      scheme: "exact",
      network: "xrpl:0",
      amount: "0.005",
      asset: RLUSD_HEX_LITERAL,
      payTo: MAINNET_PAYTO_LITERAL,
      maxTimeoutSeconds: 300,
      extra: { issuer: RLUSD_MAINNET_ISSUER_LITERAL, areFeesSponsored: false },
    });
    expect(alerts.filter((a) => a.kind === "xrpl_entry_dropped")).toEqual([]);
  }, 15_000);
});
