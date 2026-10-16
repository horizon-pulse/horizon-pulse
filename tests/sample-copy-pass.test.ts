/**
 * Sample copy pass (branch fix/sample-copy-pass, 2026-10-16):
 * - no "real output" claim on pages/snippets that also cover the canned discourse/split sample;
 * - public/sample.pdf names all four rails, and the /api/pdf example matches it;
 * - grocery/normalize and extract GET Bazaar examples answer their declared GET input.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTPUT_EXAMPLES } from "@/lib/route-examples";

const FILES = ["app/try/page.tsx", "app/page.tsx", "app/docs/page.tsx", "lib/browser-402.ts", "mcp/src/index.ts", "lib/client-snippets.ts", "lib/agent-skill.ts"];

type Decl = { extensions: { bazaar: { info: { input: { queryParams?: Record<string, string> } } } } };
const getDecl = (cfg: unknown) => Object.entries(cfg as Record<string, Decl>).find(([k]) => k.startsWith("GET"))![1].extensions.bazaar.info.input.queryParams!;

describe("copy", () => {
  it.each(FILES)("%s makes no generic 'real output' claim", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/real output/i);
  });
  it("sample.pdf names the four rails; the pdf example text matches the file", () => {
    const pdf = readFileSync("public/sample.pdf", "latin1");
    expect(pdf).not.toMatch(/\(USDC on Base\)/);
    for (const s of ["USDC on Base, Solana or Polygon", "RLUSD on the XRP Ledger"]) expect(pdf).toContain(s);
    const ex = OUTPUT_EXAMPLES["/api/pdf"] as { bytes: number; pages: { text: string }[] };
    expect(ex.bytes).toBe(readFileSync("public/sample.pdf").length);
    expect(ex.pages[0]!.text).toContain("USDC on Base, Solana or Polygon, or RLUSD on the XRP Ledger.");
  });
});

describe("examples answer their declared GET input", () => {
  it("grocery/normalize: one example item per declared line, same raw text", async () => {
    const { groceryNormalizeRouteConfig } = await import("@/lib/x402-server");
    const q = getDecl(groceryNormalizeRouteConfig());
    const lines = q.ingredients!.split("|");
    const ex = OUTPUT_EXAMPLES["/api/grocery/normalize"] as { items: { raw: string }[]; scale: { servings: number; targetServings: number } };
    expect(ex.items.map((i) => i.raw)).toEqual(lines);
    expect(String(ex.scale.servings)).toBe(q.servings);
    expect(String(ex.scale.targetServings)).toBe(q.targetServings);
  });
  it("extract: declared fields are exactly the example's fields", async () => {
    const { extractRouteConfig } = await import("@/lib/x402-server");
    const q = getDecl(extractRouteConfig());
    const ex = OUTPUT_EXAMPLES["/api/extract"] as { url: string; fields: Record<string, unknown>; requestedFields: number };
    expect(new URL(ex.url).toString()).toBe(new URL(q.url!).toString());
    const fields = JSON.parse(q.fields!) as Record<string, { limit?: number }>;
    expect(Object.keys(ex.fields).sort()).toEqual(Object.keys(fields).sort());
    expect(ex.requestedFields).toBe(Object.keys(fields).length);
    expect((ex.fields.links as unknown[]).length).toBeLessThanOrEqual(fields.links!.limit!);
  });
});
