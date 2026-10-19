/**
 * Premium public copy. Counsel-reviewed text (spec §8, v3.2), Michael-approved [M] items via Odin 2026-10-19 2:04 PM AST.
 * Verbatim strings: do not edit without Counsel. Public contact = CONTACT_EMAIL (lib/config.ts), the Horizon Pulse
 * business email already published in llms.txt and /.well-known/x402.
 */
import { CONTACT_EMAIL, PUBLIC_BASE_URL } from "@/lib/config";

export const PREMIUM_CONTACT = CONTACT_EMAIL;
export const BUYER_TERMS_PATH = "/premium-terms";
export const BUYER_TERMS_URL = `${PUBLIC_BASE_URL}${BUYER_TERMS_PATH}`;

export const DISCLAIMER =
  "Automated compilation of short quotes from public sources, with links and fetch times, as of the time shown. Informational only: not due diligence, an audit, a background or credit check, a consumer report, or legal, financial, investment or security advice. Horizon Pulse does not verify the sources, and a missing finding does not mean there is nothing to find. Screening results are mechanical address matches against dated public-list snapshots (such as OFAC SDN and ScamSniffer) and must be confirmed with the official source. Provided as is, without warranty of any kind. To the extent permitted by law, Horizon Pulse's total liability for any job is limited to the amount paid for that job.";

export const NO_DOXXING =
  "We do not try to identify the people behind wallets or services. Results never include home addresses, personal phone numbers or email addresses, government ID numbers, photos of private individuals, or family details. You may not use results to identify, locate, contact, harass or expose private individuals.";

export const FCRA_CLAUSE =
  "Not a consumer report. Horizon Pulse is not a consumer reporting agency, and these results are not consumer reports under the Fair Credit Reporting Act. You may not use them, in whole or in part, as a factor in deciding anyone's eligibility for credit, insurance, employment, housing or any other purpose covered by the FCRA or similar laws.";

export const WATCH_TERMS =
  "Watch: one check report at the start, then one check record per day for 30 days, available at your receipt URL for 30 days after the watch ends. If the first report is not delivered, you get a full refund. If we miss 3 or more daily checks, or end the watch early for any reason, you get a refund for the undelivered days (price × undelivered days ÷ 30). The watched service going down, changing or delisting is a reported event, not a failure. Webhooks are best effort. We may refuse or stop a watch that breaks our terms; in that case unused days are refunded unless the watch was stopped for abuse. No auto-renewal.";

export const REFUND_LINE =
  `Refunds: Delivered results are final. If you were charged and we did not deliver (for example a payment settle error, or a job or watch we failed to complete), send the receipt ID or transaction hash to ${PREMIUM_CONTACT} within 30 days. We confirm the payment on-chain and refund the amount owed in USDC on Base to the paying address, usually within 7 days. Undelivered watch days are refunded pro rata. Other refund requests are at our discretion.`;

export const PRIVACY_PREMIUM_REPLACEMENT =
  "We do not store user agents or headers, and we store request content only for premium jobs, as described below.";
export const PRIVACY_PREMIUM_ADDITION =
  "For premium report and watch jobs we also store the question or target URL you submit, the tier, the job's results and copies of the public web pages they cite, so the paying caller can retrieve them; these are deleted 30 days after the job's last delivery. If a payment needs to be reconciled, we keep the payment record (route, tier, payer wallet, amount, transaction details and outcome) until it is resolved and for at most 12 months.";

/** Reconcile-line retention: must match PRIVACY_PREMIUM_ADDITION (at most 12 months). */
export const RECONCILE_RETENTION_S = 365 * 86_400;

/**
 * Buyer terms (Counsel cond. 1, [M] approved): at least as protective of Parallel's IP as Parallel Customer Terms
 * §1(f) (effective 2026-10-17; re-read at sign-up). Linked from every premium 402 and response.
 */
export const BUYER_TERMS: readonly string[] = [
  "These terms apply to every paid call to a Horizon Pulse premium URL (/api/research/report/* and /api/seller-watch/*). Paying for a call means you accept them.",
  "Use of results: results are for your own internal use. You may not resell, redistribute, sublicense or publish results in bulk, use them to build or train any machine-learning model, or sell or broker the data they contain. Our upstream providers' rights in the results are reserved, and you may not remove any notices they carry.",
  "Per-buyer output: each result is produced for the paying caller only. We do not share it with other buyers and do not keep a shared report database.",
  NO_DOXXING,
  FCRA_CLAUSE,
  "Checks: we may check that use of results follows these terms, and we may refuse or stop service that breaks them.",
  WATCH_TERMS,
  REFUND_LINE,
  "Payment: paid once per call in USDC on Base. We hold no balance or stored value for you. You are charged only when the call is accepted (HTTP 200 or 202); a 4xx answer never settles.",
  `${PRIVACY_PREMIUM_REPLACEMENT} ${PRIVACY_PREMIUM_ADDITION}`,
  DISCLAIMER,
  `Contact for refunds, corrections and takedowns: ${PREMIUM_CONTACT}.`,
];

export const R1_DESCRIPTION =
  "Multi-source research report for a question. Returns short quoted snippets with source URLs and dates, which claims were found on at least two different domains, and what could not be confirmed. $20+ tiers include a source archive with hashes and fetch times for 30 days. Tiers $1–$50. Paid on Base. Not advice; sources are not verified by Horizon Pulse.";
export const R2_DESCRIPTION =
  "30-day x402 seller watch for a paid API URL. Checks the 402 terms and payTo across networks against the listing, runs public screens, and reports changes daily. $100 adds a sourced seller report. Findings only, no safety rating. Paid once for a 30-day service; no balance held. Not advice.";

/** Fields attached to every premium response body. */
export function legalBlock() {
  return { disclaimer: DISCLAIMER, terms: BUYER_TERMS_URL, contact: PREMIUM_CONTACT };
}
