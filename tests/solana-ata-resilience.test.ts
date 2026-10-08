/**
 * Live fault 2026-10-08 ~2:00 PM ET: /api/search, /api/screenshot, /api/pdf
 * (and later /api/extract) served Base-only 402s because the read-only
 * token-account RPC (public mainnet-beta) timed out from Vercel; the old code
 * cached that error as "absent" for 60 s per instance. These tests pin the
 * fix: transient RPC errors never hide a confirmed account; a cold instance
 * retries once; a confirmed absence still hides it; a cold double failure
 * still fails closed but loudly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATA_COLD_ATTEMPTS,
  ATA_ERROR_RETRY_MS,
  ATA_MAX_STALE_MS,
  ATA_TTL_MS,
  __flushSolanaBackgroundForTests,
  __setSolanaRpcForTests,
  resetSolanaRailForTests,
  setSolanaAlertHook,
  solanaTokenAccountReady,
  type SolanaAlert,
} from "@/lib/solana-rail";
import {
  SOLANA_PAYTO,
  SOLANA_PAYTO_USDC_ATA,
  SPL_TOKEN_PROGRAM,
  USDC_SOLANA_MINT,
  getSolanaRailConfig,
  type SolanaRailConfig,
} from "@/lib/solana-config";

const PRESENT = {
  context: { slot: 1 },
  value: {
    owner: SPL_TOKEN_PROGRAM,
    data: { parsed: { type: "account", info: { mint: USDC_SOLANA_MINT, owner: SOLANA_PAYTO, state: "initialized" } } },
  },
};
const ABSENT = { context: { slot: 1 }, value: null };

type Mode = "present" | "absent" | "error";
let modes: Mode[] = [];
let calls: string[] = [];
let now = 1_800_000_000_000;
let alerts: SolanaAlert[] = [];

function config(): SolanaRailConfig {
  const r = getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO });
  if (!r.enabled) throw new Error("expected on");
  return r.config;
}

beforeEach(() => {
  resetSolanaRailForTests();
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  alerts = [];
  setSolanaAlertHook((a) => alerts.push(a));
  calls = [];
  modes = [];
  __setSolanaRpcForTests(async (_url, method, params) => {
    calls.push(method);
    if (method !== "getAccountInfo") return []; // allowance count (background)
    expect(params[0]).toBe(SOLANA_PAYTO_USDC_ATA);
    const m = modes.length > 1 ? modes.shift()! : modes[0];
    if (m === "error") throw new Error("The operation was aborted due to timeout");
    return m === "present" ? PRESENT : ABSENT;
  });
});
afterEach(() => {
  __setSolanaRpcForTests(null);
  setSolanaAlertHook(null);
  vi.restoreAllMocks();
});

const ataCalls = () => calls.filter((c) => c === "getAccountInfo").length;

describe("token-account guard: transient RPC errors (live fault 2026-10-08)", () => {
  it("cold: one RPC timeout then success => Solana shown (retried once)", async () => {
    expect(ATA_COLD_ATTEMPTS).toBe(2);
    modes = ["error", "present"];
    expect(await solanaTokenAccountReady(config())).toBe(true);
    expect(ataCalls()).toBe(2);
    expect(alerts).toHaveLength(0);
  });

  it("cold: both attempts fail => fail closed (Base-only) AND an ALERT line, retried after 60 s", async () => {
    modes = ["error"];
    expect(await solanaTokenAccountReady(config())).toBe(false);
    expect(ataCalls()).toBe(2);
    expect(alerts).toEqual([{ kind: "solana_entry_dropped", reason: "token_account_rpc_unavailable" }]);
    modes = ["present"];
    now += ATA_ERROR_RETRY_MS - 1;
    expect(await solanaTokenAccountReady(config())).toBe(false); // still inside the retry window
    now += 2;
    await solanaTokenAccountReady(config()); // background re-check
    await __flushSolanaBackgroundForTests();
    expect(await solanaTokenAccountReady(config())).toBe(true);
  });

  it("drop ALERT is rate-limited per instance", async () => {
    modes = ["error"];
    await solanaTokenAccountReady(config());
    now += ATA_ERROR_RETRY_MS + 1;
    await solanaTokenAccountReady(config());
    await __flushSolanaBackgroundForTests();
    expect(alerts).toHaveLength(1);
  });

  it("warm: confirmed present, then RPC errors on re-check => stays present (no Base-only flap)", async () => {
    modes = ["present"];
    expect(await solanaTokenAccountReady(config())).toBe(true);
    modes = ["error"];
    for (let i = 0; i < 5; i++) {
      now += ATA_TTL_MS + 1;
      expect(await solanaTokenAccountReady(config())).toBe(true);
      await __flushSolanaBackgroundForTests();
      expect(await solanaTokenAccountReady(config())).toBe(true);
    }
    expect(alerts).toHaveLength(0);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("keeping last confirmed result"))).toBe(true);
  });

  it("warm: a CONFIRMED absence still hides Solana (fail closed unchanged)", async () => {
    modes = ["present"];
    expect(await solanaTokenAccountReady(config())).toBe(true);
    modes = ["absent"];
    now += ATA_TTL_MS + 1;
    await solanaTokenAccountReady(config());
    await __flushSolanaBackgroundForTests();
    expect(await solanaTokenAccountReady(config())).toBe(false);
    // and a later RPC error does not resurrect it
    modes = ["error"];
    now += ATA_TTL_MS + 1;
    await solanaTokenAccountReady(config());
    await __flushSolanaBackgroundForTests();
    expect(await solanaTokenAccountReady(config())).toBe(false);
  });

  it("last-known-good expires after ATA_MAX_STALE_MS of continuous RPC errors => fail closed + ALERT", async () => {
    modes = ["present"];
    expect(await solanaTokenAccountReady(config())).toBe(true);
    modes = ["error"];
    now += ATA_MAX_STALE_MS + 1;
    await solanaTokenAccountReady(config());
    await __flushSolanaBackgroundForTests();
    expect(await solanaTokenAccountReady(config())).toBe(false);
    expect(alerts.map((a) => a.kind)).toEqual(["solana_entry_dropped"]);
  });
});
