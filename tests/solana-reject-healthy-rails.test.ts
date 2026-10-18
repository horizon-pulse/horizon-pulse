/**
 * Odin 2:13 PM ET (4), Sentinel INFO-3: a REJECTED or UNAVAILABLE Solana payment's 402 lists every rail that is
 * healthy at that moment — Base, plus XRPL and Polygon when enabled and ready — not just Base. Each extra entry is
 * appended exactly as on the unpaid 402 (same payTo pins; verified against security/approved-addresses.md), Solana
 * itself is not re-offered, and PAYMENT-REQUIRED.error carries the reason. A rail that is not ready is left out
 * (XRPL unavailable + Polygon off → Base only, byte-identical to the golden Base-only reject).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { __flushSolanaBackgroundForTests, __setSolanaRpcForTests, resetSolanaRailForTests } from "@/lib/solana-rail";
import { __setXrplFacilitatorSchemeLoaderForTests, __setXrplRpcForTests, resetXrplRailForTests, setXrplReplayStoreForTests } from "@/lib/xrpl-rail";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";
import { resetPolygonRailForTests } from "@/lib/polygon-rail";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/solana-config";
import type { Captured } from "./helpers/capture";
import { expectRejectedGolden } from "./helpers/reject-header";
import { parseableSolanaTx, stubSolanaOn, type AtaMode } from "./helpers/solana-env";
import { installXrplFacilitators, installXrplRpc, type ReadyMode } from "./helpers/xrpl-env";

// Copied from security/approved-addresses.md (Live receive addresses) and compared character for character.
const APPROVED_BASE = "0x5b32c973596078a967562ca652761404f19be0e9";
const APPROVED_XRPL = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
const APPROVED_POLYGON = "0x5b32c973596078a967562ca652761404f19be0e9";
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
const SOL_SHAPE = { scheme: "exact", network: SOLANA_MAINNET_CAIP2, amount: "2000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz", maxTimeoutSeconds: 60, extra: {} } as PaymentRequirements;

function rails(o: { xrpl: ReadyMode | "off"; polygon: boolean; ata?: AtaMode }) {
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
    __setXrplFacilitatorSchemeLoaderForTests(async () => ({ getExtra: () => ({ areFeesSponsored: false }), verify: async () => ({ isValid: false }), settle: async () => ({ success: false }) }) as never);
    installXrplRpc(o.xrpl);
  }
  if (o.polygon) {
    vi.stubEnv("HP_POLYGON_ENABLED", "true");
    vi.stubEnv("HP_POLYGON_PAYTO", APPROVED_POLYGON);
    vi.stubEnv("HP_POLYGON_NETWORK", POLY);
  }
  installXrplFacilitators();
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

describe("Solana reject / unavailable 402 lists every healthy rail (Odin 2:13 (4))", () => {
  it("invalid_payload with Base + XRPL + Polygon healthy → 402 lists Base, XRPL, Polygon (same entries + payTo pins as the unpaid 402; no Solana)", async () => {
    rails({ xrpl: "ready", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    expect(open.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const res = await handler()(paid(solPayload(sol, parseableSolanaTx(7, { feeFill: 0x55 }))));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
    expect(h.accepts).toEqual(open.filter((a) => a.network !== SOLANA_MAINNET_CAIP2));
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_XRPL, APPROVED_POLYGON]);
    expect(ran).toBe(0);
  });

  it("rail_unavailable (Solana token account absent) with XRPL + Polygon healthy → Base, XRPL, Polygon", async () => {
    rails({ xrpl: "ready", polygon: true, ata: "absent" });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    expect(open.map((a) => a.network)).toEqual([BASE, XRPL, POLY]);
    const res = await handler()(paid(solPayload(SOL_SHAPE)));
    expect(res.status).toBe(402);
    const h = pr(res);
    expect(h.error).toBe("rail_unavailable");
    expect(h.accepts).toEqual(open);
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_XRPL, APPROVED_POLYGON]);
  });

  it("XRPL unavailable (payTo not activated) + Polygon on → Base + Polygon only", async () => {
    rails({ xrpl: "unactivated", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    expect(open.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, POLY]);
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const h = pr(await handler()(paid(solPayload(sol, parseableSolanaTx(8, { buyerFill: 0 })))));
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts.map((a) => a.network)).toEqual([BASE, POLY]);
    expect(h.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_POLYGON]);
  });

  for (const mode of ["unactivated", "no_trustline"] as const) {
    it(`XRPL unavailable (${mode}), Polygon off → Base only: byte-identical to the golden Base-only reject`, async () => {
      rails({ xrpl: mode, polygon: false });
      const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
      expect(open.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2]);
      const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
      const res = await handler()(paid(solPayload(sol, parseableSolanaTx(9, { buyerFill: 0 }))));
      expect(res.status).toBe(402);
      expect(pr(res).accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE]);
      expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader, "invalid_payload");
    });
  }

  it("XRPL RPC error: the reject 402 follows the XRPL rail's own readiness exactly as the unpaid 402 does (same entries minus Solana)", async () => {
    rails({ xrpl: "error", polygon: false });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const h = pr(await handler()(paid(solPayload(sol, parseableSolanaTx(12, { buyerFill: 0 })))));
    expect(h.error).toBe("invalid_payload");
    expect(h.accepts).toEqual(open.filter((a) => a.network !== SOLANA_MAINNET_CAIP2));
  });

  it("XRPL + Polygon off (flags) → unchanged Base-only golden reject", async () => {
    rails({ xrpl: "off", polygon: false });
    const sol = (pr(await handler()(unpaid())).accepts as PaymentRequirements[]).find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const res = await handler()(paid(solPayload(sol, parseableSolanaTx(10, { feeFill: 0x55 }))));
    expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader, "invalid_payload");
  });

  it("the extra rails' entries are the unpaid 402's own (approved pins), and the Base entry is untouched", async () => {
    rails({ xrpl: "ready", polygon: true });
    const open = pr(await handler()(unpaid())).accepts as PaymentRequirements[];
    const sol = open.find((a) => a.network === SOLANA_MAINNET_CAIP2)!;
    const h = pr(await handler()(paid(solPayload(sol, parseableSolanaTx(11, { feeFill: 0x55 })))));
    const g = decodePaymentRequiredHeader(goldenPulseHeader);
    expect(h.accepts[0]).toEqual(g.accepts[0]);
    expect(h.resource).toEqual(g.resource);
    expect(h.accepts[1].payTo).toBe(APPROVED_XRPL);
    expect(h.accepts[2].payTo).toBe(APPROVED_POLYGON);
  });
});
