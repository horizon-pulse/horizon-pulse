import { afterEach, describe, expect, it } from "vitest";
import { extractAllowed, extractBody, liveFetchAllowed, LIVE_FETCH_ALLOWLIST, setParallelForTests } from "@/lib/premium/parallel";
import { candidatePairs, nearDuplicate, resetSynthesisForTests, setSynthesisForTests, synthesizeBrief, type ModelCall } from "@/lib/premium/synthesis";
import { briefExtractUrls } from "@/lib/premium/research";

const page = (url: string, text: string) => ({ url, title: null, publish_date: null, excerpts: [text] });
afterEach(() => { setParallelForTests(null); resetSynthesisForTests(); });

describe("hardened spec §3 step 1b: never read Etherscan / usdc.org HTML", () => {
  it("live-fetch allowlist is empty; etherscan.io and usdc.org are never extracted", () => {
    expect([...LIVE_FETCH_ALLOWLIST]).toEqual([]);
    expect(liveFetchAllowed("https://etherscan.io/gastracker")).toBe(false);
    expect(extractAllowed("https://etherscan.io/gastracker")).toBe(false);
    expect(extractAllowed("https://www.usdc.org/stats")).toBe(false);
    expect(extractAllowed("https://notetherscan.io/x")).toBe(true);
    const urls = briefExtractUrls([page("https://etherscan.io/g", "x"), page("https://usdc.org/s", "y"), page("https://ok.com/a", "z")] as any, 5);
    expect(urls).toEqual(["https://ok.com/a"]);
  });
  it("cached extract body has no fetch_policy", () => {
    expect(extractBody("o", ["u"]).advanced_settings).toBeUndefined();
  });
});

describe("hardened spec §3 step 3: code builds AND chooses pairs; the model never selects evidence", () => {
  const ex = [
    page("https://a.com/1", "Coinbase introduced Base in February 2023 as an Ethereum layer-2 network. Base charges low fees on every transfer."),
    page("https://b.com/2", "Coinbase unveiled Base in February 2023, a layer-2 network built on Ethereum."),
    page("https://c.com/3", "Coinbase had revenue in February 2023 from trading."),
  ];
  const q = "When did Coinbase launch the Base network";
  it("pairs meet the strict rules (same value + shared topic word, two publishers); order is deterministic", () => {
    const c = candidatePairs(q, ex);
    expect(c.length).toBeGreaterThan(0);
    for (const [a, b] of c) expect(new URL(a.url).host).not.toBe(new URL(b.url).host);
    expect(c.some(([a, b]) => /revenue/.test(a.quote + b.quote))).toBe(false);
    expect(JSON.stringify(candidatePairs(q, [...ex].reverse()))).toBe(JSON.stringify(c));
  });
  it("near-duplicate (>60% token overlap = syndicated copy) is never a second source", () => {
    const s = "Circle said USDC supply reached 60 billion on Monday, according to its transparency page.";
    expect(nearDuplicate(s, "Circle said USDC supply reached 60 billion on Monday, according to its transparency report.")).toBe(true);
    expect(nearDuplicate(ex[0].excerpts[0].split(". ")[0], ex[1].excerpts[0])).toBe(false);
    const syn = [page("https://a.com/1", s), page("https://b.com/2", s.replace("page", "report"))];
    expect(candidatePairs("How much USDC supply", syn)).toEqual([]);
  });
  it("one model call only; code-built pairs become backed claims", async () => {
    const ON = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "k" };
    let calls = 0;
    const main: ModelCall = async () => (calls++, { text: JSON.stringify({ answer: [], claims: [{ quotes: [{ id: "u1s2", url: "https://a.com/1", quote: "Base charges low fees on every transfer." }] }], unanswerable: false }), inputTokens: 10, outputTokens: 5 });
    setSynthesisForTests({ env: ON, model: main, pairModel: async () => { throw new Error("must not be called"); }, spend: { reserve: async () => true, reconcile: async () => {} } });
    const out: any = await synthesizeBrief(q, { sources: [], claims: [] } as any, ex as any, Date.now() + 30_000);
    expect(calls).toBe(1);
    expect(out.claims.some((c: any) => c.confirmed_by?.length)).toBe(true);
  });
});
