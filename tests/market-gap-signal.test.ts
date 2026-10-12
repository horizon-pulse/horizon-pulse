import { describe, expect, it } from "vitest";
import { docGapEvent } from "@/lib/market/gap-signal";
const res = (rel: number[]) => ({ ok: true as const, results: rel.map((r) => ({ rank: { parts: { relevance: r } } })) });
describe("doc/OCR market search gap signal", () => {
  it("logs no_results and weak matches on doc/OCR queries only", () => {
    expect(docGapEvent("invoice ocr", { ok: false, code: "no_results" })).toMatchObject({ reason: "no_results" });
    expect(docGapEvent("pdf parsing", res([0.2, 0.3]))).toMatchObject({ reason: "weak_match", topRelevance: 0.3, returned: 2 });
    expect(docGapEvent("pdf parsing", res([0.9]))).toBeNull();
    expect(docGapEvent("weather api", { ok: false, code: "no_results" })).toBeNull();
    expect(docGapEvent("ocr", { ok: false, code: "cdp_unavailable" })).toBeNull();
    expect(docGapEvent(undefined, { ok: false, code: "no_results" })).toBeNull();
  });
});
describe("q redaction before logging (Odin Class A condition)", () => {
  it("redacts emails and runs of 6+ digits, keeps short numbers", async () => {
    const { redactQuery } = await import("@/lib/market/gap-signal");
    expect(redactQuery("ocr invoice for jane.doe+x@example.co.uk please")).toBe("ocr invoice for [email] please");
    expect(redactQuery("parse receipt 123456 and 12345")).toBe("parse receipt [digits] and 12345");
    expect(redactQuery("card 4111 1111 1111 1111 pdf")).toBe("card [digits] pdf");
    expect(redactQuery("call 555-867-5309 ocr")).toBe("call [digits] ocr");
    expect(redactQuery("pdf 2026 docs v2")).toBe("pdf 2026 docs v2");
  });
  it("logged event never carries the raw email or digits", () => {
    const ev = docGapEvent("ocr bob@corp.com acct 9876543210", { ok: false, code: "no_results" })!;
    expect(ev.q).toBe("ocr [email] acct [digits]");
    expect(JSON.stringify(ev)).not.toMatch(/bob@corp|9876543210/);
    const long = docGapEvent("pdf " + "a".repeat(200) + " x@y.io", { ok: false, code: "no_results" })!;
    expect(long.q.length).toBeLessThanOrEqual(120);
  });
});
