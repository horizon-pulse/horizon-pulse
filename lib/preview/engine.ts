/**
 * x402 Preview engine (phase 1, option b): draft report → human review queue.
 * Nothing is returned to the submitter automatically. No paid x402 route (phase 2).
 */
import { randomUUID } from "node:crypto";
import { fetchPublicUrl } from "@/lib/fetch-url";
import { DEMO_OUTPUT } from "@/lib/agent-demo";
import { USDC_BASE } from "@/lib/config";
import { priceUsage, maxCallUsd, spendCaps, type CostRecord } from "./cost";
import { PREVIEW_MODEL, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, MAX_INPUT_CHARS, type LlmFn } from "./llm";
import { DISCLAIMERS, EXAMPLE_LABEL, EXAMPLE_PAY_TO, PRICE_LABEL, TEST_LABEL } from "./labels";
import type { PreviewStore } from "./store";

export const MAX_PROBES = 5;
export const MAX_PASTED_DOCS_CHARS = 50_000;

export type PreviewInput = { url?: string; docs?: string };
type FetchFn = typeof fetchPublicUrl;
export type Deps = { llm: LlmFn; store: PreviewStore; fetchUrl?: FetchFn; env?: Record<string, string | undefined>; now?: Date };

export class PreviewError extends Error {
  constructor(public code: "bad_input" | "fetch_failed" | "spend_cap" | "llm_failed", msg: string) {
    super(msg);
  }
}

function extractOpenApiPaths(text: string): { method: string; path: string }[] {
  try {
    const j = JSON.parse(text) as { paths?: Record<string, Record<string, unknown>> };
    if (!j.paths || typeof j.paths !== "object") return [];
    const out: { method: string; path: string }[] = [];
    for (const [p, ops] of Object.entries(j.paths))
      for (const m of Object.keys(ops ?? {}))
        if (["get", "post", "put", "patch", "delete"].includes(m)) out.push({ method: m.toUpperCase(), path: p });
    return out;
  } catch {
    return [];
  }
}

function sample402(route: { method: string; path: string; suggestedPriceUsd: number } | undefined) {
  const amount = String(Math.round((route?.suggestedPriceUsd ?? 0.01) * 1e6));
  return {
    label: EXAMPLE_LABEL,
    header: "PAYMENT-REQUIRED (base64 of the JSON below)",
    json: {
      x402Version: 2,
      resource: `https://api.example.com${route?.path ?? "/your-route"}`,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount,
          asset: USDC_BASE,
          payTo: EXAMPLE_PAY_TO,
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    },
  };
}

export async function buildPreview(input: PreviewInput, deps: Deps) {
  const fetchUrl = deps.fetchUrl ?? fetchPublicUrl;
  const env = deps.env ?? process.env;
  let docs = "";
  let base: URL | null = null;
  if (input.docs && input.docs.trim()) docs = input.docs.slice(0, MAX_PASTED_DOCS_CHARS);
  else if (input.url) {
    const r = await fetchUrl(input.url); // SSRF-guarded, size + time capped
    if (!r.ok) throw new PreviewError("fetch_failed", r.error);
    docs = r.content.slice(0, MAX_INPUT_CHARS);
    base = new URL(r.finalUrl);
  } else throw new PreviewError("bad_input", "Provide a URL or pasted docs");

  // ≤5 unpaid GET probes, same host, through the same guarded fetcher.
  const probes: { path: string; result: string }[] = [];
  if (base) {
    for (const op of extractOpenApiPaths(docs).filter((o) => o.method === "GET" && !o.path.includes("{")).slice(0, MAX_PROBES)) {
      const r = await fetchUrl(new URL(op.path, base.origin).toString());
      probes.push({ path: op.path, result: r.ok ? `HTTP ${r.status}` : `error ${r.code}` });
    }
  }

  // Spend guard: refuse if the worst-case call would cross the daily or monthly cap.
  const caps = spendCaps(env);
  const spent = await deps.store.getSpend(deps.now);
  const worst = maxCallUsd(PREVIEW_MODEL, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS);
  if (spent.day + worst > caps.dailyUsd || spent.month + worst > caps.monthlyUsd)
    throw new PreviewError("spend_cap", "Daily or monthly preview budget reached");

  let llm;
  try {
    llm = await deps.llm(docs, probes.map((p) => `${p.path}: ${p.result}`).join("\n"));
  } catch (e) {
    throw new PreviewError("llm_failed", e instanceof Error ? e.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "llm error");
  }
  const cost: CostRecord = priceUsage(llm.model, llm.usage);
  await deps.store.addSpend(cost.usd, deps.now);

  const routes = llm.output.candidateRoutes.map((r) => ({ ...r, priceLabel: PRICE_LABEL }));
  const report = {
    id: randomUUID(),
    status: "pending_review" as const,
    source: input.url ?? "pasted docs",
    summary: llm.output.summary,
    candidateRoutes: routes,
    readinessGaps: llm.output.readinessGaps,
    probes,
    sample402: sample402(routes[0]),
    demo: { label: TEST_LABEL, transcript: DEMO_OUTPUT },
    disclaimers: DISCLAIMERS,
    reviewFlags: llm.output.instructionLikeTextSeen ? ["instruction-like text in submitted docs"] : [],
    cost,
  };
  await deps.store.putReport({ id: report.id, createdAt: (deps.now ?? new Date()).getTime(), status: "pending_review", report });
  return report;
}
