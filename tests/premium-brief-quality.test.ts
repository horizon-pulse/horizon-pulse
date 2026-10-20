import { describe, expect, it } from "vitest";
import fixture from "./fixtures/prem2-brief-results.json";
import { compile, factValues, publisherOf, sameFactValue, isOpinion, isSelfContained, isSyndicated, MIN_INDEPENDENT_DOMAINS, UNCONFIRMED_EMPTY_NOTE } from "@/lib/premium/research";
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
    const out: any = compile(brief, "q", [r("https://a.example/1", "A one", ["Base fees averaged $0.002 per transfer in September."]), r("https://b.example/2", "B two", ["Average Base transfer fees were $0.002 in September."]), r("https://c.example/3", "C three", ["September transfer fees on Base averaged $0.002 each."])]);
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
    it("(2) confirmation needs the same normalised date/number + same subject on another publisher; keyword-only never confirms", () => {
      expect(sameFactValue("Transaction fees on Base are typically under $0.01 per transfer.", "Coinbase says network fees for transfers on Base average $0.01.", new Set(["base"]))).toBe("n:$0.01");
      expect(sameFactValue("Transaction fees on Base are typically under $0.01 per transfer.", "Solana validators earn $0.01 in rewards per vote cast.", new Set(["base"]))).toBeNull();
      expect(sameFactValue("Modern Treasury added USDC payments for business customers.", "Modern Treasury added USDC payments for business customers today.", new Set())).toBeNull(); // no fact value
      expect([...factValues("Circle issued 5,000,000 USDC on 2026-06-04, up 12% since August 2023.")]).toEqual(expect.arrayContaining(["n:5000000", "d:2026-06-04", "n:12%", "d:2023-08"]));
      expect([...factValues("Mainnet opened on August 9, 2023 and on 9 Aug 2023 per filings.")]).toEqual(["d:2023-08-09"]);
      const out: any = compile(brief, "USDC on Base", [
        r("https://usdc.org/a", "A", ["Transaction fees on Base are typically under $0.01 per transfer."]),
        r("https://help.coinbase.com/b", "B", ["Coinbase says network fees for transfers on Base average $0.01."]),
        r("https://c.example/c", "C", ["Solana validators earn $0.01 in rewards per vote cast."]),
      ]);
      const fee = out.claims.find((c: any) => c.claim.startsWith("Transaction fees"));
      expect(fee.confirmed_by).toEqual(["coinbase.com"]);
      expect(fee.confirmed_values).toEqual(["$0.01"]);
      const sol = out.claims.find((c: any) => c.claim.startsWith("Solana"));
      expect(sol.confirmed_by).toBeUndefined();
      expect(out.could_not_confirm).toContain(sol.claim);
    });
    it("(3) dropped sentences are counted only (no text)", () => {
      const out: any = compile(brief, "USDC on Base overview", clone());
      expect(out.dropped).toEqual({ opinion: expect.any(Number), pronoun: expect.any(Number), headline: expect.any(Number) });
      expect(out.dropped.opinion).toBeGreaterThanOrEqual(3); // best default, pitch/simple, most popular (opinion checked first)
      const p: any = compile(brief, "q", [r("https://a.example/", "A", ["They settle in about two seconds on most days.", "Base blocks are produced every two seconds."])]);
      expect(p.dropped).toEqual({ opinion: 0, pronoun: 1, headline: 0 });
      expect(JSON.stringify(out)).not.toContain("best default");
      expect(JSON.stringify(out)).not.toContain("ideal for payments");
    });
  });
});

import prem3 from "./fixtures/prem3-search.json";
import prem3Extract from "./fixtures/prem3-extract-synthetic.json";
import { BRIEF_EXTRACT_N, briefExtractUrls, isHeadlineLike, questionKind } from "@/lib/premium/research";

describe("brief from page content (Odin 10/19, real prem3-body.json + synthetic extract)", () => {
  const run = () => compile(brief, prem3.question, JSON.parse(JSON.stringify(prem3.search)), "2026-10-19T21:35:00.000Z", JSON.parse(JSON.stringify(prem3Extract))) as any;
  it("the real prem3 claims are all headline/byline-shaped", () => {
    for (const c of prem3.real_body_claims) expect(isHeadlineLike(c, null)).toBe(true);
    expect(isHeadlineLike("Coinbase announced Base on February 23, 2023.", "Introducing Base - Coinbase")).toBe(false);
  });
  it("search-only (extract failed): no headline or byline claims; no padding", () => {
    const out: any = compile(brief, prem3.question, JSON.parse(JSON.stringify(prem3.search)));
    expect(out.claims).toEqual([]);
    expect(out.answer.lines).toEqual([]);
  });
  it("extract content: answer line first, Feb 23 2023 and Aug 9 2023 both confirmed across 2 publishers, no headline/byline claims", () => {
    const out = run();
    expect(questionKind(prem3.question)).toBe("when");
    expect(Object.keys(out).indexOf("answer")).toBeLessThan(Object.keys(out).indexOf("claims"));
    const ans = out.answer.lines.map((l: any) => l.text).join(" ");
    expect(ans).toMatch(/February 23, 2023|Feb\. 23, 2023/);
    expect(out.answer.lines.every((l: any) => l.confirmed)).toBe(true);
    const vals = out.claims.flatMap((c: any) => c.confirmed_values ?? []);
    expect(vals).toEqual(expect.arrayContaining(["2023-02-23", "2023-08-09"]));
    for (const c of out.claims) {
      expect(isHeadlineLike(c.claim, null)).toBe(false);
      expect(c.claim).not.toMatch(/^By\s/);
      expect(prem3.real_body_claims).not.toContain(c.claim);
    }
  });
  it("extract picks top distinct publishers, N within budget", () => {
    const urls = briefExtractUrls(prem3.search as never);
    expect(urls.length).toBe(BRIEF_EXTRACT_N);
    expect(new Set(urls.map((u) => new URL(u).hostname)).size).toBe(BRIEF_EXTRACT_N);
  });
});

import prem4 from "./fixtures/prem4-body.json";
import { isDateline, stripMarkdown } from "@/lib/premium/research";

describe("markdown strip + datelines (Odin 10/19 A, real prem4-body.json)", () => {
  const md = prem4.snippets.map((s: any) => s.text);
  it("stripMarkdown removes links, URLs, bold and bullets from the real prem4 quotes and keeps the words", () => {
    for (const t of md) {
      const out = stripMarkdown(t);
      expect(out).not.toMatch(/\]\(|https?:\/\/|\*\*|^\s*\* /);
    }
    expect(stripMarkdown(md[3]).trim()).toMatch(/^Introduced by Coinbase in February 2023, Base is an Ethereum layer-2 blockchain/);
    expect(stripMarkdown(md[2]).trim()).toMatch(/^Coinbase, the second largest crypto exchange by trading volume, has launched Base, an Ethereum-focused/);
    expect(stripMarkdown(md[0])).toContain("an Ethereum Layer 2 (L2) network");
  });
  it("datelines are dropped, including mid-line ('EDT Published Aug 9, 2023, 12:00 p.m.')", () => {
    expect(isDateline(prem4.answer_lines[1])).toBe(true);
    expect(isDateline("Updated Oct 3, 2024 at 4:00 PM ET")).toBe(true);
    expect(isDateline("By Jane Doe, Posted 2023-08-09 10:00")).toBe(true);
    expect(isDateline("Coinbase published its Base roadmap in a blog post with partners.")).toBe(false);
    expect(isDateline("Coinbase announced Base on February 23, 2023.")).toBe(false);
    expect(isHeadlineLike(prem4.answer_lines[1], null)).toBe(true);
  });
  it("compile over the real prem4 quotes (as page text): no markdown in any claim, no dateline answer line", () => {
    const pages = prem4.sources.map((s: any) => ({ url: s.url, title: s.title, publish_date: null, excerpts: prem4.snippets.filter((x: any) => x.source === s.n).map((x: any) => x.text) }));
    const out: any = compile(brief, prem4.question, pages.map((p: any) => ({ ...p, excerpts: [] })), "2026-10-19T21:45:00.000Z", pages);
    expect(out.claims.length).toBeGreaterThan(0);
    for (const c of out.claims) {
      expect(c.claim).not.toMatch(/\]\(|https?:\/\/|\*\*|^\* /);
      expect(isDateline(c.claim)).toBe(false);
    }
    for (const l of out.answer.lines) expect(l.text).not.toMatch(/Published/);
    expect(out.answer.lines.map((l: any) => l.text).join(" ")).toMatch(/^Introduced by Coinbase in February 2023/);
  });
});
