/**
 * x402 Preview engine (phase 1, option b): draft report → human review queue.
 * Nothing is returned to the submitter automatically. No paid x402 route (phase 2).
 */
import { randomUUID } from "node:crypto";
import { fetchPublicUrl } from "@/lib/fetch-url";
import { DEMO_OUTPUT } from "@/lib/agent-demo";
import { USDC_BASE } from "@/lib/config";
import { priceUsage, spendCaps, type CostRecord } from "./cost";
import { PREVIEW_MODEL, MAX_OUTPUT_TOKENS, MAX_INPUT_BYTES, inputTokenUpperBound, truncateBytes, LlmError, type LlmFn } from "./llm";
import { DISCLAIMERS, EXAMPLE_LABEL, EXAMPLE_PAY_TO, PRICE_LABEL, TEST_LABEL } from "./labels";
import type { Contact, PreviewStore } from "./store";

export const MAX_PROBES = 5;
export const MAX_PASTED_DOCS_CHARS = MAX_INPUT_BYTES; // capped in UTF-8 bytes

export type PreviewInput = { url?: string; docs?: string; contact?: Contact };
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
  if (input.docs && input.docs.trim()) docs = truncateBytes(input.docs, MAX_INPUT_BYTES);
  else if (input.url) {
    const r = await fetchUrl(input.url); // SSRF-guarded, size + time capped
    if (!r.ok) throw new PreviewError("fetch_failed", r.error);
    docs = truncateBytes(r.content, MAX_INPUT_BYTES);
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

  // Spend guard (Odin blocker 1): atomically RESERVE the worst case for this exact
  // request in the shared store before calling; refuse if a cap would be crossed.
  const probeText = probes.map((p) => `${p.path}: ${p.result}`).join("\n");
  const worst = priceUsage(PREVIEW_MODEL, { inputTokens: inputTokenUpperBound(docs, probeText), outputTokens: MAX_OUTPUT_TOKENS });
  const resv = await deps.store.reserveSpend(worst.usd, spendCaps(env), deps.now);
  if (!resv.ok) throw new PreviewError("spend_cap", "Daily or monthly preview budget reached");

  let llm;
  try {
    llm = await deps.llm(docs, probeText);
  } catch (e) {
    // Blocker 2: reconcile to known usage; keep the worst case if billed but usage unknown;
    // release only when the provider was never billed.
    if (e instanceof LlmError && !e.billed) await deps.store.adjustSpend(resv.slot, -resv.usd);
    else if (e instanceof LlmError && e.usage) await deps.store.adjustSpend(resv.slot, priceUsage(PREVIEW_MODEL, e.usage).usd - resv.usd);
    throw new PreviewError("llm_failed", e instanceof Error ? e.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "llm error");
  }
  const cost: CostRecord = { ...priceUsage(llm.model, llm.usage), ...(llm.usageMissing ? { usageMissing: true } : {}) };
  await deps.store.adjustSpend(resv.slot, cost.usd - resv.usd);

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
  await deps.store.putReport({ id: report.id, createdAt: (deps.now ?? new Date()).getTime(), status: "pending_review", ...(input.contact ? { contact: input.contact } : {}), report });
  return report;
}
