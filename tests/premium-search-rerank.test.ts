import { describe, expect, it } from "vitest";
import { briefQueries, briefExtractUrls, isOfficialDomain, rankExtractCandidates } from "@/lib/premium/research";
import { contradicts, sharedFact } from "@/lib/premium/synthesis";
const r = (url: string, text: string) => ({ url, title: null, publish_date: null, excerpts: [text] });
const pub = (u: string) => new URL(u).hostname.replace(/^www\./, "");

describe("brief search: entity query + subject rerank (replay #3 product fix)", () => {
  it("adds a key-entity query asking for official sources; regulatory questions ask for official text/summary", () => {
    expect(briefQueries("How much does it cost to send USDC on Base")).toEqual(["How much does it cost to send USDC on Base", "USDC Base send official"]);
    expect(briefQueries("What does the GENIUS Act require of stablecoin issuers")[1]).toMatch(/^GENIUS Act .*official text summary$/);
  });
  it("official domains: .gov, europa.eu, and a domain named after a subject term", () => {
    expect(isOfficialDomain("congress.gov")).toBe(true);
    expect(isOfficialDomain("esma.europa.eu")).toBe(true);
    expect(isOfficialDomain("circle.com", ["Circle"])).toBe(true);
    expect(isOfficialDomain("coindesk.com", ["Circle"])).toBe(false);
  });
  it("reranks by subject coverage then official, so pages that name the subject are extracted first", () => {
    const found = [r("https://a.com/x", "Ethereum fees are high."), r("https://b.com/y", "Sending USDC on Base costs under a cent."), r("https://docs.base.org/z", "Base fees are low.")];
    expect(briefExtractUrls(found, 2, "How much does it cost to send USDC on Base")).toEqual(["https://b.com/y", "https://docs.base.org/z"]);
  });
  it("comparison questions take the best page for EACH compared item first", () => {
    const found = [r("https://x.com/1", "Solana finality is fast."), r("https://y.com/2", "Solana Solana Solana."), r("https://docs.base.org/3", "Base finality depends on L1.")];
    const out = rankExtractCandidates(found, "How does Solana transaction finality compare to Base").map((f) => f.url);
    expect(out.slice(0, 2).sort()).toEqual(["https://docs.base.org/3", "https://x.com/1"].sort());
  });
});

describe("confirmation and contradiction rules (replay #3)", () => {
  it("valued facts need the same value; a day-level date matches the same month stated alone", () => {
    expect(sharedFact(new Set(["d:2024-03-13"]), new Set(["d:2024-03"]))).toBe(true);
    expect(sharedFact(new Set(["n:0.20"]), new Set(["n:0.15"]))).toBe(false);
    expect(sharedFact(new Set(["d:2024-03-13"]), new Set(["d:2024-03-14"]))).toBe(false);
  });
  it("a contrastive sentence ('$1.31 ... but free on Base') neither contradicts nor is contradicted", () => {
    const a = { url: "https://spendnode.io/x", quote: "A standard USDC transfer on Base costs $0.001-0.01 as of early 2026." };
    const b = { url: "https://thecryptobasic.com/y", quote: "Given the current block demand, users may pay as much as $1.31 to transfer USDC but will have the option to do so for free and instantly on Base." };
    expect(contradicts(a, [a, b], pub)).toBe(false);
    const c = { url: "https://other.com/z", quote: "A standard USDC transfer on Base costs $1.50 as of early 2026." };
    expect(contradicts(a, [a, c], pub)).toBe(true);
  });
});

import { searchBody } from "@/lib/premium/parallel";
import { isFresh, withSearchDates } from "@/lib/premium/research";
describe("live-value recency (Odin ruling A, product side)", () => {
  const NOW = Date.UTC(2026, 9, 19, 22);
  it("searchBody maps afterDate to advanced_settings.source_policy.after_date; omitted otherwise", () => {
    expect(searchBody("o", ["q"], 10, { afterDate: "2026-10-16" }).advanced_settings).toEqual({ max_results: 10, source_policy: { after_date: "2026-10-16" } });
    expect(searchBody("o", ["q"], 10).advanced_settings).toEqual({ max_results: 10 });
  });
  it("fresh = publish_date within 72 h; live questions rank fresh dated pages first", () => {
    expect(isFresh({ url: "u", title: null, publish_date: "2026-10-18", excerpts: [] }, NOW)).toBe(true);
    expect(isFresh({ url: "u", title: null, publish_date: "2026-10-10", excerpts: [] }, NOW)).toBe(false);
    const found = [
      { url: "https://old.com/a", title: null, publish_date: "2025-08-05", excerpts: ["Ethereum gas is 0.3 gwei."] },
      { url: "https://new.com/b", title: null, publish_date: "2026-10-19", excerpts: ["Ethereum gas is 0.2 gwei."] },
    ];
    expect(rankExtractCandidates(found, "What is the current Ethereum gas fee on mainnet", NOW)[0].url).toBe("https://new.com/b");
  });
  it("extract results inherit publish_date from the search result for the same URL", () => {
    const out = withSearchDates([{ url: "https://a.com", title: null, publish_date: null, excerpts: [] }], [{ url: "https://a.com", title: null, publish_date: "2026-10-19", excerpts: [] }]);
    expect(out[0].publish_date).toBe("2026-10-19");
  });
});
