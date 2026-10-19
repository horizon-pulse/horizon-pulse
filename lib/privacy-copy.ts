/** Counsel-approved wording (10/17). Keep word for word; tests/privacy-page.test.ts pins it. */
export const ROUTE_LOG_PRIVACY_LINE =
  "For paid API calls we log the timestamp, route, method and outcome, and for settled payments the network, amount, transaction hash and payer wallet address (already public on-chain). We do not store IP addresses, user agents, headers or request content. Records are kept for 30 days (aggregate per-route counts without payer data for 90 days), used only for our own usage analytics, and never sold or shared.";

// ---------- free tier (Counsel ruling B, 10/18): ships only with the free-tier flag ----------
import { freeTierMode, payerMarkTtlDays, payerMarkWriting } from "./free-tier-mode";
import { PRIVACY_PREMIUM_ADDITION, PRIVACY_PREMIUM_REPLACEMENT } from "./premium/copy";

/** The sentence Counsel's ruling B replaces. */
export const NO_IP_SENTENCE = "We do not store IP addresses, user agents, headers or request content.";

/**
 * Counsel's ruling-B text, word for word ("It replaces 'We do not store IP addresses, user agents,
 * headers or request content.'"). Only the retention number follows HP_FREE_PAYER_MARK_TTL_DAYS
 * (Counsel: "If the marker retention becomes 14 days, change '30 days after a paid call' to match").
 */
export function freeTierPrivacySentences(markDays: number): string {
  const days = markDays === 1 ? "1 day" : `${markDays} days`;
  return (
    "For free-tier calls we log the timestamp, route and outcome. We do not store IP addresses in readable form, and we do not store user agents, headers or request content. " +
    "To run the opt-in free tier we keep a keyed one-way hash of the caller's IP address (for IPv6, its /64 network): one to count free calls per day, deleted after about 26 hours, and, " +
    `for ${days} after a paid call, one marking that IP as a previous payer so it is not offered free calls. ` +
    "These hashes are not linked to wallet addresses, transaction hashes or receipt IDs."
  );
}

/**
 * Counsel's full combined A+B line (receipt id + price tier from the route log, plus the free tier).
 * Staged for when the route-log tier/receipt id (Counsel ruling A) ships; not rendered yet,
 * because this branch has no X-HP-Receipt-Id header.
 */
export function combinedPrivacyLine(markDays: number): string {
  const days = markDays === 1 ? "1 day" : `${markDays} days`;
  return (
    "For paid API calls we log the timestamp, route, method, price tier, outcome and a random receipt ID we generate for the call (returned to you in the X-HP-Receipt-Id header), and for settled payments the network, amount, transaction hash and payer wallet address (already public on-chain). " +
    "For free-tier calls we log the timestamp, route and outcome. We do not store IP addresses in readable form, and we do not store user agents, headers or request content. " +
    "To run the opt-in free tier we keep a keyed one-way hash of the caller's IP address (for IPv6, its /64 network): one to count free calls per day, deleted after about 26 hours, and, " +
    `for ${days} after a paid call, one marking that IP as a previous payer so it is not offered free calls. ` +
    "These hashes are not linked to wallet addresses, transaction hashes or receipt IDs. " +
    "Records are kept for 30 days; daily per-route and per-network call counts and totals, which contain no payer data, are kept for 90 days. " +
    "All of this is used only to run the service and for our own usage analytics, and is never sold or shared."
  );
}

/**
 * The line /privacy renders. Free tier off and no marker pre-seeding (the code default, and always
 * without HP_FREE_IP_HMAC_KEY) -> ROUTE_LOG_PRIVACY_LINE byte-identical. Tier optin or
 * HP_FREE_PAYER_MARK=on (Counsel B.5: whichever comes first) -> the ruling-B sentences replace
 * NO_IP_SENTENCE. Read at build time (the page is static; env changes need a redeploy, like the tier).
 */
export function privacyLine(env: Record<string, string | undefined> = process.env): string {
  const free = freeTierMode(env) === "optin" || payerMarkWriting(env);
  const line = free ? ROUTE_LOG_PRIVACY_LINE.replace(NO_IP_SENTENCE, freeTierPrivacySentences(payerMarkTtlDays(env))) : ROUTE_LOG_PRIVACY_LINE;
  return env.HP_PREMIUM_ENABLED === "true" ? withPremiumPrivacy(line, free) : line;
}

/** Free-tier variant of the request-content sentence (inside freeTierPrivacySentences). */
export const FREE_NO_CONTENT_SENTENCE = "We do not store IP addresses in readable form, and we do not store user agents, headers or request content.";
const FREE_LAST_SENTENCE = "These hashes are not linked to wallet addresses, transaction hashes or receipt IDs.";

/**
 * Counsel C1 (premium build re-read, 10/19): premium on -> Counsel's replacement sentence swaps in for the
 * request-content sentence, and the premium sentence follows (after the free-tier sentences when present); the
 * rest of the line is unchanged. Premium off -> the line is byte-identical to before.
 */
export function withPremiumPrivacy(line: string, free: boolean): string {
  if (!free) return line.replace(NO_IP_SENTENCE, `${PRIVACY_PREMIUM_REPLACEMENT} ${PRIVACY_PREMIUM_ADDITION}`);
  return line.replace(FREE_NO_CONTENT_SENTENCE, PRIVACY_PREMIUM_REPLACEMENT).replace(FREE_LAST_SENTENCE, `${FREE_LAST_SENTENCE} ${PRIVACY_PREMIUM_ADDITION}`);
}
