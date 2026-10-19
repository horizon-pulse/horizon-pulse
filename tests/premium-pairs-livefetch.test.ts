import { afterEach, describe, expect, it } from "vitest";
import { extractBody, liveFetchAllowed, LIVE_FETCH_ALLOWLIST, parallelExtract, setParallelForTests } from "@/lib/premium/parallel";
import { candidatePairs, PAIR_SCHEMA, resetSynthesisForTests, setSynthesisForTests, synthesizeBrief, type ModelCall } from "@/lib/premium/synthesis";

const page = (url: string, text: string) => ({ url, title: null, publish_date: null, excerpts: [text] });
afterEach(() => { setParallelForTests(null); resetSynthesisForTests(); });

describe("B: Parallel live fetch, allowlist only", () => {
  it("allowlist is exactly etherscan.io and usdc.org (and their subdomains)", () => {
    expect([...LIVE_FETCH_ALLOWLIST]).toEqual(["etherscan.io", "usdc.org"]);
    expect(liveFetchAllowed("https://etherscan.io/gastracker")).toBe(true);
    expect(liveFetchAllowed("https://www.usdc.org/stats")).toBe(true);
    expect(liveFetchAllowed("https://notetherscan.io/x")).toBe(false);
    expect(liveFetchAllowed("https://defistar.io/x")).toBe(false);
  });
  it("live body carries advanced_settings.fetch_policy; cached body does not", () => {
    expect(extractBody("o", ["u"], true).advanced_settings).toEqual({ fetch_policy: { max_age_seconds: 600, timeout_seconds: 6, disable_cache_fallback: false } });
    expect(extractBody("o", ["u"]).advanced_settings).toBeUndefined();
  });
  it("splits one extract into a cached call and a live call; non-allowlisted URLs never get fetch_policy", async () => {
    process.env.PARALLEL_API_KEY = process.env.PARALLEL_API_KEY || "test-key";
    const bodies: any[] = [];
    setParallelForTests({ fetch: (async (_u: any, init: any) => { const b = JSON.parse(init.body); bodies.push(b); return new Response(JSON.stringify({ results: b.urls.map((url: string) => ({ url, excerpts: ["x"] })) }), { status: 200 }); }) as any });
    const r = await parallelExtract("o", ["https://etherscan.io/gastracker", "https://defistar.io/a"], Date.now() + 5000);
    expect(r.map((x) => x.url).sort()).toEqual(["https://defistar.io/a", "https://etherscan.io/gastracker"]);
    expect(bodies.find((b) => b.urls.includes("https://defistar.io/a")).advanced_settings).toBeUndefined();
    expect(bodies.find((b) => b.urls.includes("https://etherscan.io/gastracker")).advanced_settings.fetch_policy.max_age_seconds).toBe(600);
  });
});

describe("A: pair picker (second non-reasoning call over code-built strict candidates)", () => {
  const ex = [
    page("https://a.com/1", "Coinbase introduced Base in February 2023 as an Ethereum layer-2 network. Base charges low fees on every transfer."),
    page("https://b.com/2", "Coinbase unveiled Base in February 2023, a layer-2 network built on Ethereum."),
    page("https://c.com/3", "Coinbase had revenue in February 2023 from trading."),
  ];
  const q = "When did Coinbase launch the Base network";
  it("candidates already meet the strict rules (same value + shared topic word, two publishers)", () => {
    const c = candidatePairs(q, ex);
    expect(c.length).toBeGreaterThan(0);
    for (const [a, b] of c) expect(new URL(a.url).host).not.toBe(new URL(b.url).host);
    expect(c.some(([a, b]) => /revenue/.test(a.quote + b.quote))).toBe(false);
  });
  it("picked pairs become backed claims; out-of-range or junk picks are ignored; schema caps at 3", async () => {
    expect((PAIR_SCHEMA.properties.picks as any).maxItems).toBe(3);
    const ON = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "k" };
    const main: ModelCall = async () => ({ text: JSON.stringify({ answer: [], claims: [{ quotes: [{ id: "u1s2", url: "https://a.com/1", quote: "Base charges low fees on every transfer." }] }], unanswerable: false }), inputTokens: 10, outputTokens: 5 });
    let pairCalls = 0;
    const pairModel: ModelCall = async ({ schema }) => { pairCalls++; expect(schema).toBe(PAIR_SCHEMA); return { text: JSON.stringify({ picks: [0, 99, -1] }), inputTokens: 10, outputTokens: 2 }; };
    const spent: number[] = [];
    setSynthesisForTests({ env: ON, model: main, pairModel, spend: { reserve: async (u) => (spent.push(u), true), reconcile: async () => {} } });
    const out: any = await synthesizeBrief(q, { sources: [], claims: [] } as any, ex as any, Date.now() + 30_000);
    expect(pairCalls).toBe(1);
    expect(spent.length).toBe(2); // main + pair, both through the spend cap
    expect(out.claims.some((c: any) => c.confirmed_by?.length)).toBe(true);
  });
  it("spend cap refusal skips the pair call (fail closed, brief still returned)", async () => {
    const ON = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "k" };
    const main: ModelCall = async () => ({ text: JSON.stringify({ answer: [], claims: [{ quotes: [{ id: "u1s2", url: "https://a.com/1", quote: "Base charges low fees on every transfer." }] }], unanswerable: false }) });
    let pairCalls = 0;
    let n = 0;
    setSynthesisForTests({ env: ON, model: main, pairModel: async () => (pairCalls++, { text: "{\"picks\":[0]}" }), spend: { reserve: async () => ++n === 1, reconcile: async () => {} } });
    const out: any = await synthesizeBrief(q, { sources: [], claims: [] } as any, ex as any, Date.now() + 30_000);
    expect(pairCalls).toBe(0);
    expect(out.synthesis).toBe("llm_selected_verified");
  });
});
