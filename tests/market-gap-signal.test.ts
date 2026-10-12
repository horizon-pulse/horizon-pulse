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
