/**
 * Runs 3 sample preview reports against the real LLM and prints cost per report.
 * Requires OPENAI_API_KEY in env (never printed). Spends real money (cents).
 * Usage: npx -y tsx --tsconfig tsconfig.json scripts/preview-cost-check.ts
 */
import { buildPreview } from "@/lib/preview/engine";
import { createOpenAiLlm } from "@/lib/preview/llm";
import { getPreviewStore } from "@/lib/preview/store";

const SAMPLES = [
  "https://horizonpulse.dev/openapi.json",
  "https://petstore3.swagger.io/api/v3/openapi.json",
  "https://horizonpulse.dev/llms.txt",
];

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set; nothing run.");
    process.exit(2);
  }
  const store = getPreviewStore();
  if (!store) { console.error("Shared store not configured; nothing run."); process.exit(2); }
  const llm = createOpenAiLlm();
  let total = 0;
  for (const url of SAMPLES) {
    try {
      const r = await buildPreview({ url }, { llm, store });
      total += r.cost.usd;
      console.log(`${url}\tin=${r.cost.inputTokens}\tout=${r.cost.outputTokens}\t$${r.cost.usd.toFixed(6)}`);
    } catch (e) {
      console.log(`${url}\tERROR ${(e as Error).message}`);
    }
  }
  console.log(`avg per report: $${(total / SAMPLES.length).toFixed(6)} (model prices UNTESTED, see lib/preview/cost.ts)`);
}
main();
