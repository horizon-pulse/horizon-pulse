/** Counsel 10/23 NY Fed ToU: $1 brief bodies citing newyorkfed.org carry credit, not-affiliated and free-at-source lines. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NYFED_DERIVED_LABEL, NYFED_FREE_LINE, NYFED_TERMS_URL, isNyfedUrl, nyfedCredit, nyfedUrls, withNyfedTerms } from "@/lib/premium/nyfed-attribution";
import { NOT_AFFILIATED } from "@/lib/money-market-rates";
import { ISSUING_AUTHORITIES } from "@/lib/premium/synthesis";

const now = new Date("2026-10-23T22:00:00Z");

describe("NY Fed attribution strings (verbatim)", () => {
  it("credit line matches the ToU format exactly", () => {
    expect(nyfedCredit(2026)).toBe("© 2026 Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org.");
  });
  it("free line, derived label, not-affiliated and terms url are Counsel's wording", () => {
    expect(NYFED_FREE_LINE).toBe("free at the linked page; the fee is for our analysis");
    expect(NYFED_DERIVED_LABEL).toBe("Derived by Horizon Pulse from NY Fed data; not the NY Fed's; modified");
    expect(NOT_AFFILIATED).toBe("Horizon Pulse is not affiliated with the New York Fed. The New York Fed does not sanction, endorse, or recommend any products or services offered by Horizon Pulse.");
    expect(NYFED_TERMS_URL).toBe("https://www.newyorkfed.org/privacy/termsofuse");
  });
});

describe("isNyfedUrl", () => {
  it("matches newyorkfed.org and subdomains only", () => {
    expect(isNyfedUrl("https://www.newyorkfed.org/markets/reference-rates/effr")).toBe(true);
    expect(isNyfedUrl("https://markets.newyorkfed.org/api/rates/")).toBe(true);
    expect(isNyfedUrl("https://newyorkfed.org/x")).toBe(true);
    expect(isNyfedUrl("https://www.federalreserve.gov/monetarypolicy.htm")).toBe(false);
    expect(isNyfedUrl("https://newyorkfed.org.evil.example/x")).toBe(false);
    expect(isNyfedUrl("https://notnewyorkfed.org/x")).toBe(false);
    expect(isNyfedUrl("not a url")).toBe(false);
    expect(isNyfedUrl(42)).toBe(false);
  });
});

describe("withNyfedTerms on a brief body", () => {
  const nyBody = {
    tier: "brief",
    contract: { claims: [{ claim: "The effective federal funds rate was 4.33 percent.", evidence: [{ url: "https://www.newyorkfed.org/markets/reference-rates/effr", quote: "x" }] }] },
    authority: { url: "https://www.newyorkfed.org/markets/reference-rates/effr" },
  };
  it("adds nyfed_terms with all lines and keeps the source URL", () => {
    const out = withNyfedTerms(nyBody, now);
    expect(out.nyfed_terms).toEqual({
      credit: nyfedCredit(2026),
      terms_url: NYFED_TERMS_URL,
      not_affiliated: NOT_AFFILIATED,
      free_at_source: NYFED_FREE_LINE,
      source_urls: ["https://www.newyorkfed.org/markets/reference-rates/effr"],
    });
    expect(out.contract).toBe(nyBody.contract);
    expect(JSON.stringify(out)).toContain("https://www.newyorkfed.org/markets/reference-rates/effr");
  });
  it("leaves bodies without newyorkfed.org unchanged", () => {
    const b = { tier: "brief", contract: { claims: [{ evidence: [{ url: "https://www.federalreserve.gov/x" }] }] } };
    expect(withNyfedTerms(b, now)).toBe(b);
    expect("nyfed_terms" in withNyfedTerms(b, now)).toBe(false);
  });
  it("collects distinct URLs from nested arrays", () => {
    expect(nyfedUrls({ a: ["https://markets.newyorkfed.org/a", { u: "https://markets.newyorkfed.org/a" }, "https://www.newyorkfed.org/b"] })).toEqual(["https://markets.newyorkfed.org/a", "https://www.newyorkfed.org/b"]);
  });
});

describe("wiring", () => {
  const src = readFileSync(path.join(__dirname, "..", "lib/premium/research.ts"), "utf8");
  it("both brief return paths are wrapped (verified brief and legacy synthesis path)", () => {
    expect(src).toMatch(/return withNyfedTerms\(\{ tier: "brief", question: q, contract, timing,/);
    expect(src).toMatch(/return withNyfedTerms\(\{ \.\.\.full, contract: toContract\(/);
  });
  it("synthesis.ts:471 issuing-authority entry still lists newyorkfed.org (now covered by nyfed_terms)", () => {
    expect(ISSUING_AUTHORITIES.some((a) => a.domains.includes("newyorkfed.org"))).toBe(true);
  });
});
