import { VerifyError } from "@x402/core/types";
/**
 * Premium ladder v3.2 (spec to-odin/2026-10-19-pulse-premium-spec-v3.md incl. v3.1 / v3.2). All upstreams mocked:
 * facilitator (helpers/facilitator-mock), Base RPC (setPremiumRpcForTests), Parallel (setParallelForTests).
 * No network, no real key, no paid call.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { setBriefGateForTests, setPremiumClockForTests } from "@/lib/premium/handler";
import { setClassifierForTests, TEST_GENERIC_TYPE } from "@/lib/premium/source-index";
import * as researchTier from "@/app/api/research/report/[tier]/route";
import * as researchBare from "@/app/api/research/report/route";
import * as watchTier from "@/app/api/seller-watch/[tier]/route";
import * as watchBare from "@/app/api/seller-watch/route";
import * as wellKnown from "@/app/.well-known/x402/route";
import * as skill from "@/app/skill.md/route";
import { PREMIUM_TIERS, premiumEnabled, projectedSeconds, tierPath, WORK_BUDGET_S, type TierId } from "@/lib/premium/tiers";
import { resetPremiumFacilitatorForTests, resetPremiumNoncesForTests, setPremiumRpcForTests, AUTHORIZATION_STATE_SELECTOR, TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_BASE_DOMAIN } from "@/lib/premium/payment";
import { setParallelForTests } from "@/lib/premium/parallel";
import { setReconcileForTests, type ReconcileLine } from "@/lib/premium/reconcile";
import { BUYER_TERMS, DISCLAIMER, FCRA_CLAUSE, NO_DOXXING, PREMIUM_CONTACT, R1_DESCRIPTION, R2_DESCRIPTION, REFUND_LINE, WATCH_TERMS } from "@/lib/premium/copy";
import { premiumSkillSection } from "@/lib/premium/discovery";
import { SNIPPET_MAX_WORDS, SNIPPETS_PER_SOURCE } from "@/lib/premium/research";

const ROOT = path.resolve(__dirname, "..");
// approved-addresses.md line 8 (Base payTo), full string.
const PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const FROM = ACCOUNT.address;
const KEY = "test-parallel-key-not-real";
const price = (id: TierId) => PREMIUM_TIERS.find((t) => t.id === id)!.amount;
const routeOf = (id: TierId) => (["watch", "watch-report"].includes(id) ? "seller-watch" : "research");
const input = (id: TierId) => (routeOf(id) === "research" ? "q=what%20is%20x402" : "target=https%3A%2F%2Fexample.com%2Fapi");
let nonceSeq = 0;
const nonce = () => `0x${(++nonceSeq).toString(16).padStart(64, "0")}`;

type PayOpts = { amount?: string; value?: string; network?: string; scheme?: string; asset?: string; payTo?: string; to?: string; nonce?: string; validAfter?: string; validBefore?: string; badSig?: boolean };
/** Real EIP-3009 signature by a throwaway test key (never a real wallet), so the local signature check passes. */
async function payment(o: PayOpts = {}) {
  const amount = o.amount ?? price("brief");
  const auth = { from: FROM, to: o.to ?? o.payTo ?? PAYTO, value: o.value ?? amount, validAfter: o.validAfter ?? "0", validBefore: o.validBefore ?? String(Math.floor(Date.now() / 1000) + 1800), nonce: o.nonce ?? nonce() };
  let signature = "0x" + "ab".repeat(65);
  if (!o.badSig && /^0x[0-9a-fA-F]{40}$/.test(auth.to)) {
    signature = await ACCOUNT.signTypedData({
      domain: USDC_BASE_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: FROM as `0x${string}`, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` },
    });
  }
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: o.scheme ?? "exact", network: o.network ?? "eip155:8453", amount, asset: o.asset ?? USDC, payTo: o.payTo ?? PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
    payload: { signature, authorization: auth },
  } as never);
}

function call(id: string, query = "", headers: Record<string, string> = {}, method = "GET") {
  const route = ["watch", "watch-report"].includes(id) ? "seller-watch" : "research";
  const base = route === "research" ? "/api/research/report" : "/api/seller-watch";
  const req = new NextRequest(`https://horizonpulse.dev${base}/${id}${query ? `?${query}` : ""}`, { method, headers: { accept: "application/json", ...headers } });
  const mod = route === "research" ? researchTier : watchTier;
  return (method === "OPTIONS" ? mod.OPTIONS(req, { params: Promise.resolve({ tier: id }) }) : mod.GET(req, { params: Promise.resolve({ tier: id }) })) as Promise<Response>;
}

let fac: ReturnType<typeof installFacilitatorMock>;
let rpcCalls: string[];
let rpcAnswer: "used" | "unused" | "down";
let parallelCalls: { url: string; key: string | null; body: any }[];
let reconciles: ReconcileLine[];
let settleBehaviour: () => unknown;
let errors: string[];

function on(extra: Record<string, string> = {}) {
  vi.stubEnv("HP_PREMIUM_ENABLED", "true");
  vi.stubEnv("PARALLEL_API_KEY", KEY);
  vi.stubEnv("CDP_API_KEY_ID", "test-key-id");
  vi.stubEnv("CDP_API_KEY_SECRET", "test-key-secret");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

const LONG_EXCERPT =
  "Section Title: x\nContent:\nThe x402 protocol lets an HTTP server answer 402 Payment Required and settle a stablecoin payment in the same request cycle, which agents can use without accounts. " +
  "It was announced in May 2025 by Coinbase and has since been adopted by several API sellers across Base and Solana networks for pay per call access to data. " +
  Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + ". Another sentence long enough to count as a snippet for the cap test here. Yet another sentence long enough to count as a snippet too. " +
  "Fifth sentence that is long enough to be a snippet in this test. Sixth sentence that is long enough to be a snippet in this test case. Seventh sentence long enough to be a snippet here.";

let store: MemoryPremiumStore;
beforeEach(() => {
  setBriefGateForTests((b) => (b ? "confirmed" : null)); // legacy settle/redeem flow tests: contract gate stubbed to pass
  setClassifierForTests(() => ({ ok: true, type: TEST_GENERIC_TYPE })); // ...and any question accepted (ruling (c) scope tested separately)
  vi.unstubAllEnvs();
  store = new MemoryPremiumStore();
  setPremiumStoreForTests(store);
  resetPremiumFacilitatorForTests();
  resetPremiumNoncesForTests();
  rpcCalls = [];
  rpcAnswer = "unused";
  parallelCalls = [];
  reconciles = [];
  errors = [];
  settleBehaviour = () => ({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: FROM });
  fac = installFacilitatorMock({
    verify: () => ({ isValid: true, payer: FROM }),
    settle: () => settleBehaviour(),
  });
  setPremiumRpcForTests({
    now: () => Date.now(),
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      rpcCalls.push(body.params[0].data);
      if (rpcAnswer === "down") throw new Error("down");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (rpcAnswer === "used" ? "1" : "0").padStart(64, "0") }));
    }) as never,
  });
  setParallelForTests({
    fetch: (async (u: string, init: RequestInit) => {
      parallelCalls.push({ url: u, key: new Headers(init.headers).get("x-api-key"), body: JSON.parse(String(init.body)) });
      const results = [
        { url: "https://a.example.com/x402", title: "A", publish_date: "2025-05-06", excerpts: [LONG_EXCERPT] },
        { url: "https://b.example.org/post", title: "B", publish_date: null, excerpts: ["The x402 protocol lets an HTTP server answer 402 Payment Required and settle a stablecoin payment in the same request cycle, as reported."] },
        { url: "https://agency.gov/report.pdf", title: "PDF", publish_date: "2026-01-02", excerpts: ["A government report published on 2026-01-02 describes agent payments over HTTP in some detail."] },
      ];
      return new Response(JSON.stringify({ results }));
    }) as never,
  });
  setReconcileForTests({ sink: (l) => reconciles.push(l) });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setPremiumRpcForTests(null);
  setParallelForTests(null);
  setReconcileForTests(null);
  setPremiumStoreForTests(undefined);
  setPremiumClockForTests(null);
});

const ALL: TierId[] = ["brief", "standard", "extended", "report", "monitor", "watch", "watch-report"];

describe("feature flag HP_PREMIUM_ENABLED (default OFF)", () => {
  for (const v of [undefined, "TRUE", "1", " true", "false", "yes"]) {
    it(`flag=${JSON.stringify(v)} -> 404 on every tier URL, bare path and OPTIONS; no 402`, async () => {
      if (v !== undefined) vi.stubEnv("HP_PREMIUM_ENABLED", v);
      vi.stubEnv("PARALLEL_API_KEY", KEY);
      expect(premiumEnabled()).toBe(false);
      for (const id of ALL) {
        for (const r of [await call(id, input(id)), await call(id, input(id), { "payment-signature": await payment() }), await call(id, "", {}, "OPTIONS")]) {
          expect(r.status).toBe(404);
          expect(r.headers.get("payment-required")).toBeNull();
        }
      }
      for (const mod of [researchBare, watchBare]) {
        const r = await mod.GET(new NextRequest("https://horizonpulse.dev/api/x"));
        expect(r.status).toBe(404);
      }
      expect(fac.length).toBe(0);
      expect(parallelCalls.length).toBe(0);
    });
  }
});

describe("N2 / T3a.3: path URLs only, 400 before any 402", () => {
  it("bare paths -> 400 tier_required, no PAYMENT-REQUIRED", async () => {
    on();
    for (const mod of [researchBare, watchBare]) {
      for (const verb of ["GET", "POST", "OPTIONS"] as const) {
        const r = await (mod as any)[verb](new NextRequest("https://horizonpulse.dev/api/research/report?q=x402&tier=brief", { method: verb }));
        expect(r.status).toBe(400);
        expect(r.headers.get("payment-required")).toBeNull();
      }
    }
  });
  it("unknown tiers (incl. case variants, old names) -> 400", async () => {
    on();
    for (const id of ["dossier", "Brief", "BRIEF", "full", "diligence", "", "brief ", "watch-report2"]) {
      const r = await call(id, "q=hello%20world");
      expect(r.status).toBe(400);
      expect(r.headers.get("payment-required")).toBeNull();
    }
    // cross-route tiers are unknown on the other route
    const r1 = await researchTier.GET(new NextRequest("https://horizonpulse.dev/api/research/report/watch?q=abc"), { params: Promise.resolve({ tier: "watch" }) });
    expect(r1.status).toBe(400);
    const r2 = await watchTier.GET(new NextRequest("https://horizonpulse.dev/api/seller-watch/brief?target=https://x.dev"), { params: Promise.resolve({ tier: "brief" }) });
    expect(r2.status).toBe(400);
  });
  it("any tier query -> 400, incl. /brief?tier=monitor and with a payment attached", async () => {
    on({ HP_PREMIUM_ASYNC_ENABLED: "true" });
    for (const id of ALL) {
      for (const q of [`${input(id)}&tier=monitor`, `tier=${id}&${input(id)}`, `${input(id)}&tier=`]) {
        const r = await call(id, q, { "payment-signature": await payment({ amount: price(id) }) });
        expect(r.status).toBe(400);
        expect(r.headers.get("payment-required")).toBeNull();
      }
    }
    expect(fac.length).toBe(0);
    expect(rpcCalls.length).toBe(0);
  });
  it("missing / bad q or target -> 400 before 402", async () => {
    on({ HP_PREMIUM_ASYNC_ENABLED: "true" });
    expect((await call("brief", "")).status).toBe(400);
    expect((await call("brief", "q=" + "x".repeat(501))).status).toBe(400);
    expect((await call("watch", "target=http%3A%2F%2Fexample.com")).status).toBe(400);
    expect((await call("watch", "target=notaurl")).status).toBe(400);
  });
  it("non-GET on a tier URL -> 405", async () => {
    on();
    const r = await researchTier.POST(new NextRequest("https://horizonpulse.dev/api/research/report/brief?q=abc", { method: "POST" }), { params: Promise.resolve({ tier: "brief" }) });
    expect(r.status).toBe(405);
  });
});

describe("unpaid 402: server-side per-tier price, Base-only", () => {
  it("each sync tier: one Base accepts entry at price(tier), pinned payTo, even with every other rail flag on", async () => {
    on({ HP_SOLANA_ENABLED: "true", HP_XRPL_ENABLED: "true", HP_POLYGON_ENABLED: "true" });
    for (const id of ["brief", "standard", "extended"] as TierId[]) {
      const r = await call(id, input(id));
      expect(r.status).toBe(402);
      const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
      expect(pr.accepts).toHaveLength(1);
      expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453", amount: price(id), asset: USDC, payTo: PAYTO });
      expect(pr.resource.url).toBe(`https://horizonpulse.dev/api/research/report/${id}`);
      expect(pr.resource.terms).toBe("https://horizonpulse.dev/premium-terms");
      expect(JSON.stringify(pr)).not.toMatch(/solana|xrpl|eip155:137/i);
    }
    expect(fac.length).toBe(0);
  });
  it("prices are the spec ladder", () => {
    expect(Object.fromEntries(PREMIUM_TIERS.map((t) => [t.id, t.amount]))).toEqual({
      brief: "1000000", standard: "5000000", extended: "10000000", report: "20000000", monitor: "50000000", watch: "75000000", "watch-report": "100000000",
    });
    expect(PREMIUM_TIERS.every((t) => t.rails.length === 1 && t.rails[0] === "base" && t.premium)).toBe(true);
  });
  it("OPTIONS on a sync tier = 200 + the same Base-only requirement", async () => {
    on();
    const r = await call("standard", "", {}, "OPTIONS");
    expect(r.status).toBe(200);
    const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0].amount).toBe(price("standard"));
  });
});

describe("refusals before payment (uncharged)", () => {
  it("no PARALLEL_API_KEY -> 503 before any 402 / verify / settle", async () => {
    on();
    vi.stubEnv("PARALLEL_API_KEY", "");
    for (const h of [{} as Record<string, string>, { "payment-signature": await payment() }]) {
      const r = await call("brief", input("brief"), h);
      expect(r.status).toBe(503);
      expect(r.headers.get("payment-required")).toBeNull();
    }
    expect(fac.length).toBe(0);
  });
  it("async tiers ($20+) with HP_PREMIUM_ASYNC_ENABLED off -> 503, no 402, nothing verified", async () => {
    on();
    for (const id of ["report", "monitor", "watch", "watch-report"] as TierId[]) {
      for (const h of [{} as Record<string, string>, { "payment-signature": await payment({ amount: price(id) }) }]) {
        const r = await call(id, input(id), h);
        expect(r.status).toBe(503);
        expect(r.headers.get("payment-required")).toBeNull();
        expect((await r.json()).charged).toBe(false);
      }
    }
    expect(fac.length).toBe(0);
    expect(rpcCalls.length).toBe(0);
  });
  it("async flag on: $50 monitor and $100 watch-report (not live this Class A) still refused 503 BEFORE any 402 / verify", async () => {
    on({ HP_PREMIUM_ASYNC_ENABLED: "true" });
    for (const id of ["monitor", "watch-report"] as TierId[]) {
      const r = await call(id, input(id), { "payment-signature": await payment({ amount: price(id) }) });
      expect(r.status).toBe(503);
    }
    expect(fac.length).toBe(0);
    expect(rpcCalls.length).toBe(0);
  });
  it("$10 extended: projection > 50 s -> uncharged 503 before verify/settle, never 202; within budget -> 402", async () => {
    on();
    const long = encodeURIComponent("a1 one?b2 two?c3 three?d4 four?e5 five?f6 six?");
    const ext = PREMIUM_TIERS.find((t) => t.id === "extended")!;
    expect(projectedSeconds(ext, decodeURIComponent(long))).toBeGreaterThan(WORK_BUDGET_S);
    for (const h of [{} as Record<string, string>, { "payment-signature": await payment({ amount: price("extended") }) }]) {
      const r = await call("extended", `q=${long}`, h);
      expect(r.status).toBe(503);
      expect(r.headers.get("payment-required")).toBeNull();
      expect((await r.json()).error).toBe("time_budget_exceeded");
    }
    expect(fac.length).toBe(0);
    expect((await call("extended", "q=what%20is%20x402")).status).toBe(402);
  });
});

describe("T3.1: non-Base payloads -> rail_unavailable with zero store / facilitator / RPC calls", () => {
  const variants: Record<string, Parameters<typeof payment>[0]> = {
    solana: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz" },
    xrpl: { network: "xrpl:0", asset: "RLUSD", payTo: "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf" },
    polygon: { network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
    "base wrong asset": { asset: "0x0000000000000000000000000000000000000001" },
    "base wrong scheme": { scheme: "upto" },
  };
  for (const [name, v] of Object.entries(variants)) {
    it(name, async () => {
      on({ HP_SOLANA_ENABLED: "true", HP_XRPL_ENABLED: "true", HP_POLYGON_ENABLED: "true" });
      const f = vi.spyOn(globalThis, "fetch");
      for (const id of ["brief", "standard", "extended"] as TierId[]) {
        const r = await call(id, input(id), { "payment-signature": await payment({ ...v, amount: price(id) }) });
        expect(r.status).toBe(402);
        expect((await r.json()).error).toBe("rail_unavailable");
        const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
        expect(pr.accepts.map((a: any) => a.network)).toEqual(["eip155:8453"]);
      }
      expect(fac.length).toBe(0);
      expect(rpcCalls.length).toBe(0);
      expect(parallelCalls.length).toBe(0);
      expect(f).not.toHaveBeenCalled();
      expect(reconciles.length).toBe(0);
    });
  }
  it("garbage header -> 402 invalid_payment, zero calls", async () => {
    on();
    const r = await call("brief", input("brief"), { "payment-signature": "not-base64-json" });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("invalid_payment");
    expect(fac.length + rpcCalls.length + parallelCalls.length).toBe(0);
  });
  it("X-PAYMENT header classified the same way (by payload, not header type)", async () => {
    on();
    const r = await call("brief", input("brief"), { "x-payment": await payment(variants.polygon) });
    expect((await r.json()).error).toBe("rail_unavailable");
  });
});

describe("§3a price binding (T3a.1 / T3a.2)", () => {
  it("T3a.1: $1 brief payment sent to /report ($20, async live) -> 402 for $20, no verify/settle, nothing delivered", async () => {
    on({ HP_PREMIUM_ASYNC_ENABLED: "true" });
    const r = await call("report", input("report"), { "payment-signature": await payment({ amount: price("brief") }) });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("amount_mismatch");
    const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
    expect(pr.accepts[0].amount).toBe("20000000");
    expect(pr.accepts[0].maxTimeoutSeconds).toBe(900);
    expect(fac.length + rpcCalls.length + parallelCalls.length).toBe(0);
  });
  it("T3a.1 (sync): $1 payment on /standard and /extended -> 402 for that tier", async () => {
    on();
    for (const id of ["standard", "extended"] as TierId[]) {
      const r = await call(id, input(id), { "payment-signature": await payment({ amount: price("brief") }) });
      expect(r.status).toBe(402);
      expect((decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any).accepts[0].amount).toBe(price(id));
    }
    expect(fac.length + parallelCalls.length).toBe(0);
  });
  it("T3a.2: $1 or $20 payment on /seller-watch/watch ($75) -> 402 for $75", async () => {
    on({ HP_PREMIUM_ASYNC_ENABLED: "true" });
    for (const a of [price("brief"), price("report")]) {
      const r = await call("watch", input("watch"), { "payment-signature": await payment({ amount: a }) });
      expect(r.status).toBe(402);
      expect((decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any).accepts[0].amount).toBe("75000000");
    }
    expect(fac.length).toBe(0);
  });
  it("accepted.amount right but signed authorization.value lower -> 402 amount_mismatch", async () => {
    on();
    const r = await call("standard", input("standard"), { "payment-signature": await payment({ amount: price("standard"), value: price("brief") }) });
    expect((await r.json()).error).toBe("amount_mismatch");
    expect(fac.length).toBe(0);
  });
  it("payTo or authorization.to not the full line-8 string -> 402 payto_mismatch", async () => {
    on();
    for (const o of [{ payTo: PAYTO.slice(0, -1) + "0" }, { to: "0x2222222222222222222222222222222222222222" }]) {
      const r = await call("brief", input("brief"), { "payment-signature": await payment(o) });
      expect((await r.json()).error).toBe("payto_mismatch");
    }
    expect(fac.length).toBe(0);
  });
});

describe("paid sync path", () => {
  it("brief: verify -> Parallel -> settle -> 200 with paid tier, disclaimer, terms, contact, PAYMENT-RESPONSE", async () => {
    on();
    const r = await call("brief", "q=what%20is%20x402", { "payment-signature": await payment() });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.paid).toMatchObject({ tier: "brief", amount: "1000000", network: "eip155:8453" });
    expect(j.disclaimer).toBe(DISCLAIMER);
    expect(j.contact).toBe(PREMIUM_CONTACT);
    expect(r.headers.get("payment-response")).toBeTruthy();
    expect(fac.map((c) => c.op)).toEqual(["verify", "settle"]);
    expect(fac.every((c) => c.network === "eip155:8453")).toBe(true);
    expect(rpcCalls[0].startsWith(AUTHORIZATION_STATE_SELECTOR)).toBe(true);
    expect(parallelCalls[0].url).toBe("https://api.parallel.ai/v1/search");
    expect(parallelCalls[0].key).toBe(KEY);
    expect(JSON.stringify(j)).not.toContain(KEY);
    expect(j.contract.method).toBe("https://horizonpulse.dev/contracts/brief-verified"); // ruling (c): contract view
    expect(SNIPPET_MAX_WORDS).toBeGreaterThan(0);
  });
  it("standard: fan-out, two-domain claims, could_not_confirm; <= 5 snippets per source; PDFs only on extended", async () => {
    on();
    const j = await (await call("standard", "q=what%20is%20x402%3F%20who%20uses%20it", { "payment-signature": await payment({ amount: price("standard") }) })).json();
    expect(j.sub_questions.length).toBe(2);
    expect(j.found_on_two_or_more_domains.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(j.could_not_confirm)).toBe(true);
    const per = new Map<number, number>();
    for (const s of j.snippets) per.set(s.source, (per.get(s.source) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(SNIPPETS_PER_SOURCE);
    expect(j.sources.some((s: any) => s.pdf)).toBe(false);
    expect(parallelCalls.map((c) => c.url)).toContain("https://api.parallel.ai/v1/extract");
  });
  it("extended: timeline, primary/secondary heuristic labels, PDF sources", async () => {
    on();
    const j = await (await call("extended", "q=what%20is%20x402", { "payment-signature": await payment({ amount: price("extended") }) })).json();
    expect(j.timeline.length).toBeGreaterThan(0);
    expect(j.sources.find((s: any) => s.pdf).label).toBe("primary_heuristic");
  });
  it("charge-on-pass + Sentinel LOW-7: Parallel outage -> 503 research_provider_unavailable, charged:false, NO settle, authorization not burned", async () => {
    on();
    setParallelForTests({ fetch: (async () => new Response("x", { status: 500 })) as never });
    const r = await call("brief", input("brief"), { "payment-signature": await payment() });
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.charged).toBe(false);
    expect(j.error).toBe("research_provider_unavailable");
    expect(r.headers.get("payment-response")).toBeNull();
    expect(fac.map((c) => c.op)).toEqual(["verify"]);
    expect(reconciles).toHaveLength(0);
  });
  it("charge-on-pass: Parallel runs BEFORE settle; settle only after the gate passes (order)", async () => {
    on();
    const order: string[] = [];
    fac = installFacilitatorMock({ verify: () => (order.push("verify"), { isValid: true }), settle: () => (order.push("settle"), settleBehaviour()) });
    setParallelForTests({ fetch: (async (u: string) => (order.push("parallel"), new Response(JSON.stringify({ results: [{ url: "https://a.example/", excerpts: ["e"] }] })))) as never });
    expect((await call("brief", input("brief"), { "payment-signature": await payment() })).status).toBe(200);
    expect(order.indexOf("parallel")).toBeGreaterThan(-1);
    expect(order.indexOf("parallel")).toBeLessThan(order.indexOf("settle"));
  });
  it("charge-on-pass: real contract gate (no stub) on a brief that misses the contract -> 422, unpaid, failed brief returned with reasons", async () => {
    on();
    setBriefGateForTests(null);
    const r = await call("brief", input("brief"), { "payment-signature": await payment() });
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.charged).toBe(false);
    expect(fac.some((c) => c.op === "settle")).toBe(false);
    expect(j.contract).toBe("https://horizonpulse.dev/contracts/brief-verified");
  });
  it("verify invalid -> 402 for the tier; verify error -> 503; neither settles", async () => {
    on();
    fac = installFacilitatorMock({ verify: () => ({ isValid: false, invalidReason: "insufficient_funds" }) });
    const r = await call("brief", input("brief"), { "payment-signature": await payment() });
    expect(r.status).toBe(402);
    resetPremiumFacilitatorForTests();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fac = installFacilitatorMock({ verify: () => { throw new Error("boom"); } });
    expect((await call("brief", input("brief"), { "payment-signature": await payment() })).status).toBe(503);
    expect(fac.some((c) => c.op === "settle")).toBe(false);
  });
  it("verify throws VerifyError with invalidReason (CDP non-2xx rejection) -> 402 invalid reason, charged:false, no settle", async () => {
    on();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fac = installFacilitatorMock({ verify: () => { throw new VerifyError(400, { isValid: false, invalidReason: "invalid_payload", invalidMessage: "contract call failed: execution reverted" }); } });
    const r = await call("brief", input("brief"), { "payment-signature": await payment() });
    expect(r.status).toBe(402);
    const b: any = await r.json();
    expect(b.error).toBe("invalid_payload");
    expect(b.charged).toBe(false);
    expect(b.accepts[0].amount).toBe("1000000");
    expect(JSON.stringify(b)).not.toContain("execution reverted");
    expect(r.headers.get("payment-required")).toBeTruthy();
    expect(fac.some((c) => c.op === "settle")).toBe(false);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[premium][facilitator]"))).toBe(false);
  });
  it("verify throws VerifyError without invalidReason, or a non-VerifyError -> 503 facilitator_unavailable, charged:false, no settle", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const thrower of [() => { throw new VerifyError(500, { isValid: false }); }, () => { throw new Error("Facilitator verify failed (500): oops"); }]) {
      resetPremiumFacilitatorForTests();
      fac = installFacilitatorMock({ verify: thrower });
      const r = await call("brief", input("brief"), { "payment-signature": await payment() });
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: "facilitator_unavailable", charged: false });
      expect(fac.some((c) => c.op === "settle")).toBe(false);
    }
  });
  it("no CDP keys -> 503 settlement_unavailable before any facilitator call", async () => {
    on();
    vi.stubEnv("CDP_API_KEY_ID", "");
    vi.stubEnv("CDP_API_KEY_SECRET", "");
    expect((await call("brief", input("brief"), { "payment-signature": await payment() })).status).toBe(503);
    expect(fac.length).toBe(0);
  });
});

describe("§4 settle timeout / ambiguous / used nonce", () => {
  const expectReconcile = (outcome: string) => {
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]).toMatchObject({ outcome, tier: "brief", route: "/api/research/report/brief", payer: FROM, amount: "1000000", payTo: PAYTO });
    expect(reconciles[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(reconciles[0])).not.toContain("abab"); // no signature
    expect(errors.some((e) => e.includes("[premium][ALERT][HIGH]") && e.includes(outcome))).toBe(true);
  };
  it("T4.1: settle timeout -> 504 settle_unconfirmed + reconcile + HIGH, never a 402", async () => {
    on();
    settleBehaviour = () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; };
    const r = await call("brief", input("brief"), { "payment-signature": await payment() });
    expect(r.status).toBe(504);
    expect(r.headers.get("payment-required")).toBeNull();
    const j = await r.json();
    expect(j.status).toBe("settle_unconfirmed");
    expect(j.reconcile_id).toBe(reconciles[0].reconcile_id);
    expectReconcile("settle_timeout");
  });
  it("T4.1b: ambiguous settle (success false / no tx / error) -> 502 settle_unconfirmed + reconcile + HIGH, never a 402", async () => {
    for (const b of [() => ({ success: false, errorReason: "x" }), () => ({ success: true }), () => { throw new Error("upstream 500"); }]) {
      reconciles = [];
      errors = [];
      on();
      settleBehaviour = b as never;
      const r = await call("brief", input("brief"), { "payment-signature": await payment() });
      expect(r.status).toBe(502);
      expect(r.headers.get("payment-required")).toBeNull();
      expectReconcile("settle_ambiguous");
    }
  });
  it("T4.2: authorizationState(from, nonce) = used -> 409 + reconcile + HIGH, no verify, never a 402", async () => {
    on();
    rpcAnswer = "used";
    const r = await call("brief", input("brief"), { "payment-signature": await payment() });
    expect(r.status).toBe(409);
    expect(r.headers.get("payment-required")).toBeNull();
    expect((await r.json()).error).toBe("authorization_already_used");
    expect(fac.length).toBe(0);
    expect(parallelCalls.length).toBe(0);
    expectReconcile("authorization_already_used");
  });
  it("nonce RPC down -> uncharged 503, nothing verified", async () => {
    on();
    rpcAnswer = "down";
    expect((await call("brief", input("brief"), { "payment-signature": await payment() })).status).toBe(503);
    expect(fac.length).toBe(0);
  });
  it("T4.3: settled authorization replayed on the identical and on a different request -> 409, nothing delivered, zero work", async () => {
    on();
    const header = await payment({ nonce: nonce() });
    expect((await call("brief", "q=first%20question", { "payment-signature": header })).status).toBe(200);
    const workBefore = parallelCalls.length;
    const facBefore = fac.length;
    for (const q of ["q=first%20question", "q=a%20different%20question"]) {
      const r = await call("brief", q, { "payment-signature": header });
      expect(r.status).toBe(409);
      const j = await r.json();
      expect(j.snippets).toBeUndefined();
    }
    // a different tier: price binding already refuses (402 for that tier), nothing delivered
    const r3 = await call("standard", "q=x402%20again", { "payment-signature": header });
    expect(r3.status).toBe(402);
    expect(parallelCalls.length).toBe(workBefore);
    expect(fac.length).toBe(facBefore);
    // shared claim says settled: 409 with no new reconcile line, alert or store write (Sentinel MEDIUM-1 dedupe)
    expect(reconciles).toHaveLength(0);
  });
  it("T4.3 (cross-instance): replay seen only on-chain (fresh instance) -> 409", async () => {
    on();
    resetPremiumNoncesForTests();
    rpcAnswer = "used";
    expect((await call("brief", "q=other", { "payment-signature": await payment() })).status).toBe(409);
  });
});

describe("discovery (T3.2 / T3a.4) and N1 (no MCP)", () => {
  it("/.well-known/x402 with flag on: sync tier URLs + Base-only premium block whose prices equal the 402 amounts", async () => {
    on();
    const doc = await wellKnown.GET().json();
    expect(doc.resources).toEqual(expect.arrayContaining(["https://horizonpulse.dev/api/research/report/brief", "https://horizonpulse.dev/api/research/report/standard", "https://horizonpulse.dev/api/research/report/extended"]));
    expect(doc.resources.some((u: string) => /monitor|seller-watch|\?tier=/.test(u))).toBe(false);
    expect(doc.premium.networks).toEqual(["eip155:8453"]);
    for (const t of doc.premium.tiers) {
      const id = t.url.split("/").pop();
      const r = await call(id, input(id));
      expect((decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any).accepts[0].amount).toBe(t.amount);
    }
    expect(JSON.stringify(doc.premium)).not.toMatch(/solana|xrpl|eip155:137|\?tier=/i);
  });
  it("async flag on lists the 3 sync tiers + the 2 live async tiers ($20 report, $75 watch), each once; $50/$100 unlisted", async () => {
    on({ HP_PREMIUM_ASYNC_ENABLED: "true" });
    const doc = await wellKnown.GET().json();
    const prem = doc.resources.filter((u: string) => /research\/report|seller-watch/.test(u));
    expect(prem).toEqual(PREMIUM_TIERS.filter((t) => !["monitor", "watch-report"].includes(t.id)).map((t) => `https://horizonpulse.dev${tierPath(t)}`));
  });
  it("skill.md premium section: Base only, no ?tier=, prices match", async () => {
    on();
    const md = await (await skill.GET()).text();
    const sec = premiumSkillSection();
    expect(md.endsWith(sec)).toBe(true);
    expect(sec).toContain("`GET /api/research/report/brief?q=…` — $1");
    expect(sec).not.toMatch(/\?tier=|solana|xrpl|polygon/i);
  });
  it("N1: premium is not on hosted /mcp or local mcp/ (no premium path or tool in either source)", () => {
    for (const f of ["lib/mcp-server.ts", "mcp/src/catalog.ts", "mcp/src/index.ts", "app/mcp/route.ts"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(src).not.toMatch(/research\/report|seller-watch|premium/i);
    }
  });
  it("cheap-route surfaces never mention premium (balance, related-routes, live catalog)", () => {
    for (const f of ["lib/balance.ts", "lib/route-hints.ts", "lib/live-catalog.ts", "public/openapi.json", "public/llms.txt"]) {
      expect(readFileSync(path.join(ROOT, f), "utf8")).not.toMatch(/research\/report|seller-watch/);
    }
  });
});

describe("copy (Counsel v3.2)", () => {
  it("public descriptions avoid banned words", () => {
    for (const s of [R1_DESCRIPTION, R2_DESCRIPTION, premiumSkillSection({ HP_PREMIUM_ENABLED: "true", HP_PREMIUM_ASYNC_ENABLED: "true" }).replace(DISCLAIMER, "")]) {
      expect(s).not.toMatch(/dossier|verifiable provenance|no AI|diligence|\baudit\b|credit|scam|fraud|unsafe/i);
    }
    expect(R2_DESCRIPTION).toContain("Paid once for a 30-day service; no balance held.");
  });
  it("buyer terms carry no-doxxing, FCRA, watch terms, refund line, disclaimer and the contact", () => {
    const all = BUYER_TERMS.join("\n");
    for (const s of [NO_DOXXING, FCRA_CLAUSE, WATCH_TERMS, REFUND_LINE, DISCLAIMER]) expect(all).toContain(s);
    expect(REFUND_LINE).toContain("horizonpulse.co@proton.me");
    expect(REFUND_LINE).not.toContain("[contact]");
    expect(WATCH_TERMS).toContain("price × undelivered days ÷ 30");
    expect(WATCH_TERMS).toContain("No auto-renewal");
    expect(all).toContain("at most 12 months");
  });
});

describe("facilitator error diagnostics (Preview 503 root cause, 10/19)", () => {
  it("verify 401 -> 503 facilitator_unavailable, uncharged, and a non-secret log line naming http_401 + the CDP env names", async () => {
    on();
    fac = installFacilitatorMock({ verify: () => { throw new Error("Facilitator verify failed (401): Unauthorized"); } });
    const r = await call("brief", input("brief"), { "payment-signature": await payment() });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).charged).toBe(false);
    const line = errors.find((l) => l.includes("[premium][facilitator] verify error"));
    expect(line).toContain("http_401");
    expect(line).toContain("CDP_API_KEY_ID");
    expect(line).not.toContain("test-key-secret");
    expect(line).not.toContain("test-key-id");
  });
  it("summary never includes the facilitator message body", async () => {
    const { facilitatorErrorSummary } = await import("@/lib/premium/payment");
    expect(facilitatorErrorSummary("settle", new Error("Facilitator settle failed (500): secret-ish body text"))).toBe("[premium][facilitator] settle error http_500");
    expect(facilitatorErrorSummary("verify", new TypeError("fetch failed"))).toBe("[premium][facilitator] verify error TypeError");
  });
});
