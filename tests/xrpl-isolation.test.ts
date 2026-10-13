/**
 * Isolation: no XRPL failure may change the Base path.
 *   - unpaid 402 / OPTIONS: byte-identical to the main golden when @x402/xrpl
 *     fails to import, the scheme throws, SDK constants disagree, the SDK
 *     builds an unexpected requirement, the facilitator is down / hangs / lacks
 *     xrpl:N / claims sponsored fees, or the payTo is not ready (unactivated,
 *     no / frozen RLUSD trust line, dest-tag / deposit-auth flag, RPC error);
 *     with Solana also on, an XRPL failure leaves the Base+Solana 402 untouched
 *   - paid: Base payloads go only to CDP and settle exactly as with the flag
 *     off; XRPL payloads go only to the XRPL facilitator; verify failures and
 *     DEFINITIVE settle failures → exact Base-only 402; AMBIGUOUS settle →
 *     generic 502/504 (never 402); replay guard; cross-instance replay check;
 *     reason-codes-only logging.
 */
import { expectRejectedGolden } from "./helpers/reject-header";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { FacilitatorResponseError, FacilitatorTimeoutError, SettleError } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  __loadRealXrplModulesForTests,
  __setXrplModuleLoaderForTests,
  setXrplReplayStoreForTests,
  __setXrplRpcForTests,
  resetXrplRailForTests,
  setXrplAlertHook,
  WARN_ALERT_THRESHOLD,
  type XrplModules,
} from "@/lib/xrpl-rail";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { captureRoutes, captureDiscovery, type Captured } from "./helpers/capture";
import { CDP_URL_PREFIX, type FacilitatorCall } from "./helpers/facilitator-mock";
import {
  XRPL_FAC,
  XRPL_PAYER,
  XRPL_TX_HASH,
  blobOf,
  fillerAddress,
  installXrplFacilitators,
  installXrplRpc,
  setCdp,
  specTx,
  stubXrplOn,
  xrplPayload,
  type ReadyMode,
} from "./helpers/xrpl-env";
import { installRpc as installSolanaRpc } from "./helpers/solana-env";
import { SOLANA_PAYTO } from "@/lib/solana-config";

const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));

async function captureAll() {
  setCdp(true);
  const cdp = await captureRoutes();
  setCdp(false);
  const local = await captureRoutes();
  return { cdp, local, discovery: await captureDiscovery() };
}

const xrplWarned = () => vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).startsWith("[xrpl-rail]"));
const warnLines = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));

async function realModules(): Promise<XrplModules> {
  return __loadRealXrplModulesForTests();
}

describe("unpaid isolation: XRPL failures serve the exact main 402", () => {
  beforeEach(() => {
    resetXrplRailForTests();
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    __setXrplModuleLoaderForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("@x402/xrpl import throws", async () => {
    installXrplFacilitators();
    stubXrplOn();
    __setXrplModuleLoaderForTests(() => Promise.reject(new Error("Cannot find module '@x402/xrpl'")));
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(xrplWarned()).toBe(true);
  });

  it("XRPL scheme constructor throws", async () => {
    installXrplFacilitators();
    stubXrplOn();
    const real = await realModules();
    __setXrplModuleLoaderForTests(async () => ({
      ...real,
      ExactXrplScheme: class {
        constructor() {
          throw new Error("ctor boom");
        }
      } as never,
    }));
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("SDK constants disagree with our pinned RLUSD issuer (supply-chain guard)", async () => {
    installXrplFacilitators();
    stubXrplOn();
    const real = await realModules();
    __setXrplModuleLoaderForTests(async () => ({ ...real, RLUSD_TESTNET_ISSUER: fillerAddress(3) }));
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("SDK builds a requirement with a different payTo / extra key (post-build assert)", async () => {
    installXrplFacilitators();
    stubXrplOn();
    const real = await realModules();
    const Real = real.ExactXrplScheme as unknown as new () => { enhancePaymentRequirements(...a: unknown[]): Promise<PaymentRequirements> };
    class Tampered extends Real {
      async enhancePaymentRequirements(...a: unknown[]) {
        const r = await super.enhancePaymentRequirements(...a);
        return { ...r, payTo: fillerAddress(6), extra: { ...r.extra, sourceTag: 804681468 } };
      }
    }
    __setXrplModuleLoaderForTests(async () => ({ ...real, ExactXrplScheme: Tampered as never }));
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(warnLines().some((l) => l.includes("unexpected XRPL requirement (payTo, network/issuer/payTo mix, extra.sourceTag)"))).toBe(true);
  });

  it("XRPL facilitator unreachable (failure cached: one attempt for 82 requests)", async () => {
    const calls = installXrplFacilitators({ supported: () => { throw new Error("fetch failed: ECONNREFUSED"); } });
    stubXrplOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(calls.filter((c) => c.url === XRPL_FAC && c.op === "supported").length).toBe(1);
  });

  it("XRPL facilitator hangs: bounded by HP_XRPL_INIT_TIMEOUT_MS", async () => {
    installXrplFacilitators({ supported: () => new Promise(() => {}) });
    stubXrplOn({ HP_XRPL_INIT_TIMEOUT_MS: "150" });
    const t0 = Date.now();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("XRPL facilitator does not list exact on xrpl:1", async () => {
    installXrplFacilitators({ supported: () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "xrpl:0" }], extensions: [], signers: {} }) });
    stubXrplOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  it("XRPL facilitator claims areFeesSponsored=true (spec violation)", async () => {
    installXrplFacilitators({ supported: () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "xrpl:1", extra: { areFeesSponsored: true } }], extensions: [], signers: {} }) });
    stubXrplOn();
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
  });

  for (const mode of ["unactivated", "no_trustline", "frozen", "zero_limit", "dest_tag", "deposit_auth", "error", "malformed"] as ReadyMode[]) {
    it(`payTo not ready (${mode}): entry hidden, exact main 402`, async () => {
      installXrplFacilitators();
      stubXrplOn({}, true, mode);
      expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(golden));
    });
  }

  it("readiness flips on by itself once the account + trust line exist (no redeploy), and back off", async () => {
    installXrplFacilitators();
    let mode: ReadyMode = "unactivated";
    stubXrplOn();
    installXrplRpc(() => mode);
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    try {
      const h = makeHandler().handler;
      const count = async () => decodePaymentRequiredHeader((await h(unpaid())).headers.get("payment-required")!).accepts.length;
      expect(await count()).toBe(1);
      mode = "ready";
      expect(await count()).toBe(1); // cached (≤ 10 min)
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await count(); // stale → background re-check
      await new Promise((r) => setTimeout(r, 20));
      expect(await count()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("transient RPC error after a confirmed ready keeps the entry (sticky ≤ 60 min); definitive not-ready still hides", async () => {
    installXrplFacilitators();
    let mode: ReadyMode = "ready";
    stubXrplOn();
    installXrplRpc(() => mode);
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    try {
      const h = makeHandler().handler;
      const count = async () => decodePaymentRequiredHeader((await h(unpaid())).headers.get("payment-required")!).accepts.length;
      const recheck = async () => { await count(); await new Promise((r) => setTimeout(r, 20)); };
      expect(await count()).toBe(2);
      mode = "error";
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await recheck();
      expect(await count()).toBe(2); // RPC timeout: last confirmed kept
      vi.setSystemTime(Date.now() + 55 * 60_000);
      await recheck();
      expect(await count()).toBe(1); // > 60 min since last confirm: hidden
      mode = "ready";
      vi.setSystemTime(Date.now() + 60_001);
      await recheck();
      expect(await count()).toBe(2);
      mode = "no_trustline";
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await recheck();
      expect(await count()).toBe(1); // definitive answer hides immediately
    } finally {
      vi.useRealTimers();
    }
  });

  it("Solana on + XRPL failure: the Base+Solana 402 is left exactly as it is without XRPL", async () => {
    installXrplFacilitators();
    installSolanaRpc("present");
    vi.unstubAllEnvs();
    vi.stubEnv("HP_SOLANA_ENABLED", "true");
    vi.stubEnv("HP_SOLANA_PAYTO", SOLANA_PAYTO);
    const solanaOnly = await captureAll();
    resetSolanaRailForTests();
    installSolanaRpc("present");
    stubXrplOn({}, true, "unactivated", true);
    __setXrplModuleLoaderForTests(() => Promise.reject(new Error("import boom")));
    expect(JSON.stringify(await captureAll())).toBe(JSON.stringify(solanaOnly));
    expect(JSON.stringify(solanaOnly)).not.toBe(JSON.stringify(golden));
  });
});

// ---------------------------------------------------------------------------
// Paid path
// ---------------------------------------------------------------------------

const BASE_PAYER = `0x${"11".repeat(20)}`;
const BASE_TX = `0x${"ab".repeat(32)}`;
const MARKER = "FACILITATOR-FREETEXT-MARKER-Zq9";

type Xrpl = { verify?: () => unknown; settle?: () => unknown };

function behaviour(x: Xrpl = {}) {
  return {
    verify: (url: string, _p: unknown, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { isValid: true, payer: BASE_PAYER };
      if (x.verify) return x.verify();
      return { isValid: true, payer: XRPL_PAYER };
    },
    settle: (url: string, _p: unknown, r: PaymentRequirements) => {
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: BASE_TX, network: r.network, payer: BASE_PAYER };
      if (x.settle) return x.settle();
      return { success: true, transaction: XRPL_TX_HASH, network: r.network, payer: XRPL_PAYER };
    },
  };
}

function makeHandler(throwErr?: Error) {
  const ran = { count: 0 };
  const handler = createX402GetHandler(
    async () => {
      ran.count++;
      if (throwErr) throw throwErr;
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
      authorization: { from: BASE_PAYER, to: baseAccept.payTo, value: baseAccept.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  } as PaymentPayload;
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
    resetXrplRailForTests();
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    __setXrplModuleLoaderForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function getAccepts() {
    const res = await makeHandler().handler(unpaid());
    return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
  }
  const nonSupported = () => calls.filter((c) => c.op !== "supported");

  it("Base payment: identical response with flag off and on; only CDP sees it", async () => {
    calls = installXrplFacilitators(behaviour());
    vi.unstubAllEnvs();
    setCdp(true);
    const [baseAccept] = await getAccepts();
    const offRun = makeHandler();
    const off = await snap(await offRun.handler(paid(basePayload(baseAccept))));
    expect(off.status).toBe(200);

    stubXrplOn();
    const accepts = await getAccepts();
    expect(accepts.map((a) => a.network)).toEqual(["eip155:8453", "xrpl:1"]);
    expect(JSON.stringify(accepts[0])).toBe(JSON.stringify(baseAccept));
    calls.length = 0;
    const onRun = makeHandler();
    const on = await snap(await onRun.handler(paid(basePayload(accepts[0]))));
    expect(on).toEqual(off);
    expect(onRun.ran.count).toBe(1);
    expect(nonSupported().map((c) => c.op)).toEqual(["verify", "settle"]);
    expect(nonSupported().every((c) => c.url.startsWith(CDP_URL_PREFIX) && c.network === "eip155:8453")).toBe(true);
  });

  it("XRPL payment: verified + settled only by the XRPL facilitator, handler once, PAYMENT-RESPONSE set, Bazaar never forwarded", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const run = makeHandler();
    const p = { ...xrplPayload(accepts[1]), extensions: { bazaar: { info: {} } } } as PaymentPayload;
    let seenExt: unknown = "unset";
    const spy = vi.mocked((await import("@x402/core/server")).HTTPFacilitatorClient.prototype.verify);
    const res = await run.handler(paid(p));
    seenExt = (spy.mock.calls.at(-1)?.[0] as { extensions?: unknown })?.extensions;
    expect(res.status).toBe(200);
    expect(run.ran.count).toBe(1);
    const prh = res.headers.get("payment-response")!;
    expect(JSON.parse(Buffer.from(prh, "base64").toString())).toMatchObject({ success: true, transaction: XRPL_TX_HASH, network: "xrpl:1" });
    expect(nonSupported().map((c) => c.op)).toEqual(["verify", "settle"]);
    expect(nonSupported().every((c) => c.url === XRPL_FAC && c.network === "xrpl:1")).toBe(true);
    expect(seenExt).toBeUndefined();
  });

  it("XRPL payment works without CDP keys too", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn({}, false);
    const accepts = await getAccepts();
    const res = await makeHandler().handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.startsWith(CDP_URL_PREFIX))).toBe(false);
  });

  for (const [name, x, handlerRuns, expectStatus] of [
    ["verify throws (facilitator down)", { verify: () => { throw new Error(`verify exploded ${MARKER}`); } }, 0, 402],
    ["verify says invalid", { verify: () => ({ isValid: false, invalidReason: "insufficient_funds", invalidMessage: MARKER, payer: XRPL_PAYER }) }, 0, 402],
    ["verify returns malformed response", { verify: () => { throw new FacilitatorResponseError(`bad json ${MARKER}`); } }, 0, 402],
    ["settle throws (transport error, outcome unknown)", { settle: () => { throw new Error(`settle exploded ${MARKER}`); } }, 1, 502],
    ["settle times out (validated result not seen)", { settle: () => { throw new FacilitatorTimeoutError("settle", 20000); } }, 1, 504],
    ["settle duplicate_settlement (seen, not settled)", { settle: () => ({ success: false, errorReason: "duplicate_settlement", errorMessage: MARKER, transaction: "", network: "xrpl:1" }) }, 1, 502],
    ["settle 500 SettleError", { settle: () => { throw new SettleError(500, { success: false, errorReason: "internal", transaction: "", network: "xrpl:1" } as never); } }, 1, 502],
    ["settle success:false WITH a tx hash", { settle: () => ({ success: false, errorReason: "tec_path_dry", transaction: XRPL_TX_HASH, network: "xrpl:1" }) }, 1, 502],
    ["settle definitive failure (tefPAST_SEQ, no tx)", { settle: () => ({ success: false, errorReason: "tef_past_seq", errorMessage: MARKER, transaction: "", network: "xrpl:1" }) }, 1, 402],
  ] as const) {
    it(`${name}: ${expectStatus === 402 ? "exact Base-only 402" : `generic ${expectStatus} settlement_unconfirmed (never 402)`}; nothing to CDP; Base still settles; no facilitator text logged`, async () => {
      calls = installXrplFacilitators(behaviour(x as Xrpl));
      stubXrplOn();
      const accepts = await getAccepts();
      calls.length = 0;
      const run = makeHandler();
      const res = await run.handler(paid(xrplPayload(accepts[1])));
      expect(res.status).toBe(expectStatus);
      expect(run.ran.count).toBe(handlerRuns);
      const body = await res.text();
      if (expectStatus === 402) {
        // 1b: machine-readable reason (facilitator code when it is one), no handler body.
        const code = ({ "verify throws (facilitator down)": "verification_failed", "verify returns malformed response": "verification_failed", "verify says invalid": "insufficient_funds", "settle definitive failure (tefPAST_SEQ, no tx)": "tef_past_seq" } as Record<string, string>)[name];
        expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader(), code);
        expect(code).toBeDefined(); // Odin F2: every 402 case pinned, no match-anything fallback
        expect(body).not.toContain('"ok":true');
      } else {
        expect(res.headers.get("payment-required")).toBeNull();
        expect(body).toBe('{"error":"settlement_unconfirmed"}');
      }
      expect(body).not.toContain(MARKER);
      expect(calls.filter((c) => c.url.startsWith(CDP_URL_PREFIX) && c.op !== "supported")).toEqual([]);
      const logged = [...vi.mocked(console.warn).mock.calls, ...(vi.isMockFunction(console.error) ? vi.mocked(console.error).mock.calls : [])].flat().map(String).join("\n");
      expect(logged).not.toContain(MARKER);
      // The payer appears ONLY in the structured XRPL_RECONCILE record (A1).
      const lines = logged.split("\n");
      expect(lines.filter((l) => !l.includes("XRPL_RECONCILE ")).join("\n")).not.toContain(XRPL_PAYER);
      const rec = lines.filter((l) => l.includes("XRPL_RECONCILE "));
      if (expectStatus === 402) expect(rec).toEqual([]);
      else {
        expect(rec).toHaveLength(1);
        const r = JSON.parse(rec[0].slice(rec[0].indexOf("{")));
        expect(r).toMatchObject({ tag: "XRPL_RECONCILE", status: expectStatus, network: "xrpl:1", route: "/api/pulse", payer: XRPL_PAYER });
        expect(r.txHash).toMatch(/^[0-9A-F]{64}$/);
        expect(r.slot).toMatch(/^(sequence|ticket):\d+$/);
        expect(r.required).toMatchObject({ currency: "524C555344000000000000000000000000000000", value: expect.any(String) });
        expect(Date.parse(r.at)).not.toBeNaN();
        expect(r.reason).toMatch(/^[a-z0-9_]+$/);
      }

      calls.length = 0;
      const base = await run.handler(paid(basePayload(accepts[0])));
      expect(base.status).toBe(200);
      expect(nonSupported().every((c) => c.url.startsWith(CDP_URL_PREFIX))).toBe(true);
    });
  }

  for (const [name, txOver, acceptedOver] of [
    ["accepted.payTo swapped", {}, { payTo: fillerAddress(8) }],
    ["accepted.payTo edited one char", {}, { payTo: "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcd" }],
    ["accepted.amount lowered", {}, { amount: "0.001" }],
    ["accepted.asset swapped (USD)", {}, { asset: "USD" }],
    ["Destination is another address", { Destination: fillerAddress(4) }, {}],
    ["Memos present", { Memos: [{ Memo: { MemoData: "AA" } }] }, {}],
    ["partial payment flag", { Flags: 0x00020000 }, {}],
    ["mainnet issuer on testnet", { Amount: { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", value: "0.005" } }, {}],
  ] as const) {
    it(`preflight: ${name} → rejected before any facilitator call, Base-only 402`, async () => {
      calls = installXrplFacilitators(behaviour());
      stubXrplOn();
      const accepts = await getAccepts();
      calls.length = 0;
      const run = makeHandler();
      const res = await run.handler(paid(xrplPayload(accepts[1], txOver as Record<string, unknown>, acceptedOver as Partial<PaymentRequirements>)));
      expect(res.status).toBe(402);
      expect(run.ran.count).toBe(0);
      expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader(), "invalid_payload");
      expect(nonSupported()).toEqual([]);
    });
  }

  it("payTo not ready on the paid path: Base-only 402, nothing forwarded", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    resetXrplRailForTests();
    installXrplRpc("unactivated");
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(402);
    expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader(), "rail_unavailable");
    expect(nonSupported()).toEqual([]);
  });

  it("XRPL payload while @x402/xrpl is broken: Base-only 402; Base payment still settles", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    __setXrplModuleLoaderForTests(() => Promise.reject(new Error("import boom")));
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1], {}, {}, blobOf(specTx(accepts[1])))));
    expect(res.status).toBe(402);
    expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader(), "rail_unavailable");
    expect((await run.handler(paid(basePayload(accepts[0])))).status).toBe(200);
    expect(run.ran.count).toBe(1);
  });

  it("local mode (no CDP keys) + XRPL failure: Base-only local 402 identical to main", async () => {
    calls = installXrplFacilitators(behaviour({ verify: () => { throw new Error("down"); } }));
    stubXrplOn({}, false);
    const accepts = await getAccepts();
    const res = await makeHandler().handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(402);
    expectRejectedGolden(res.headers.get("payment-required"), goldenPulseHeader("local"), "verification_failed");
  });

  it("flag off: an XRPL-looking payload never reaches an XRPL facilitator; it takes main's CDP path", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    vi.unstubAllEnvs();
    setCdp(true);
    resetXrplRailForTests();
    calls.length = 0;
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(402);
    expect(run.ran.count).toBe(0);
    expect(calls.some((c) => c.url === XRPL_FAC)).toBe(false);
  });

  it("route handler throws on the XRPL path: re-thrown like the Base path (Next 500), never 402, nothing settled", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const boom = new Error("handler boom");
    await expect(makeHandler(boom).handler(paid(xrplPayload(accepts[1])))).rejects.toBe(boom);
    expect(nonSupported().map((c) => c.op)).toEqual(["verify"]);
  });
});

describe("replay guard + cross-instance check", () => {
  let calls: FacilitatorCall[];
  beforeEach(() => {
    resetXrplRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  async function getAccepts() {
    const res = await makeHandler().handler(unpaid());
    return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
  }

  it("same payload x4 (2 sequential + 2 concurrent) => 1x200 + 3x409; handler 1x; verify 1x, settle 1x", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    calls.length = 0;
    const run = makeHandler();
    const p = xrplPayload(accepts[1]);
    const first = await run.handler(paid(p));
    const second = await run.handler(paid(p));
    const [c, d] = await Promise.all([run.handler(paid(p)), run.handler(paid(p))]);
    expect([first, second, c, d].map((r) => r.status)).toEqual([200, 409, 409, 409]);
    expect(await second.text()).toBe('{"error":"duplicate_payment"}');
    expect(run.ran.count).toBe(1);
    expect(calls.filter((x) => x.op !== "supported").map((x) => x.op)).toEqual(["verify", "settle"]);
  });

  it("a different blob for the SAME payment slot (re-signed / higher fee) is the same payment => 409", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    const run = makeHandler();
    const a = xrplPayload(accepts[1], { Sequence: 4242 });
    const b = xrplPayload(accepts[1], { Sequence: 4242, Fee: "20", LastLedgerSequence: 1_000_001 });
    expect((a.payload as { signedTxBlob: string }).signedTxBlob).not.toBe((b.payload as { signedTxBlob: string }).signedTxBlob);
    expect((await run.handler(paid(a))).status).toBe(200);
    expect((await run.handler(paid(b))).status).toBe(409);
    expect(run.ran.count).toBe(1);
  });

  it("nothing charged (verify rejected) => key released; the client may retry the same payload", async () => {
    let valid = false;
    calls = installXrplFacilitators(behaviour({ verify: () => (valid ? { isValid: true, payer: XRPL_PAYER } : { isValid: false, invalidReason: "sequence_mismatch" }) }));
    stubXrplOn();
    const accepts = await getAccepts();
    const run = makeHandler();
    const p = xrplPayload(accepts[1]);
    expect((await run.handler(paid(p))).status).toBe(402);
    valid = true;
    expect((await run.handler(paid(p))).status).toBe(200);
  });

  it("ambiguous settle keeps the key: retrying the same payment => 409, never 402, facilitator not re-asked", async () => {
    calls = installXrplFacilitators(behaviour({ settle: () => { throw new Error("reset"); } }));
    stubXrplOn();
    const accepts = await getAccepts();
    const run = makeHandler();
    const p = xrplPayload(accepts[1]);
    expect((await run.handler(paid(p))).status).toBe(502);
    calls.length = 0;
    expect((await run.handler(paid(p))).status).toBe(409);
    expect(calls.filter((x) => x.op !== "supported")).toEqual([]);
  });

  it("cross-instance: settle reports success for a tx whose ledger closed BEFORE this request => 409, paid body withheld", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    installXrplRpc("ready", () => ({ validated: true, status: "success", date: Math.floor((Date.now() - 946_684_800_000) / 1000) - 3600 }));
    const run = makeHandler();
    const res = await run.handler(paid(xrplPayload(accepts[1])));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('{"error":"duplicate_payment"}');
  });

  it("cross-instance: closed during the request (or within the 30 s skew) => 200; tx time unknown => 502 settlement_unconfirmed on the memory store", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    const run = makeHandler();
    const cases: [() => unknown, number][] = [
      [() => ({ validated: true, status: "success", date: Math.floor((Date.now() - 946_684_800_000) / 1000) - 10 }), 200],
      [() => ({ validated: true, status: "success", close_time_iso: new Date().toISOString() }), 200],
      [() => { throw new Error("rpc down"); }, 502],
      [() => ({ validated: false, status: "success" }), 502],
      [() => ({ status: "error", error: "txnNotFound" }), 502],
    ];
    for (const [tx, want] of cases) {
      installXrplRpc("ready", tx);
      const res = await run.handler(paid(xrplPayload(accepts[1])));
      expect(res.status).toBe(want);
      if (want === 502) {
        expect(await res.json()).toEqual({ error: "settlement_unconfirmed" });
        const rec = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("XRPL_RECONCILE ")).pop()!;
        const r = JSON.parse(rec.slice(rec.indexOf("{")));
        expect(r).toMatchObject({ status: 502, reason: "settled_tx_time_unreadable", route: "/api/pulse", txHash: XRPL_TX_HASH });
      }
    }
  });

  it("cross-instance: tx time unknown on a SHARED (Upstash) store => 200 (the store already rules out replays)", async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    const run = makeHandler();
    const mem = new MemoryReplayStore();
    setXrplReplayStoreForTests({ kind: "upstash", claim: (k, t) => mem.claim(k, t), set: (k, st, t) => mem.set(k, st, t), release: (k) => mem.release(k) });
    try {
      for (const tx of [() => { throw new Error("rpc down"); }, () => ({ validated: false, status: "success" })]) {
        installXrplRpc("ready", tx);
        expect((await run.handler(paid(xrplPayload(accepts[1])))).status).toBe(200);
      }
    } finally {
      setXrplReplayStoreForTests(null);
    }
  });

  it("RPC fetch is read-only POST with redirect: 'error' and a timeout", async () => {
    const { __defaultXrplRpcForTests } = await import("@/lib/xrpl-rail");
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ result: { status: "success" } }), { status: 200 }));
    await __defaultXrplRpcForTests("https://testnet.xrpl-labs.com/", "account_info", { account: "r" }, 100);
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeDefined();
    expect(JSON.parse(String(init.body))).toEqual({ method: "account_info", params: [{ account: "r" }] });
    __setXrplRpcForTests(null);
  });

  it(`warn-rate alert: exactly one alert via the hook when ≥${WARN_ALERT_THRESHOLD} [xrpl-rail] warnings land in the window`, async () => {
    calls = installXrplFacilitators(behaviour());
    stubXrplOn();
    const accepts = await getAccepts();
    const alerts: unknown[] = [];
    setXrplAlertHook((a) => alerts.push(a));
    const run = makeHandler();
    // Each preflight-rejected payload logs one [xrpl-rail] warning and gets the Base-only 402.
    for (let i = 0; i < WARN_ALERT_THRESHOLD + 10; i++) {
      expect((await run.handler(paid(xrplPayload(accepts[1], { Memos: [{ Memo: { MemoData: "AA" } }] })))).status).toBe(402);
    }
    expect(warnLines().filter((l) => l.startsWith("[xrpl-rail]")).length).toBeGreaterThanOrEqual(WARN_ALERT_THRESHOLD + 10);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "warn_rate", threshold: WARN_ALERT_THRESHOLD });
    expect(run.ran.count).toBe(0);
  });
});
