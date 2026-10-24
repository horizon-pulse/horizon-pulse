/** llms.txt EURC on Base: constants match the code, scope = 29 standard routes, Counsel wording, no rate source named. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAY_TO } from "@/lib/config";
import { EURC_BASE } from "@/lib/eurc-config";

const llms = readFileSync("public/llms.txt", "utf8");
const line = llms.split("\n").find((l) => l.startsWith("  - Base EURC")) ?? "";

describe("llms.txt EURC", () => {
  it("one EURC rail line with the code's asset and payTo", () => {
    expect(llms.split("\n").filter((l) => l.startsWith("  - Base EURC"))).toHaveLength(1);
    expect(line).toContain(`\`${EURC_BASE}\``);
    expect(line).toContain(`payTo \`${DEFAULT_PAY_TO}\``);
    expect(line).toContain("eip155:8453");
  });
  it("scoped to the 29 standard routes; brief stays Base USDC only", () => {
    expect(line).toContain("the 29 standard routes");
    expect(line).toContain("not the verified brief");
    expect(llms).toContain("## Verified brief ($1, Base USDC only)");
  });
  it("Counsel wording; names no rate source", () => {
    expect(line).toContain("EURC prices are converted from our USD list prices");
    expect(line.toLowerCase()).not.toMatch(/\becb\b|reference rate|european central bank/);
  });
});
