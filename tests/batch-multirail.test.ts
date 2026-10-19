/**
 * /api/batch enabled path on every rail (Odin follow-up 10/19, after the HP_BATCH_ENABLED flip at dpl_8hRFoXHi…).
 * With HP_BATCH_ENABLED=true and Solana, XRPL (mainnet, ready) and Polygon on, the unpaid 402 on GET and POST
 * lists Base, Solana, XRPL and Polygon in that order, each at the batch price ($0.01) and each to the pinned payTo.
 * The pre-existing batch.test.ts only checked accepts[0] (Base).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { BATCH_PRICE_ATOMIC, BATCH_PRICE_USD } from "@/lib/config";
import * as route from "@/app/api/batch/route";
import { __flushSolanaBackgroundForTests, __setSolanaRpcForTests, resetSolanaRailForTests } from "@/lib/solana-rail";
import { __setXrplFacilitatorSchemeLoaderForTests, __setXrplRpcForTests, resetXrplRailForTests, setXrplReplayStoreForTests } from "@/lib/xrpl-rail";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";
import { resetPolygonRailForTests } from "@/lib/polygon-rail";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/solana-config";
import { stubSolanaOn } from "./helpers/solana-env";
import { installXrplFacilitators, installXrplRpc } from "./helpers/xrpl-env";

// Copied programmatically from security/approved-addresses.md rows 8 (Base), 9 (Solana), 10 (XRPL), 11 (Polygon);
// compared character for character.
const APPROVED_BASE = "0x5b32c973596078a967562ca652761404f19be0e9";
const APPROVED_SOLANA = "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz";
const APPROVED_XRPL = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
const APPROVED_POLYGON = "0x5b32c973596078a967562ca652761404f19be0e9";
const BASE = "eip155:8453";
const XRPL = "xrpl:0";
const POLY = "eip155:137";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

const ITEMS = [{ route: "gas" }];
const unpaidPost = () =>
  new NextRequest("https://horizonpulse.dev/api/batch", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ items: ITEMS }) });
const unpaidGet = () => new NextRequest(`https://horizonpulse.dev/api/batch?items=${encodeURIComponent(JSON.stringify(ITEMS))}`, { headers: { accept: "application/json" } });

function allRailsOn() {
  stubSolanaOn({ HP_BATCH_ENABLED: "true" }, true, "present"); // stubSolanaOn unstubs all env first
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
  installXrplRpc("ready");
  vi.stubEnv("HP_POLYGON_ENABLED", "true");
  vi.stubEnv("HP_POLYGON_PAYTO", APPROVED_POLYGON);
  vi.stubEnv("HP_POLYGON_NETWORK", POLY);
  installXrplFacilitators();
}

beforeEach(() => {
  resetSolanaRailForTests();
  resetXrplRailForTests();
  resetPolygonRailForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
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

describe("/api/batch enabled: unpaid 402 on all four rails at $0.01 to the approved payTo", () => {
  for (const [name, mk] of [
    ["POST", unpaidPost],
    ["GET", unpaidGet],
  ] as const) {
    it(`${name}: Base, Solana, XRPL, Polygon in order; amounts = $0.01; payTo = approved-addresses rows 8/9/10/11`, async () => {
      allRailsOn();
      const res = await (name === "POST" ? route.POST : route.GET)(mk());
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(pr.accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
      const by = Object.fromEntries(pr.accepts.map((a) => [a.network, a]));
      expect(BATCH_PRICE_USD).toBe("$0.01");
      expect(BATCH_PRICE_ATOMIC).toBe("10000");
      // Base + Solana + Polygon: USDC, 6 decimals -> 10000 atomic = $0.01
      expect(by[BASE]).toMatchObject({ scheme: "exact", amount: BATCH_PRICE_ATOMIC, asset: USDC_BASE, payTo: APPROVED_BASE });
      expect(by[SOLANA_MAINNET_CAIP2]).toMatchObject({ scheme: "exact", amount: BATCH_PRICE_ATOMIC, asset: USDC_SOLANA, payTo: APPROVED_SOLANA });
      expect(by[POLY]).toMatchObject({ scheme: "exact", amount: BATCH_PRICE_ATOMIC, asset: USDC_POLYGON, payTo: APPROVED_POLYGON });
      // XRPL: RLUSD decimal string, 0.01
      expect(by[XRPL]).toMatchObject({ amount: "0.01", payTo: APPROVED_XRPL });
      expect(pr.accepts.map((a) => a.payTo)).toEqual([APPROVED_BASE, APPROVED_SOLANA, APPROVED_XRPL, APPROVED_POLYGON]);
    });
  }

  it("unpaid bad input is still a 402 on every rail (payment before validation; no item runs unpaid)", async () => {
    allRailsOn();
    const res = await route.POST(new NextRequest("https://horizonpulse.dev/api/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [] }) }));
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.accepts.map((a) => a.network)).toEqual([BASE, SOLANA_MAINNET_CAIP2, XRPL, POLY]);
  });
});
