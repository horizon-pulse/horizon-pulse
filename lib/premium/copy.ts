/**
 * Premium public copy. Counsel-reviewed text (spec §8, v3.2). [M] items: OPEN, pending Michael (Odin 10/20 7:22 AM;
 * his 10/19 3:20 PM ruling is current). Verified-brief clause 6 (refund item): APPROVED (Michael, 10/20 7:59 AM ET), option (a),
 * no refund promise for delivered briefs (contract.ts). REFUND_LINE stays OPEN (kept: it is the charge-without-delivery
 * line that clause 6 (a) refers to; flagged to Odin/Counsel 10/20).
 * Verbatim strings: do not edit without Counsel. Public contact = CONTACT_EMAIL (lib/config.ts), the Horizon Pulse
 * business email already published in llms.txt and /.well-known/x402.
 */
import { CONTACT_EMAIL, PUBLIC_BASE_URL } from "@/lib/config";

export const PREMIUM_CONTACT = CONTACT_EMAIL;
export const BUYER_TERMS_PATH = "/premium-terms";
export const BUYER_TERMS_URL = `${PUBLIC_BASE_URL}${BUYER_TERMS_PATH}`;

export const DISCLAIMER =
  "Automated compilation of short quotes from public sources, with links and fetch times, as of the time shown. Informational only: not due diligence, an audit, a background or credit check, a consumer report, or legal, financial, investment or security advice. Horizon Pulse does not check whether the sources are accurate, and a missing finding does not mean there is nothing to find. Screening results are mechanical address matches against dated public-list snapshots (such as OFAC SDN and ScamSniffer) and must be confirmed with the official source. Provided as is, without warranty of any kind. To the extent permitted by law, Horizon Pulse's total liability for any job is limited to the amount paid for that job.";

export const NO_DOXXING =
  "We do not try to identify the people behind wallets or services. Results never include home addresses, personal phone numbers or email addresses, government ID numbers, photos of private individuals, or family details. You may not use results to identify, locate, contact, harass or expose private individuals.";

export const FCRA_CLAUSE =
  "Not a consumer report. Horizon Pulse is not a consumer reporting agency, and these results are not consumer reports under the Fair Credit Reporting Act. You may not use them, in whole or in part, as a factor in deciding anyone's eligibility for credit, insurance, employment, housing or any other purpose covered by the FCRA or similar laws.";

export const WATCH_TERMS =
  "Watch: one check report at the start, then one check record per day for 30 days, available at your status link for 30 days after the watch ends. You are charged only once the first report is built; if it cannot be built, you are not charged, or, if settlement was temporarily moved to payment verification, you are refunded in full. If we miss 3 or more daily checks, or end the watch early for any reason, you get a refund for the undelivered days (price × undelivered days ÷ 30). The watched service going down, changing or delisting is a reported event, not a failure. There are no webhooks; check the status link. We may refuse or stop a watch that breaks our terms; in that case unused days are refunded unless the watch was stopped for abuse. No auto-renewal: a watch ends after 30 days and is never charged again.";

/** APPROVED (Michael, 10/20 7:59 AM ET, option (a) relayed by Odin; confirmed in chat 8:02 AM ET: no delivered-brief refunds in v1). Counsel PASS 10/20 8:04 AM ET. Michael approved with option (a), GO 10/20 8:05 AM ET (Odin relay). */
export const REFUND_LINE =
  `Refunds: Delivered results are final. If you were charged and we did not deliver (for example a payment settle error, or a job or watch we failed to complete), send the receipt ID or transaction hash to ${PREMIUM_CONTACT} within 30 days. We confirm the payment on-chain and refund the amount owed in USDC on Base to the paying address, usually within 7 days. Undelivered watch days are refunded pro rata. Other refund requests are at our discretion.`;

export const PRIVACY_PREMIUM_REPLACEMENT =
  "We do not store user agents or headers, and we store request content only for premium jobs, as described below.";
export const PRIVACY_PREMIUM_ADDITION =
  "For premium report and watch jobs we also store the question or target URL you submit, the tier, the job's results and copies of the public web pages they cite, so the paying caller can retrieve them; these are deleted 30 days after the job is delivered, fails or, for a watch, ends. If a payment needs to be reconciled, we keep the payment record (route, tier, payer wallet, amount, transaction details and outcome) until it is resolved and for at most 12 months.";

/** Reconcile-line retention: must match PRIVACY_PREMIUM_ADDITION (at most 12 months). */
export const RECONCILE_RETENTION_S = 365 * 86_400;

/**
 * Buyer terms (Counsel cond. 1, [M] OPEN, pending Michael): at least as protective of Parallel's IP as Parallel Customer Terms
 * §1(f) (effective 2026-10-17; re-read at sign-up). Linked from every premium 402 and response.
 */
/**
 * Counsel X7 (10/20 memo): buyer terms must flow down the providers' terms. Counsel R3 wording (10/19 ~6:40 PM ET), verbatim. Always shown.
 */
export const BUYER_FLOWDOWN =
  "You must not use premium results for any unlawful purpose, to harass, track or profile any private person or otherwise violate anyone's privacy, or as the basis for decisions about a person's eligibility for credit, employment, housing or insurance. You must not use premium results to train or improve AI models, and you must not represent that the selection or ordering of quotes was done by a human.";
/** Counsel X1 with R1 edit (10/19), verbatim. True only once ZDR is confirmed on the account (PREMIUM_LLM_ZDR_CONFIRMED gate). Shown on /premium-terms only while LLM synthesis is enabled. */
export const AI_PROVIDER_PRIVACY =
  "For premium briefs we send your question and the text we extracted from the cited public web pages to an AI model provider, which processes it on our behalf only to select and order quotes and, for verified briefs, to write the answer line from the confirmed claims, does not use it to train its models, and deletes it within one hour of returning the result. We do not send your wallet address or payment details.";
/** Counsel X6 line (Odin: names "an AI model provider"). Shown with X1. */
export const AI_SELECTION_TERM = "In premium briefs, quotes are selected and ordered with the help of an AI model provider, and for verified briefs about x402 the provider writes the answer line from the confirmed claims; that line is marked as machine-written. Every quote is verbatim from the cited page and checked against it by code.";
export const AI_PROVIDER_TERMS: readonly string[] = [AI_PROVIDER_PRIVACY, AI_SELECTION_TERM];

export const BUYER_TERMS: readonly string[] = [
  "These terms apply to every paid call to a Horizon Pulse premium URL (/api/research/report/* and /api/seller-watch/*). Paying for a call means you accept them.",
  "Use of results: results are for your own internal use. You may not resell, redistribute, sublicense or publish results in bulk, use them to build or train any machine-learning model, or sell or broker the data they contain. Our upstream providers' rights in the results are reserved, and you may not remove any notices they carry.",
  "Per-buyer output: each result is produced for the paying caller only. We do not share it with other buyers and do not keep a shared report database.",
  NO_DOXXING,
  FCRA_CLAUSE,
  "Checks: we may check that use of results follows these terms, and we may refuse or stop service that breaks them.",
  WATCH_TERMS,
  REFUND_LINE,
  "Payment: paid once per call in USDC on Base. We hold no balance or stored value for you. A 4xx answer is never charged. The $1 verified brief is settled only after the brief passes its published contract (/contracts/brief-verified); a brief that does not pass is not charged. The $5 and $10 tiers are settled before the result is built; report and watch purchases (HTTP 202) are settled after the first deliverable is built, except while settlement is temporarily moved to payment verification, as the 202 response will say. If you are charged and we do not deliver, the refund terms below apply.",
  `${PRIVACY_PREMIUM_REPLACEMENT} ${PRIVACY_PREMIUM_ADDITION}`,
  DISCLAIMER,
  `Contact for refunds, corrections and takedowns: ${PREMIUM_CONTACT}.`,
  // Counsel X7 flow-down (R3 wording, approved 10/19).
  BUYER_FLOWDOWN,
];

export const R1_DESCRIPTION =
  "Multi-source research report for a question. Returns short quoted snippets with source URLs and dates, which claims were found on at least two different domains, and what could not be confirmed. $20+ tiers include a source archive with hashes and fetch times for 30 days. Tiers $1–$50. Paid on Base. Not advice; sources are not verified by Horizon Pulse.";
export const R2_DESCRIPTION =
  "30-day x402 seller watch for a paid API URL. Checks the 402 terms and payTo across networks against the listing, runs public screens, and reports changes daily. $100 adds a sourced seller report. Findings only, no safety rating. Paid once for a 30-day service; no balance held. Not advice.";

/** Fields attached to every premium response body. */
export function legalBlock() {
  return { disclaimer: DISCLAIMER, terms: BUYER_TERMS_URL, contact: PREMIUM_CONTACT };
}

/**
 * Technical notes on /premium-terms. Paragraphs 3-5 = Counsel F1-F3 (async re-read 10/19); paragraphs 1-2 (EOA-only,
 * failed-settle pause, Odin rulings 10/19) are NOT Counsel-reviewed yet (paragraph 2 breaker sentence = DRAFT): see the async build report, delta 3.
 */
export const TECHNICAL_NOTES: string[] = [
  "Wallets: at launch, premium accepts payments signed by a regular wallet key (an EOA) only. Smart-wallet signatures (ERC-1271 or ERC-6492) are not supported and are refused before anything is charged; depending on the signature, the error is smart_wallet_unsupported or invalid_signature.",
  "If two payments from one address fail to settle within 24 hours, new report and watch jobs from that address are refused for 24 hours; nothing is charged for a refused request. If several payments fail to settle across the service within 24 hours, report and watch purchases may temporarily be settled when the payment is verified, before the job runs; the 202 response says when this applies. If a charged job then fails, or an earlier payment was charged but not delivered, the refund terms above apply.",
  "Report and watch purchases return a job ID, a status link and a job token. The token is shown once and cannot be recovered; anyone who has it can open the job, so keep it secret. Send it as Authorization: Bearer <token> (never in the URL). Without the right token the link returns Not found. Results stay available for 30 days after a report is delivered or a watch ends; after that the link returns Gone.",
  "Report and watch purchases are charged only after the first deliverable is built. If we cannot build it within 10 minutes, the job ends as failed_uncharged and the payment authorization is never submitted. Exception: while settlement is temporarily moved to payment verification (the 202 response says so), you are charged before the job runs; if it then fails, it ends as failed_charged and the refund terms apply. The $5 and $10 tiers are settled before the report is built; if we then cannot deliver, the response says charged: true and you can redeem as below or ask for a refund. The $1 verified brief is settled only after it passes; if that settlement cannot be confirmed, the response says settle_unconfirmed and the steps below apply.",
  "If a response says settle_unconfirmed, do not sign a new payment. For the $1, $5 and $10 tiers you can retry the exact same request with the same payment and an x-hp-payer-proof header: an EIP-191 signature by the paying address over the redeem_message returned with that response. Only standard wallets (EOAs) can sign this proof; smart-contract wallets are not supported. The content is delivered once, only after the payment is confirmed on Base. Otherwise contact us with the reconcile_id.",
];

/** Hardened $1 brief: 402 / Bazaar description (<= 500 chars incl. the handler suffix), schema brief-verified/1. */
export const BRIEF_DESCRIPTION =
  "Verified brief (schema brief-verified/1), on-chain live values and x402 spec facts only: answer plus 2-8 claims, each with an evidence array (verbatim quote, URL, retrieval time, body hash, offset; or chain, block and block time for on-chain reads). Charged only if >=2 claims are confirmed (2 publishers, 2 nodes, or 2 x402 spec documents) and every quote verifies; otherwise unpaid. Contract: horizonpulse.dev/contracts/brief-verified. Not advice.";
