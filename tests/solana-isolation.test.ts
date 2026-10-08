/**
 * Isolation: no Solana/PayAI failure may change the Base path.
 *   - unpaid 402 / OPTIONS: byte-identical to the main golden when the
 *     @x402/svm import fails, the scheme throws, PayAI is down / hangs /
 *     lacks Solana mainnet / lacks a fee payer, or the SDK builds an
 *     unexpected requirement
 *   - paid: Base payloads go only to CDP and settle exactly as with the flag
 *     off; Solana payloads go only to PayAI; a Solana verify failure/throw or a
 *     definitive settle failure returns the exact Base-only 402, an ambiguous
 *     settle a generic 502/504 (never 402); none ever reaches the Base path.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { __loadRealSolanaModulesForTests, __setSolanaModuleLoaderForTests, resetSolanaRailForTests, type SolanaModules } from "@/lib/solana-rail";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { captureRoutes, captureDiscovery, type Captured } from "./helpers/capture";
import { CDP_URL_PREFIX, type FacilitatorCall } from "./helpers/facilitator-mock";
import { PAYAI_SUPPORTED, SOL_PAYER, fillerPubkey, installBothFacilitators, setCdp, stubSolanaOn } from "./helpers/solana-env";

const PAYAI = "https://facilitator.payai.network";
const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

async function captureAll() {
  setCdp(true);
  const cdp = await captureRoutes();
  setCdp(false);
  const local = await captureRoutes();
  return { cdp, local, discovery: await captureDiscovery() };
}

const solanaWarned = () => vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).startsWith("[solana-rail]"));

async function realModules(): Promise<SolanaModules> {
  return __loadRealSolanaModulesForTests();
}

function payaiWithoutSolanaMainnet() {
  return {
    ...PAYAI_SUPPORTED,
    kinds: PAYAI_SUPPORTED.kinds.filter((k: { network: string }) => k.network !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
  };
}

describe("unpaid isolation: Solana failures serve the exact main 402", () => {
  beforeEach(() => {
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    __setSolanaModuleLoaderForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("@x402/svm import throws", async () => {
    installBothFacilitators();
    __setSolanaModuleLoaderForTests(() => Promise.reject(new Error("Cannot find module '@x402/svm'")));
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(solanaWarned()).toBe(true);
  });

  it("Solana scheme constructor throws", async () => {
    installBothFacilitators();
    const real = await realModules();
    __setSolanaModuleLoaderForTests(async () => ({
      ...real,
      ExactSvmScheme: class {
        constructor() {
          throw new Error("ctor boom");
        }
      } as never,
    }));
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("SDK constants disagree with our pinned mint (supply-chain guard)", async () => {
    installBothFacilitators();
    const real = await realModules();
    __setSolanaModuleLoaderForTests(async () => ({ ...real, USDC_MAINNET_ADDRESS: fillerPubkey(4) }));
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("SDK builds a requirement with a different payTo/asset (post-build assert)", async () => {
    installBothFacilitators();
    const real = await realModules();
    type Enh = { enhancePaymentRequirements(...a: unknown[]): Promise<PaymentRequirements> };
    class Tampering extends (real.ExactSvmScheme as unknown as new () => Enh) {
      async enhancePaymentRequirements(...a: unknown[]) {
        const r = await super.enhancePaymentRequirements(...a);
        return { ...r, payTo: fillerPubkey(6) };
      }
    }
    __setSolanaModuleLoaderForTests(async () => ({ ...real, ExactSvmScheme: Tampering as never }));
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(solanaWarned()).toBe(true);
  });

  it("PayAI unreachable (failure cached: one attempt for 82 requests)", async () => {
    const calls = installBothFacilitators({
      supported: () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    });
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(calls.filter((c) => c.op === "supported" && c.url === PAYAI).length).toBe(1);
  });

  it("PayAI hangs: bounded by HP_SOLANA_INIT_TIMEOUT_MS", async () => {
    installBothFacilitators({ supported: () => new Promise(() => {}) });
    stubSolanaOn({ HP_SOLANA_INIT_TIMEOUT_MS: "150" });
    const t0 = Date.now();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("PayAI does not list x402 v2 exact on Solana mainnet", async () => {
    installBothFacilitators({ supported: () => payaiWithoutSolanaMainnet() });
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("PayAI lists Solana mainnet but without a valid feePayer", async () => {
    installBothFacilitators({
      supported: () => ({
        ...PAYAI_SUPPORTED,
        kinds: PAYAI_SUPPORTED.kinds.map((k: { network: string; extra?: object }) =>
          k.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ? { ...k, extra: { feePayer: "not-a-key" } } : k,
        ),
      }),
    });
    stubSolanaOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });
});

// ---------------------------------------------------------------------------
// Paid path
// ---------------------------------------------------------------------------

const BASE_PAYER = `0x${"11".repeat(20)}`;
const BASE_TX = `0x${"ab".repeat(32)}`;
const SOL_SIG = "5".repeat(87);
/** Opaque base64 blob standing in for a signed Solana tx (facilitator is mocked; nothing is signed). */
const FAKE_TX_B64 = Buffer.alloc(400, 7).toString("base64");

function behaviour(sol: { verify?: () => unknown; settle?: () => unknown } = {}) {
  return {
    verify: (url: string, _p: unknown, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { isValid: true, payer: BASE_PAYER };
      if (sol.verify) return sol.verify();
      return { isValid: true, payer: SOL_PAYER };
    },
    settle: (url: string, _p: unknown, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: BASE_TX, network: r.network, payer: BASE_PAYER };
      if (sol.settle) return sol.settle();
      return { success: true, transaction: SOL_SIG, network: r.network, payer: SOL_PAYER };
    },
  };
}

function makeHandler() {
  const ran = { count: 0 };
  const handler = createX402GetHandler(
    async () => {
      ran.count++;
      return NextResponse.json({ ok: true });
    },
    pulseRouteConfig(),
    pulseOpts,
  );
  return { handler, ran };
}

const unpaid = () => new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } });
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", {
    headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) },
  });

function basePayload(baseAccept: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: baseAccept,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: {
        from: BASE_PAYER,
        to: baseAccept.payTo,
        value: baseAccept.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"00".repeat(32)}`,
      },
    },
  } as PaymentPayload;
}

function solanaPayload(accept: PaymentRequirements, tx = FAKE_TX_B64): PaymentPayload {
  return { x402Version: 2, accepted: accept, payload: { transaction: tx } } as PaymentPayload;
}

async function snap(res: Response) {
  const headers = [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return { status: res.status, headers, body: await res.text() };
}

const goldenPulseHeader = (mode: "cdp" | "local" = "cdp") =>
  (golden[mode]["GET /api/pulse json"] as Captured).headers.find(([k]) => k === "payment-required")![1];

describe("paid isolation", () => {
  let calls: FacilitatorCall[];
  beforeEach(() => {
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    __setSolanaModuleLoaderForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function getAccepts() {
    const { handler } = makeHandler();
    const res = await handler(unpaid());
    return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
  }

  const nonSupported = () => calls.filter((c) => c.op !== "supported");

  it("Base payment: identical response with flag off and on; only CDP sees it", async () => {
    calls = installBothFacilitators(behaviour());
    vi.unstubAllEnvs();
    setCdp(true);
    const [baseAccept] = await getAccepts();
    const offRun = makeHandler();
    const off = await snap(await offRun.handler(paid(basePayload(baseAccept))));
    expect(off.status).toBe(200);
    expect(offRun.ran.count).toBe(1);

    stubSolanaOn();
    const accepts = await getAccepts();
    expect(accepts.map((a) => a.network)).toEqual(["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    expect(JSON.stringify(accepts[0])).toBe(JSON.stringify(baseAccept));
    calls.length = 0;
    const onRun = makeHandler();
    const on = await snap(await onRun.handler(paid(basePayload(accepts[0]))));
    expect(on).toEqual(off);
    expect(onRun.ran.count).toBe(1);
    expect(nonSupported().map((c) => c.op)).toEqual(["verify", "settle"]);
    expect(nonSupported().every((c) => c.url.startsWith(CDP_URL_PREFIX) && c.network === "eip155:8453")).toBe(true);
  });

  it("Solana payment: verified + settled only by PayAI, handler runs once, PAYMENT-RESPONSE set", async () => {
    calls = installBothFacilitators(behaviour());
    stubSolanaOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(solanaPayload(accepts[1])));
    expect(res.status).toBe(200);
    expect(run.ran.count).toBe(1);
    const prh = res.headers.get("payment-response")!;
    expect(JSON.parse(Buffer.from(prh, "base64").toString())).toMatchObject({ success: true, transaction: SOL_SIG, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    expect(nonSupported().map((c) => c.op)).toEqual(["verify", "settle"]);
    expect(nonSupported().every((c) => c.url === PAYAI && c.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(true);
  });

  it("Solana payment works without CDP keys too (Solana path does not depend on CDP)", async () => {
    calls = installBothFacilitators(behaviour());
    stubSolanaOn({}, false);
    const accepts = await getAccepts();
    const run = makeHandler();
    const res = await run.handler(paid(solanaPayload(accepts[1])));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.startsWith(CDP_URL_PREFIX))).toBe(false);
  });

  // Odin review fix 1: verify-phase failures and DEFINITIVE settle failures → Base-only 402;
  // an AMBIGUOUS settle (plain throw = transport error; tx may have landed) → generic 502, never 402.
  for (const [name, sol, handlerRuns, expectStatus] of [
    ["PayAI verify throws (PayAI down)", { verify: () => { throw new Error("payai verify exploded"); } }, 0, 402],
    ["PayAI verify says invalid", { verify: () => ({ isValid: false, invalidReason: "transaction_simulation_failed", payer: SOL_PAYER }) }, 0, 402],
    ["PayAI settle throws (transport error, outcome unknown)", { settle: () => { throw new Error("payai settle exploded"); } }, 1, 502],
    ["PayAI settle unsuccessful", { settle: () => ({ success: false, errorReason: "settle_failed", transaction: "", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }) }, 1, 402],
  ] as const) {
    it(`${name}: ${expectStatus === 402 ? "exact Base-only 402" : "generic 502 settlement_unconfirmed (no 402)"}, nothing to CDP, Base still settles after`, async () => {
      calls = installBothFacilitators(behaviour(sol as never));
      stubSolanaOn();
      const accepts = await getAccepts();
      calls.length = 0;
      const run = makeHandler();
      const res = await run.handler(paid(solanaPayload(accepts[1])));
      expect(res.status).toBe(expectStatus);
      expect(run.ran.count).toBe(handlerRuns);
      if (expectStatus === 402) {
        expect(res.headers.get("payment-required")).toBe(goldenPulseHeader());
      } else {
        expect(res.headers.get("payment-required")).toBeNull();
        expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
      }
      expect(calls.filter((c) => c.url.startsWith(CDP_URL_PREFIX) && c.op !== "supported")).toEqual([]);

      calls.length = 0;
      const base = await run.handler(paid(basePayload(accepts[0])));
      expect(base.status).toBe(200);
      expect(run.ran.count).toBe(handlerRuns + 1);
      expect(nonSupported().every((c) => c.url.startsWith(CDP_URL_PREFIX))).toBe(true);
    });
  }

  for (const [name, mutate] of [
    ["accepted.payTo swapped to another address", (a: PaymentRequirements) => ({ ...a, payTo: fillerPubkey(8) })],
    ["accepted.payTo edited one char", (a: PaymentRequirements) => ({ ...a, payTo: a.payTo.slice(0, -1) + "Q" })],
    ["accepted.amount lowered", (a: PaymentRequirements) => ({ ...a, amount: "1" })],
    ["accepted.asset swapped (devnet USDC)", (a: PaymentRequirements) => ({ ...a, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" })],
    ["accepted.extra.feePayer swapped", (a: PaymentRequirements) => ({ ...a, extra: { feePayer: fillerPubkey(2) } })],
  ] as const) {
    it(`preflight: ${name} → rejected before any facilitator call, Base-only 402`, async () => {
      calls = installBothFacilitators(behaviour());
      stubSolanaOn();
      const accepts = await getAccepts();
      calls.length = 0;
      const run = makeHandler();
      const res = await run.handler(paid(solanaPayload(mutate(accepts[1]) as PaymentRequirements)));
      expect(res.status).toBe(402);
      expect(run.ran.count).toBe(0);
      expect(res.headers.get("payment-required")).toBe(goldenPulseHeader());
      expect(nonSupported()).toEqual([]);
    });
  }

  it("preflight: oversized / non-base64 transaction rejected before PayAI", async () => {
    calls = installBothFacilitators(behaviour());
    stubSolanaOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const run = makeHandler();
    for (const tx of [Buffer.alloc(2000, 1).toString("base64"), "not base64!!", ""]) {
      const res = await run.handler(paid(solanaPayload(accepts[1], tx)));
      expect(res.status).toBe(402);
    }
    expect(run.ran.count).toBe(0);
    expect(nonSupported()).toEqual([]);
  });

  it("Solana payload while @x402/svm is broken: Base-only 402; Base payment still settles", async () => {
    calls = installBothFacilitators(behaviour());
    stubSolanaOn();
    const accepts = await getAccepts();
    __setSolanaModuleLoaderForTests(() => Promise.reject(new Error("import boom")));
    const run = makeHandler();
    const res = await run.handler(paid(solanaPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(goldenPulseHeader());
    const base = await run.handler(paid(basePayload(accepts[0])));
    expect(base.status).toBe(200);
    expect(run.ran.count).toBe(1);
  });

  it("local mode (no CDP keys) + Solana failure: Base-only local 402 identical to main", async () => {
    calls = installBothFacilitators(behaviour({ verify: () => { throw new Error("down"); } }));
    stubSolanaOn({}, false);
    const accepts = await getAccepts();
    const run = makeHandler();
    const res = await run.handler(paid(solanaPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(goldenPulseHeader("local"));
  });

  it("flag off: a Solana-looking payload never reaches PayAI; it takes main's CDP path", async () => {
    calls = installBothFacilitators(behaviour());
    stubSolanaOn();
    const accepts = await getAccepts();
    vi.unstubAllEnvs();
    setCdp(true);
    resetSolanaRailForTests();
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(solanaPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(run.ran.count).toBe(0);
    expect(calls.some((c) => c.url === PAYAI)).toBe(false);
  });
});
