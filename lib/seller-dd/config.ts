/**
 * Seller due-diligence ($5, single seller). Spec: oversight/to-odin/2026-10-20-pulse-seller-dd-spec.md (v3 + Counsel D1-D5 +
 * Sentinel C1-C6 + Odin C4). Flags are exact-string; anything else = off (fail closed).
 *   HP_PREMIUM_ENABLED=true AND HP_SELLER_DD_ENABLED=true -> route exists; otherwise 404 on every verb, no discovery entry.
 *   HP_DD_TESTPAY=on -> test payments allowed. Any other value (including unset) = kill switch: every paid request is
 *   NO CHARGE with reason "test_pay_disabled" before the buyer's payment is verified. (Stricter than spec §3 "=off".)
 */
import type { Tier } from "@/lib/premium/tiers";

type Env = Record<string, string | undefined>;
export const DD_PATH = "/api/seller-dd/single";
export const DD_PRICE_USD = 5;
export const DD_AMOUNT = "5000000";

export function sellerDdEnabled(env: Env = process.env): boolean {
  return env.HP_PREMIUM_ENABLED === "true" && env.HP_SELLER_DD_ENABLED === "true";
}
export function testPayEnabled(env: Env = process.env): boolean {
  return env.HP_DD_TESTPAY === "on";
}

/** Tier-shaped record so the shared premium verify/settle/price-binding helpers bind THIS price. Not in PREMIUM_TIERS. */
export const DD_TIER = { id: "seller-dd", route: "seller-dd", priceUsd: "$5", amount: DD_AMOUNT, searches: 0, reads: 0, mode: "sync", rails: ["base"], premium: true } as unknown as Tier;

/* ---- hard caps (spec §3; estimates to tune, enforcement not optional; no env override) ---- */
export const DAILY_CAP_USD = 5;
export const LIFETIME_CAP_USD = 25;
export const PER_CALL_MAX_USD = 0.1;
export const PER_CALL_MAX_ATOMIC = 100_000n;
export const PER_HOST_DAILY = 3;
export const SETTLE_FAIL_LIMIT = 3;
export const VALID_BEFORE_MAX_S = 300;

/** 402/Bazaar description. 10/20 copy recheck (Odin Class A on 173cb97): "dated snapshots" -> CDP discovery listing (#4),
 * "settlement history" -> recent window (#3). PENDING Counsel re-check. Test asserts < 500 chars. */
export const DD_DESCRIPTION =
  "Seller due-diligence for one x402 endpoint. We make a real capped test payment, check the paid response against the listed schema, compare payTo with the CDP listing, read a recent window of on-chain USDC payments to the payTo and screen for lookalike addresses. Returns a signed JSON verdict of evidenced facts. No charge unless the test payment succeeds and at least 3 of the other 4 checks complete. Facts, not endorsement; no warranty. Not affiliated with the seller checked. $5.";

/** Counsel notice (spec §5 + D1), verbatim, REQUIRED top-level field in every response body including no_charge. */
export const DD_NOTICE =
  "Technical facts as observed at checked_at, with evidence. Not an endorsement, rating, recommendation or warranty. Horizon Pulse is not affiliated with the seller checked. Not financial advice. Disputes or corrections: horizonpulse.co@proton.me.";

/** D5: excerpt cap (estimate). */
export const EXCERPT_MAX = 200;
export const FETCH_MAX_BYTES = 200_000;
export const FETCH_TIMEOUT_MS = 8_000;

/**
 * L-5 watch start (non-secret). With no stored cursor, the first scan starts here, so the first funding of dd-tester
 * (Michael's 3.000000 USDC, Base block 52869933) is counted naturally by the LOW-2 inbound total. Odin round 4, 10/20.
 */
export const DD_WATCH_START_BLOCK = 52_869_932;

/** Counsel D3 copy (to-pulse/2026-10-20-counsel-seller-dd-d3.md), verbatim. */
export const DD_SUPERSEDED_NOTE = "A superseded verdict has been replaced after a re-check; rely on the verdict named in superseded_by.";
export const DD_PASS_NOTE = "pass means Horizon Pulse's charge criteria were met; it is not a rating of the seller.";
export const DD_RETENTION_TERM = "Verdict receipts (hashes only) are kept for 3 years.";
