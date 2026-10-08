/**
 * Odin follow-up guards (2026-10-08):
 *   (b) token-account guard: Solana entry only while payTo's USDC ATA exists;
 *       re-checked (cached ~10 min), flips on automatically.
 *   (c) PayAI rejection reason logged server-side (no PII); client still gets
 *       exactly main's Base-only 402.
 *   (e) Bazaar stripped from incoming Solana payloads; never declared on PayAI.
 *   (f) fee payer must be on PayAI's live HTTPS signer list; else fail closed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  ATA_TTL_MS,
  RAIL_TTL_MS,
  SolanaOnlyFacilitatorClient,
  buildSolanaOnlyRoutes,
  redact,
  resetSolanaRailForTests,
  stripBazaar,
} from "@/lib/solana-rail";
import { SOLANA_MAINNET_CAIP2, SOLANA_PAYTO, SOLANA_PAYTO_USDC_ATA, getSolanaRailConfig } from "@/lib/solana-config";
import { createX402GetHandler, pulseRouteConfig, extractRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { captureDiscovery, captureRoutes, type Captured } from "./helpers/capture";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import {
  ATA_ACCOUNT_VALUE,
  PAYAI_FEE_PAYER,
  PAYAI_SUPPORTED,
  SOL_PAYER,
  fillerPubkey,
  ataCalls,
  installBothFacilitators,
  revalidateSolana,
  setAtaMode,
  setCdp,
  stubSolanaOn,
} from "./helpers/solana-env";

const PAYAI = "https://facilitator.payai.network";
const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));
const header = (c: Captured) => c.headers.find(([k]) => k === "payment-required")![1];

async function captureAll() {
  setCdp(true);
  const cdp = await captureRoutes();
  setCdp(false);
  const local = await captureRoutes();
  return { cdp, local, discovery: await captureDiscovery() };
}

function assertBaseFirstSolanaSecond(all: { cdp: Record<string, Captured>; local: Record<string, Captured> }) {
  let n = 0;
  for (const mode of ["cdp", "local"] as const) {
    for (const [key, cap] of Object.entries(all[mode])) {
      const got = decodePaymentRequiredHeader(header(cap)).accepts;
      const base = decodePaymentRequiredHeader(header(golden[mode][key])).accepts;
      expect(got.length, key).toBe(2);
      expect(JSON.stringify(got[0]), key).toBe(JSON.stringify(base[0]));
      expect(got[1]).toMatchObject({ network: SOLANA_MAINNET_CAIP2, payTo: SOLANA_PAYTO, amount: base[0].amount });
      n++;
    }
  }
  expect(n).toBe(82);
}

let now = 1_800_000_000_000;
function useClock() {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
}

const warnLines = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  resetSolanaRailForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("(b) token-account guard", () => {
  it("(b) account absent => every 402/OPTIONS + discovery byte-identical to main", async () => {
    installBothFacilitators();
    const rpc = stubSolanaOn({}, true, "absent");
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    // Cached: one RPC call for all 82 requests, read-only getAccountInfo on the pinned ATA.
    expect(rpc).toHaveLength(1); // absent → no receipt count either
    expect(rpc[0]).toMatchObject({ url: "https://api.mainnet-beta.solana.com", method: "getAccountInfo", account: SOLANA_PAYTO_USDC_ATA });
    expect(warnLines().some((l) => l.includes("token account not found"))).toBe(true);
  });

  it("(b) account present => Base first (unchanged) + Solana second on all 82", async () => {
    installBothFacilitators();
    stubSolanaOn({}, true, "present");
    const all = await captureAll();
    assertBaseFirstSolanaSecond(all);
    expect(JSON.stringify(all.discovery)).toBe(JSON.stringify(golden.discovery));
  });

  it("(b) flips to Solana automatically once the account exists (after the ~10 min cache), no restart", async () => {
    useClock();
    installBothFacilitators();
    const rpc = stubSolanaOn({}, true, "absent");
    const { cdp: before } = await captureAll();
    expect(JSON.stringify(before)).toBe(JSON.stringify(golden.cdp));

    setAtaMode(rpc, "present"); // account gets created on-chain
    now += ATA_TTL_MS - 1000; // still inside the cache window
    setCdp(true);
    expect(JSON.stringify(await captureRoutes())).toBe(JSON.stringify(golden.cdp));

    now += 2000; // cache expired → re-check (stale-while-revalidate: in the background)
    await revalidateSolana();
    const after = await captureAll();
    assertBaseFirstSolanaSecond(after);
    expect(ataCalls(rpc).length).toBe(2);
  });

  it("(b) and flips back off if the account disappears", async () => {
    useClock();
    installBothFacilitators();
    const rpc = stubSolanaOn({}, true, "present");
    setCdp(true);
    assertBaseFirstSolanaSecond({ cdp: await captureRoutes(), local: await (async () => { setCdp(false); return captureRoutes(); })() });
    setAtaMode(rpc, "absent");
    now += ATA_TTL_MS + 1;
    await revalidateSolana();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("(b) RPC unreachable => Base-only byte-identical to main (fail closed)", async () => {
    installBothFacilitators();
    stubSolanaOn({}, true, "error");
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("(b) account exists but is not payTo's initialized USDC account => Base-only", async () => {
    installBothFacilitators();
    const wrong = structuredClone(ATA_ACCOUNT_VALUE);
    (wrong.data.parsed.info as { owner: string }).owner = fillerPubkey(3);
    stubSolanaOn({}, true, () => ({ context: { slot: 1 }, value: wrong }));
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("(b) Solana-paid request while the account is absent => main's Base-only 402, PayAI never called", async () => {
    const calls = installBothFacilitators();
    const rpc = stubSolanaOn({}, true, "present");
    const accept = (await accepts())[1];
    setAtaMode(rpc, "absent");
    resetSolanaRailForTests();
    const res = await handler().handler(paid(solPayload(accept)));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(header(golden.cdp["GET /api/pulse json"]));
    expect(calls.some((c) => c.url === PAYAI && c.op !== "supported")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
const FAKE_TX = Buffer.alloc(400, 7).toString("base64");
const BASE_PAYER = `0x${"11".repeat(20)}`;

function handler(routes = pulseRouteConfig(), opts: { maxAmountRequired: string; resource: string; description: string } = pulseOpts) {
  const ran = { count: 0 };
  return {
    ran,
    handler: createX402GetHandler(async () => {
      ran.count++;
      return NextResponse.json({ ok: true });
    }, routes, opts),
  };
}
async function accepts(): Promise<PaymentRequirements[]> {
  const res = await handler().handler(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
}
function solPayload(accept: PaymentRequirements, extensions?: Record<string, unknown>): PaymentPayload {
  return { x402Version: 2, accepted: accept, payload: { transaction: FAKE_TX }, ...(extensions ? { extensions } : {}) } as PaymentPayload;
}
const paid = (p: PaymentPayload, url = "https://horizonpulse.dev/api/pulse") =>
  new NextRequest(url, { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });

type Seen = { op: string; url: string; payload: PaymentPayload };
function facilitators(sol: { verify?: () => unknown; settle?: () => unknown } = {}) {
  const seen: Seen[] = [];
  const calls = installBothFacilitators({
    verify: (url: string, p: PaymentPayload) => {
      seen.push({ op: "verify", url, payload: p });
      if (url.startsWith(CDP_URL_PREFIX)) return { isValid: true, payer: BASE_PAYER };
      return sol.verify ? sol.verify() : { isValid: true, payer: SOL_PAYER };
    },
    settle: (url: string, p: PaymentPayload, r: PaymentRequirements) => {
      seen.push({ op: "settle", url, payload: p });
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
      return sol.settle ? sol.settle() : { success: true, transaction: "5".repeat(87), network: r.network, payer: SOL_PAYER };
    },
  } as never);
  return { calls, seen };
}

describe("(c) PayAI rejection: logged server-side, client gets main's Base-only 402", () => {
  for (const [name, sol, expectIn] of [
    ["verify invalid", { verify: () => ({ isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_simulation_failed", invalidMessage: `account ${SOL_PAYER} insufficient funds`, payer: SOL_PAYER }) }, "reason=invalid_exact_svm_payload_transaction_simulation_failed"],
    ["verify throws", { verify: () => { throw new Error(`503 from facilitator for ${SOL_PAYER}`); } }, "PayAI verify threw"],
    ["settle failed", { settle: () => ({ success: false, errorReason: "transaction_failed", errorMessage: `tx ${"5".repeat(87)} failed`, transaction: "", network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER }) }, "reason=transaction_failed"],
  ] as const) {
    it(`(c) ${name}: exact Base-only 402 to client; reason logged; no payer/tx in log`, async () => {
      const { calls } = facilitators(sol as never);
      stubSolanaOn();
      const [, solAccept] = await accepts();
      calls.length = 0;
      const res = await handler().handler(paid(solPayload(solAccept)));
      expect(res.status).toBe(402);
      expect(res.headers.get("payment-required")).toBe(header(golden.cdp["GET /api/pulse json"]));
      expect(await res.text()).toBe(golden.cdp["GET /api/pulse json"].body);
      expect(calls.filter((c) => c.url.startsWith(CDP_URL_PREFIX) && c.op !== "supported")).toEqual([]);
      const lines = warnLines().filter((l) => l.startsWith("[solana-rail]"));
      expect(lines.some((l) => l.includes(expectIn))).toBe(true);
      for (const l of lines) {
        expect(l).not.toContain(SOL_PAYER);
        expect(l).not.toContain("5".repeat(40));
        expect(l).not.toContain(FAKE_TX.slice(0, 40));
      }
    });
  }

  it("(c) redact() strips addresses / signatures / hex / base64, keeps reason codes", () => {
    const line = redact(`reason=insufficient_funds payer=${SOL_PAYER} sig=${"5".repeat(87)} evm=0x${"ab".repeat(20)} tx=${FAKE_TX}`);
    expect(line).toContain("reason=insufficient_funds");
    expect(line).not.toContain(SOL_PAYER);
    expect(line).not.toMatch(/0x[0-9a-f]{8,}/);
    expect(line.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
describe("(e) Bazaar never reaches PayAI", () => {
  const BAZAAR = { bazaar: { info: { input: { type: "http", method: "GET" } }, schema: { type: "object" } } };

  it("(e) Solana payload carrying extensions.bazaar: stripped before PayAI verify + settle; payment settles", async () => {
    const { seen } = facilitators();
    stubSolanaOn();
    const [, solAccept] = await accepts();
    const run = handler();
    const res = await run.handler(paid(solPayload(solAccept, { ...BAZAAR, "other-ext": { keep: true } })));
    expect(res.status).toBe(200);
    expect(run.ran.count).toBe(1);
    const payai = seen.filter((s) => s.url === PAYAI);
    expect(payai.map((s) => s.op)).toEqual(["verify", "settle"]);
    for (const s of payai) {
      const ext = (s.payload as { extensions?: Record<string, unknown> }).extensions;
      expect(ext?.bazaar).toBeUndefined();
      expect(ext?.["other-ext"]).toEqual({ keep: true });
    }
  });

  it("(e) POST /api/extract Solana payload with bazaar only: stripped (extensions removed) and body preserved", async () => {
    const { seen } = facilitators();
    stubSolanaOn();
    const { paymentOpts: extractOpts } = await import("@/app/api/extract/handler");
    const h = handler(extractRouteConfig(), extractOpts);
    const unpaid = await h.handler(new NextRequest("https://horizonpulse.dev/api/extract", { method: "POST", headers: { accept: "application/json" } }));
    const solAccept = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!).accepts[1];
    let gotBody = "";
    const h2 = createX402GetHandler(async (r) => {
      gotBody = await r.text();
      return NextResponse.json({ ok: true });
    }, extractRouteConfig(), extractOpts);
    const req = new NextRequest("https://horizonpulse.dev/api/extract", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "payment-signature": encodePaymentSignatureHeader(solPayload(solAccept, BAZAAR)) },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const res = await h2(req);
    expect(res.status).toBe(200);
    expect(gotBody).toBe('{"url":"https://example.com"}');
    const v = seen.find((s) => s.url === PAYAI && s.op === "verify")!;
    expect((v.payload as { extensions?: unknown }).extensions).toBeUndefined();
  });

  it("(e) stripBazaar is a no-op without bazaar", () => {
    const p = solPayload({} as PaymentRequirements);
    expect(stripBazaar(p)).toBe(p);
  });

  it("(e) the Solana/PayAI side never declares Bazaar: routes carry no extensions; wrapper reports none", async () => {
    const cfg = getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO });
    if (!cfg.enabled) throw new Error("expected on");
    const { routeConfigs } = await allRouteConfigs();
    for (const rc of routeConfigs) {
      const base = Object.values(rc)[0] as { extensions?: Record<string, unknown> };
      expect(base.extensions?.bazaar).toBeDefined(); // Base keeps Bazaar
      const sol = buildSolanaOnlyRoutes(cfg.config, rc, "5000");
      for (const v of Object.values(sol)) {
        expect(v).not.toHaveProperty("extensions");
        expect((v as { accepts: unknown[] }).accepts).toHaveLength(1);
      }
    }
    installBothFacilitators();
    const w = new SolanaOnlyFacilitatorClient(new HTTPFacilitatorClient({ url: PAYAI }), SOLANA_MAINNET_CAIP2);
    const sup = await w.getSupported();
    expect(sup.extensions).toEqual([]);
    expect(PAYAI_SUPPORTED.extensions).toContain("bazaar"); // PayAI itself offers it; we drop it
  });
});

async function allRouteConfigs() {
  const m = await import("@/lib/x402-server");
  const routeConfigs = [
    m.pulseRouteConfig(), m.signalsRouteConfig(), m.yieldRouteConfig(), m.portfolioRouteConfig(), m.gasRouteConfig(),
    m.fundingRouteConfig(), m.fetchRouteConfig(), m.httpRouteConfig(), m.extractRouteConfig(), m.x402CheckRouteConfig(),
    m.screenshotRouteConfig(), m.searchRouteConfig(), m.pdfRouteConfig(),
  ];
  return { routeConfigs };
}

// ---------------------------------------------------------------------------
describe("(f) fee payer must be on PayAI's live signer list (fail closed)", () => {
  const withSigners = (signers: unknown, feePayer = PAYAI_FEE_PAYER) => ({
    ...PAYAI_SUPPORTED,
    signers,
    kinds: PAYAI_SUPPORTED.kinds.map((k: { network: string; scheme: string; extra?: object }) =>
      k.network === SOLANA_MAINNET_CAIP2 && k.scheme === "exact" ? { ...k, extra: { ...k.extra, feePayer } } : k,
    ),
  });

  it("(f) recorded live list contains the advertised fee payer (sanity)", () => {
    expect(PAYAI_SUPPORTED.signers["solana:*"]).toContain(PAYAI_FEE_PAYER);
  });

  it("(f) fee payer NOT on PayAI's live list => Base-only byte-identical to main", async () => {
    installBothFacilitators({ supported: () => withSigners(PAYAI_SUPPORTED.signers, fillerPubkey(12)) });
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(warnLines().some((l) => l.includes("not in PayAI's live Solana signer list"))).toBe(true);
  });

  it("(f) PayAI signer list missing/empty => Base-only (fail closed)", async () => {
    for (const signers of [undefined, {}, { "solana:*": [] }, { "eip155:*": [PAYAI_FEE_PAYER] }]) {
      resetSolanaRailForTests();
      installBothFacilitators({ supported: () => withSigners(signers) });
      stubSolanaOn();
      expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
      vi.restoreAllMocks();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    }
  });

  it("(f) PayAI list cannot be fetched => Base-only (fail closed)", async () => {
    installBothFacilitators({ supported: () => { throw new Error("fetch failed: ENOTFOUND facilitator.payai.network"); } });
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("(f) non-https facilitator URL => wrapper refuses (fail closed)", async () => {
    installBothFacilitators({ supported: () => PAYAI_SUPPORTED });
    const w = new SolanaOnlyFacilitatorClient(new HTTPFacilitatorClient({ url: "http://facilitator.payai.network" }), SOLANA_MAINNET_CAIP2);
    await expect(w.getSupported()).rejects.toThrow(/https/);
  });

  it("(f) network-specific signer list is honoured too", async () => {
    installBothFacilitators({ supported: () => withSigners({ [SOLANA_MAINNET_CAIP2]: [PAYAI_FEE_PAYER] }) });
    stubSolanaOn();
    setCdp(true);
    const res = await (await import("@/app/api/pulse/route")).GET(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
    expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts).toHaveLength(2);
  });

  it("(f) fee payer dropped from PayAI's list later => Base-only after the rail refresh (RAIL_TTL)", async () => {
    useClock();
    let list: string[] = [...PAYAI_SUPPORTED.signers["solana:*"]];
    installBothFacilitators({ supported: () => withSigners({ "solana:*": list }) });
    stubSolanaOn();
    setCdp(true);
    expect((await accepts()).length).toBe(2);
    list = list.filter((a) => a !== PAYAI_FEE_PAYER);
    now += RAIL_TTL_MS + 1;
    await revalidateSolana(); // background /supported refresh fails → rail retired (fail closed)
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });
});
