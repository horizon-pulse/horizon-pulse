import { describe, expect, it } from "vitest";
import fixture from "./fixtures/prem2-brief-results.json";
import { compile, keyFacts, publisherOf, sameFact, isOpinion, isSelfContained, isSyndicated, MIN_INDEPENDENT_DOMAINS, UNCONFIRMED_EMPTY_NOTE } from "@/lib/premium/research";
import { tierFor } from "@/lib/premium/tiers";

const brief = tierFor("research" as never, "brief")!;
const clone = () => JSON.parse(JSON.stringify(fixture));
const r = (url: string, title: string, excerpts: string[]) => ({ url, title, publish_date: null, excerpts });

describe("brief quality (Odin 10/19, fixture from prem2-redeem.json)", () => {
  it("fixture: >=3 distinct domains quoted, <=2 claims per domain, no opinion, no dangling pronoun, unconfirmed section present", () => {
    const out: any = compile(brief, "USDC on Base overview", clone(), "2026-10-19T21:25:19.594Z");
    const doms = out.snippets.map((s: any) => out.sources[s.source - 1].domain);
    expect(new Set(doms).size).toBeGreaterThanOrEqual(MIN_INDEPENDENT_DOMAINS);
    for (const d of new Set(doms)) expect(doms.filter((x: string) => x === d).length).toBeLessThanOrEqual(2);
    for (const c of out.claims) {
      expect(isOpinion(c.claim)).toBe(false);
      expect(c.claim).not.toMatch(/^(It|This|They)\b/);
    }
    expect(JSON.stringify(out.claims)).not.toContain("best default");
    expect(Array.isArray(out.could_not_confirm)).toBe(true);
    expect(typeof out.could_not_confirm_note).toBe("string");
    expect(out.coverage_note ?? "").not.toMatch(/Only \d/);
  });
  it("syndication: Business Wire + Morningstar copy of the same release count as one source and the copy is never quoted", () => {
    const out: any = compile(brief, "USDC on Base overview", clone());
    const ms = out.sources.find((s: any) => s.domain === "morningstar.com");
    const bw = out.sources.find((s: any) => s.domain === "businesswire.com");
    expect(ms.syndicated_copy_of).toBe(bw.n);
    expect(out.snippets.some((s: any) => s.source === ms.n)).toBe(false);
    expect(out.independent_domains.domains).not.toContain("morningstar.com");
    // also by near-identical title alone (no shared wire id)
    expect(isSyndicated(r("https://a.example/x", "Acme Raises $10M Series A to Expand Payments Network", ["x"]), r("https://b.example/y", "Acme Raises $10M Series A to Expand Payments Network | Yahoo Finance", ["y"]))).toBe(true);
    expect(isSyndicated(r("https://a.example/x", "Acme Raises $10M Series A", ["x"]), r("https://b.example/y", "Base Fees Fall After Upgrade", ["y"]))).toBe(false);
  });
  it("opinion filter", () => {
    expect(isOpinion("For most everyday USDC use cases, Base is the best default.")).toBe(true);
    expect(isOpinion("The core pitch is simple: Ethereum's security at a fraction of the cost.")).toBe(true);
    expect(isOpinion("Transaction fees on Base are typically under a penny, and confirmations take about two seconds.")).toBe(false);
  });
  it("pronoun fix: claims led by It/This/They are dropped (extractive: never rewritten)", () => {
    expect(isSelfContained("It launched in August 2023 and has grown fast.")).toBe(false);
    expect(isSelfContained("This makes it ideal for payments today.")).toBe(false);
    expect(isSelfContained("They settle in about two seconds on Base.")).toBe(false);
    expect(isSelfContained("Itself aside, Base launched in August 2023.")).toBe(true);
    expect(isSelfContained("Base launched in August 2023 as an Ethereum L2.")).toBe(true);
  });
  it("unconfirmed section is always present, with an explicit note when empty", () => {
    const out: any = compile(brief, "q", [r("https://a.example/1", "A one", ["Base fees are under one cent per transfer on average."]), r("https://b.example/2", "B two", ["Base fees are under one cent per transfer on average."]), r("https://c.example/3", "C three", ["Base fees are under one cent per transfer on average today."])]);
    expect(out.could_not_confirm).toEqual([]);
    expect(out.could_not_confirm_note).toBe(UNCONFIRMED_EMPTY_NOTE);
    const empty: any = compile(brief, "q", []);
    expect(empty.could_not_confirm).toEqual([]);
    expect(empty.could_not_confirm_note).toBe(UNCONFIRMED_EMPTY_NOTE);
  });
  it("fewer than 3 independent domains -> plain shortfall note, no padding", () => {
    const out: any = compile(brief, "q", [
      r("https://usdc.org/a", "One", ["Base is an Ethereum Layer 2 network built by Coinbase.", "Fees on Base are usually under one cent per transfer.", "USDC on Base is issued natively by Circle today."]),
      r("https://help.coinbase.com/b", "Two", ["Coinbase accounts can send USDC on Base without network fees."]),
    ]);
    expect(out.independent_domains.found).toBe(2);
    expect(out.coverage_note).toMatch(/Only 2 independent publishers/);
    expect(out.snippets.filter((s: any) => s.source === 1).length).toBeLessThanOrEqual(2);
  });
  describe("rulings 10/19", () => {
    it("(1) usdc.org + usdc.com + circle.com are one publisher (Circle); coverage_note says so; independent_domains counts publishers", () => {
      expect(publisherOf("usdc.org")).toBe("circle.com");
      expect(publisherOf("www.usdc.com")).toBe("circle.com");
      expect(publisherOf("developers.circle.com")).toBe("circle.com");
      expect(publisherOf("help.coinbase.com")).toBe("coinbase.com");
      const out: any = compile(brief, "USDC on Base overview", clone());
      expect(out.independent_domains.found).toBe(3);
      expect(out.independent_domains.counted_as).toBe("publishers");
      expect(out.independent_domains.domains).toEqual(expect.arrayContaining(["circle.com", "businesswire.com", "coinbase.com"]));
      expect(out.coverage_note).toMatch(/Same-owner domains counted as one publisher: usdc\.org \+ usdc\.com \(circle\.com\)/);
      const circleQuotes = out.snippets.filter((s: any) => publisherOf(out.sources[s.source - 1].domain) === "circle.com");
      expect(circleQuotes.length).toBeLessThanOrEqual(2);
    });
    it("(1b) two Circle domains alone -> shortfall note with merge", () => {
      const out: any = compile(brief, "q", [r("https://usdc.org/a", "A", ["Circle issues USDC natively on many blockchain networks."]), r("https://usdc.com/b", "B", ["USDC reserves are held in cash and short-dated Treasuries."])]);
      expect(out.independent_domains.found).toBe(1);
      expect(out.coverage_note).toMatch(/Only 1 independent publisher/);
      expect(out.coverage_note).toMatch(/usdc\.org \+ usdc\.com/);
    });
    it("(2) confirmation: same number + same subject on two publishers confirms; same number, different subject does not", () => {
      expect(sameFact("Transaction fees on Base are typically under $0.01 per transfer.", "Coinbase says network fees for transfers on Base average $0.01.", new Set(["base"]))).toBe(true);
      expect(sameFact("Transaction fees on Base are typically under $0.01 per transfer.", "Solana validators earn $0.01 in rewards per vote cast.", new Set(["base"]))).toBe(false);
      expect(sameFact("Base launched in August 2023 as an Ethereum layer 2 network.", "The Ethereum layer 2 network Base went live in August 2023.", new Set())).toBe(true);
      expect(sameFact("Modern Treasury added USDC payments for business customers.", "Modern Treasury raised a funding round from investors.", new Set(["usdc"]))).toBe(false);
      expect(sameFact("Fees fell sharply after the upgrade for users.", "Fees fell sharply after the upgrade for users.", new Set())).toBe(false); // no key fact
      expect([...keyFacts("Circle issued 5,000,000 USDC on 2026-06-04 with Modern Treasury.")]).toEqual(expect.arrayContaining(["n:5000000", "d:2026-06-04", "e:modern"]));
      const out: any = compile(brief, "USDC on Base", [
        r("https://usdc.org/a", "A", ["Transaction fees on Base are typically under $0.01 per transfer."]),
        r("https://help.coinbase.com/b", "B", ["Coinbase says network fees for transfers on Base average $0.01."]),
        r("https://c.example/c", "C", ["Solana validators earn $0.01 in rewards per vote cast."]),
      ]);
      const fee = out.claims.find((c: any) => c.claim.startsWith("Transaction fees"));
      expect(fee.confirmed_by).toEqual(["coinbase.com"]);
      expect(out.could_not_confirm).not.toContain(fee.claim);
      const sol = out.claims.find((c: any) => c.claim.startsWith("Solana"));
      expect(sol.confirmed_by).toBeUndefined();
      expect(out.could_not_confirm).toContain(sol.claim);
    });
    it("(3) dropped sentences are counted only (no text)", () => {
      const out: any = compile(brief, "USDC on Base overview", clone());
      expect(out.dropped).toEqual({ opinion: expect.any(Number), pronoun: expect.any(Number) });
      expect(out.dropped.opinion).toBeGreaterThanOrEqual(3); // best default, pitch/simple, most popular (opinion checked first)
      const p: any = compile(brief, "q", [r("https://a.example/", "A", ["They settle in about two seconds on most days.", "Base blocks are produced every two seconds."])]);
      expect(p.dropped).toEqual({ opinion: 0, pronoun: 1 });
      expect(JSON.stringify(out)).not.toContain("best default");
      expect(JSON.stringify(out)).not.toContain("ideal for payments");
    });
  });
});
