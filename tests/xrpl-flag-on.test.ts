/**
 * Flag ON: every route appends exactly one RLUSD entry AFTER the unchanged
 * Base entry, in the PAYMENT-REQUIRED header (and the JSON body where the body
 * is a PaymentRequired), for GET/POST 402s and OPTIONS, in CDP and local mode.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RLUSD_TESTNET_ISSUER } from "@x402/xrpl";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER } from "@/lib/xrpl-config";
import { resetXrplRailForTests } from "@/lib/xrpl-rail";
import { routeMetadata } from "@/lib/route-metadata";
import { captureRoutes, PAID_ROUTES, type Captured } from "./helpers/capture";
import { installBothFacilitators, setCdp, stubXrplOn, XRPL_PAYTO } from "./helpers/xrpl-env";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

const header = (c: Captured) => c.headers.find(([k]) => k === "payment-required")?.[1];
const pr = (c: Captured) => decodePaymentRequiredHeader(header(c)!);

/** USD price per route from the golden Base entry (atomic USDC, 6 decimals). */
function usdValue(atomic: string) {
  return (Number(atomic) / 1e6).toString();
}

async function captureBoth() {
  setCdp(true);
  const cdp = await captureRoutes();
  setCdp(false);
  const local = await captureRoutes();
  return { cdp, local } as Record<"cdp" | "local", Record<string, Captured>>;
}

describe("flag on", () => {
  beforeEach(() => {
    resetXrplRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("testnet: Base first (unchanged), RLUSD second, on every route/method/mode", async () => {
    installBothFacilitators();
    stubXrplOn();
    const all = await captureBoth();
    let checked = 0;
    for (const mode of ["cdp", "local"] as const) {
      for (const [key, cap] of Object.entries(all[mode])) {
        const g = golden[mode][key] as Captured;
        expect(cap.status, key).toBe(g.status);
        const got = pr(cap);
        const base = pr(g);
        // Everything except accepts is unchanged (resource, Bazaar extension, error, version).
        const { accepts: gotAccepts, ...gotRest } = got;
        const { accepts: baseAccepts, ...baseRest } = base;
        expect(JSON.stringify(gotRest), key).toBe(JSON.stringify(baseRest));
        expect(gotAccepts).toHaveLength(2);
        expect(baseAccepts).toHaveLength(1);
        expect(JSON.stringify(gotAccepts[0]), key).toBe(JSON.stringify(baseAccepts[0]));
        expect(gotAccepts[0].network).toBe("eip155:8453");

        const x = gotAccepts[1];
        expect(x, key).toEqual({
          scheme: "exact",
          network: "xrpl:1",
          amount: usdValue(baseAccepts[0].amount),
          asset: RLUSD_CURRENCY_HEX,
          payTo: XRPL_PAYTO,
          maxTimeoutSeconds: 300,
          extra: { issuer: RLUSD_TESTNET_ISSUER, areFeesSponsored: false },
        });
        expect(x.extra).not.toHaveProperty("sourceTag");
        expect(x.extra).not.toHaveProperty("decimals");

        // Body: a PaymentRequired body gets the same 2 entries; the CDP 402 body ({}) is untouched.
        if (g.body.startsWith('{"x402Version"')) {
          expect(JSON.parse(cap.body).accepts).toEqual(gotAccepts);
        } else if (!g.body.startsWith("<!doctype")) {
          expect(cap.body).toBe(g.body);
        }
        // Discovery copy on the browser 402 page is unchanged.
        if (g.body.startsWith("<!doctype")) expect(cap.body).toBe(g.body);
        checked++;
      }
    }
    expect(checked).toBe(82);
    // And it really differs from main (the byte comparison is meaningful).
    expect(JSON.stringify(all.cdp)).not.toBe(JSON.stringify(golden.cdp));
  });

  it("USD price check against route metadata coverage", () => {
    for (const r of PAID_ROUTES) expect(routeMetadata(`/api/${r}`)).toBeTruthy();
  });

  it("mainnet: xrpl:0 with Ripple's mainnet RLUSD issuer; only via an explicit facilitator", async () => {
    const calls = installBothFacilitators();
    stubXrplOn({ HP_XRPL_NETWORK: "xrpl:0", HP_XRPL_FACILITATOR_URL: "https://xrpl-facilitator.example.test" });
    const mod = await import("@/app/api/pulse/route");
    const { NextRequest } = await import("next/server");
    const res = await mod.GET(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
    const accepts = decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
    expect(accepts.map((a) => a.network)).toEqual(["eip155:8453", "xrpl:0"]);
    expect(accepts[1]).toMatchObject({ amount: "0.005", asset: RLUSD_CURRENCY_HEX, extra: { issuer: RLUSD_MAINNET_ISSUER, areFeesSponsored: false } });
    expect(calls.filter((c) => c.op === "supported").map((c) => c.url)).toContain("https://xrpl-facilitator.example.test");
  });

  it("ticketSequence opt-in is echoed in extra.assetTransferMethod", async () => {
    installBothFacilitators();
    stubXrplOn({ HP_XRPL_ASSET_TRANSFER_METHOD: "ticketSequence" });
    const mod = await import("@/app/api/fetch/route");
    const res = await mod.OPTIONS();
    const accepts = decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
    expect(accepts[1].extra).toEqual({ issuer: RLUSD_TESTNET_ISSUER, areFeesSponsored: false, assetTransferMethod: "ticketSequence" });
  });
});
