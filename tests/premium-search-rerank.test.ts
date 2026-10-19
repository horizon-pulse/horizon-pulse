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
