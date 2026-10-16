/**
 * Paid-call metadata (volume plan #2, 10/14).
 *
 * 1. Cadence hints: on a SETTLED 2xx response (PAYMENT-RESPONSE / X-PAYMENT-RESPONSE
 *    present) for a feed-style route, add
 *      x-hp-poll-interval-seconds: <n>   (how often the upstream data can change)
 *    (deterministic: no clock-dependent value, so responses stay cacheable/comparable)
 *    so a monitoring agent knows to call again on a schedule. Headers only:
 *    the JSON body, price and payment terms are unchanged.
 * 2. Attribution log: one structured line {evt:"paid_call", route, rail, tx}
 *    per settled call, so on-chain receipts can be joined to routes from the
 *    platform logs. No payer, payload, signature or keys are logged; tx is
 *    already public on-chain.
 * Unpaid 402s, errors and HEAD are untouched.
 */
export const POLL_INTERVAL_SECONDS: Readonly<Record<string, number>> = {
  "/api/pulse": 60, // spot prices revalidate 30 s
  "/api/gas": 60, // fee history moves per block
  "/api/funding": 300, // OKX funding revalidate 60 s; rate changes slowly
  "/api/signals": 300, // OHLC-based indicators
  "/api/yield": 3600, // DefiLlama pools
  "/api/balance": 60, // balances move with each payment
  "/api/grocery/normalize": 0, // deterministic: same input, same answer; no reason to poll
  "/api/grocery/ingredient": 0, // USDA snapshot is static; Open Food Facts records change rarely
  "/api/tx-guard": 300, // account age moves slowly; SDN is a bundled snapshot
  "/api/watch": 300, // agent decides; 5 min is a sane floor for page checks
  "/api/tokenized-stock": 300, // token state (supply, pause, multiplier) changes slowly
  "/api/tx-status": 5, // poll until final; the body also carries pollAgainSeconds per chain
};

function settleHeader(res: Response): string | null {
  return res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
}

/** Best-effort decode of the base64 JSON settle header; returns tx + network only. */
export function settleInfo(res: Response): { tx?: string; network?: string } {
  const h = settleHeader(res);
  if (!h) return {};
  try {
    const j = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as Record<string, unknown>;
    const tx = typeof j.transaction === "string" ? j.transaction : undefined;
    const network = typeof j.network === "string" ? j.network : undefined;
    return { tx, network };
  } catch {
    return {};
  }
}

export function withPaidCallMeta<T extends Response>(path: string, method: string, res: T): T {
  if (method === "HEAD" || res.status < 200 || res.status >= 300 || !settleHeader(res)) return res;
  const { tx, network } = settleInfo(res);
  console.log(JSON.stringify({ evt: "paid_call", route: path, rail: network ?? "unknown", tx: tx ?? null }));
  const n = POLL_INTERVAL_SECONDS[path];
  if (n) res.headers.set("x-hp-poll-interval-seconds", String(n));
  return res;
}
