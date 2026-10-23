/**
 * Trade Gate (DARK: HP_TRADE_GATE_ENABLED, default off). A deterministic, stateless checker of ONE order
 * against rules the CALLER supplies. Spec v1 (team-room to-pulse 2026-10-22) with Counsel E1-E8 applied
 * (to-odin/2026-10-22-counsel-trade-gate-spec.md):
 *   E1 Rules are supplied by the caller; Trade Gate ships no default rule set. No broker is named anywhere.
 *   E2 No default thresholds in code: an omitted (or false) rule is "skipped", never filled in.
 *   E3 rules_result all_supplied_rules_met | supplied_rule_not_met | no_rules_checked, plus checked/skipped.
 *   E4 TRADE_GATE_DISCLAIMER verbatim in every response and the route description.
 *   E5 detail strings state arithmetic / input facts only (tests ban judgment words).
 *   E6 Nothing from the request or the response is stored or logged here.
 *   E7 order/rules sha256 hashes are returned to the caller only, never stored.
 *   E8 thesis_id / approval_ref are opaque strings, only checked for being non-empty, never echoed.
 * Inputs are self-reported by the caller; Trade Gate verifies nothing with any outside party.
 */
import { createHash } from "node:crypto";

/** Counsel E4, verbatim. */
export const TRADE_GATE_DISCLAIMER =
  "Checks only the rules you supplied, using the inputs you supplied, which are not verified. Not investment advice, a recommendation, a suitability determination or an approval to trade. Horizon Pulse is not a broker or investment adviser and is not affiliated with any broker.";
/** Counsel E7(a), verbatim. */
export const TRADE_GATE_HASH_NOTE = "Hashes are returned to you and not stored by Horizon Pulse.";
/** Counsel E8, verbatim. */
export const TRADE_GATE_ID_NOTE = "Do not include personal data, account numbers or credentials.";
/** Counsel E1 replacement line, verbatim. */
export const TRADE_GATE_RULES_NOTE = "Rules are supplied by the caller; Trade Gate ships no default rule set.";
/** Counsel E2 label for any public example. */
export const TRADE_GATE_EXAMPLE_LABEL = "Example values only; not suggested limits.";

export const TRADE_GATE_DESCRIPTION =
  "Trade Gate: mechanical check of one order against rules the caller supplies (POST JSON order, account, rules, attestations, as_of). Returns per-rule pass, fail or skipped, rules_result, checked/skipped counts, sha256 hashes. " +
  TRADE_GATE_DISCLAIMER;

export const TRADE_GATE_MAX_BODY_BYTES = 64 * 1024;
const MAX_POSITIONS = 500;
const MAX_ID_LEN = 200;

export type CheckId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11";
export type Check = { id: CheckId; rule: string; status: "pass" | "fail" | "skipped"; detail: string };
export type RulesResult = "all_supplied_rules_met" | "supplied_rule_not_met" | "no_rules_checked";

type Order = {
  symbol: string;
  underlying: string;
  asset_type: "option" | "equity";
  side: "buy_to_open" | "sell_to_open" | "sell_to_close" | "buy" | "sell";
  quantity: number;
  limit_price: number;
  multiplier: number;
  expiration: string | null;
  order_type: "limit" | "market";
};
type Position = { symbol: string; underlying: string; asset_type: "option" | "equity"; market_value: number };
type Rules = {
  cash_only?: boolean; long_premium_only?: boolean; max_options_pct_nav?: number; max_option_positions?: number;
  max_single_position_pct_nav?: number; min_days_to_expiry?: number; limit_orders_only?: boolean; no_averaging_down?: boolean;
  require_thesis?: boolean; require_preview?: boolean; require_approval?: boolean;
};

export type TradeGateOk = {
  ok: true;
  rules_result: RulesResult;
  checked: number;
  skipped: number;
  failed: CheckId[];
  checks: Check[];
  order_cost: number;
  as_of: string;
  journal: { ts: string; order_hash: string; rules_hash: string; rules_result: RulesResult };
};
export type TradeGateErr = { ok: false; status: 400; code: "bad_input"; error: string };

const RULE_KEYS: Record<CheckId, keyof Rules> = {
  R1: "cash_only", R2: "long_premium_only", R3: "max_options_pct_nav", R4: "max_option_positions",
  R5: "max_single_position_pct_nav", R6: "min_days_to_expiry", R7: "limit_orders_only", R8: "no_averaging_down",
  R9: "require_thesis", R10: "require_preview", R11: "require_approval",
};
const NUMERIC_RULES = new Set<keyof Rules>(["max_options_pct_nav", "max_option_positions", "max_single_position_pct_nav", "min_days_to_expiry"]);
const OPTION_SIDES = ["buy_to_open", "sell_to_open", "sell_to_close"];
const EQUITY_SIDES = ["buy", "sell"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const sym = (v: unknown): string | null => (str(v) && /^[A-Za-z0-9.\-_/ ]{1,40}$/.test(v.trim()) ? v.trim().toUpperCase() : null);
const isoDate = (v: unknown): number | null => {
  if (!str(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? t : null;
};
/** 2 decimals, no float noise. */
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => r2(n).toString();
const bad = (error: string): TradeGateErr => ({ ok: false, status: 400, code: "bad_input", error });

/** Canonical JSON (sorted keys) so the same order always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function parseOrder(o: unknown): Order | string {
  if (!isObj(o)) return "order must be an object";
  const symbol = sym(o.symbol);
  if (!symbol) return "order.symbol must be a short ticker string";
  if (o.asset_type !== "option" && o.asset_type !== "equity") return "order.asset_type must be option or equity";
  const sides = o.asset_type === "option" ? OPTION_SIDES : EQUITY_SIDES;
  if (!str(o.side) || !sides.includes(o.side)) return `order.side must be one of ${sides.join(", ")} for ${o.asset_type}`;
  if (!num(o.quantity) || !Number.isInteger(o.quantity) || o.quantity <= 0) return "order.quantity must be a positive integer";
  if (!num(o.limit_price) || o.limit_price <= 0) return "order.limit_price must be a positive number (for a market order, the price to use for cost)";
  if (o.order_type !== "limit" && o.order_type !== "market") return "order.order_type must be limit or market";
  let multiplier = 1;
  let expiration: string | null = null;
  if (o.asset_type === "option") {
    if (!num(o.multiplier) || o.multiplier <= 0) return "order.multiplier must be a positive number for an option";
    multiplier = o.multiplier;
    if (isoDate(o.expiration) === null) return "order.expiration must be YYYY-MM-DD for an option";
    expiration = o.expiration as string;
    if (o.option_type !== "call" && o.option_type !== "put") return "order.option_type must be call or put for an option";
  } else if (o.multiplier !== undefined && o.multiplier !== null) {
    if (!num(o.multiplier) || o.multiplier <= 0) return "order.multiplier must be a positive number";
    multiplier = o.multiplier;
  }
  const underlying = o.underlying === undefined || o.underlying === null ? symbol : sym(o.underlying);
  if (!underlying) return "order.underlying must be a short ticker string";
  return { symbol, underlying, asset_type: o.asset_type, side: o.side as Order["side"], quantity: o.quantity, limit_price: o.limit_price, multiplier, expiration, order_type: o.order_type };
}

function parseAccount(a: unknown): { nav: number; cash: number; positions: Position[] } | string {
  if (!isObj(a)) return "account must be an object";
  if (!num(a.nav) || a.nav <= 0) return "account.nav must be a positive number";
  if (!num(a.cash) || a.cash < 0) return "account.cash must be a number >= 0";
  if (!Array.isArray(a.positions)) return "account.positions must be an array (may be empty)";
  if (a.positions.length > MAX_POSITIONS) return `account.positions may hold at most ${MAX_POSITIONS} entries`;
  const positions: Position[] = [];
  for (const [i, p] of a.positions.entries()) {
    if (!isObj(p)) return `account.positions[${i}] must be an object`;
    const symbol = sym(p.symbol);
    if (!symbol) return `account.positions[${i}].symbol must be a short ticker string`;
    if (p.asset_type !== "option" && p.asset_type !== "equity") return `account.positions[${i}].asset_type must be option or equity`;
    if (!num(p.market_value) || p.market_value < 0) return `account.positions[${i}].market_value must be a number >= 0`;
    const underlying = p.underlying === undefined || p.underlying === null ? symbol : sym(p.underlying);
    if (!underlying) return `account.positions[${i}].underlying must be a short ticker string`;
    positions.push({ symbol, underlying, asset_type: p.asset_type, market_value: p.market_value });
  }
  return { nav: a.nav, cash: a.cash, positions };
}

function parseRules(r: unknown): Rules | string {
  if (r === undefined || r === null) return {};
  if (!isObj(r)) return "rules must be an object";
  const known = new Set<string>(Object.values(RULE_KEYS));
  for (const k of Object.keys(r)) if (!known.has(k)) return `unknown rule ${k}`;
  for (const k of known) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    if (NUMERIC_RULES.has(k as keyof Rules)) {
      if (!num(v) || v < 0) return `rules.${k} must be a number >= 0`;
    } else if (typeof v !== "boolean") return `rules.${k} must be true or false`;
  }
  return r as Rules;
}

function parseAttestations(a: unknown): { thesis: boolean; preview: boolean; approval: boolean; basis: number | null } | string {
  if (a === undefined || a === null) return { thesis: false, preview: false, approval: false, basis: null };
  if (!isObj(a)) return "attestations must be an object";
  for (const k of ["thesis_id", "approval_ref"] as const) {
    const v = a[k];
    if (v !== undefined && v !== null && (!str(v) || v.length > MAX_ID_LEN)) return `attestations.${k} must be an opaque string of at most ${MAX_ID_LEN} characters or null. ${TRADE_GATE_ID_NOTE}`;
  }
  if (a.preview_ok !== undefined && a.preview_ok !== null && typeof a.preview_ok !== "boolean") return "attestations.preview_ok must be true or false";
  const b = a.existing_cost_basis;
  if (b !== undefined && b !== null && (!num(b) || b < 0)) return "attestations.existing_cost_basis must be a number >= 0 or null";
  const nonEmpty = (v: unknown) => str(v) && v.trim().length > 0;
  return { thesis: nonEmpty(a.thesis_id), preview: a.preview_ok === true, approval: nonEmpty(a.approval_ref), basis: num(b) ? b : null };
}

/** Pure evaluation. `now` only stamps journal.ts and the as_of fallback. */
export function evaluateTradeGate(body: unknown, now: Date = new Date()): TradeGateOk | TradeGateErr {
  if (!isObj(body)) return bad("Body must be a JSON object {order, account, rules, attestations, as_of}");
  const order = parseOrder(body.order);
  if (typeof order === "string") return bad(order);
  const account = parseAccount(body.account);
  if (typeof account === "string") return bad(account);
  const rules = parseRules(body.rules);
  if (typeof rules === "string") return bad(rules);
  const att = parseAttestations(body.attestations);
  if (typeof att === "string") return bad(att);
  let asOf = now.toISOString().slice(0, 10);
  if (body.as_of !== undefined && body.as_of !== null) {
    if (isoDate(body.as_of) === null) return bad("as_of must be YYYY-MM-DD");
    asOf = body.as_of as string;
  }

  const isBuy = order.side === "buy" || order.side === "buy_to_open";
  const isReducingSell = order.side === "sell" || order.side === "sell_to_close";
  const isOption = order.asset_type === "option";
  const cost = r2(order.quantity * order.limit_price * order.multiplier);
  const navPct = (v: number) => (v / account.nav) * 100;

  const checks: Check[] = [];
  const push = (id: CheckId, status: Check["status"], detail: string) => checks.push({ id, rule: RULE_KEYS[id], status, detail });
  const supplied = (id: CheckId) => {
    const v = rules[RULE_KEYS[id]];
    return NUMERIC_RULES.has(RULE_KEYS[id]) ? num(v) : v === true;
  };
  const limitOf = (id: CheckId) => rules[RULE_KEYS[id]] as number;
  /** Sells that only reduce or close are checked against R2, R7, R10, R11 only (spec). */
  const SELL_RULES: CheckId[] = ["R2", "R7", "R10", "R11"];
  const BUY_ONLY: CheckId[] = ["R1", "R3", "R4", "R5", "R6", "R8"];

  for (const id of Object.keys(RULE_KEYS) as CheckId[]) {
    if (!supplied(id)) { push(id, "skipped", "rule not supplied"); continue; }
    if (isReducingSell && !SELL_RULES.includes(id)) { push(id, "skipped", `not applied to side ${order.side}`); continue; }
    if (!isBuy && BUY_ONLY.includes(id)) { push(id, "skipped", `not applied to side ${order.side}`); continue; }
    switch (id) {
      case "R1": {
        push(id, cost > account.cash ? "fail" : "pass", `order cost ${fmt(cost)}, cash ${fmt(account.cash)}`);
        break;
      }
      case "R2": {
        const short = isOption && order.side === "sell_to_open";
        push(id, short ? "fail" : "pass", `side ${order.side}, asset_type ${order.asset_type}`);
        break;
      }
      case "R3": {
        const existing = account.positions.filter((p) => p.asset_type === "option").reduce((s, p) => s + p.market_value, 0);
        const after = existing + (isOption ? cost : 0);
        const pct = navPct(after);
        push(id, pct > limitOf(id) ? "fail" : "pass", `options ${fmt(pct)}% of NAV after order (${fmt(after)} / ${fmt(account.nav)}), limit ${fmt(limitOf(id))}%`);
        break;
      }
      case "R4": {
        if (!isOption) { push(id, "skipped", "not applied to asset_type equity"); break; }
        const optSymbols = new Set(account.positions.filter((p) => p.asset_type === "option").map((p) => p.symbol));
        const opensNew = !optSymbols.has(order.symbol);
        const fail = opensNew && optSymbols.size >= limitOf(id);
        push(id, fail ? "fail" : "pass", `${optSymbols.size} option positions before order, ${opensNew ? optSymbols.size + 1 : optSymbols.size} after, limit ${fmt(limitOf(id))}`);
        break;
      }
      case "R5": {
        const existing = account.positions.filter((p) => p.underlying === order.underlying).reduce((s, p) => s + p.market_value, 0);
        const after = existing + cost;
        const pct = navPct(after);
        push(id, pct > limitOf(id) ? "fail" : "pass", `${order.underlying} ${fmt(pct)}% of NAV after order (${fmt(after)} / ${fmt(account.nav)}), limit ${fmt(limitOf(id))}%`);
        break;
      }
      case "R6": {
        if (!isOption) { push(id, "skipped", "not applied to asset_type equity"); break; }
        const days = Math.floor((isoDate(order.expiration)! - isoDate(asOf)!) / 86_400_000);
        push(id, days < limitOf(id) ? "fail" : "pass", `${days} days from ${asOf} to expiration ${order.expiration}, minimum ${fmt(limitOf(id))}`);
        break;
      }
      case "R7": {
        push(id, order.order_type === "market" ? "fail" : "pass", `order_type ${order.order_type}`);
        break;
      }
      case "R8": {
        if (att.basis === null) { push(id, "skipped", "no existing_cost_basis supplied"); break; }
        push(id, att.basis > order.limit_price ? "fail" : "pass", `existing_cost_basis ${fmt(att.basis)}, limit_price ${fmt(order.limit_price)}`);
        break;
      }
      case "R9": push(id, att.thesis ? "pass" : "fail", att.thesis ? "thesis_id present" : "thesis_id empty"); break;
      case "R10": push(id, att.preview ? "pass" : "fail", att.preview ? "preview_ok is true" : "preview_ok is not true"); break;
      case "R11": push(id, att.approval ? "pass" : "fail", att.approval ? "approval_ref present" : "approval_ref empty"); break;
    }
  }

  const checked = checks.filter((c) => c.status !== "skipped").length;
  const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
  const rules_result: RulesResult = checked === 0 ? "no_rules_checked" : failed.length ? "supplied_rule_not_met" : "all_supplied_rules_met";
  return {
    ok: true,
    rules_result,
    checked,
    skipped: checks.length - checked,
    failed,
    checks,
    order_cost: cost,
    as_of: asOf,
    journal: { ts: now.toISOString(), order_hash: sha256(canonicalJson(body.order)), rules_hash: sha256(canonicalJson(body.rules ?? {})), rules_result },
  };
}
