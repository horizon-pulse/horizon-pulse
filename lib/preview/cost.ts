/**
 * Per-report cost meter + in-code spend guard (second layer UNDER the provider's
 * hard monthly cap). Prices are per 1M tokens, USD.
 *
 * UNTESTED PRICES: not yet verified against https://openai.com/api/pricing
 * (fetched 2026-10-13 01:05 ET: that URL now shows ChatGPT business plans, no
 * per-token API table). Re-check on the provider's API pricing page before go-live.
 */
export type Usage = { inputTokens: number; outputTokens: number };
export type CostRecord = Usage & { model: string; usd: number; usageMissing?: boolean };

export const PRICES_STATUS = "UNTESTED" as const;
export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  // UNTESTED: verify on the provider pricing page before go-live.
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export function priceUsage(model: string, u: Usage): CostRecord {
  const p = MODEL_PRICES_PER_MTOK[model];
  if (!p) throw new Error(`no price configured for model ${model}`);
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output) / 1_000_000;
  return { model, ...u, usd: Math.ceil(usd * 1e6) / 1e6 };
}

/** Hard ceilings: env overrides can only LOWER spend below these. */
export const DAILY_CAP_CEILING_USD = 5;
export const MONTHLY_CAP_CEILING_USD = 20;
export const DEFAULT_DAILY_CAP_USD = 1;
export const DEFAULT_MONTHLY_CAP_USD = 15;

type Env = Record<string, string | undefined>;
export function spendCaps(env: Env = process.env): { dailyUsd: number; monthlyUsd: number } {
  const n = (v: string | undefined, d: number, ceil: number) => {
    const x = Number(v);
    return Math.min(Number.isFinite(x) && x > 0 ? x : d, ceil);
  };
  return {
    dailyUsd: n(env.PREVIEW_DAILY_USD_CAP, DEFAULT_DAILY_CAP_USD, DAILY_CAP_CEILING_USD),
    monthlyUsd: n(env.PREVIEW_MONTHLY_USD_CAP, DEFAULT_MONTHLY_CAP_USD, MONTHLY_CAP_CEILING_USD),
  };
}

/** Worst-case cost of one call, reserved BEFORE spending. */
export function maxCallUsd(model: string, maxInputTokens: number, maxOutputTokens: number): number {
  return priceUsage(model, { inputTokens: maxInputTokens, outputTokens: maxOutputTokens }).usd;
}

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
