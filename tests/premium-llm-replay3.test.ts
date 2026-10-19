import { describe, expect, it } from "vitest";
import { isFragment, namesSubject, subjectTerms } from "@/lib/premium/synthesis";

describe("replay #3: subject naming + fragments (12 real fixtures)", () => {
  it("subject terms match fuzzily: acronym expansion, ETF~ETP, hyphenated ids, plural", () => {
    const s = subjectTerms("When did the SEC approve spot bitcoin ETFs");
    expect(namesSubject("On January 10, 2024, the Securities and Exchange Commission (SEC) approved 11 spot Bitcoin exchange-traded product (ETP) Rule 19b-4 applications.", s)).toBe(true);
    expect(namesSubject("EIP-4844, or Proto-Danksharding, is a pivotal proposal to enhance Ethereum's scalability.", subjectTerms("What is EIP-4844"))).toBe(true);
  });
  it("capitalised proper nouns are case-sensitive: 'base layer' does not name Base", () => {
    const s = subjectTerms("How does Solana transaction finality compare to Base");
    expect(namesSubject("Solana is significantly faster at the base layer, processing 2,000-4,000 TPS compared to Ethereum.", s)).toBe(false);
    expect(namesSubject("Solana finality is about 400 ms while Base relies on Ethereum finality.", s)).toBe(true);
  });
  it("every core subject term is required; jurisdiction qualifiers (EU/US/UK) are optional", () => {
    expect(namesSubject("On Base or Arbitrum the fee is < $0.10, well below 1%.", subjectTerms("How much does it cost to send USDC on Base"))).toBe(false);
    expect(namesSubject("MiCA's stablecoin provisions took full effect on December 30, 2024.", subjectTerms("When did MiCA stablecoin rules take effect in the EU"))).toBe(true);
  });
  it("irregular past-tense verbs count as verbs; 'Label: ...' headings are fragments", () => {
    expect(isFragment("MiCA's stablecoin provisions took full effect on December 30, 2024.")).toBe(false);
    expect(isFragment("Big Goal: EIP-4844 aims to reduce costs for blockchain rollups by introducing blob transactions.")).toBe(true);
  });
});
