/**
 * Odin 2:13 PM ET (4), Sentinel INFO-3: a REJECTED or UNAVAILABLE Solana payment's 402 lists every rail that is
 * healthy at that moment — Base, plus XRPL and Polygon when enabled and ready — not just Base. Each extra entry is
 * appended exactly as on the unpaid 402 (same payTo pins; verified against security/approved-addresses.md), and
 * PAYMENT-REQUIRED.error carries the reason. A rail that is not ready is left out.
 * Odin 2:29 (b) delta6: Solana itself is re-offered ONLY for a client-caused rejection (invalid_payload) while the
 * getSlot breaker is closed and the rail is present; never for rail_unavailable, an open breaker or an absent rail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { __flushSolanaBackgroundForTests, __setSolanaRpcForTests, resetSolanaRailForTests, SOLANA_SLOT_PROBE_INTERVAL_MS, solanaSlotBreakerOpen } from "@/lib/solana-rail";
import { __setXrplFacilitatorSchemeLoaderForTests, __setXrplRpcForTests, resetXrplRailForTests, setXrplReplayStoreForTests, xrplReplayEvalOk } from "@/lib/xrpl-rail";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";
import { resetPolygonRailForTests } from "@/lib/polygon-rail";
import { SOLANA_MAINNET_CAIP2, base58Encode } from "@/lib/solana-config";
import type { Captured } from "./helpers/capture";
import { expectRejectedGolden, expectRejectedGoldenPlus } from "./helpers/reject-header";
import { PAYAI_FEE_PAYER, installRpc, parseableSolanaTx, stubSolanaOn, type AtaMode } from "./helpers/solana-env";
import { PAYAI, installXrplFacilitators, installXrplRpc, type ReadyMode, type XrplRpcCall } from "./helpers/xrpl-env";
import type { FacilitatorBehaviour } from "./helpers/facilitator-mock";

// Copied from security/approved-addresses.md (Live receive addresses) and compared character for character.
const APPROVED_BASE = "0x5b32c973596078a967562ca652761404f19be0e9";
const APPROVED_XRPL = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
const APPROVED_POLYGON = "0x5b32c973596078a967562ca652761404f19be0e9";
const APPROVED_SOLANA = "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz";
const BASE = "eip155:8453";
const XRPL = "xrpl:0";
const POLY = "eip155:137";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));
const goldenPulseHeader = (golden.cdp["GET /api/pulse json"] as Captured).headers.find(([k]) => k === "payment-required")![1];

let ran = 0;
const handler = () =>
  createX402GetHandler(
    async () => {
      ran++;
      return NextResponse.json({ ok: true });
    },
    pulseRouteConfig(),
    pulseOpts,
  );
const unpaid = () => new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } });
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });
const pr = (res: Response) => decodePaymentRequiredHeader(res.headers.get("payment-required")!);
let tag = 1;
const solPayload = (accept: PaymentRequirements, tx = parseableSolanaTx(tag++ % 250)) => ({ x402Version: 2, accepted: accept, payload: { transaction: tx } }) as PaymentPayload;
/** A Solana requirement shaped like the live one (used when Solana is absent from the unpaid 402). */
// Odin 2:32 (3): the constant fields must match the route requirement exactly (checked locally before getSlot).
const SOL_SHAPE = { scheme: "exact", network: SOLANA_MAINNET_CAIP2, amount: pulseOpts.maxAmountRequired, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz", maxTimeoutSeconds: 300, extra: { feePayer: PAYAI_FEE_PAYER } } as PaymentRequirements;

let xrplRpcCalls: XrplRpcCall[] = [];
let xrplInits = 0;
function rails(o: { xrpl: ReadyMode | "off"; polygon: boolean; ata?: AtaMode; fac?: FacilitatorBehaviour }) {
  stubSolanaOn({}, true, o.ata ?? "present");
  if (o.xrpl !== "off") {
    // XRPL MAINNET (xrpl:0) through the real env parser (pinned-payTo gate), as in xrpl-cold-start-accepts: "self"
    // facilitator (scheme stubbed), shared-kind replay store, read-only RPC stub in the requested readiness mode.
    for (const [k, v] of Object.entries({
      HP_XRPL_ENABLED: "true",
      HP_XRPL_NETWORK: XRPL,
      HP_XRPL_PAYTO: APPROVED_XRPL,
      HP_XRPL_FACILITATOR_URL: "self",
      XRPL_MAINNET_ALLOWED: "true",
      UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
    }))
      vi.stubEnv(k, v);
    resetXrplRailForTests();
    setXrplReplayStoreForTests(Object.assign(new MemoryReplayStore(), { kind: "upstash" as const }) as never);
    xrplInits = 0;
    __setXrplFacilitatorSchemeLoaderForTests(async () => (xrplInits++, { getExtra: () => ({ areFeesSponsored: false }), verify: async () => ({ isValid: false }), settle: async () => ({ success: false }) }) as never);
    xrplRpcCalls = installXrplRpc(o.xrpl);
  }
  if (o.polygon) {
    vi.stubEnv("HP_POLYGON_ENABLED", "true");
    vi.stubEnv("HP_POLYGON_PAYTO", APPROVED_POLYGON);
    vi.stubEnv("HP_POLYGON_NETWORK", POLY);
  }
  installXrplFacilitators(o.fac);
}

beforeEach(() => {
  resetSolanaRailForTests();
  resetXrplRailForTests();
  resetPolygonRailForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  ran = 0;
});
afterEach(async () => {
  await __flushSolanaBackgroundForTests();
  __setSolanaRpcForTests(null);
  __setXrplRpcForTests(null);
  setXrplReplayStoreForTests(null);
  __setXrplFacilitatorSchemeLoaderForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Solana reject / unavailable 402 lists every healthy rail (Odin 2:13 (4)) + Solana re-offered only when client-caused (Odin 2:29 (b))", () => {
  const down = () => {
    throw new Error("down");
  };
  /** Trip the getSlot breaker: 5 VALID paid Solana requests whose getSlot fails (4 × 503, 5th = rail_unavailable). */
  async function tripBreaker(sol: PaymentRequirements) {
    installRpc("present", 0, undefined, down);
    for (let i = 0; i < 4; i++) expect((await handler()(paid(solPayload(sol)))).status).toBe(503);
    const fifth = await handler()(paid(solPayload(sol)));
    expect(fifth.status).toBe(402);
    expect(solanaSlotBreakerOpen()).toBe(true);
    return fifth;
  }

  it("delta6: invalid_payload, breaker CLOSED, all rails healthy → Base, Solana, XRPL, Polygon = the unpaid 402's own entries (approved pins)", async () => {
    rails({ xrpl: "ready", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    expect(open.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const res = await handler()(paid(solPayload(sol, parseableSolanaTx(7, { feeFill: 0x55 }))));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("invalid_payload");
    expect(solanaSlotBreakerOpen()).toBe(false);
    expect(h.accepts).toEqual(open);
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_SOLANA, APPROVED_XRPL, APPROVED_POLYGON]);
    expect(ran).toBe(0);
  });

  it("delta6: invalid_payload with the breaker OPEN → Solana excluded (Base, XRPL, Polygon)", async () => {
    rails({ xrpl: "ready", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    await tripBreaker(sol);
    const res = await handler()(paid(solPayload(sol, parseableSolanaTx(13, { feeFill: 0x55 }))));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
    expect(h.accepts).toEqual(open.filter((a) => a.network !== SOLANA_MAINNET_CAIP2));
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_XRPL, APPROVED_POLYGON]);
  });

  it("delta6: rail_unavailable from the open breaker → Solana excluded (Base, XRPL, Polygon)", async () => {
    rails({ xrpl: "ready", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const fifth = pr(await tripBreaker(sol));
    expect(fifth.error).toBe("rail_unavailable");
    expect(fifth.accepts.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
    expect(fifth.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_XRPL, APPROVED_POLYGON]);
  });

  it("delta6: rail_unavailable (Solana token account absent, breaker closed) → Solana excluded (Base, XRPL, Polygon)", async () => {
    rails({ xrpl: "ready", polygon: true, ata: "absent" });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    expect(open.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
    const res = await handler()(paid(solPayload(SOL_SHAPE)));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("rail_unavailable");
    expect(solanaSlotBreakerOpen()).toBe(false);
    expect(h.accepts).toEqual(open);
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_XRPL, APPROVED_POLYGON]);
  });

  it("delta6: invalid_payload while the Solana rail is ABSENT (token account missing) → Solana excluded (rail not otherwise present)", async () => {
    rails({ xrpl: "ready", polygon: true, ata: "absent" });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const res = await handler()(paid(solPayload(SOL_SHAPE, parseableSolanaTx(14, { feeFill: 0x55 }))));
    const h = pr(res);
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts).toEqual(open);
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
  });

  it("XRPL unavailable (payTo not activated) + Polygon on, invalid_payload → Base, Solana, Polygon", async () => {
    rails({ xrpl: "unactivated", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    expect(open.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, POLY]);
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const h = pr(await handler()(paid(solPayload(sol, parseableSolanaTx(8, { buyerFill: 0 })))));
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts).toEqual(open);
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_SOLANA, APPROVED_POLYGON]);
  });

  for (const mode of ["unactivated", "no_trustline"] as const) {
    it(`XRPL unavailable (${mode}), Polygon off: rail_unavailable → Base only, byte-identical to the golden Base-only reject; invalid_payload → golden Base + Solana`, async () => {
      rails({ xrpl: mode, polygon: false });
      const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
      expect(open.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2]);
      const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
      const inv = await handler()(paid(solPayload(sol, parseableSolanaTx(9, { buyerFill: 0 }))));
      expect(inv.status).toBe(402);
      expectRejectedGoldenPlus(inv.headers.get("payment-required"), goldenPulseHeader, "invalid_payload", [sol]);
      const unavailable = await tripBreaker(sol);
      expect(pr(unavailable).accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE]);
      expectRejectedGolden(unavailable.headers.get("payment-required"), goldenPulseHeader, "rail_unavailable");
    });
  }

  it("XRPL RPC error: the reject 402 follows the XRPL rail's own readiness exactly as the unpaid 402 does", async () => {
    rails({ xrpl: "error", polygon: false });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const h = pr(await handler()(paid(solPayload(sol, parseableSolanaTx(12, { buyerFill: 0 })))));
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts).toEqual(open);
  });

  it("XRPL + Polygon off (flags): invalid_payload → golden Base 402 + the Solana entry (pinned payTo)", async () => {
    rails({ xrpl: "off", polygon: false });
    const sol = (pr(await handler()(unpaid())).accepts as PaymentRequirements[]).find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    expect(sol.payTo).toBe(APPROVED_SOLANA);
    const res = await handler()(paid(solPayload(sol, parseableSolanaTx(10, { feeFill: 0x55 }))));
    expectRejectedGoldenPlus(res.headers.get("payment-required"), goldenPulseHeader, "invalid_payload", [sol]);
  });

  it("the re-offered entries are the unpaid 402's own (approved pins), and the Base entry is untouched", async () => {
    rails({ xrpl: "ready", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const h = pr(await handler()(paid(solPayload(sol, parseableSolanaTx(11, { feeFill: 0x55 })))));
    const g = decodePaymentRequiredHeader(goldenPulseHeader);
    expect(h.accepts[0]).toEqual(g.accepts[0]);
    expect(h.resource).toEqual(g.resource);
    expect(h.accepts[1]).toEqual(sol);
    expect(h.accepts[1].payTo).toBe(APPROVED_SOLANA);
    expect(h.accepts[2].payTo).toBe(APPROVED_XRPL);
    expect(h.accepts[3].payTo).toBe(APPROVED_POLYGON);
  });

  // ---- Odin 2:32 (1): never re-offer on verify / settle failures ----
  it("delta6 (1): PayAI verify refuses (verification_failed) → Solana NOT re-offered (Base, XRPL, Polygon)", async () => {
    rails({ xrpl: "ready", polygon: true, fac: { verify: (url) => (url === PAYAI ? { isValid: false, invalidReason: "invalid_exact_svm_payload_transaction" } : { isValid: true, payer: "0x" + "ab".repeat(20) }) } });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const res = await handler()(paid(solPayload(sol)));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).not.toBe("invalid_payload");
    expect(h.error).toMatch(/^[a-z0-9_]+$/);
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
    expect(ran).toBe(0);
  });

  it("Sentinel LOW (v3): PayAI verify answers \"invalid_payload\" (passed through as the reason) → Solana still NOT re-offered: only OUR local checks set the internal flag", async () => {
    rails({ xrpl: "ready", polygon: true, fac: { verify: (url) => (url === PAYAI ? { isValid: false, invalidReason: "invalid_payload" } : { isValid: true, payer: "0x" + "ab".repeat(20) }) } });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    expect(open.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const res = await handler()(paid(solPayload(sol)));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("invalid_payload"); // same TEXT as our own local reject…
    expect(solanaSlotBreakerOpen()).toBe(false);
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, XRPL, POLY]); // …but no Solana re-offer
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_XRPL, APPROVED_POLYGON]);
    expect(ran).toBe(0);
    // Control, same instance: OUR local invalid_payload (non-zero fee-payer slot) does re-offer Solana.
    const own = pr(await handler()(paid(solPayload(sol, parseableSolanaTx(23, { feeFill: 0x55 })))));
    expect(own.error).toBe("invalid_payload");
    expect(own.accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
  });

  it("Sentinel LOW (v3): the SECOND local site (post-init requirement check: fee payer ≠ PayAI) also flags the re-offer", async () => {
    rails({ xrpl: "ready", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    // key 0 = a non-PayAI fee payer that the client also put in accepted.extra.feePayer: passes the local checks,
    // fails validateSolanaPaymentPayload after init (extra ≠ the built requirement's), before PayAI.
    const raw = Buffer.from(parseableSolanaTx(24), "base64");
    Buffer.alloc(32, 0x31).copy(raw, 1 + 64 + 64 + 4);
    const other = base58Encode(new Uint8Array(32).fill(0x31));
    const res = await handler()(paid(solPayload({ ...sol, extra: { ...sol.extra, feePayer: other } } as PaymentRequirements, raw.toString("base64"))));
    const h = pr(res);
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
    expect(ran).toBe(0);
  });

  it("delta6 (1): PayAI settle fails definitively (transaction_failed) → Solana NOT re-offered (Base, XRPL, Polygon)", async () => {
    rails({
      xrpl: "ready",
      polygon: true,
      fac: {
        verify: () => ({ isValid: true, payer: "0x" + "ab".repeat(20) }),
        settle: (url, _p, r) => (url === PAYAI ? { success: false, errorReason: "transaction_failed", transaction: "", network: r.network } : { success: true, transaction: "0x" + "11".repeat(32), network: r.network }),
      },
    });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const res = await handler()(paid(solPayload(sol)));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("transaction_failed");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
  });

  // ---- Odin 2:32 (2) LOW-1: XRPL only if warm; no XRPL init on the reject path ----
  it("delta6 (2): COLD XRPL (never initialised on this instance) is left out of the reject 402 and NO XRPL init / RPC / EVAL runs", async () => {
    rails({ xrpl: "ready", polygon: true });
    const res = await handler()(paid(solPayload(SOL_SHAPE, parseableSolanaTx(15, { feeFill: 0x55 })))); // no unpaid 402 first: XRPL cold
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts.map((a) => a.network)).not.toContain(XRPL);
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, POLY]);
    expect(xrplInits).toBe(0);
    expect(xrplRpcCalls).toEqual([]);
    // Once warm (an unpaid 402 initialised it), the same reject lists XRPL.
    await handler()(unpaid());
    expect(xrplInits).toBe(1);
    const warm = pr(await handler()(paid(solPayload(SOL_SHAPE, parseableSolanaTx(16, { feeFill: 0x55 })))));
    expect(warm.accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
    expect(warm.accepts[2].payTo).toBe(APPROVED_XRPL);
    expect(xrplInits).toBe(1);
  });

  it("delta6 (2): cold XRPL on a rail_unavailable reject → left out, no XRPL init", async () => {
    rails({ xrpl: "ready", polygon: false, ata: "absent" });
    const res = await handler()(paid(solPayload(SOL_SHAPE)));
    const h = pr(res);
    expect(h.error).toBe("rail_unavailable");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE]);
    expect(xrplInits).toBe(0);
    expect(xrplRpcCalls).toEqual([]);
    expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader, "rail_unavailable");
  });

  it("delta6 (1): invalid_payload with the breaker OPEN and a getSlot probe DUE (node healthy again) → Solana excluded, no getSlot spent on the reject path", async () => {
    rails({ xrpl: "off", polygon: false });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    await tripBreaker(sol);
    const calls = installRpc("present"); // node healthy again
    // Past SOLANA_SLOT_PROBE_INTERVAL_MS since the trip: the unpaid-path recovery probe WOULD be due now.
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => t0 + SOLANA_SLOT_PROBE_INTERVAL_MS + 1_000);
    const res = await handler()(paid(solPayload(sol, parseableSolanaTx(21, { feeFill: 0x55 }))));
    const h = pr(res);
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE]);
    expect(calls.filter((c) => c.method === "getSlot")).toEqual([]);
    expect(solanaSlotBreakerOpen()).toBe(true);
    expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader, "invalid_payload");
    // Control: the probe really was due — the next UNPAID 402 runs it, closes the breaker and lists Solana again.
    expect(pr(await handler()(unpaid())).accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2]);
    expect(calls.filter((c) => c.method === "getSlot").length).toBe(1);
    expect(solanaSlotBreakerOpen()).toBe(false);
  });

  it("delta6 (2): XRPL warm but its replay-store EVAL probe has since FAILED → left out of the reject 402 (no re-probe on that path)", async () => {
    rails({ xrpl: "ready", polygon: false });
    let evalFails = false;
    let probes = 0;
    const store = Object.assign(new MemoryReplayStore(), {
      kind: "upstash" as const,
      probeEval: async () => {
        probes++;
        if (evalFails) throw new Error("NOSCRIPT");
      },
    });
    setXrplReplayStoreForTests(store as never);
    expect(pr(await handler()(unpaid())).accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL]);
    evalFails = true;
    setXrplReplayStoreForTests(store as never); // drop the cached pass
    expect(await xrplReplayEvalOk()).toBe(false);
    const before = probes;
    const h = pr(await handler()(paid(solPayload(SOL_SHAPE, parseableSolanaTx(22, { feeFill: 0x55 })))));
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2]);
    expect(probes).toBe(before);
    expect(xrplInits).toBe(1);
  });
});
