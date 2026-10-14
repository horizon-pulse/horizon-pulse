/**
 * XRPL flag ON (payTo ready): every route appends exactly one RLUSD entry
 * AFTER the unchanged Base entry (and after the Solana entry when that rail
 * is on too), in the PAYMENT-REQUIRED header (and the JSON body where the
 * body is a PaymentRequired), for GET json / GET browser / POST (http,
 * extract) 402s and OPTIONS, in CDP and local mode. Everything else
 * (resource, Bazaar extension, browser HTML, discovery docs) is unchanged.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { resetXrplRailForTests } from "@/lib/xrpl-rail";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { captureDiscovery, captureRoutes, type Captured } from "./helpers/capture";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import { PINNED_XRPL_PAYTO, payToForNet, T54_MAINNET, XRPL_FAC, installXrplFacilitators, setCdp, stubXrplOn } from "./helpers/xrpl-env";
import { PAYAI_FEE_PAYER, installRpc } from "./helpers/solana-env";
import { SOLANA_PAYTO } from "@/lib/solana-config";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

const header = (c: Captured) => c.headers.find(([k]) => k === "payment-required")?.[1];
const pr = (c: Captured) => decodePaymentRequiredHeader(header(c)!);

/** main's per-route Base prices (atomic USDC) and the RLUSD decimal value they must map to. */
const MAIN_PRICES: Record<string, [string, string]> = {
  pulse: ["2000", "0.002"], signals: ["5000", "0.005"], yield: ["20000", "0.02"], portfolio: ["40000", "0.04"],
  gas: ["2000", "0.002"], funding: ["3000", "0.003"], fetch: ["20000", "0.02"], http: ["10000", "0.01"],
  extract: ["15000", "0.015"], "x402-check": ["10000", "0.01"], screenshot: ["20000", "0.02"],
  search: ["30000", "0.03"], pdf: ["20000", "0.02"],
  // landed on main after rail-xrpl bef2ab6 (rebased onto 82ce1c3):
  "bazaar-check": ["10000", "0.01"], "market/search": ["5000", "0.005"], "market/quote": ["5000", "0.005"],
  "discourse/split": ["30000", "0.03"], // discourse-split 2026-10-13
  "tx-status": ["2000", "0.002"], // tx-status 2026-10-14
  "tokenized-stock": ["2000", "0.002"], // tokenized-stock 2026-10-14
  watch: ["2000", "0.002"], // watch 2026-10-14
};

const RLUSD = "524C555344000000000000000000000000000000";
const TESTNET_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const MAINNET_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

async function captureBoth() {
  setCdp(true);
  const cdp = await captureRoutes();
  setCdp(false);
  const local = await captureRoutes();
  return { cdp, local } as Record<"cdp" | "local", Record<string, Captured>>;
}

function expectShape(
  all: Record<"cdp" | "local", Record<string, Captured>>,
  extraEntries: (baseAmount: string, route: string) => unknown[],
) {
  let checked = 0;
  for (const mode of ["cdp", "local"] as const) {
    for (const [key, cap] of Object.entries(all[mode])) {
      const g = golden[mode][key] as Captured;
      expect(cap.status, key).toBe(g.status);
      const got = pr(cap);
      const base = pr(g);
      const { accepts: gotAccepts, ...gotRest } = got;
      const { accepts: baseAccepts, ...baseRest } = base;
      expect(JSON.stringify(gotRest), key).toBe(JSON.stringify(baseRest));
      expect(baseAccepts).toHaveLength(1);
      // Base entry FIRST and byte-identical.
      expect(JSON.stringify(gotAccepts[0]), key).toBe(JSON.stringify(baseAccepts[0]));
      expect(gotAccepts[0].network).toBe("eip155:8453");
      const route = key.split(" ")[1].replace("/api/", "");
      expect(baseAccepts[0].amount, key).toBe(MAIN_PRICES[route][0]);
      expect(gotAccepts.slice(1), key).toEqual(extraEntries(baseAccepts[0].amount, route));
      if (g.body.startsWith('{"x402Version"')) {
        expect(JSON.parse(cap.body).accepts).toEqual(gotAccepts);
      } else {
        expect(cap.body, key).toBe(g.body);
      }
      const strip = (h: [string, string][]) => h.filter(([k]) => k !== "payment-required" && k !== "content-length");
      expect(strip(cap.headers), key).toEqual(strip(g.headers));
      checked++;
    }
  }
  expect(checked).toBe(124); // as tests/solana-flag-on: 88 on main + 12 market-mvp + 6 discourse-split + 6 tx-status + 6 tokenized-stock + 6 watch
}

const xrplEntry = (route: string, network = "xrpl:1", issuer = TESTNET_ISSUER, extra: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network,
  amount: MAIN_PRICES[route][1],
  asset: RLUSD,
  payTo: payToForNet(network),
  maxTimeoutSeconds: 300,
  extra: { issuer, ...extra, areFeesSponsored: false },
});

describe("XRPL flag on", () => {
  beforeEach(() => {
    resetXrplRailForTests();
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("testnet default: Base first (unchanged), RLUSD second (xrpl:1, testnet issuer, pinned payTo), every route/method/mode", async () => {
    installXrplFacilitators();
    stubXrplOn();
    const all = await captureBoth();
    expectShape(all, (_amt, route) => [xrplEntry(route)]);
    expect(JSON.stringify(all.cdp)).not.toBe(JSON.stringify(golden.cdp));
  });

  it("HP_XRPL_ASSET_TRANSFER_METHOD=ticketSequence is advertised in extra", async () => {
    installXrplFacilitators();
    stubXrplOn({ HP_XRPL_ASSET_TRANSFER_METHOD: "ticketSequence" });
    const all = await captureBoth();
    expectShape(all, (_amt, route) => [xrplEntry(route, "xrpl:1", TESTNET_ISSUER, { assetTransferMethod: "ticketSequence" })]);
  });

  it("Solana AND XRPL on: order is Base, Solana, XRPL on every route (accepts[] are alternatives; Base unchanged)", async () => {
    installXrplFacilitators();
    installRpc("present");
    vi.unstubAllEnvs();
    vi.stubEnv("HP_SOLANA_ENABLED", "true");
    vi.stubEnv("HP_SOLANA_PAYTO", SOLANA_PAYTO);
    stubXrplOn({}, true, "ready", true);
    const all = await captureBoth();
    expectShape(all, (amt, route) => [
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: amt,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: SOLANA_PAYTO,
        maxTimeoutSeconds: 300,
        extra: { feePayer: PAYAI_FEE_PAYER },
      },
      xrplEntry(route),
    ]);
  });

  it("Bazaar: extensions on the 402 are byte-identical to main (CDP/Base stays the Bazaar entry)", async () => {
    installXrplFacilitators();
    stubXrplOn();
    setCdp(true);
    const cdp = await captureRoutes();
    for (const [key, cap] of Object.entries(cdp)) {
      expect(JSON.stringify(pr(cap).extensions), key).toBe(JSON.stringify(pr(golden.cdp[key]).extensions));
    }
  });

  it("discovery docs (/.well-known/x402, skill.md, openapi.json, llms.txt) unchanged with flag on", async () => {
    installXrplFacilitators();
    stubXrplOn();
    expect(JSON.stringify(await captureDiscovery())).toBe(JSON.stringify(golden.discovery));
  });

  it("XRPL facilitator is asked only for /supported on unpaid traffic, once (cached); RPC readiness checked once; CDP never sees XRPL", async () => {
    const calls = installXrplFacilitators();
    const rpc = stubXrplOn();
    await captureBoth();
    expect(calls.filter((c) => c.url === XRPL_FAC).map((c) => c.op)).toEqual(["supported"]);
    expect(calls.every((c) => c.url.startsWith(CDP_URL_PREFIX) || c.url === XRPL_FAC)).toBe(true);
    expect(calls.filter((c) => c.url.startsWith(CDP_URL_PREFIX)).every((c) => c.op === "supported")).toBe(true);
    expect(rpc.map((c) => c.method).sort()).toEqual(["account_info", "account_lines"]);
    expect(rpc.every((c) => c.url === "https://testnet.xrpl-labs.com/")).toBe(true);
  });
});
