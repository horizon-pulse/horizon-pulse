import { describe, expect, it } from "vitest";
import { consistentValues, isDefinitionOf, isLiveValueQuestion, liveAmounts, personNames, CONSISTENT_NOTE } from "@/lib/premium/synthesis";
const pub = (u: string) => new URL(u).hostname.replace(/^www\./, "");
const NOW = Date.UTC(2026, 9, 19, 22, 0, 0);
const page = (url: string, publish_date: string | null) => ({ url, title: null, publish_date, excerpts: [] as string[] });

describe("Odin ruling A: 'consistent' live values (never 'confirmed')", () => {
  it("only live-value questions qualify", () => {
    expect(isLiveValueQuestion("What is the current Ethereum gas fee on mainnet")).toBe(true);
    expect(isLiveValueQuestion("How much USDC is in circulation")).toBe(true);
    expect(isLiveValueQuestion("When did the SEC approve spot bitcoin ETFs")).toBe(false);
  });
  it("unit-tagged amounts", () => {
    expect(liveAmounts("gas is 0.20 gwei and supply $75.3 billion at 4.33%").map((a) => [a.unit, a.n])).toEqual([["gwei", 0.2], ["$billion", 75.3], ["%", 4.33]]);
  });
  it("within 2% and both dated within 72 h -> consistent pair with both values, publishers and dates", () => {
    const ex = [page("https://a.com/1", "2026-10-19"), page("https://b.com/2", "2026-10-18")];
    const pool = [{ url: "https://a.com/1", quote: "The Ethereum gas price is 0.200 gwei." }, { url: "https://b.com/2", quote: "Ethereum gas sits at 0.197 gwei." }];
    const out = consistentValues(ex, pool, pub, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].map((v) => [v.raw, pub(v.url), v.date])).toEqual([["0.197 gwei", "b.com", "2026-10-18"], ["0.200 gwei", "a.com", "2026-10-19"]]);
    expect(CONSISTENT_NOTE).toMatch(/not confirmed/);
  });
  it("more than 2% apart, an undated page, or a date older than 72 h -> not consistent", () => {
    const pool = [{ url: "https://a.com/1", quote: "Gas is 0.20 gwei." }, { url: "https://b.com/2", quote: "Gas is 0.21 gwei." }];
    expect(consistentValues([page("https://a.com/1", "2026-10-19"), page("https://b.com/2", "2026-10-19")], pool, pub, NOW)).toHaveLength(0);
    const pool2 = [{ url: "https://a.com/1", quote: "Gas is 0.200 gwei." }, { url: "https://b.com/2", quote: "Gas is 0.199 gwei." }];
    expect(consistentValues([page("https://a.com/1", "2026-10-19"), page("https://b.com/2", null)], pool2, pub, NOW)).toHaveLength(0);
    expect(consistentValues([page("https://a.com/1", "2026-10-19"), page("https://b.com/2", "2026-10-10")], pool2, pub, NOW)).toHaveLength(0);
  });
});

describe("tightened backing rules (x402 stability fix)", () => {
  it("definition-to-definition only for value-free claims; questions are not definitions", () => {
    expect(isDefinitionOf("x402 is an open payments protocol developed by Coinbase.", ["x402"])).toBe(true);
    expect(isDefinitionOf("Why is sending USDC cheaper on Base than on Ethereum?", ["USDC", "Base"])).toBe(false);
    expect(isDefinitionOf("Solana launched in 2020 as a high-performance blockchain.", ["Solana"])).toBe(false);
  });
  it("who-questions match on the same named person outside the question", () => {
    expect(personNames("Circle co-founder Jeremy Allaire saw his fortune surge.", "Who founded Circle")).toEqual(["jeremy allaire"]);
  });
});

describe("consistent: value date vs page date", () => {
  it("a sentence naming its own period ('second quarter') is not dated by a fresh page", () => {
    const ex = [page("https://kucoin.com/a", "2026-10-17"), page("https://bitunix.com/b", "2026-10-19")];
    const pool = [{ url: "https://kucoin.com/a", quote: "The total supply stands at $72.5 billion." }, { url: "https://bitunix.com/b", quote: "Circle reported that USDC circulation reached roughly $73 billion in the second quarter." }];
    expect(consistentValues(ex, pool, pub, NOW)).toHaveLength(0);
  });
});
