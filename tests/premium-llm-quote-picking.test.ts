/** Odin 10/19 (a): quote-picking fixes from the real-model replay; replays the RECORDED real outputs (no model call). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile, publisherOf, domainOf, stripMarkdown } from "@/lib/premium/research";
import { tierFor } from "@/lib/premium/tiers";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { cleanQuote, contradicts, hasExplicitDate, isFragment, norm, pageSentences, resetSynthesisForTests, SELECTION_SCHEMA, setSynthesisForTests, synthesizeBrief, usdValues } from "@/lib/premium/synthesis";

const brief = tierFor("research" as never, "brief")!;
const ON = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-not-a-key" };
const REPLAY = JSON.parse(readFileSync("/workspace/x402t/fixtures/real-replay-out-2026-10-19.json", "utf8"));
const load = (n: string) => ({ s: JSON.parse(readFileSync(`tests/fixtures/real/${n}-search.json`, "utf8")), e: JSON.parse(readFileSync(`tests/fixtures/real/${n}-extract.json`, "utf8")) });
const pub = (u: string) => publisherOf(domainOf(u) ?? u);
beforeEach(() => setPremiumStoreForTests(new MemoryPremiumStore()));
afterEach(() => {
  resetSynthesisForTests();
  setPremiumStoreForTests(undefined);
});

/** Re-issue the real model's recorded selection: look up each recorded quote text among the sentences the model is shown. */
async function replayRecorded(n: string) {
  const { s, e } = load(n);
  const rec = REPLAY.results.find((r: any) => r.n === n);
  const { list } = pageSentences(e.results, s.question);
  const find = (text: string, url?: string) => {
    const t = norm(cleanQuote(text));
    const hit = list.find((x) => (!url || x.url === url) && (norm(x.text) === t || norm(x.text).includes(t) || t.includes(norm(x.text))));
    return hit ? { id: hit.id, url: hit.url, quote: text } : null; // quote exactly as the model returned it (bullets, "....")
  };
  const answer = rec.answer.lines.map((l: any) => find(l.text)).filter(Boolean);
  const claims = rec.claims.map((c: any) => ({ quotes: [find(c.claim, c.urls[0])].filter(Boolean) })).filter((c: any) => c.quotes.length);
  const missed = rec.claims.length - claims.length;
  setSynthesisForTests({ env: ON, model: async () => ({ text: JSON.stringify({ answer, claims, unanswerable: false }), inputTokens: 3000, outputTokens: 500 }) });
  const out: any = await synthesizeBrief(s.question, compile(brief, s.question, s.results, "t", e.results) as any, e.results, Date.now() + 30_000);
  console.log(`[replay] ${n}: recorded claims ${rec.claims.length}, re-selectable under the 7k cut ${claims.length}`);
  return { out, e, missed };
}
const shown = (out: any) => [...(out.answer?.lines ?? []).map((l: any) => l.text), ...out.claims.map((c: any) => c.claim), ...out.snippets.map((x: any) => x.text)];

describe("recorded real outputs, replayed through the new picking rules", () => {
  for (const n of ["prem4", "howmuch", "x402"]) {
    it(`${n}: no leading bullets or trailing ellipses shown; every snippet verbatim at its URL; <= 2 claims per publisher`, async () => {
      const { out, e } = await replayRecorded(n);
      expect(out.synthesis).toBe("llm_selected_verified");
      for (const t of shown(out)) {
        expect(t).not.toMatch(/^\s*[•·]/);
        expect(t).not.toMatch(/(…|\.{3,})\s*$/);
      }
      for (const sn of out.snippets) {
        const src = out.sources[sn.source - 1];
        const page = norm(stripMarkdown(e.results.find((r: any) => r.url === src.url).excerpts.join("\n")));
        expect(page.includes(norm(sn.text.replace(/ …$/, "")))).toBe(true);
      }
      const per = new Map<string, number>();
      for (const c of out.claims) {
        const p = pub(out.sources[c.sources[0] - 1].url);
        per.set(p, (per.get(p) ?? 0) + 1);
      }
      for (const v of per.values()) expect(v).toBeLessThanOrEqual(2);
    });
  }
  it("howmuch: the raw table row is not an answer line; gasfeepredictor capped at 2 claims (was 4)", async () => {
    const { out } = await replayRecorded("howmuch");
    for (const l of out.answer.lines ?? []) expect(isFragment(l.text)).toBe(false);
    expect(out.answer.lines?.some((l: any) => /Arbitrum \$0\.0027/.test(l.text))).not.toBe(true);
    expect(out.claims.filter((c: any) => /gasfeepredictor/.test(out.sources[c.sources[0] - 1].url)).length).toBeLessThanOrEqual(2);
  });
  it("x402: the recorded '$0.001 cents' quote (verbatim from the whitepaper) is flagged contradicted and never confirmed", async () => {
    const { s: srch, e } = load("x402");
    const rec = REPLAY.results.find((r: any) => r.n === "x402").claims.find((c: any) => /\$0\.001 cents/.test(c.claim));
    expect(rec).toBeTruthy();
    // That sentence sits past the 7k cut on the full page, so replay it on its own page slice (same URL, verbatim text).
    const page = e.results.find((r: any) => r.url === rec.urls[0]);
    const sent = page.excerpts.join("\n").split("\n").find((l: string) => /\$0\.001 cents/.test(l));
    const ex = [{ ...page, excerpts: [sent, "x402 is an open payment standard that enables AI agents to pay for API access."] }];
    const { list } = pageSentences(ex, srch.question);
    const hit = list.find((x) => /cents/.test(x.text))!;
    setSynthesisForTests({ env: ON, model: async () => ({ text: JSON.stringify({ answer: [{ id: hit.id, url: hit.url, quote: rec.claim }], claims: [{ quotes: [{ id: hit.id, url: hit.url, quote: rec.claim }] }], unanswerable: false }) }) });
    const out: any = await synthesizeBrief(srch.question, compile(brief, srch.question, srch.results, "t", ex) as any, ex, Date.now() + 30_000);
    const c = out.claims.find((x: any) => /\$0\.001 cents/.test(x.claim));
    expect(c.contradicted).toBe(true);
    expect(c.confirmed_by).toBeUndefined();
    expect(c.claim).not.toMatch(/^•|\.{3,}$/);
    expect(out.could_not_confirm).toContain(c.claim);
    expect(out.answer.lines?.some((l: any) => /cents/.test(l.text))).not.toBe(true);
  });
  it("prem4: answer keeps the explicit Feb 2023 date; dated claims come first", async () => {
    const { out } = await replayRecorded("prem4");
    expect(out.answer.lines[0].text).toMatch(/February 2023/);
    const dated = out.claims.map((c: any) => hasExplicitDate(c.claim));
    expect(dated.indexOf(false) === -1 || dated.lastIndexOf(true) < dated.indexOf(false)).toBe(true);
  });
});

describe("rules (unit)", () => {
  it("schema asks for a backing quote from a second publisher", () => {
    const d = (SELECTION_SCHEMA as any).properties.claims.items.properties.quotes.description;
    expect(d).toMatch(/DIFFERENT publisher/);
  });
  it("cleanQuote strips bullet and ellipsis", () => {
    expect(cleanQuote("• USDC transfer on Base — cents, gas in ETH.")).toBe("USDC transfer on Base — cents, gas in ETH.");
    expect(cleanQuote("costs pennies in gas....")).toBe("costs pennies in gas.");
    expect(cleanQuote("costs pennies in gas…")).toBe("costs pennies in gas.");
  });
  it("isFragment: pipes, bullets, glued label:value, verbless", () => {
    expect(isFragment("Base | $0.0008 | 2s")).toBe(true);
    expect(isFragment("L2 comparison (estimate):Arbitrum $0.0027 · Optimism $0.0001 · Base $0.0008")).toBe(true);
    expect(isFragment("Base, Arbitrum, Optimism, Polygon.")).toBe(true);
    expect(isFragment("Sending USDC on Base costs about $0.0008 per transfer.")).toBe(false);
    expect(isFragment("Coinbase launched Base in August 2023.")).toBe(false);
  });
  it("usdValues / contradicts: '$0.001 cents' is internally inconsistent; 10x apart on the same subject across publishers", () => {
    expect(usdValues("as low as $0.001 cents per request")).toEqual([{ usd: 0.00001, inconsistent: true }]);
    const a = { url: "https://a.example/x", quote: "A USDC transfer on Base costs about $0.0008 in network fees." };
    const b = { url: "https://b.example/y", quote: "A USDC transfer on Base costs about $0.05 in network fees." };
    const c = { url: "https://c.example/z", quote: "A USDC transfer on Base costs roughly $0.0009 in network fees." };
    expect(contradicts(a, [a, b], pub)).toBe(true);
    expect(contradicts(a, [a, c], pub)).toBe(false);
    expect(contradicts({ url: "https://d.example/", quote: "Payments as low as $0.001 cents per request are possible." }, [], pub)).toBe(true);
  });
});

describe("backing quotes and confirmation", () => {
  const ex = [
    { url: "https://a.example/p", title: "A", publish_date: null, excerpts: ["Coinbase opened the Base mainnet to the public on August 9, 2023, after a testing period."] },
    { url: "https://b.example/q", title: "B", publish_date: null, excerpts: ["Base became open to the public on August 9, 2023, according to Coinbase."] },
    { url: "https://a.example/other", title: "A2", publish_date: null, excerpts: ["Coinbase made Base available to everyone on August 9, 2023, the company said."] },
    { url: "https://c.example/r", title: "C", publish_date: null, excerpts: ["The weather in Lisbon was sunny and warm all week long."] },
  ];
  const run = async (claims: any[]) => {
    const { list } = pageSentences(ex, "When did Base open to the public");
    const q = (i: number) => ({ id: list[i].id, url: list[i].url, quote: list[i].text });
    setSynthesisForTests({ env: ON, model: async () => ({ text: JSON.stringify({ answer: [], claims: claims.map((ids) => ({ quotes: ids.map(q) })), unanswerable: false }) }) });
    return (await synthesizeBrief("When did Base open to the public", compile(brief, "q", [], "t", ex) as any, ex, Date.now() + 30_000)) as any;
  };
  it("backing from a second publisher confirms the claim", async () => {
    const out = await run([[0, 1]]);
    expect(out.claims[0].confirmed_by).toContain("b.example");
    expect(out.could_not_confirm).toEqual([]);
  });
  it("model backing from the SAME publisher, or on an unrelated subject, is dropped (code-side backing may then attach another publisher)", async () => {
    const out = await run([[0, 2], [0, 3]]);
    for (const c of out.claims) {
      const pubs = c.snippets.map((id: string) => out.sources[out.snippets.find((x: any) => x.id === id).source - 1].url).map((u: string) => new URL(u).hostname);
      expect(new Set(pubs).size).toBe(pubs.length); // never two quotes from one publisher
      expect(pubs).not.toContain("c.example");
    }
  });
});
