/** Odin 10/23 6:13 PM ET: a rate-bearing newyorkfed.org sentence never reaches the paid $1 brief body (claims, quotes, answer). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVerified } from "@/lib/premium/verified";
import { setSynthesisForTests, writeAnswer, issuingAuthority } from "@/lib/premium/synthesis";
import { BOARD_CITATION, NYFED_WITHHELD, hasRate, nyfedLast, scrubNyfedPages, withNyfedTerms, withholdNyfedRates } from "@/lib/premium/nyfed-attribution";
import { briefExtractUrls } from "@/lib/premium/research";
import { SOURCE_INDEX } from "@/lib/premium/source-index";

const page = (url: string, text: string) => ({ url, title: null, publish_date: null, excerpts: [text] });
const NY_RATE = "The effective federal funds rate was 4.33 percent on October 22, 2026, according to the New York Fed.";
const NY_PLAIN = "The effective federal funds rate is calculated as a volume-weighted median of overnight transactions.";
const NY_VOL = "The Desk accepted $500 billion in overnight reverse repo operations.";
const NYURL = "https://www.newyorkfed.org/markets/reference-rates/effr";

afterEach(() => { setSynthesisForTests(null); vi.unstubAllEnvs(); });

describe("hasRate", () => {
  it("flags percent, bp and rate numbers; ignores plain text", () => {
    for (const t of ["rate was 4.33 percent", "up 25 bp", "25 basis points", "4.33%", "range of 4 to 4-1/4 percent", "rate 4.33 today", "4-1/4"]) expect(hasRate(t)).toBe(true);
    expect(hasRate(NY_PLAIN)).toBe(false);
  });
  it("Sentinel LOW-1: word-form rates are rate-bearing", () => {
    for (const t of ["four and one-quarter percent", "four percent", "twenty-five basis points", "one basis point", "three per cent", "a quarter percentage point"]) expect(hasRate(t)).toBe(true);
  });
});

describe("scrub + backstop", () => {
  it("scrubNyfedPages drops ALL NY Fed excerpts (rate, volume and plain prose) but keeps the URL; other publishers untouched", () => {
    const out = scrubNyfedPages([page(NYURL, `${NY_RATE} ${NY_PLAIN} ${NY_VOL}`), page("https://example.com/a", NY_RATE)]);
    expect(out[0].url).toBe(NYURL);
    expect(out[0].excerpts).toEqual([]);
    expect(out[1].excerpts[0]).toBe(NY_RATE);
  });
  it("withholdNyfedRates also withholds non-rate NY Fed prose and whole-dollar volumes", () => {
    const out = withholdNyfedRates({ a: NY_PLAIN, b: NY_VOL, c: "fine" }, [page(NYURL, `${NY_PLAIN} ${NY_VOL}`)]);
    expect(out).toEqual({ a: NYFED_WITHHELD, b: NYFED_WITHHELD, c: "fine" });
  });
  it("Board citation wording (Counsel E2) and no stlouisfed.org authority (E1)", () => {
    expect(BOARD_CITATION).toContain("public domain unless otherwise indicated");
    expect(BOARD_CITATION).not.toContain("U.S. government work");
    expect(issuingAuthority("What is the fed funds policy rate", ["https://www.stlouisfed.org/x"], [])).toBeNull();
  });
  it("withholdNyfedRates replaces any string carrying an original NY Fed rate sentence, at any depth", () => {
    const body = { contract: { answer: NY_RATE, claims: [{ text: NY_RATE.slice(0, 60), evidence: [{ quote: NY_RATE }] }] }, other: "fine" };
    const out = withholdNyfedRates(body, [page(NYURL, NY_RATE)]);
    expect(JSON.stringify(out)).not.toContain("4.33");
    expect(out.contract.answer).toBe(NYFED_WITHHELD);
    expect(out.other).toBe("fine");
  });
  it("NY Fed pages are linked (nyfed_terms.source_urls) even when not quoted", () => {
    const b = withNyfedTerms({ tier: "brief" }, new Date("2026-10-23T22:00:00Z"), [NYURL, "https://example.com"]);
    expect(b.nyfed_terms?.source_urls).toEqual([NYURL]);
    expect(b.nyfed_terms?.free_at_source).toBe("free at the linked page; the fee is for our analysis");
  });
  it("extract candidates put NY Fed pages last; Board first", () => {
    expect(nyfedLast([{ url: NYURL }, { url: "https://www.federalreserve.gov/x" }]).map((x) => x.url)).toEqual(["https://www.federalreserve.gov/x", NYURL]);
    const urls = briefExtractUrls([page(NYURL, NY_PLAIN), page("https://www.federalreserve.gov/monetarypolicy/openmarket.htm", NY_PLAIN)] as any, 1);
    expect(urls).toEqual(["https://www.federalreserve.gov/monetarypolicy/openmarket.htm"]);
  });
  it("issuing authority: Board page gets the Board citation; a NY Fed page is not an authority", () => {
    const q = "What is the fed funds policy rate";
    expect(issuingAuthority(q, ["https://www.federalreserve.gov/a.htm"], [])?.citation).toBe(BOARD_CITATION);
    expect(issuingAuthority(q, [NYURL], [])).toBeNull();
  });
});

describe("end to end through buildVerified (claims + AI answer line)", () => {
  const x402 = SOURCE_INDEX.find((x) => x.id === "x402")!;
  const web = [
    page(NYURL, `${NY_RATE} ${NY_PLAIN} ${NY_VOL}`),
    page("https://a.com/x", "x402 is an open payment protocol that uses the HTTP 402 status code for stablecoin payments in 2025."),
    page("https://b.org/y", "Launched in 2025, x402 is an open payment protocol built on the HTTP 402 status code."),
  ];
  it("rate-bearing NY Fed sentence is absent from claims/evidence even with the model answer path on and a model that tries to echo it", async () => {
    vi.stubEnv("HP_BRIEF_MODEL_ANSWER", "true");
    const env = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-placeholder" } as any;
    let modelUser = "";
    setSynthesisForTests({
      env, store: null,
      spend: { reserve: async () => true, reconcile: async () => undefined },
      model: async ({ user }) => { modelUser += user; return { text: JSON.stringify({ answer: `x402 ${NY_PLAIN} ${NY_VOL}` }) }; },
      pairModel: async () => ({ text: JSON.stringify({ pairs: [] }) }),
    });
    const raw = await buildVerified("What is the x402 payment protocol", x402, scrubNyfedPages(web) as any, [], null, "t", Date.now() + 5000, 1);
    const out = withholdNyfedRates(raw, web);
    const s = JSON.stringify(out);
    expect(s).not.toContain("4.33");
    for (const t of ["volume-weighted median", "$500 billion"]) { expect(s).not.toContain(t); expect(modelUser).not.toContain(t); }
    expect(modelUser).not.toContain("4.33"); // the model never even sees the NY Fed rate
    expect(modelUser.length).toBeGreaterThan(0); // the model path really ran
    expect(out.answer_by).not.toBe("model"); // its echo carried a number not in the claims -> rejected by code
  });
  it("writeAnswer rejects an answer whose rate is not in the (scrubbed) claims", async () => {
    const env = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-placeholder" } as any;
    setSynthesisForTests({ env, store: null, spend: { reserve: async () => true, reconcile: async () => undefined }, model: async () => ({ text: JSON.stringify({ answer: "The federal funds rate was 4.33 percent." }) }) });
    expect(await writeAnswer("What is the federal funds rate", [NY_PLAIN], Date.now() + 5000)).toBeNull();
  });
});
