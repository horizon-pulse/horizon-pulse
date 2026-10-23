/** Sentinel NOTE-1: production recomputes pass status after the final-output NY Fed withhold (never charge a withheld claim). */
import { describe, expect, it } from "vitest";
import { NYFED_WITHHELD, recheckWithheldContract, withholdNyfedRates } from "@/lib/premium/nyfed-attribution";
import { briefPassTier } from "@/lib/premium/research";

const NYURL = "https://www.newyorkfed.org/markets/reference-rates/effr";
const NY = "The effective federal funds rate is calculated as a volume-weighted median of overnight transactions.";
const base = (answer: string, claimText: string, quote = "fine quote from a.com") => ({
  question: "q", answer, status: "pass", fail_reasons: [] as string[],
  claims: [{ text: claimText, tier: "publisher-confirmed", evidence: [{ url: "https://a.com", quote }, { url: "https://b.com", quote: "other" }] }],
  tiers: { "publisher-confirmed": 1, "onchain-confirmed": 0, official: 0 },
});

describe("recheckWithheldContract", () => {
  it("withheld answer flips pass -> fail and briefPassTier returns null (no settle)", () => {
    const c = recheckWithheldContract(withholdNyfedRates(base(NY, "ok claim"), [{ url: NYURL, excerpts: [NY] }]));
    expect(c.status).toBe("fail");
    expect(c.fail_reasons).toContain("answer_withheld_nyfed");
    expect(briefPassTier({ contract: c })).toBeNull();
  });
  it("withheld claim text or evidence quote fails", () => {
    expect(recheckWithheldContract(base("ok", NYFED_WITHHELD)).fail_reasons).toContain("claim_withheld_nyfed");
    expect(recheckWithheldContract(base("ok", "ok", NYFED_WITHHELD)).status).toBe("fail");
  });
  it("untouched passing contract stays pass (same object)", () => {
    const b = base("ok", "ok");
    expect(recheckWithheldContract(b)).toBe(b);
    expect(briefPassTier({ contract: b })).toBe("confirmed");
  });
  it("existing fail reasons are kept", () => {
    const b = { ...base(NYFED_WITHHELD, "ok"), status: "fail", fail_reasons: ["no_answer"] };
    expect(recheckWithheldContract(b).fail_reasons).toEqual(["no_answer", "answer_withheld_nyfed"]);
  });
});
