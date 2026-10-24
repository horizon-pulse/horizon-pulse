/**
 * EURC on Base (lib/eurc-config.ts), HP_EURC_ENABLED, off by default.
 *  - flag off (and look-alike values): every 402 / OPTIONS / discovery byte equals the UNCHANGED golden
 *  - flag on: exactly one EURC entry appended on each of the 29 standard routes' 402 (CDP + local), none on premium
 *  - amount math + rounding, payTo exact (pinned config string), asset + decimals + EIP-712 domain
 *  - `priced` block on the EURC rail
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV, PAID_ROUTES, captureDiscovery, captureRoutes } from "./helpers/capture";
import { DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";
import {
  EURC_BASE,
  EURC_DECIMALS,
  EURUSD_RATE,
  EURUSD_RATE_DATE,
  eurcAtomicFromUsdAtomic,
  eurcEnabled,
  usdPriceToAtomic,
} from "@/lib/eurc-config";
import { baseRailFor, eurcRail, pricedBlock, runOnPaidRail } from "@/lib/paid-rail";

const ROOT = path.resolve(__dirname, "..");
const GOLDEN = readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8");
/** Typed independently of the code (Circle docs, Base mainnet). */
const CIRCLE_EURC_BASE = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";
const MAIN = "0x5b32c973596078a967562ca652761404f19be0e9";

async function captureWith(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
  vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
  const cdp = await captureRoutes();
  vi.stubEnv("CDP_API_KEY_ID", "");
  vi.stubEnv("CDP_API_KEY_SECRET", "");
  const local = await captureRoutes();
  return { cdp, local, discovery: await captureDiscovery() };
}

const header = (c: { headers: [string, string][] }) => c.headers.find(([k]) => k === "payment-required")?.[1];

beforeEach(() => {
  installFacilitatorMock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("constants", () => {
  it("asset is Circle's EURC on Base, 6 decimals; payTo is the pinned Main wallet", () => {
    expect(EURC_BASE).toBe(CIRCLE_EURC_BASE);
    expect(EURC_DECIMALS).toBe(6);
    expect(DEFAULT_PAY_TO).toBe(MAIN);
    expect(EURUSD_RATE).toBe("1.1193");
    expect(EURUSD_RATE_DATE).toBe("2026-10-23");
  });
  it("flag is exactly 'true'", () => {
    for (const v of ["", "TRUE", "1", " true", "true ", "false", "yes"]) {
      vi.stubEnv("HP_EURC_ENABLED", v);
      expect(eurcEnabled()).toBe(false);
    }
    vi.stubEnv("HP_EURC_ENABLED", "true");
    expect(eurcEnabled()).toBe(true);
  });
});

describe("amount math", () => {
  it("ceil(usd / rate * 1.01) at 6 decimals, known values", () => {
    expect(eurcAtomicFromUsdAtomic("2000")).toBe("1805"); // 2020/1.1193 = 1804.69
    expect(eurcAtomicFromUsdAtomic("3000")).toBe("2708"); // 3030/1.1193 = 2707.04
    expect(eurcAtomicFromUsdAtomic("10000")).toBe("9024"); // 10100/1.1193 = 9023.50
    expect(eurcAtomicFromUsdAtomic("30000")).toBe("27071"); // 30300/1.1193 = 27070.49
    expect(eurcAtomicFromUsdAtomic("1000000")).toBe("902350"); // 1010000/1.1193 = 902349.68
  });
  it("is the smallest integer whose value at the rate covers usd * 1.01 (never under)", () => {
    for (let usd = 1n; usd <= 50_000n; usd += 7n) {
      const e = BigInt(eurcAtomicFromUsdAtomic(usd));
      // e * 1.1193 >= usd * 1.01  <=>  e * 11193 * 100 >= usd * 101 * 10000
      expect(e * 11193n * 100n >= usd * 101n * 10000n).toBe(true);
      expect((e - 1n) * 11193n * 100n < usd * 101n * 10000n).toBe(true);
    }
  });
  it("exact division is not rounded up", () => {
    expect(eurcAtomicFromUsdAtomic("1000", "1", "1")).toBe("1000");
    expect(eurcAtomicFromUsdAtomic("1010", "1.01", "1")).toBe("1000");
  });
  it("rejects bad inputs", () => {
    expect(() => eurcAtomicFromUsdAtomic("0")).toThrow();
    expect(() => eurcAtomicFromUsdAtomic("10", "abc")).toThrow();
    expect(() => eurcAtomicFromUsdAtomic("10", "0")).toThrow();
  });
  it("USD price strings parse exactly", () => {
    expect(usdPriceToAtomic("$0.002")).toBe("2000");
    expect(usdPriceToAtomic("$0.015")).toBe("15000");
    expect(usdPriceToAtomic("$1")).toBe("1000000");
    expect(usdPriceToAtomic("0.01")).toBeNull();
    expect(usdPriceToAtomic("$0.0000001")).toBeNull();
    expect(usdPriceToAtomic(5)).toBeNull();
  });
});

describe("flag off: byte-identical to main (unchanged golden)", () => {
  for (const env of [{}, { HP_EURC_ENABLED: "TRUE" }, { HP_EURC_ENABLED: "1" }, { HP_EURC_ENABLED: " true" }, { HP_EURC_ENABLED: "false" }] as Record<string, string>[]) {
    it(`env ${JSON.stringify(env)}`, async () => {
      const all = await captureWith(env);
      expect(JSON.stringify(all, null, 1) + "\n").toBe(GOLDEN);
    });
  }
});

describe("flag on", () => {
  it("each standard route's 402 gains exactly one EURC entry (CDP + local); everything else unchanged", async () => {
    const off = JSON.parse(GOLDEN);
    const on = await captureWith({ HP_EURC_ENABLED: "true" });
    let checked = 0;
    for (const mode of ["cdp", "local"] as const) {
      for (const [key, cap] of Object.entries(on[mode])) {
        const before = off[mode][key];
        if (key.startsWith("OPTIONS")) {
          expect(JSON.stringify(cap)).toBe(JSON.stringify(before)); // OPTIONS unchanged (not in scope)
          continue;
        }
        const h = header(cap);
        const hb = header(before);
        expect(h && hb).toBeTruthy();
        const pr = decodePaymentRequiredHeader(h!);
        const pb = decodePaymentRequiredHeader(hb!);
        expect(pr.accepts.length).toBe(pb.accepts.length + 1);
        // existing entries untouched, in order
        expect(JSON.stringify(pr.accepts.slice(0, pb.accepts.length))).toBe(JSON.stringify(pb.accepts));
        const eurc = pr.accepts.filter((a) => a.asset.toLowerCase() === CIRCLE_EURC_BASE);
        expect(eurc).toHaveLength(1);
        const e = eurc[0];
        const usdc = pb.accepts.find((a) => a.asset === USDC_BASE)!;
        expect(e.scheme).toBe("exact");
        expect(e.network).toBe("eip155:8453");
        expect(e.asset).toBe(CIRCLE_EURC_BASE);
        expect(e.payTo).toBe(MAIN); // exact string
        expect(e.payTo).toBe(usdc.payTo);
        expect(e.amount).toBe(eurcAtomicFromUsdAtomic(usdc.amount));
        expect(e.maxTimeoutSeconds).toBe(usdc.maxTimeoutSeconds);
        expect(e.extra).toMatchObject({ name: "EURC", version: "2", eurUsdRate: "1.1193", rateDate: "2026-10-23", buffer: "1.01" });
        // the rest of the challenge (resource, extensions, x402Version) is unchanged
        const { accepts: _a, ...restOn } = pr as Record<string, unknown>;
        const { accepts: _b, ...restOff } = pb as Record<string, unknown>;
        expect(restOn).toEqual(restOff);
        checked++;
      }
    }
    // 28 captured routes x GET json + GET browser (+ 4 POST) x 2 modes
    expect(checked).toBe((PAID_ROUTES.length * 2 + 4) * 2);
    // discovery and public copy untouched
    expect(JSON.stringify(on.discovery)).toBe(JSON.stringify(off.discovery));
  });

  it("/api/batch (29th standard route) gains exactly one EURC entry", async () => {
    vi.stubEnv("HP_BATCH_ENABLED", "true");
    vi.stubEnv("HP_EURC_ENABLED", "true");
    vi.resetModules();
    const mod = await import("@/app/api/batch/route");
    const items = encodeURIComponent(JSON.stringify([{ route: "gas" }]));
    for (const cdp of [true, false]) {
      vi.stubEnv("CDP_API_KEY_ID", cdp ? CDP_ENV.CDP_API_KEY_ID : "");
      vi.stubEnv("CDP_API_KEY_SECRET", cdp ? CDP_ENV.CDP_API_KEY_SECRET : "");
      const res = await mod.GET(new NextRequest(`https://horizonpulse.dev/api/batch?items=${items}`, { headers: { accept: "application/json" } }));
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(pr.accepts.filter((a) => a.asset.toLowerCase() === CIRCLE_EURC_BASE)).toHaveLength(1);
      expect(pr.accepts.filter((a) => a.asset === USDC_BASE)).toHaveLength(1);
    }
  });

  it("premium ($1 brief, $5 Seller DD) stays USDC-only", async () => {
    vi.stubEnv("HP_EURC_ENABLED", "true");
    const { PREMIUM_TIERS } = await import("@/lib/premium/tiers");
    const { paymentRequired } = await import("@/lib/premium/payment");
    const { ddPaymentRequired } = await import("@/lib/seller-dd/handler");
    const bodies = [...PREMIUM_TIERS.map((t) => paymentRequired(t, "x")), ddPaymentRequired()];
    for (const b of bodies) {
      expect(b.accepts).toHaveLength(1);
      expect(b.accepts[0].asset).toBe(USDC_BASE);
    }
    // and no premium / seller-dd source references EURC
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
    for (const dir of ["lib/premium", "lib/seller-dd", "app/api/premium", "app/api/seller-dd", "app/api/research"]) {
      const abs = path.join(ROOT, dir);
      let files: string[] = [];
      try { files = walk(abs); } catch { continue; }
      for (const f of files) {
        const src = readFileSync(f, "utf8").toLowerCase();
        expect(src.includes("eurc"), f).toBe(false);
        expect(src.includes(CIRCLE_EURC_BASE), f).toBe(false);
      }
    }
  });
});

describe("priced block on the EURC rail", () => {
  it("EURC rail reports EURC atomic at the fixed rate; USDC rail unchanged", async () => {
    const usdc = await runOnPaidRail(() => ({ network: "base", asset: USDC_BASE, payTo: MAIN }), async () => new Response(JSON.stringify(pricedBlock("$0.01", "10000"))))(undefined as never);
    expect(await usdc.json()).toEqual({ amountUsd: "$0.01", amountAtomic: "10000", asset: USDC_BASE, network: "base", payTo: MAIN });
    const e = await runOnPaidRail(eurcRail, async () => new Response(JSON.stringify(pricedBlock("$0.01", "10000"))))(undefined as never);
    expect(await e.json()).toEqual({
      amountUsd: "$0.01", amountAtomic: "9024", asset: CIRCLE_EURC_BASE, network: "base", payTo: MAIN,
      currency: "EURC", eurUsdRate: "1.1193", rateDate: "2026-10-23",
    });
  });
  it("baseRailFor picks EURC only for an EURC payload", () => {
    const sig = (asset: string) =>
      new Request("https://x", { headers: { "payment-signature": encodePaymentSignatureHeader({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", asset, amount: "1", payTo: MAIN, maxTimeoutSeconds: 300, extra: {} }, payload: {} } as never) } });
    expect(baseRailFor(sig(CIRCLE_EURC_BASE)).asset).toBe(CIRCLE_EURC_BASE);
    expect(baseRailFor(sig(CIRCLE_EURC_BASE.toUpperCase().replace("0X", "0x"))).asset).toBe(CIRCLE_EURC_BASE);
    expect(baseRailFor(sig(USDC_BASE)).asset).toBe(USDC_BASE);
    expect(baseRailFor(new Request("https://x")).asset).toBe(USDC_BASE);
    expect(baseRailFor(new Request("https://x", { headers: { "payment-signature": "garbage" } })).asset).toBe(USDC_BASE);
  });
});

describe("paid path (mock facilitator, no network)", () => {
  it("an EURC payload is verified by the CDP client against the EURC requirement", async () => {
    const seen: any[] = [];
    vi.restoreAllMocks();
    installFacilitatorMock({
      verify: (_u, _p, r) => { seen.push(r); return { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }; },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("HP_EURC_ENABLED", "true");
    vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
    vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
    vi.resetModules();
    const mod = await import("@/app/api/gas/route");
    const unpaid = await mod.GET(new NextRequest("https://horizonpulse.dev/api/gas", { headers: { accept: "application/json" } }));
    const pr = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!);
    const accepted = pr.accepts.find((a) => a.asset === CIRCLE_EURC_BASE)!;
    const payload = {
      x402Version: 2, resource: pr.resource, accepted,
      payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x" + "22".repeat(20), to: MAIN, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "33".repeat(32) } },
    };
    const res = await mod.GET(new NextRequest("https://horizonpulse.dev/api/gas", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(payload as never) } }));
    expect(res.status).toBe(402);
    expect(seen).toHaveLength(1);
    expect(seen[0].asset).toBe(CIRCLE_EURC_BASE);
    expect(seen[0].payTo).toBe(MAIN);
    expect(seen[0].amount).toBe(eurcAtomicFromUsdAtomic("2000"));
    expect(seen[0].extra).toMatchObject({ name: "EURC", version: "2" });
  });
});

