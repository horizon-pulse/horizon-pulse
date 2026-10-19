/**
 * Premium ladder (spec v3 + v3.1 + v3.2, Michael GO via Odin 2026-10-19 2:04 PM AST).
 *
 * Single source of truth for every premium tier: path, price (atomic USDC, 6 dp), units, mode, rails.
 * Price is ALWAYS taken from this table for the request's own path tier (spec §3a); no client value is trusted.
 *
 * Flags (exact string "true" only, anything else = off):
 *   HP_PREMIUM_ENABLED        - every premium URL; off = 404 on every verb, no discovery entry (default OFF).
 *   HP_PREMIUM_ASYNC_ENABLED  - lists the async tiers ($20+) and lets them issue a 402 / run the price-binding
 *                               check. The async job path itself is NOT built (separate Class A, spec §5): even
 *                               with this on, an async tier refuses with an uncharged 503 before verify/settle.
 */
export type PremiumRoute = "research" | "seller-watch";
export type TierId = "brief" | "standard" | "extended" | "report" | "monitor" | "watch" | "watch-report";
export type Tier = {
  id: TierId;
  route: PremiumRoute;
  priceUsd: string;
  /** USDC atomic units (6 decimals). */
  amount: string;
  searches: number;
  reads: number;
  mode: "sync" | "async";
  /** Spec §3: per-route rail allowlist. Premium is Base-only at launch. */
  rails: readonly ["base"];
  premium: true;
};

const t = (id: TierId, route: PremiumRoute, usd: number, searches: number, reads: number, mode: "sync" | "async"): Tier => ({
  id,
  route,
  priceUsd: `$${usd}`,
  amount: String(usd * 1_000_000),
  searches,
  reads,
  mode,
  rails: ["base"] as const,
  premium: true,
});

export const PREMIUM_TIERS: readonly Tier[] = [
  t("brief", "research", 1, 2, 5, "sync"),
  t("standard", "research", 5, 5, 12, "sync"),
  t("extended", "research", 10, 10, 25, "sync"),
  t("report", "research", 20, 20, 40, "async"),
  t("monitor", "research", 50, 60, 120, "async"),
  t("watch", "seller-watch", 75, 0, 0, "async"),
  t("watch-report", "seller-watch", 100, 30, 60, "async"),
];

export const ROUTE_BASE: Record<PremiumRoute, string> = {
  research: "/api/research/report",
  "seller-watch": "/api/seller-watch",
};

export function premiumEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HP_PREMIUM_ENABLED === "true";
}
export function premiumAsyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return premiumEnabled(env) && env.HP_PREMIUM_ASYNC_ENABLED === "true";
}

/** Tier for (route, path segment), or null. Exact, case-sensitive match only. */
export function tierFor(route: PremiumRoute, seg: string | undefined): Tier | null {
  if (typeof seg !== "string") return null;
  return PREMIUM_TIERS.find((x) => x.route === route && x.id === seg) ?? null;
}

export function tierPath(x: Tier): string {
  return `${ROUTE_BASE[x.route]}/${x.id}`;
}

/** Tiers that discovery may list right now (sync tiers when premium is on; async tiers only with the async flag). */
export function listedTiers(env: Record<string, string | undefined> = process.env): Tier[] {
  if (!premiumEnabled(env)) return [];
  return PREMIUM_TIERS.filter((x) => x.mode === "sync" || premiumAsyncEnabled(env));
}

/**
 * $10 time budget (spec §5 / v3.1): maxDuration 60 s, ~10 s reserved for settle -> 50 s of work.
 * Deterministic projection decided BEFORE verify/settle. Constants are provisional and are pinned at the sync Class A.
 *   projected = searches * SEARCH_S + ceil(reads / READ_BATCH) * READ_BATCH_S + (subQuestions - 1) * SUBQ_S
 */
export const WORK_BUDGET_S = 50;
export const SETTLE_RESERVE_S = 10;
export const SEARCH_S = 1.2;
export const READ_BATCH = 5;
export const READ_BATCH_S = 4;
export const SUBQ_S = 6;
export const MAX_SUBQUESTIONS = 8;

export function subQuestions(q: string): number {
  const parts = q.split(/[?;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 3);
  return Math.min(MAX_SUBQUESTIONS, Math.max(1, parts.length));
}

export function projectedSeconds(x: Tier, q: string): number {
  return x.searches * SEARCH_S + Math.ceil(x.reads / READ_BATCH) * READ_BATCH_S + (subQuestions(q) - 1) * SUBQ_S;
}
