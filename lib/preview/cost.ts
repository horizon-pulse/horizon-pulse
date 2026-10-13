/**
 * Per-report cost meter + in-code spend guard (second layer UNDER the provider's
 * hard monthly cap). Prices are per 1M tokens, USD, and must be re-checked against
 * the provider's price page before relying on them (UNTESTED).
 */
export type Usage = { inputTokens: number; outputTokens: number };
export type CostRecord = Usage & { model: string; usd: number };

export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  // UNTESTED: verify on the provider pricing page before go-live.
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export function priceUsage(model: string, u: Usage): CostRecord {
  const p = MODEL_PRICES_PER_MTOK[model];
  if (!p) throw new Error(`no price configured for model ${model}`);
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output) / 1_000_000;
  return { model, ...u, usd: Math.round(usd * 1e6) / 1e6 };
}

type Env = Record<string, string | undefined>;
export function spendCaps(env: Env = process.env): { dailyUsd: number; monthlyUsd: number } {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return { dailyUsd: n(env.PREVIEW_DAILY_USD_CAP, 1), monthlyUsd: n(env.PREVIEW_MONTHLY_USD_CAP, 15) };
}

/** Worst-case cost of one call, used to refuse BEFORE spending. */
export function maxCallUsd(model: string, maxInputTokens: number, maxOutputTokens: number): number {
  return priceUsage(model, { inputTokens: maxInputTokens, outputTokens: maxOutputTokens }).usd;
}

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
