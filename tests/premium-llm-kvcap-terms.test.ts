import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "@/lib/premium/research";
import { tierFor } from "@/lib/premium/tiers";
import { MemoryPremiumStore, setPremiumStoreForTests, SPEND_RESERVE_LUA, type PremiumStore } from "@/lib/premium/store";
import {
  kvSpendHook, llmCacheKey, llmSpendKey, LLM_CACHE_TTL_S, LLM_MAX_COST_USD, LLM_MAX_COST_PESSIMISTIC_USD, LLM_MAX_INPUT_CHARS, LLM_MAX_OUTPUT_TOKENS, LLM_RESERVE_USD, LLM_SPEND_TTL_S,
  pageSentences, resetSynthesisForTests, setSynthesisForTests, synthesizeBrief, type ModelCall,
} from "@/lib/premium/synthesis";
import { AI_PROVIDER_PRIVACY, AI_PROVIDER_TERMS, AI_SELECTION_TERM, BUYER_FLOWDOWN, BUYER_TERMS } from "@/lib/premium/copy";

const brief = tierFor("research" as never, "brief")!;
const ON = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-not-a-key" };
const load = (n: string) => ({ s: JSON.parse(readFileSync(`tests/fixtures/real/${n}-search.json`, "utf8")), e: JSON.parse(readFileSync(`tests/fixtures/real/${n}-extract.json`, "utf8")) });
const T0 = Date.UTC(2026, 9, 19, 22, 0, 0);
let store: MemoryPremiumStore;
beforeEach(() => {
  store = new MemoryPremiumStore();
  store.now = () => T0;
  setPremiumStoreForTests(store);
});
afterEach(() => {
  resetSynthesisForTests();
  setPremiumStoreForTests(undefined);
});

function pickModel(n: string, q: string, counter: { n: number; users: string[] }): ModelCall {
  const { e } = load(n);
  const { list } = pageSentences(e.results, q);
  const sel = list.slice(0, 3).map((s) => ({ id: s.id, url: s.url, quote: s.text }));
  return async ({ user }) => {
    counter.n++;
    counter.users.push(user);
    return { text: JSON.stringify({ answer: [], claims: sel.map((x) => ({ quotes: [x] })), unanswerable: false }), inputTokens: 2000, outputTokens: 200 };
  };
}
const run = async (n: string, jobKey?: string) => {
  const { s, e } = load(n);
  return (await synthesizeBrief(s.question, compile(brief, s.question, s.results, "t", e.results) as any, e.results, Date.now() + 30_000, jobKey)) as any;
};

describe("KV global daily spend cap (fails closed)", () => {
  it("reserves atomically in the premium store, keyed by UTC day, 2-day TTL; reconciles to the actual cost", async () => {
    const c = { n: 0, users: [] as string[] };
    const { s } = load("prem4");
    setSynthesisForTests({ env: ON, model: pickModel("prem4", s.question, c), now: () => T0 });
    const out = await run("prem4");
    expect(out.synthesis).toBe("llm_selected_verified");
    const key = llmSpendKey(T0);
    expect(key).toBe("llm:spend:2026-10-19");
    expect(store.writes.find((w) => w.op === "spendReserve")).toEqual({ op: "spendReserve", key, ttlMs: LLM_SPEND_TTL_S * 1000 });
    const actual = (2000 * 1.25 + 200 * 2.5) / 1e6;
    expect(Number(await store.get(key))).toBeCloseTo(actual, 10);
  });
  it("cap reached -> code fallback, model never called", async () => {
    const c = { n: 0, users: [] as string[] };
    const { s } = load("prem4");
    await store.spendReserve(llmSpendKey(T0), 1.999, 2, 60);
    setSynthesisForTests({ env: ON, model: pickModel("prem4", s.question, c), now: () => T0 });
    expect((await run("prem4")).synthesis).toBe("code_fallback:spend_cap");
    expect(c.n).toBe(0);
  });
  it("PREMIUM_LLM_DAILY_CAP_USD lowers the cap", async () => {
    const c = { n: 0, users: [] as string[] };
    const { s } = load("prem4");
    setSynthesisForTests({ env: { ...ON, PREMIUM_LLM_DAILY_CAP_USD: String(LLM_RESERVE_USD / 2) }, model: pickModel("prem4", s.question, c), now: () => T0 });
    expect((await run("prem4")).synthesis).toBe("code_fallback:spend_cap");
    expect(c.n).toBe(0);
  });
  it("KV error -> code fallback (fail closed); no store configured -> code fallback", async () => {
    const c = { n: 0, users: [] as string[] };
    const { s } = load("prem4");
    const broken = Object.assign(new MemoryPremiumStore(), { spendReserve: async () => { throw new Error("upstash down"); } }) as PremiumStore;
    setPremiumStoreForTests(broken);
    setSynthesisForTests({ env: ON, model: pickModel("prem4", s.question, c), now: () => T0 });
    expect((await run("prem4")).synthesis).toBe("code_fallback:spend_cap");
    setPremiumStoreForTests(null);
    expect((await run("prem4")).synthesis).toBe("code_fallback:spend_cap");
    expect(c.n).toBe(0);
  });
  it("refunds the full reservation when the model is never called", async () => {
    const h = kvSpendHook(store, ON, () => T0);
    expect(await h.reserve(0.01)).toBe(true);
    await h.reconcile(0.01, 0);
    expect(Number(await store.get(llmSpendKey(T0)))).toBeCloseTo(0, 12);
  });
  it("reserve before UTC midnight, reconcile after: adjusts the reserve day, not the new day (per-request hook)", async () => {
    let t = Date.UTC(2026, 9, 19, 23, 59, 59, 500);
    const h = kvSpendHook(store, ON, () => t);
    const d1 = llmSpendKey(t);
    expect(await h.reserve(0.01)).toBe(true);
    t += 2_000; // now 2026-10-20 UTC
    const d2 = llmSpendKey(t);
    expect(d2).not.toBe(d1);
    await h.reconcile(0.01, 0.004);
    expect(Number(await store.get(d1))).toBeCloseTo(0.004, 12);
    expect(await store.get(d2)).toBeFalsy();
  });
  it("model error after the call: charges the reserved worst case (no usage reported)", async () => {
    const { s } = load("prem4");
    setSynthesisForTests({ env: ON, model: async () => { throw new Error("boom"); }, now: () => T0 });
    expect((await run("prem4")).synthesis).toBe("code_fallback:error");
    expect(Number(await store.get(llmSpendKey(T0)))).toBeCloseTo(LLM_RESERVE_USD, 10);
    void s;
  });
  it("Lua reservation checks the cap and increments in one script (INCRBYFLOAT + EXPIRE)", () => {
    expect(SPEND_RESERVE_LUA).toMatch(/INCRBYFLOAT/);
    expect(SPEND_RESERVE_LUA).toMatch(/EXPIRE/);
    expect(SPEND_RESERVE_LUA).toMatch(/> tonumber\(ARGV\[2\]\)/);
  });
});

describe("job-keyed synthesis cache (verified quotes only)", () => {
  it("second run with the same job key: no model call, no spend; stores only url+quote, TTL 1h, hashed key", async () => {
    const c = { n: 0, users: [] as string[] };
    const { s } = load("prem4");
    setSynthesisForTests({ env: ON, model: pickModel("prem4", s.question, c), now: () => T0 });
    const job = "hp:claim:0xabc:0xnonce";
    const a = await run("prem4", job);
    const spentAfterFirst = await store.get(llmSpendKey(T0));
    const b = await run("prem4", job);
    expect(c.n).toBe(1);
    expect(b.synthesis).toBe("llm_selected_verified_cached");
    expect(b.claims.map((x: any) => x.claim)).toEqual(a.claims.map((x: any) => x.claim));
    expect(await store.get(llmSpendKey(T0))).toBe(spentAfterFirst);
    const key = llmCacheKey(job);
    expect(key).toMatch(/^llm:sel:[0-9a-f]{32}$/);
    expect(key).not.toContain("0xabc");
    expect(store.writes.find((w) => w.key === key)?.ttlMs).toBe(LLM_CACHE_TTL_S * 1000);
    const raw = (await store.get(key))!;
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(["answer", "claims", "v"]);
    for (const qs of parsed.claims) for (const q of qs) expect(Object.keys(q).sort()).toEqual(["quote", "url"]);
    expect(raw).not.toContain("Question:");
    expect(raw).not.toContain("<page");
    expect(raw).not.toContain(s.question);
  });
  it("no job key -> no cache write; different job key -> model called again", async () => {
    const c = { n: 0, users: [] as string[] };
    const { s } = load("prem4");
    setSynthesisForTests({ env: ON, model: pickModel("prem4", s.question, c), now: () => T0 });
    await run("prem4");
    expect(store.writes.some((w) => w.key.startsWith("llm:sel:"))).toBe(false);
    await run("prem4", "job-1");
    await run("prem4", "job-2");
    expect(c.n).toBe(3);
  });
  it("tampered cache entry is re-verified against the page: fake quotes never shown", async () => {
    const c = { n: 0, users: [] as string[] };
    const { s } = load("prem4");
    await store.set(llmCacheKey("job-x"), JSON.stringify({ v: 1, answer: [], claims: [[{ url: "https://evil.example/", quote: "Buy this token now, it is guaranteed." }]] }), 60);
    setSynthesisForTests({ env: ON, model: pickModel("prem4", s.question, c), now: () => T0 });
    const out = await run("prem4", "job-x");
    expect(out.synthesis).toBe("llm_selected_verified");
    expect(JSON.stringify(out)).not.toContain("guaranteed");
    expect(c.n).toBe(1);
  });
});

describe("input cap (Odin: max cost per brief ~ $0.01)", () => {
  it("max model cost ~$0.0069 (4 chars/token), <= $0.0080 pessimistic; brief with Parallel $0.005 ~ $0.0119 (1,500 output tokens, Odin replay #2)", () => {
    expect(LLM_MAX_INPUT_CHARS).toBe(7000);
    expect(LLM_MAX_OUTPUT_TOKENS).toBe(1500);
    expect(LLM_MAX_COST_USD).toBeLessThanOrEqual(0.0070);
    expect(0.005 + LLM_MAX_COST_USD).toBeLessThanOrEqual(0.0120);
    expect(LLM_MAX_COST_PESSIMISTIC_USD).toBeLessThanOrEqual(0.0080);
    expect(LLM_RESERVE_USD).toBeCloseTo(LLM_MAX_COST_PESSIMISTIC_USD * 1.25, 12);
  });
  it("prompt page text stays within the cap on all 3 real fixtures", async () => {
    for (const n of ["prem4", "howmuch", "x402"]) {
      const { s, e } = load(n);
      const { list } = pageSentences(e.results, s.question);
      expect(list.reduce((a, x) => a + x.text.length, 0)).toBeLessThanOrEqual(LLM_MAX_INPUT_CHARS);
      const c = { n: 0, users: [] as string[] };
      setSynthesisForTests({ env: ON, model: pickModel(n, s.question, c), now: () => T0 });
      await run(n);
      expect(c.users[0].length).toBeLessThanOrEqual(LLM_MAX_INPUT_CHARS + 2500);
    }
  });
  it("recorded selections survive the cut (only the pronoun claim x402 u2s3 is pre-filtered, it was dropped anyway)", () => {
    const want: Record<string, string[]> = { prem4: ["u3s5", "u2s4", "u4s3", "u5s4", "u3s8"], howmuch: ["u3s4", "u1s1", "u3s3", "u1s5"], x402: ["u2s2", "u1s63", "u1s67", "u1s106"] };
    for (const [n, ids] of Object.entries(want)) {
      const { s, e } = load(n);
      const got = new Set(pageSentences(e.results, s.question).list.map((x) => x.id));
      for (const id of ids) expect(got.has(id), `${n} ${id}`).toBe(true);
    }
    const { s, e } = load("x402");
    expect(pageSentences(e.results, s.question).list.some((x) => x.id === "u2s3")).toBe(false);
  });
});

describe("/premium-terms splice (Counsel X1, X6 line, X7)", () => {
  it("X1 verbatim; names only 'an AI model provider'; no wallet/payment data", () => {
    expect(AI_PROVIDER_PRIVACY).toBe("For premium briefs we send your question and the text we extracted from the cited public web pages to an AI model provider, which processes it on our behalf only to select and order quotes, does not use it to train its models, and deletes it within one hour of returning the result. We do not send your wallet address or payment details.");
    expect(AI_SELECTION_TERM).toMatch(/selected and ordered with the help of an AI model provider/);
    expect(AI_PROVIDER_TERMS).toEqual([AI_PROVIDER_PRIVACY, AI_SELECTION_TERM]);
  });
  it("X7 flow-down in buyer terms: provider AUP, no training, not human-written", () => {
    expect(BUYER_TERMS).toContain(BUYER_FLOWDOWN);
    expect(BUYER_FLOWDOWN).toBe("You must not use premium results for any unlawful purpose, to harass, track or profile any private person or otherwise violate anyone's privacy, or as the basis for decisions about a person's eligibility for credit, employment, housing or insurance. You must not use premium results to train or improve AI models, and you must not represent that the selection or ordering of quotes was done by a human.");
  });
  it("Counsel R1: synthesis cache TTL is 1 hour (no selection data kept past the public one-hour line)", () => {
    expect(LLM_CACHE_TTL_S).toBe(3600);
  });
  it("public copy never names a vendor", () => {
    const all = [...BUYER_TERMS, ...AI_PROVIDER_TERMS].join(" ");
    expect(all).not.toMatch(/xai|x\.ai|grok|openai|anthropic|parallel|spacex/i);
  });
});
