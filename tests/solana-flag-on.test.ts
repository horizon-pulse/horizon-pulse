/**
 * Flag ON: every route appends exactly one Solana USDC entry AFTER the
 * unchanged Base entry, in the PAYMENT-REQUIRED header (and the JSON body
 * where the body is a PaymentRequired), for GET json / GET browser / POST
 * (http, extract) 402s and OPTIONS, in CDP and local mode. Everything else
 * (resource, Bazaar extension, browser HTML, discovery docs) is unchanged.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { captureDiscovery, captureRoutes, type Captured } from "./helpers/capture";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { PAYAI_FEE_PAYER, PINNED_PAYTO, installBothFacilitators, setCdp, stubSolanaOn } from "./helpers/solana-env";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

const header = (c: Captured) => c.headers.find(([k]) => k === "payment-required")?.[1];
const pr = (c: Captured) => decodePaymentRequiredHeader(header(c)!);

/** main's per-route Base prices (atomic USDC) — must be matched exactly on Solana. */
const MAIN_PRICES: Record<string, string> = {
  pulse: "5000", signals: "15000", yield: "20000", portfolio: "40000", gas: "10000", funding: "10000",
  fetch: "20000", http: "10000", extract: "15000", "x402-check": "10000", "bazaar-check": "10000", screenshot: "20000",
  search: "30000", pdf: "20000",
};

async function captureBoth() {
  setCdp(true);
  const cdp = await captureRoutes();
  setCdp(false);
  const local = await captureRoutes();
  return { cdp, local } as Record<"cdp" | "local", Record<string, Captured>>;
}

describe("flag on", () => {
  beforeEach(() => {
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("Base first (unchanged), Solana second, on every route/method/mode", async () => {
    installBothFacilitators();
    stubSolanaOn();
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
        // Base entry first and byte-identical.
        expect(JSON.stringify(gotAccepts[0]), key).toBe(JSON.stringify(baseAccepts[0]));
        expect(gotAccepts[0].network).toBe("eip155:8453");

        const route = key.split(" ")[1].replace("/api/", "");
        expect(baseAccepts[0].amount, key).toBe(MAIN_PRICES[route]);
        expect(gotAccepts[1], key).toEqual({
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          amount: baseAccepts[0].amount,
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          payTo: "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz",
          maxTimeoutSeconds: 300,
          extra: { feePayer: PAYAI_FEE_PAYER },
        });
        expect(gotAccepts[1].payTo).toBe(PINNED_PAYTO);

        // Body: a PaymentRequired body gets the same 2 entries; other bodies untouched.
        if (g.body.startsWith('{"x402Version"')) {
          expect(JSON.parse(cap.body).accepts).toEqual(gotAccepts);
        } else {
          // CDP 402 body ({}) and the browser HTML page are byte-identical.
          expect(cap.body, key).toBe(g.body);
        }
        // Headers other than PAYMENT-REQUIRED / content-length are unchanged.
        const strip = (h: [string, string][]) => h.filter(([k]) => k !== "payment-required" && k !== "content-length");
        expect(strip(cap.headers), key).toEqual(strip(g.headers));
        checked++;
      }
    }
    expect(checked).toBe(88);
    expect(JSON.stringify(all.cdp)).not.toBe(JSON.stringify(golden.cdp));
  });

  it("Bazaar: extensions on the 402 are byte-identical to main (CDP/Base stays the Bazaar entry)", async () => {
    installBothFacilitators();
    stubSolanaOn();
    setCdp(true);
    const cdp = await captureRoutes();
    for (const [key, cap] of Object.entries(cdp)) {
      expect(JSON.stringify(pr(cap).extensions), key).toBe(JSON.stringify(pr(golden.cdp[key]).extensions));
    }
  });

  it("discovery docs (/.well-known/x402, skill.md, openapi.json, llms.txt) unchanged with flag on", async () => {
    installBothFacilitators();
    stubSolanaOn();
    expect(JSON.stringify(await captureDiscovery())).toBe(JSON.stringify(golden.discovery));
  });

  it("PayAI is asked only for /supported on unpaid traffic, once (cached); CDP never sees Solana", async () => {
    const calls = installBothFacilitators();
    stubSolanaOn();
    await captureBoth();
    const payai = calls.filter((c) => c.url === "https://facilitator.payai.network");
    expect(payai.map((c) => c.op)).toEqual(["supported"]);
    expect(calls.filter((c) => c.url.startsWith(CDP_URL_PREFIX)).every((c) => c.op === "supported")).toBe(true);
    expect(calls.every((c) => c.url.startsWith(CDP_URL_PREFIX) || c.url === "https://facilitator.payai.network")).toBe(true);
  });
});
