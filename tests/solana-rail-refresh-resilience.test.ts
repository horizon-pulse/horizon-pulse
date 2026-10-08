/**
 * Live fault 2026-10-08 2:46:27 PM ET (prod 153d1f3): 12 of 15 x402 resources
 * dropped to Base-only for ~30-60 s, no 500s, Base present throughout. Cause:
 * the ~10-min (RAIL_TTL_MS) PayAI /supported rail refresh failed on those
 * instances, and startRailInit's rejection handler retired the confirmed rail
 * (railState = null) and cached the failure for RETRY_AFTER_MS (60 s), logging
 * only a warn — bypassing the last-known-good protection 153d1f3 gave the
 * token-account guard.
 *
 * Rule (Odin, 2026-10-08): a refresh ERROR never clears a confirmed-present
 * Solana entry; only a CONFIRMED ABSENCE (PayAI answered and no longer offers
 * exact/Solana with a valid listed fee payer) removes it, with an ALERT.
 * Mocked facilitators / RPC only: no network, no keys, no wallets, no money.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import {
  RAIL_MAX_STALE_MS,
  RAIL_TTL_MS,
  SolanaRailAbsentError,
  isConfirmedAbsence,
  resetSolanaRailForTests,
  setSolanaAlertHook,
  type SolanaAlert,
} from "@/lib/solana-rail";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/solana-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { NextResponse } from "next/server";
import { PAYAI_FEE_PAYER, PAYAI_SUPPORTED, installBothFacilitators, revalidateSolana, stubSolanaOn } from "./helpers/solana-env";

type Mode = "ok" | "throw" | "timeout" | "http500" | "malformed" | "kind_absent" | "feepayer_unlisted";
let mode: Mode = "ok";
let supportedCalls = 0;
let now = 1_800_000_000_000;
let alerts: SolanaAlert[] = [];

function payaiSupported(): unknown {
  supportedCalls++;
  switch (mode) {
    case "ok":
      return PAYAI_SUPPORTED;
    case "throw":
      throw new TypeError("fetch failed");
    case "timeout":
      return new Promise(() => {}); // hangs past HP_SOLANA_INIT_TIMEOUT_MS
    case "http500":
      throw new Error("Facilitator getSupported failed (503): upstream unavailable");
    case "malformed":
      return { nope: true };
    case "kind_absent":
      return { ...PAYAI_SUPPORTED, kinds: PAYAI_SUPPORTED.kinds.filter((k: { network: string }) => k.network !== SOLANA_MAINNET_CAIP2) };
    case "feepayer_unlisted":
      return {
        ...PAYAI_SUPPORTED,
        signers: { "solana:*": (PAYAI_SUPPORTED.signers["solana:*"] as string[]).filter((a) => a !== PAYAI_FEE_PAYER) },
      };
  }
}

const handler = createX402GetHandler(async () => NextResponse.json({ ok: true }), pulseRouteConfig(), pulseOpts);
async function accepts(): Promise<PaymentRequirements[]> {
  const res = await handler(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
}
const hasSolana = async () => (await accepts()).some((a) => a.network === SOLANA_MAINNET_CAIP2);
const warnLines = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));

// Warm the lazy @x402/svm import so the first cold init can't trip the short init timeout below.
beforeAll(async () => {
  await import("@x402/svm");
});

beforeEach(() => {
  resetSolanaRailForTests();
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  alerts = [];
  mode = "ok";
  supportedCalls = 0;
  installBothFacilitators({ supported: payaiSupported });
  stubSolanaOn({ HP_SOLANA_INIT_TIMEOUT_MS: "500" }); // token account: present
  setSolanaAlertHook((a) => alerts.push(a));
});
afterEach(() => {
  setSolanaAlertHook(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("rail refresh: errors never drop a confirmed Solana entry (live fault 2026-10-08 2:46 PM ET)", () => {
  for (const err of ["throw", "timeout", "http500", "malformed"] as const) {
    it(`refresh error (${err}) at the 10-min refresh => Solana stays present, no ALERT, retried after 60 s`, async () => {
      expect(await hasSolana()).toBe(true); // confirmed present
      mode = err;
      now += RAIL_TTL_MS + 1; // the ~10-min refresh fires
      expect(await hasSolana()).toBe(true); // stale-while-revalidate
      await revalidateSolana(); // refresh fails
      expect(await hasSolana()).toBe(true); // <- dropped to Base-only before the fix
      now += 30_000; // inside Forge's 30-60 s window
      expect(await hasSolana()).toBe(true);
      expect(alerts).toHaveLength(0);
      expect(warnLines().some((l) => l.includes("keeping last confirmed rail"))).toBe(true);

      // Retry is paced (not every request) and recovery is clean.
      const before = supportedCalls;
      await revalidateSolana();
      expect(supportedCalls).toBe(before); // still inside RETRY_AFTER_MS
      mode = "ok";
      now += 31_000;
      await revalidateSolana();
      expect(supportedCalls).toBeGreaterThan(before);
      expect(await hasSolana()).toBe(true);
    });
  }

  it("repeated refresh errors across many cycles (< RAIL_MAX_STALE_MS) => never Base-only", async () => {
    expect(await hasSolana()).toBe(true);
    mode = "throw";
    for (let i = 0; i < 20; i++) {
      now += RAIL_TTL_MS + 1;
      await revalidateSolana();
      expect(await hasSolana()).toBe(true);
    }
    expect(alerts).toHaveLength(0);
  });

  it("CONFIRMED absence (exact/Solana kind gone from /supported) => Solana removed + ALERT", async () => {
    expect(await hasSolana()).toBe(true);
    mode = "kind_absent";
    now += RAIL_TTL_MS + 1;
    await revalidateSolana();
    expect(await hasSolana()).toBe(false);
    expect(alerts).toEqual([{ kind: "solana_entry_dropped", reason: "payai_kind_absent" }]);
  });

  it("CONFIRMED absence (fee payer no longer on PayAI's live signer list) => Solana removed + ALERT", async () => {
    expect(await hasSolana()).toBe(true);
    mode = "feepayer_unlisted";
    now += RAIL_TTL_MS + 1;
    await revalidateSolana();
    expect(await hasSolana()).toBe(false);
    expect(alerts).toEqual([{ kind: "solana_entry_dropped", reason: "payai_kind_absent" }]);
  });

  it("an error AFTER a confirmed absence does not resurrect Solana", async () => {
    expect(await hasSolana()).toBe(true);
    mode = "kind_absent";
    now += RAIL_TTL_MS + 1;
    await revalidateSolana();
    expect(await hasSolana()).toBe(false);
    mode = "throw";
    now += 61_000;
    await revalidateSolana();
    expect(await hasSolana()).toBe(false);
  });

  it("errors beyond RAIL_MAX_STALE_MS (6 h) => fail closed with an ALERT (bounded last-known-good)", async () => {
    expect(RAIL_MAX_STALE_MS).toBe(6 * 60 * 60_000);
    expect(await hasSolana()).toBe(true);
    mode = "throw";
    now += RAIL_MAX_STALE_MS + 1;
    await revalidateSolana();
    expect(await hasSolana()).toBe(false);
    expect(alerts).toEqual([{ kind: "solana_entry_dropped", reason: "payai_supported_unavailable_stale" }]);
  });

  it("cold instance: init error still fails closed (no confirmed rail to keep), no ALERT", async () => {
    mode = "throw";
    expect(await hasSolana()).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("isConfirmedAbsence walks the SDK's 'Failed to initialize' cause chain", () => {
    const wrapped = new Error("Failed to initialize: no supported payment kinds loaded from any facilitator.", {
      cause: new SolanaRailAbsentError("PayAI does not list exactly one x402 v2 exact kind"),
    });
    expect(isConfirmedAbsence(wrapped)).toBe(true);
    expect(isConfirmedAbsence(new Error("Solana rail init timed out after 100ms"))).toBe(false);
    expect(isConfirmedAbsence(new Error("Failed to initialize", { cause: new TypeError("fetch failed") }))).toBe(false);
  });
});
