/** Odin 10/19 replay #2 fixes: 1,500 output tokens, fragments in claims + subject-term answers, code-side backing. No model call. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile, publisherOf, domainOf, stripMarkdown } from "@/lib/premium/research";
import { tierFor } from "@/lib/premium/tiers";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { cleanQuote, isListFragment, LLM_MAX_OUTPUT_TOKENS, norm, pageSentences, resetSynthesisForTests, setSynthesisForTests, subjectTerms, synthesizeBrief } from "@/lib/premium/synthesis";

const brief = tierFor("research" as never, "brief")!;
const ON = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-not-a-key" };
const R2 = JSON.parse(readFileSync("/workspace/x402t/fixtures/real-replay-2-out-2026-10-19.json", "utf8"));
const load = (n: string) => ({ s: JSON.parse(readFileSync(`tests/fixtures/real/${n}-search.json`, "utf8")), e: JSON.parse(readFileSync(`tests/fixtures/real/${n}-extract.json`, "utf8")) });
const pub = (u: string) => publisherOf(domainOf(u) ?? u);
beforeEach(() => setPremiumStoreForTests(new MemoryPremiumStore()));
afterEach(() => {
  resetSynthesisForTests();
  setPremiumStoreForTests(undefined);
});

/** Replays replay-2's recorded selection (answer lines + main quote per claim, as the model returned them). prem4 truncated
 *  in replay-2, so its recorded code-only claims stand in for the selection a non-truncated call would make. */
async function replay2(n: string) {
  const { s, e } = load(n);
  const rec = R2.results.find((r: any) => r.n === n);
  const { list } = pageSentences(e.results, s.question);
  const find = (text: string, url?: string) => {
    const t = norm(cleanQuote(stripMarkdown(text)));
    const hit = list.find((x) => (!url || x.url === url) && (norm(x.text) === t || norm(x.text).includes(t) || t.includes(norm(x.text))));
    return hit ? { id: hit.id, url: hit.url, quote: hit.text } : null;
  };
  const answer = (rec.answer?.lines ?? []).map((l: any) => find(l.text)).filter(Boolean);
  const claims = rec.claims.map((c: any) => ({ quotes: [find(c.claim, c.urls[0])].filter(Boolean) })).filter((c: any) => c.quotes.length);
  setSynthesisForTests({ env: ON, model: async () => ({ text: JSON.stringify({ answer, claims, unanswerable: false }), inputTokens: 2000, outputTokens: 500 }) });
  const out: any = await synthesizeBrief(s.question, compile(brief, s.question, s.results, "t", e.results) as any, e.results, Date.now() + 30_000);
  return { out, e };
}
const verbatim = (out: any, e: any) => {
  for (const sn of out.snippets) {
    const src = out.sources[sn.source - 1];
    const page = norm(stripMarkdown(e.results.find((r: any) => r.url === src.url).excerpts.join("\n")));
    expect(page.includes(norm(sn.text.replace(/ …$/, ""))), sn.text).toBe(true);
  }
};

describe("Odin replay #2 fixes", () => {
  it("(1) output budget back to 1,500 tokens", () => expect(LLM_MAX_OUTPUT_TOKENS).toBe(1500));
  it("(2) glued words and tables are list fragments; brand names are not", () => {
    expect(isListFragment("The cheapest network to send USDC right now isOptimism at about $0.0001.")).toBe(true);
    expect(isListFragment("L2 comparison:Arbitrum $0.0027 · Optimism $0.0001 · Base $0.0008.")).toBe(true);
    expect(isListFragment("Base | $0.0008 | 2s")).toBe(true);
    expect(isListFragment("Jesse Pollak, lead for Base, told TechCrunch about PayPal and JavaScript.")).toBe(false);
    expect(subjectTerms("How much does it cost to send USDC on Base")).toEqual(["USDC", "Base"]);
    expect(subjectTerms("What is the x402 payment protocol")).toEqual(["x402"]);
  });
  it("(2) howmuch: the 'isOptimism' wrong-network answer and the L2 table claim are both gone; any answer names Base and USDC", async () => {
    const { out, e } = await replay2("howmuch");
    for (const l of out.answer.lines ?? []) {
      expect(l.text).toMatch(/\bBase\b/);
      expect(l.text).toMatch(/\bUSDC\b/);
      expect(l.text).not.toMatch(/isOptimism/);
    }
    for (const c of out.claims) expect(c.claim).not.toMatch(/·|isOptimism|\):[A-Z]/);
    verbatim(out, e);
  });
  for (const n of ["prem4", "howmuch", "x402"]) {
    it(`(3) ${n}: code-side backing quotes come from another publisher, share a fact value, and are verbatim`, async () => {
      const { out, e } = await replay2(n);
      verbatim(out, e);
      for (const c of out.claims) {
        const urls = c.snippets.map((id: string) => out.sources[out.snippets.find((x: any) => x.id === id).source - 1].url);
        expect(new Set(urls.map(pub)).size).toBe(urls.length);
        if (c.contradicted) expect(c.confirmed_by).toBeUndefined();
      }
      console.log(`[replay2] ${n}: claims ${out.claims.length}, confirmed ${out.claims.filter((c: any) => c.confirmed_by?.length).length}, answer lines ${out.answer.lines?.length ?? 0}`);
    });
  }
  it("(3) prem4: bylines/datelines ('By Will Robinson Feb 23, 2023', 'February 23, 2023...') are never used as backing", async () => {
    // In this extract the only other-publisher sentences carrying Feb 2023 are bylines/datelines, so no backing is attached.
    const { out } = await replay2("prem4");
    for (const sn of out.snippets) expect(sn.text).not.toMatch(/^By |^\d{1,2}:\d{2} [AP]M|^Updated |^Published /);
  });
  it("(3) backing never attaches when the matching sentence would contradict (cents inconsistency)", async () => {
    const ex = [
      { url: "https://a.example/p", title: "A", publish_date: null, excerpts: ["Sending USDC on Base costs about $0.0008 per transfer today."] },
      { url: "https://b.example/q", title: "B", publish_date: null, excerpts: ["Sending USDC on Base costs about $0.0008 cents per transfer."] },
    ];
    const { list } = pageSentences(ex, "How much does it cost to send USDC on Base");
    setSynthesisForTests({ env: ON, model: async () => ({ text: JSON.stringify({ answer: [], claims: [{ quotes: [{ id: list[0].id, url: list[0].url, quote: list[0].text }] }], unanswerable: false }) }) });
    const out: any = await synthesizeBrief("How much does it cost to send USDC on Base", compile(brief, "q", [], "t", ex) as any, ex, Date.now() + 30_000);
    expect(out.claims[0].confirmed_by).toBeUndefined();
  });
});
