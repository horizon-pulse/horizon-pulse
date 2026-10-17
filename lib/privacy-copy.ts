/** Counsel-approved wording (10/17). Keep word for word; tests/privacy-page.test.ts pins it. */
export const ROUTE_LOG_PRIVACY_LINE =
  "For paid API calls we log the timestamp, route, method and outcome, and for settled payments the network, amount, transaction hash and payer wallet address (already public on-chain). We do not store IP addresses, user agents, headers or request content. Records are kept for 30 days (aggregate per-route counts without payer data for 90 days), used only for our own usage analytics, and never sold or shared.";
