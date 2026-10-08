/**
 * Odin pre-deploy code review (2026-10-08, PASS WITH FIXES) — fixes 1-3 and
 * should-fixes 4-9. Mocked facilitators / stubbed fetch and RPC only: no
 * network, no keys, no wallets, no money.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FacilitatorResponseError, FacilitatorTimeoutError, SettleError } from "@x402/core/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  ATA_TTL_MS,
  PAYAI_FREE_SETTLEMENTS,
  RAIL_TTL_MS,
  REPLAY_TTL_MS,
  SOLANA_SETTLE_TIMEOUT_MS,
  SOLANA_VERIFY_TIMEOUT_MS,
  WARN_ALERT_THRESHOLD,
  WARN_ALERT_WINDOW_MS,
  __defaultSolanaRpcForTests,
  __flushSolanaBackgroundForTests,
  __setSolanaFacilitatorTimeoutsForTests,
  __setSolanaRpcForTests,
  createPayaiFacilitator,
  getSolanaRailStats,
  resetSolanaRailForTests,
  setSolanaAlertHook,
  solanaPaymentKey,
  solanaTokenAccountReady,
  type SolanaAlert,
} from "@/lib/solana-rail";
import { SOLANA_MAINNET_CAIP2, SOLANA_PAYTO, getSolanaRailConfig } from "@/lib/solana-config";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { CDP_URL_PREFIX } from "./helpers/facilitator-mock";
import {
  PAYAI_SUPPORTED,
  SOL_PAYER,
  ataCalls,
  fillerPubkey,
  installBothFacilitators,
  installRpc,
  revalidateSolana,
  setAtaMode,
  stubSolanaOn,
} from "./helpers/solana-env";

const PAYAI = "https://facilitator.payai.network";
const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "x402-flag-off.golden.json"), "utf8"));
const GOLDEN_PULSE = golden.cdp["GET /api/pulse json"];
const goldenHeader = GOLDEN_PULSE.headers.find(([k]: [string]) => k === "payment-required")[1];
const BASE_PAYER = `0x${"11".repeat(20)}`;
const SOL_SIG = "5".repeat(87);

/** A wire-shaped (not signed, not valid on-chain) Solana tx: [n sigs][64-byte slots][message]. */
function wireTx(messageFill: number, feePayerSlotFill = 0, clientSigFill = 0xaa): string {
  return Buffer.concat([
    Buffer.from([2]),
    Buffer.alloc(64, feePayerSlotFill),
    Buffer.alloc(64, clientSigFill),
    Buffer.alloc(220, messageFill),
  ]).toString("base64");
}
let txSeq = 1;
const freshTx = () => wireTx(txSeq++ % 250);

let now = 1_800_000_000_000;
function useClock() {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
}
const warnLines = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));

function handler(throwErr?: Error) {
  const ran = { count: 0 };
  return {
    ran,
    handler: createX402GetHandler(async () => {
      ran.count++;
      if (throwErr) throw throwErr;
      return NextResponse.json({ ok: true });
    }, pulseRouteConfig(), pulseOpts),
  };
}
async function accepts(): Promise<PaymentRequirements[]> {
  const res = await handler().handler(new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json" } }));
  return decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
}
const solPayload = (accept: PaymentRequirements, tx = freshTx()) =>
  ({ x402Version: 2, accepted: accept, payload: { transaction: tx } }) as PaymentPayload;
const paid = (p: PaymentPayload) =>
  new NextRequest("https://horizonpulse.dev/api/pulse", { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(p) } });
function basePayload(accept: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: accept,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: { from: BASE_PAYER, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  } as PaymentPayload;
}

type Sol = { verify?: () => unknown; settle?: () => unknown };
function facilitators(sol: Sol = {}) {
  const seen: { op: string; url: string }[] = [];
  const calls = installBothFacilitators({
    verify: (url: string) => {
      seen.push({ op: "verify", url });
      if (url.startsWith(CDP_URL_PREFIX)) return { isValid: true, payer: BASE_PAYER };
      return sol.verify ? sol.verify() : { isValid: true, payer: SOL_PAYER };
    },
    settle: async (url: string, _p: PaymentPayload, r: PaymentRequirements) => {
      seen.push({ op: "settle", url });
      if (url.startsWith(CDP_URL_PREFIX)) return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: BASE_PAYER };
      return sol.settle ? sol.settle() : { success: true, transaction: SOL_SIG, network: r.network, payer: SOL_PAYER };
    },
  } as never);
  const payai = (op: string) => seen.filter((s) => s.url === PAYAI && s.op === op).length;
  return { calls, seen, payai };
}

/** Let the REAL HTTPFacilitatorClient verify/settle run against a stubbed fetch (PayAI only). */
function realPayaiClientOverFetch(routes: { verify?: (init: RequestInit) => Promise<Response> | Response; settle?: (init: RequestInit) => Promise<Response> | Response }) {
  vi.mocked(HTTPFacilitatorClient.prototype.verify).mockRestore();
  vi.mocked(HTTPFacilitatorClient.prototype.settle).mockRestore();
  const hits: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = String(url);
    hits.push(u);
    if (u === `${PAYAI}/verify`) return routes.verify ? routes.verify(init) : Response.json({ isValid: true, payer: SOL_PAYER });
    if (u === `${PAYAI}/settle`) {
      if (routes.settle) return routes.settle(init);
      return Response.json({ success: true, transaction: SOL_SIG, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return hits;
}
const hangUntilAbort = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  });

function expectNoPayaiText(body: string) {
  for (const needle of ["Facilitator", "PayAI", "payai", "html", "stack", "SECRET", "timed out", SOL_PAYER, SOL_SIG]) {
    expect(body).not.toContain(needle);
  }
}

beforeEach(() => {
  resetSolanaRailForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await __flushSolanaBackgroundForTests();
  __setSolanaFacilitatorTimeoutsForTests(null);
  __setSolanaRpcForTests(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ===========================================================================
describe("fix 1: PayAI timeout / malformed response never leaks; ambiguous settle is never a 402", () => {
  // (a) verify phase: nothing charged → main's exact Base-only 402
  for (const [name, verify] of [
    ["FacilitatorTimeoutError", () => { throw new FacilitatorTimeoutError("verify", 10_000); }],
    ["FacilitatorResponseError (invalid JSON with PayAI body excerpt)", () => { throw new FacilitatorResponseError("Facilitator verify returned invalid JSON: <html>internal payai stack SECRET</html>"); }],
  ] as const) {
    it(`(1a) verify throws the real ${name} => main's exact Base-only 402, no PayAI text, handler never runs`, async () => {
      const { payai } = facilitators({ verify });
      stubSolanaOn();
      const [, sol] = await accepts();
      const run = handler();
      const res = await run.handler(paid(solPayload(sol)));
      expect(res.status).toBe(402);
      expect(res.headers.get("payment-required")).toBe(goldenHeader);
      const body = await res.text();
      expect(body).toBe(GOLDEN_PULSE.body);
      expectNoPayaiText(body);
      expect(run.ran.count).toBe(0);
      expect(payai("settle")).toBe(0);
    });
  }

  it("(1a) REAL HTTPFacilitatorClient: verify deadline genuinely expires (fetch hangs) => Base-only 402", async () => {
    installBothFacilitators();
    const hits = realPayaiClientOverFetch({ verify: hangUntilAbort });
    __setSolanaFacilitatorTimeoutsForTests({ verifyMs: 50, settleMs: 50 });
    stubSolanaOn();
    const [, sol] = await accepts();
    const run = handler();
    const res = await run.handler(paid(solPayload(sol)));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(goldenHeader);
    expect(run.ran.count).toBe(0);
    expect(hits).toEqual([`${PAYAI}/verify`]);
    expect(warnLines().some((l) => l.includes("PayAI verify threw (FacilitatorTimeoutError)"))).toBe(true);
  });

  it("(1a) REAL HTTPFacilitatorClient: PayAI verify returns non-JSON => Base-only 402, PayAI body not echoed", async () => {
    installBothFacilitators();
    realPayaiClientOverFetch({ verify: () => new Response("<html>internal payai stack SECRET</html>", { status: 200 }) });
    stubSolanaOn();
    const [, sol] = await accepts();
    const res = await handler().handler(paid(solPayload(sol)));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(goldenHeader);
    expectNoPayaiText(await res.text());
  });

  // (b) settle phase, ambiguous: tx may have landed → generic 502/504, never 402, no PayAI text
  for (const [name, settle, status] of [
    ["real FacilitatorTimeoutError", () => { throw new FacilitatorTimeoutError("settle", 12_000); }, 504],
    ["real FacilitatorResponseError (malformed body)", () => { throw new FacilitatorResponseError("Facilitator settle returned invalid data: <html>internal payai stack SECRET</html>"); }, 502],
    ["transport error (TypeError: fetch failed)", () => { throw new TypeError("fetch failed"); }, 502],
    ["SettleError 500", () => { throw new SettleError(500, { success: false, errorReason: "unexpected_settle_error", transaction: "", network: SOLANA_MAINNET_CAIP2 } as never); }, 502],
    ["SettleError 409 duplicate_settlement", () => { throw new SettleError(409, { success: false, errorReason: "duplicate_settlement", transaction: "", network: SOLANA_MAINNET_CAIP2 } as never); }, 502],
    ["success:false settlement_pending (PayAI 100 s budget expired)", () => ({ success: false, errorReason: "settlement_pending", transaction: "", network: SOLANA_MAINNET_CAIP2 }), 502],
    ["success:false but a tx signature is present", () => ({ success: false, errorReason: "confirmation_timeout", transaction: SOL_SIG, network: SOLANA_MAINNET_CAIP2 }), 502],
  ] as const) {
    it(`(1b) ambiguous settle — ${name} => ${status} {"error":"settlement_unconfirmed"}, no PAYMENT-REQUIRED, never 402`, async () => {
      const { payai } = facilitators({ settle });
      stubSolanaOn();
      const [, sol] = await accepts();
      const run = handler();
      const res = await run.handler(paid(solPayload(sol)));
      expect(res.status).toBe(status);
      expect(res.headers.get("payment-required")).toBeNull();
      expect(res.headers.get("payment-response")).toBeNull();
      const body = await res.text();
      expect(body).toBe('{"error":"settlement_unconfirmed"}');
      expectNoPayaiText(body);
      expect(run.ran.count).toBe(1);
      expect(payai("settle")).toBe(1);
      // Reconciliation log: redacted fingerprint, no payer / tx / PayAI body.
      const lines = warnLines().filter((l) => l.includes("settlement unconfirmed fp="));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/fp=[0-9a-f]{16} /);
      for (const l of warnLines()) {
        expect(l).not.toContain(SOL_PAYER);
        expect(l).not.toContain(SOL_SIG.slice(0, 40));
        expect(l).not.toContain("SECRET");
      }
    });
  }

  it("(1b) REAL HTTPFacilitatorClient: settle deadline genuinely expires (fetch hangs past 12 s budget, shortened) => 504, never 402", async () => {
    installBothFacilitators();
    const hits = realPayaiClientOverFetch({ settle: hangUntilAbort });
    __setSolanaFacilitatorTimeoutsForTests({ verifyMs: 5_000, settleMs: 50 });
    stubSolanaOn();
    const [, sol] = await accepts();
    const res = await handler().handler(paid(solPayload(sol)));
    expect(res.status).toBe(504);
    expect(await res.text()).toBe('{"error":"settlement_unconfirmed"}');
    expect(res.headers.get("payment-required")).toBeNull();
    expect(hits).toEqual([`${PAYAI}/verify`, `${PAYAI}/settle`]);
    expect(warnLines().some((l) => l.includes("PayAI settle threw (FacilitatorTimeoutError)"))).toBe(true);
  });

  it("(1b) REAL HTTPFacilitatorClient: PayAI settle returns non-JSON 200 => 502, PayAI body not echoed", async () => {
    installBothFacilitators();
    realPayaiClientOverFetch({ settle: () => new Response("<html>internal payai stack SECRET</html>", { status: 200 }) });
    stubSolanaOn();
    const [, sol] = await accepts();
    const res = await handler().handler(paid(solPayload(sol)));
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toBe('{"error":"settlement_unconfirmed"}');
    expectNoPayaiText(body);
  });

  it("(1b) REAL HTTPFacilitatorClient: PayAI settle 500 problem+json => 502, never 402", async () => {
    installBothFacilitators();
    realPayaiClientOverFetch({ settle: () => new Response(JSON.stringify({ type: "x", title: "Internal Server Error", status: 500 }), { status: 500 }) });
    stubSolanaOn();
    const [, sol] = await accepts();
    const res = await handler().handler(paid(solPayload(sol)));
    expect(res.status).toBe(502);
  });

  // (c) settle phase, definitive: nothing landed → Base-only 402 is fine
  for (const [name, settle] of [
    ["success:false transaction_failed (no tx)", () => ({ success: false, errorReason: "transaction_failed", transaction: "", network: SOLANA_MAINNET_CAIP2 })],
    ["SettleError 400 simulation failed", () => { throw new SettleError(400, { success: false, errorReason: "invalid_exact_svm_payload_transaction_simulation_failed", transaction: "", network: SOLANA_MAINNET_CAIP2 } as never); }],
  ] as const) {
    it(`(1c) definitive settle failure — ${name} => main's exact Base-only 402`, async () => {
      facilitators({ settle });
      stubSolanaOn();
      const [, sol] = await accepts();
      const res = await handler().handler(paid(solPayload(sol)));
      expect(res.status).toBe(402);
      expect(res.headers.get("payment-required")).toBe(goldenHeader);
      expect(await res.text()).toBe(GOLDEN_PULSE.body);
    });
  }
});

// ===========================================================================
describe("fix 2: replay guard (before verify)", () => {
  it("(2) same payload x4 (2 sequential + 2 concurrent) => 1x200 + 3x409; handler 1x; PayAI verify 1x, settle 1x", async () => {
    const { payai } = facilitators();
    stubSolanaOn();
    const [, sol] = await accepts();
    const run = handler();
    const p = solPayload(sol);
    const a = await run.handler(paid(p));
    const b = await run.handler(paid(p));
    const [c, d] = await Promise.all([run.handler(paid(p)), run.handler(paid(p))]);
    expect([a.status, b.status, c.status, d.status]).toEqual([200, 409, 409, 409]);
    for (const r of [b, c, d]) {
      expect(await r.text()).toBe('{"error":"duplicate_payment"}');
      expect(r.headers.get("payment-required")).toBeNull();
    }
    expect(run.ran.count).toBe(1);
    expect(payai("verify")).toBe(1);
    expect(payai("settle")).toBe(1);
  });

  it("(2) concurrent first-time duplicates: exactly one reaches PayAI (in-flight key)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { payai } = facilitators({ settle: async () => { await gate; return { success: true, transaction: SOL_SIG, network: SOLANA_MAINNET_CAIP2, payer: SOL_PAYER }; } });
    stubSolanaOn();
    const [, sol] = await accepts();
    const run = handler();
    const p = solPayload(sol);
    const first = run.handler(paid(p));
    await new Promise((r) => setTimeout(r, 20));
    const second = await run.handler(paid(p)); // first is still settling
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(payai("verify")).toBe(1);
  });

  it("(2) same message with a different fee-payer signature slot / re-encoding is the same payment", async () => {
    expect(await solanaPaymentKey(wireTx(7, 0))).toBe(await solanaPaymentKey(wireTx(7, 0x55)));
    expect(await solanaPaymentKey(wireTx(7, 0, 0xaa))).toBe(await solanaPaymentKey(wireTx(7, 0, 0xbb)));
    expect(await solanaPaymentKey(wireTx(7))).not.toBe(await solanaPaymentKey(wireTx(8)));
    const { payai } = facilitators();
    stubSolanaOn();
    const [, sol] = await accepts();
    const run = handler();
    expect((await run.handler(paid(solPayload(sol, wireTx(9, 0))))).status).toBe(200);
    expect((await run.handler(paid(solPayload(sol, wireTx(9, 0x55))))).status).toBe(409);
    expect(payai("verify")).toBe(1);
  });

  it("(2) nothing charged (verify rejected) => key released, the client may retry the same payload", async () => {
    let valid = false;
    facilitators({ verify: () => (valid ? { isValid: true, payer: SOL_PAYER } : { isValid: false, invalidReason: "transaction_simulation_failed" }) });
    stubSolanaOn();
    const [, sol] = await accepts();
    const run = handler();
    const p = solPayload(sol);
    expect((await run.handler(paid(p))).status).toBe(402);
    valid = true;
    expect((await run.handler(paid(p))).status).toBe(200);
  });

  it("(2) ambiguous settle keeps the key: retrying the same tx => 409, never 402, PayAI not re-asked", async () => {
    const { payai } = facilitators({ settle: () => { throw new FacilitatorTimeoutError("settle", 12_000); } });
    stubSolanaOn();
    const [, sol] = await accepts();
    const run = handler();
    const p = solPayload(sol);
    expect((await run.handler(paid(p))).status).toBe(504);
    expect((await run.handler(paid(p))).status).toBe(409);
    expect(payai("settle")).toBe(1);
  });

  it("(2) retention ≥ 300 s (25 h: covers PayAI's 24 h replay of recorded outcomes), then expires", async () => {
    expect(REPLAY_TTL_MS).toBeGreaterThanOrEqual(300_000);
    expect(REPLAY_TTL_MS).toBeGreaterThan(24 * 3600_000);
    useClock();
    const { payai } = facilitators();
    stubSolanaOn();
    const [, sol] = await accepts();
    const run = handler();
    const p = solPayload(sol);
    expect((await run.handler(paid(p))).status).toBe(200);
    now += 301_000;
    expect((await run.handler(paid(p))).status).toBe(409);
    now += 24 * 3600_000;
    expect((await run.handler(paid(p))).status).toBe(409);
    expect(payai("verify")).toBe(1);
    now += REPLAY_TTL_MS;
    await revalidateSolana();
    await run.handler(paid(p));
    expect(payai("verify")).toBe(2);
  });
});

// ===========================================================================
describe("fix 3: HP_SOLANA_RPC_URL hardening", () => {
  const on = (url: string) => getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_RPC_URL: url });

  for (const [url, why] of [
    ["http://api.mainnet-beta.solana.com", "https"],
    ["file:///etc/passwd", "https"],
    ["not a url", "not a URL"],
    ["https://169.254.169.254/latest/meta-data", "IP literal"],
    ["https://127.0.0.1:8899", "IP literal"],
    ["https://2130706433/", "IP literal"],
    ["https://0x7f.0.0.1/", "IP literal"],
    ["https://[::1]/", "IP literal"],
    ["https://[fd00::1]:8899/", "IP literal"],
    ["https://localhost:8899", "localhost"],
    ["https://rpc.localhost/", "localhost"],
    ["https://user:pw@api.mainnet-beta.solana.com/", "userinfo"],
    ["https://user@api.mainnet-beta.solana.com/", "userinfo"],
    ["https://api.mainnet-beta.solana.com:8443/", "default https port"],
    ["https://evil.example/", "allow-list"],
    ["https://api.mainnet-beta.solana.com.evil.example/", "allow-list"],
    ["https://api.mainnet-beta.solana.com./", "allow-list"],
    ["https://mainnet.helius-rpc.com/?api-key=x", "allow-list"],
  ] as const) {
    it(`(3) rejects ${url} (${why}) => rail OFF (misconfigured)`, () => {
      const r = on(url);
      expect(r.enabled).toBe(false);
      expect(r).toMatchObject({ misconfigured: true });
      expect((r as { reason: string }).reason).toContain(why);
    });
  }

  it("(3) trims + parses and stores the normalised URL (the stored value is what is fetched)", async () => {
    const r = on("  https://API.MAINNET-BETA.SOLANA.COM  ");
    expect(r).toMatchObject({ enabled: true, config: { rpcUrl: "https://api.mainnet-beta.solana.com/" } });
    expect(on("https://api.mainnet-beta.solana.com/?commitment=confirmed")).toMatchObject({ config: { rpcUrl: "https://api.mainnet-beta.solana.com/?commitment=confirmed" } });
    const rpc = installRpc("present");
    if (!r.enabled) throw new Error("expected on");
    await solanaTokenAccountReady(r.config);
    expect(rpc[0].url).toBe("https://api.mainnet-beta.solana.com/");
  });

  it("(3) the RPC fetch uses redirect: 'error' (a 307/308 can't bounce the POST)", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen = init;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } });
    });
    await __defaultSolanaRpcForTests("https://api.mainnet-beta.solana.com", "getAccountInfo", [], 1000);
    expect(seen?.redirect).toBe("error");
    expect(seen?.method).toBe("POST");
  });

  it("(3) redirect refused by fetch => token account treated as absent (fail closed, Base-only)", async () => {
    __setSolanaRpcForTests(null); // real fetch-based RPC
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      if (init.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { value: {} } });
    });
    const r = on("https://api.mainnet-beta.solana.com");
    if (!r.enabled) throw new Error("expected on");
    expect(await solanaTokenAccountReady(r.config)).toBe(false);
  });
});

// ===========================================================================
describe("should-fixes 4-9", () => {
  it("(4) vitest pinned to 3.2.7", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.devDependencies.vitest).toBe("3.2.7");
  });

  it("(5) docs/solana-rail.md states the fix-1 fallback (verify → 402; ambiguous settle → 502/504, never 402)", () => {
    const doc = readFileSync(path.join(__dirname, "..", "docs", "solana-rail.md"), "utf8");
    expect(doc).not.toMatch(/verify or settle failure \/ throw → exact Base-only 402/);
    expect(doc).toContain("settlement_unconfirmed");
    expect(doc).toContain("duplicate_payment");
  });

  it("(6) warm 402 never waits on the token-account re-check (stale-while-revalidate)", async () => {
    useClock();
    facilitators();
    const rpc = stubSolanaOn();
    expect((await accepts()).length).toBe(2); // warm
    let release!: (v: unknown) => void;
    setAtaMode(rpc, () => new Promise((r) => (release = r))); // re-check hangs
    now += ATA_TTL_MS + 1;
    const t = await Promise.race([accepts(), new Promise<"waited">((r) => setTimeout(() => r("waited"), 150))]);
    expect(t).not.toBe("waited");
    expect((t as PaymentRequirements[]).length).toBe(2); // stale value served
    expect(ataCalls(rpc).length).toBe(2); // the re-check did start, in the background
    release({ context: { slot: 2 }, value: null }); // account gone → next 402s are Base-only
    await __flushSolanaBackgroundForTests();
    expect((await accepts()).length).toBe(1);
  });

  it("(6) warm 402 never waits on the PayAI /supported (fee payer list) refresh", async () => {
    useClock();
    let hang = false;
    installBothFacilitators({ supported: () => (hang ? new Promise(() => {}) : PAYAI_SUPPORTED) });
    stubSolanaOn({ HP_SOLANA_INIT_TIMEOUT_MS: "200" });
    expect((await accepts()).length).toBe(2);
    hang = true;
    now += RAIL_TTL_MS + 1;
    const t = await Promise.race([accepts(), new Promise<"waited">((r) => setTimeout(() => r("waited"), 100))]);
    expect(t).not.toBe("waited");
    expect((t as PaymentRequirements[]).length).toBe(2);
    await __flushSolanaBackgroundForTests(); // refresh times out → rail retired (fail closed)
    expect((await accepts()).length).toBe(1);
  });

  it("(7) PayAI settle deadline is 12 s (10-15 s band), verify 10 s; both https", () => {
    expect(SOLANA_SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(SOLANA_SETTLE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    const r = getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO });
    if (!r.enabled) throw new Error("expected on");
    const w = createPayaiFacilitator(r.config) as unknown as { inner: HTTPFacilitatorClient; settleInner: HTTPFacilitatorClient };
    expect(w.inner.timeoutMs).toBe(SOLANA_VERIFY_TIMEOUT_MS);
    expect(w.settleInner.timeoutMs).toBe(12_000);
    expect(w.inner.url).toBe(PAYAI);
    expect(w.settleInner.url).toBe(PAYAI);
  });

  it("(8) route handler throws on the Solana path => same throw as the Base path (Next 500), never 402, nothing settled", async () => {
    const { payai } = facilitators();
    stubSolanaOn();
    const [base, sol] = await accepts();
    const boom = new Error("handler boom");
    const run = handler(boom);
    const p = solPayload(sol);
    await expect(run.handler(paid(p))).rejects.toBe(boom);
    await expect(run.handler(paid(basePayload(base)))).rejects.toBe(boom); // Base path: identical behaviour
    expect(payai("settle")).toBe(0);
    // Nothing charged → key released; the same payment can be retried.
    expect((await handler().handler(paid(p))).status).toBe(200);
  });

  it(`(9) warn-rate alert: one alert via the hook when ≥${WARN_ALERT_THRESHOLD} [solana-rail] warnings land in ${WARN_ALERT_WINDOW_MS / 60000} min`, async () => {
    useClock();
    const alerts: SolanaAlert[] = [];
    facilitators();
    stubSolanaOn();
    const [, sol] = await accepts();
    setSolanaAlertHook((a) => alerts.push(a));
    const bad = { ...sol, payTo: fillerPubkey(8) } as PaymentRequirements;
    for (let i = 0; i < WARN_ALERT_THRESHOLD + 5; i++) await handler().handler(paid(solPayload(bad)));
    expect(alerts.filter((a) => a.kind === "warn_rate")).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "warn_rate", threshold: WARN_ALERT_THRESHOLD, windowMs: WARN_ALERT_WINDOW_MS });
    now += WARN_ALERT_WINDOW_MS + 1;
    for (let i = 0; i < WARN_ALERT_THRESHOLD; i++) await handler().handler(paid(solPayload(bad)));
    expect(alerts.filter((a) => a.kind === "warn_rate")).toHaveLength(2);
  });

  it("(9) default alert sink: one console.error line tagged [solana-rail][ALERT]", async () => {
    facilitators();
    stubSolanaOn();
    const [, sol] = await accepts();
    const bad = { ...sol, payTo: fillerPubkey(8) } as PaymentRequirements;
    for (let i = 0; i < WARN_ALERT_THRESHOLD; i++) await handler().handler(paid(solPayload(bad)));
    const lines = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[solana-rail][ALERT]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"kind":"warn_rate"');
  });

  it(`(9) PayAI free allowance: alert at 80% (${Math.ceil(PAYAI_FREE_SETTLEMENTS * 0.8)} of ${PAYAI_FREE_SETTLEMENTS} settlements, on-chain receipt count), not below`, async () => {
    const at = Math.ceil(PAYAI_FREE_SETTLEMENTS * 0.8);
    for (const [count, expected] of [[at - 1, 0], [at, 1]] as const) {
      resetSolanaRailForTests();
      const alerts: SolanaAlert[] = [];
      setSolanaAlertHook((a) => alerts.push(a));
      facilitators();
      stubSolanaOn();
      installRpc("present", count);
      await revalidateSolana();
      expect(getSolanaRailStats().receiptCount).toBe(count);
      expect(alerts.filter((a) => a.kind === "payai_allowance")).toHaveLength(expected);
      if (expected) expect(alerts[0]).toMatchObject({ kind: "payai_allowance", source: "onchain_receipts", used: at, allowance: PAYAI_FREE_SETTLEMENTS, threshold: at });
      vi.restoreAllMocks();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    }
  });

  it("(9) PayAI free_tier_exhausted on settle => allowance alert + Base-only 402 (definitive, nothing charged)", async () => {
    const alerts: SolanaAlert[] = [];
    facilitators({ settle: () => { throw new SettleError(403, { success: false, errorReason: "free_tier_exhausted: buy credits", transaction: "", network: SOLANA_MAINNET_CAIP2 } as never); } });
    stubSolanaOn();
    const [, sol] = await accepts();
    setSolanaAlertHook((a) => alerts.push(a));
    const res = await handler().handler(paid(solPayload(sol)));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(goldenHeader);
    expect(alerts).toEqual([expect.objectContaining({ kind: "payai_allowance", source: "free_tier_exhausted" })]);
  });
});
