/**
 * Glama connector ownership claim (Michael approved 2026-10-17 9:28 AM ET).
 * public/.well-known/glama.json must stay published permanently, byte for byte,
 * as a static file. Removing or editing it must fail CI. It must also never be
 * shadowed by an app route (only /.well-known/x402 is dynamic).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "public", ".well-known", "glama.json");

const EXPECTED =
  '{\n' +
  '  "$schema": "https://glama.ai/mcp/schemas/connector.json",\n' +
  '  "claim": "glama_claim_XoVcWfvS85HI3GKqxORmKGTBRr9v6-i1"\n' +
  '}\n';

describe("/.well-known/glama.json (Glama claim, permanent)", () => {
  it("exists as a static public file with the exact approved bytes", () => {
    expect(existsSync(FILE)).toBe(true);
    expect(readFileSync(FILE, "utf8")).toBe(EXPECTED);
  });

  it("parses as JSON with exactly the schema and claim keys", () => {
    const body = JSON.parse(readFileSync(FILE, "utf8"));
    expect(body).toEqual({
      $schema: "https://glama.ai/mcp/schemas/connector.json",
      claim: "glama_claim_XoVcWfvS85HI3GKqxORmKGTBRr9v6-i1",
    });
  });

  it("is not shadowed by an app route or middleware", () => {
    const wk = path.join(ROOT, "app", ".well-known");
    const entries = existsSync(wk) ? readdirSync(wk) : [];
    expect(entries).not.toContain("glama.json");
    expect(entries.filter((e) => e.startsWith("["))).toEqual([]);
    for (const f of ["middleware.ts", "middleware.js", "proxy.ts", "proxy.js"]) {
      expect(existsSync(path.join(ROOT, f))).toBe(false);
      expect(existsSync(path.join(ROOT, "app", f))).toBe(false);
    }
  });
});
