/**
 * Generates public/llms.txt from scripts/llms.template.txt + config/payto.json,
 * so the payTo / Basename in the agent guide can never drift from the 402s.
 * The output is still a static file (same served bytes and headers).
 *
 *   npm run gen:llms
 *
 * Placeholders: {{BASE_PAY_TO}}, {{BASENAME}}, {{SOLANA_PAY_TO}}. Edit the
 * template, never public/llms.txt (tests/payto-single-source.test.ts fails if
 * public/llms.txt != the rendered template).
 */
import fs from "node:fs";
import path from "node:path";
import { PAYTO } from "../lib/payto";

const ROOT = path.join(__dirname, "..");
export const LLMS_TEMPLATE = path.join(ROOT, "scripts", "llms.template.txt");
export const LLMS_OUT = path.join(ROOT, "public", "llms.txt");

export const LLMS_PLACEHOLDERS: Record<string, string> = {
  BASE_PAY_TO: PAYTO.base.payTo,
  BASENAME: PAYTO.base.basename,
  SOLANA_PAY_TO: PAYTO.solana.payTo,
};

/** Render the template; throws on an unknown or unreplaced placeholder. */
export function renderLlms(template: string = fs.readFileSync(LLMS_TEMPLATE, "utf8")): string {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => {
    const v = LLMS_PLACEHOLDERS[key];
    if (v === undefined) throw new Error(`scripts/llms.template.txt: unknown placeholder ${m}`);
    return v;
  });
  if (out.includes("{{")) throw new Error("scripts/llms.template.txt: unreplaced placeholder");
  return out;
}

if (!process.env.VITEST) {
  fs.writeFileSync(LLMS_OUT, renderLlms());
  console.log(`wrote ${LLMS_OUT}`);
}
