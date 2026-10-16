/**
 * x402-check gaps (branch fix/x402-check-gaps, 2026-10-16), found when x402-check
 * audited our own /api/pulse 402:
 * (1) an EIP-7702-delegated EOA (code 0xef0100 || delegate) is reported as
 *     payToType "eoa_7702" with payToDelegate, not "contract";
 * (2) XRPL accepts state decimal amounts ("0.002"): no "not an integer string"
 *     fail, RLUSD gets a label and amountUsd;
 * (3) Circle native USDC on Polygon PoS is a recognized asset.
 * Network fully mocked; nothing leaves the box, nothing is signed or paid.
 * Addresses here are dummies except public token/issuer/proxy contracts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fetch-url", async (orig) => {
  const real = await orig<typeof import("@/lib/fetch-url")>();
  return { ...real, assertSafePublicUrl: async (u: string) => ({ url: new URL(u) }) };
});

import { USDC_POLYGON } from "@/lib/polygon-config";
import { RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER } from "@/lib/xrpl-config";
import {
  X402_CHECK_METHODOLOGY,
  checkX402Endpoint,
  classifyCode,
  knownAsset,
  normalizeDecimal,
  xrplKnownAsset,
} from "@/lib/x402-check";

const PAYTO = "0x1111111111111111111111111111111111111111";
const DELEGATE = "0x7702cb554e6bfb442cb743a7df23154544a7176c"; // Base EIP7702Proxy (public contract)
const CODE_7702 = `0xef0100${DELEGATE.slice(2)}`;
const XRPL_PAYTO = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

const challenge = (xrplAmount = "0.002", issuer: string = RLUSD_MAINNET_ISSUER) => ({
  x402Version: 2,
  resource: { url: "https://s.example/api/pulse", description: "d", mimeType: "application/json" },
  accepts: [
    { scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYTO, maxTimeoutSeconds: 300 },
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "2000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "So11111111111111111111111111111111111111112", maxTimeoutSeconds: 300 },
    { scheme: "exact", network: "xrpl:0", amount: xrplAmount, asset: RLUSD_CURRENCY_HEX, payTo: XRPL_PAYTO, maxTimeoutSeconds: 300, extra: { issuer } },
    { scheme: "exact", network: "eip155:137", amount: "2000", asset: USDC_POLYGON, payTo: PAYTO, maxTimeoutSeconds: 300 },
  ],
  extensions: { bazaar: { info: { input: { type: "http", method: "GET" }, output: { type: "json" } }, schema: {} } },
});

/** Probe gets the 402; eth_getCode RPC calls get `code`. */
function stub(c: unknown, code: string) {
  const rpcCalls: string[] = [];
  vi.stubGlobal("fetch", async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.startsWith("https://s.example/")) return new Response("{}", { status: 402, headers: { "payment-required": b64(c) } });
    rpcCalls.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    expect(body.method).toBe("eth_getCode");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: code }), { status: 200 });
  });
  return rpcCalls;
}

afterEach(() => vi.unstubAllGlobals());

describe("(1) EIP-7702-delegated payTo", () => {
  it("classifyCode: empty = eoa, 0xef0100||addr = eoa_7702 with delegate, anything else = contract", () => {
    expect(classifyCode("0x")).toEqual({ type: "eoa", delegate: null });
    expect(classifyCode("0x0")).toEqual({ type: "eoa", delegate: null });
    expect(classifyCode(CODE_7702)).toEqual({ type: "eoa_7702", delegate: DELEGATE });
    expect(classifyCode(CODE_7702.toUpperCase().replace("0XEF", "0xef"))).toEqual({ type: "eoa_7702", delegate: DELEGATE });
    expect(classifyCode(`${CODE_7702}00`)).toEqual({ type: "contract", delegate: null }); // wrong length
    expect(classifyCode("0xef0000" + DELEGATE.slice(2))).toEqual({ type: "contract", delegate: null });
    expect(classifyCode("0x6080604052")).toEqual({ type: "contract", delegate: null });
  });

  it("end to end: Base payTo with 7702 code -> eoa_7702 + delegate + info check, no 'is a contract'", async () => {
    stub(challenge(), CODE_7702);
    const r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
    if (!r.ok) throw new Error(r.error);
    const base = r.accepts.find((a) => a.network === "eip155:8453")!;
    expect(base.payToType).toBe("eoa_7702");
    expect(base.payToDelegate).toBe(DELEGATE);
    const msgs = r.checks.filter((c) => c.id === "payto_type").map((c) => c.message);
    expect(msgs.some((m) => m.includes("EIP-7702 delegation to " + DELEGATE))).toBe(true);
    expect(msgs.some((m) => m.includes("is a contract"))).toBe(false);
    expect(X402_CHECK_METHODOLOGY.payToType).toMatch(/0xef0100/);
  });

  it("plain EOA and real contract are unchanged; payToDelegate null; non-EVM rails not checked", async () => {
    stub(challenge(), "0x");
    let r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
    if (!r.ok) throw new Error(r.error);
    expect(r.accepts[0]!.payToType).toBe("eoa");
    expect(r.accepts[0]!.payToDelegate).toBeNull();
    expect(r.accepts.find((a) => a.network === "xrpl:0")!.payToType).toBeNull();
    expect(r.accepts.find((a) => a.network === "eip155:137")!.payToType).toBeNull(); // Polygon getCode not in scope
    vi.unstubAllGlobals();
    stub(challenge(), "0x6080604052");
    r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
    if (!r.ok) throw new Error(r.error);
    expect(r.accepts[0]!.payToType).toBe("contract");
    expect(r.checks.some((c) => c.id === "payto_type" && c.message.includes("is a contract"))).toBe(true);
  });
});

describe("(2) XRPL decimal amounts", () => {
  it("RLUSD decimal amount: no amount fail, label and amountUsd filled", async () => {
    stub(challenge(), "0x");
    const r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
    if (!r.ok) throw new Error(r.error);
    const x = r.accepts.find((a) => a.network === "xrpl:0")!;
    expect(x.amountAtomic).toBe("0.002");
    expect(x.assetLabel).toBe("RLUSD (XRP Ledger)");
    expect(x.amountUsd).toBe("$0.002");
    expect(r.checks.filter((c) => c.level === "fail")).toEqual([]);
    expect(r.checks.some((c) => c.id === "asset")).toBe(false);
  });

  it("bad XRPL amounts still fail; EVM decimal amounts still fail", async () => {
    for (const bad of ["1e-3", "-0.002", ".5", "0.002.1", "abc", "01"]) {
      stub(challenge(bad), "0x");
      const r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
      if (!r.ok) throw new Error(r.error);
      expect(r.checks.some((c) => c.id === "amount" && c.level === "fail" && c.message.includes("accepts[2]")), bad).toBe(true);
      vi.unstubAllGlobals();
    }
    const c = challenge();
    c.accepts[0]!.amount = "0.002";
    stub(c, "0x");
    const r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
    if (!r.ok) throw new Error(r.error);
    expect(r.checks.some((k) => k.id === "amount" && k.level === "fail" && k.message.includes("accepts[0]") && k.message.includes("integer"))).toBe(true);
  });

  it("RLUSD needs Ripple's issuer for that network; otherwise unlabeled (no amountUsd)", async () => {
    stub(challenge("0.002", "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"), "0x");
    const r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
    if (!r.ok) throw new Error(r.error);
    const x = r.accepts.find((a) => a.network === "xrpl:0")!;
    expect(x.assetLabel).toBeNull();
    expect(x.amountUsd).toBeNull();
    expect(xrplKnownAsset("xrpl:0", "RLUSD", RLUSD_MAINNET_ISSUER)?.label).toBe("RLUSD (XRP Ledger)");
    expect(xrplKnownAsset("xrpl:1", RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER)).toBeUndefined();
    expect(xrplKnownAsset("eip155:8453", RLUSD_CURRENCY_HEX, RLUSD_MAINNET_ISSUER)).toBeUndefined();
  });

  it("normalizeDecimal", () => {
    expect(normalizeDecimal("0.0020")).toBe("0.002");
    expect(normalizeDecimal("1.0")).toBe("1");
    expect(normalizeDecimal("12")).toBe("12");
    expect(normalizeDecimal("1e-3")).toBeNull();
  });

  it("RLUSD stays out of KNOWN_ASSETS (shared with lib/market, which assumes atomic integers)", () => {
    expect(knownAsset(RLUSD_CURRENCY_HEX)).toBeUndefined();
  });
});

describe("(3) Polygon USDC", () => {
  it("native USDC on Polygon resolves (checksum or lowercase) and gets amountUsd", async () => {
    expect(knownAsset(USDC_POLYGON)).toEqual({ label: "USDC (Polygon)", decimals: 6, usd: true });
    expect(knownAsset(USDC_POLYGON.toLowerCase())?.label).toBe("USDC (Polygon)");
    stub(challenge(), "0x");
    const r = await checkX402Endpoint({ url: "https://s.example/api/pulse", method: "GET" });
    if (!r.ok) throw new Error(r.error);
    const p = r.accepts.find((a) => a.network === "eip155:137")!;
    expect(p.assetLabel).toBe("USDC (Polygon)");
    expect(p.amountUsd).toBe("$0.002");
    expect(r.checks.some((c) => c.id === "asset")).toBe(false);
  });
});

describe("recorded example (lib/route-examples.ts)", () => {
  it("x402-check example was re-recorded with the fixes: eoa_7702 + delegate, RLUSD and Polygon USDC labelled, 0 fails", async () => {
    const { OUTPUT_EXAMPLES } = await import("@/lib/route-examples");
    const ex = OUTPUT_EXAMPLES["/api/x402-check"] as {
      accepts: { network: string; assetLabel: string | null; amountUsd: string | null; payToType: string | null; payToDelegate: string | null }[];
      summary: { fail: number };
    };
    const by = Object.fromEntries(ex.accepts.map((a) => [a.network, a]));
    expect(by["eip155:8453"]!.payToType).toBe("eoa_7702");
    expect(by["eip155:8453"]!.payToDelegate).toBe(DELEGATE);
    expect(by["xrpl:0"]!.assetLabel).toBe("RLUSD (XRP Ledger)");
    expect(by["eip155:137"]!.assetLabel).toBe("USDC (Polygon)");
    expect(ex.accepts.every((a) => a.amountUsd === "$0.002")).toBe(true);
    expect(ex.summary.fail).toBe(0);
  });
});
