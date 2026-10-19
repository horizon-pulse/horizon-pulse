# Premium manual refund runbook (spec v3 §4)

Applies to every premium reconcile line (`[premium][RECONCILE]` log line / `hp:premium:reconcile:YYYY-MM` in Upstash,
kept at most 12 months): outcomes `settle_timeout` (504), `settle_ambiguous` (502), `authorization_already_used` (409).
Base has no redeem-on-retry: nothing is ever re-delivered against an earlier settle or a replayed authorization.

1. **Find the reconcile line** by `reconcile_id` (the buyer has it in the 504/502/409 body) or by payer + nonce.
2. **Confirm on-chain** whether the transfer landed: BaseScan for `tx` (if known) or a USDC `Transfer` from `payer`
   to the line-8 payTo for `amount`; and USDC `authorizationState(payer, nonce)` (true = used).
3. **If charged and not delivered:** prepare a refund of the exact `amount` to the `from` address **as read from the
   on-chain transfer** (full string from chain, never from the reconcile line or an email).
4. **Refunds are Michael's money call.** Pulse drafts amount, address, reason and reconcile_id; Michael approves and
   sends. No agent, script or cron sends a refund.
5. **Log** a `REFUND` line (reconcile_id, amount, to, tx) and report the tx to Odin.

A 409 replay: the real payer (the on-chain `from`) gets the result only by paying a new request; the earlier charge
is refunded at Michael's call. Watch refunds follow the published watch terms (full if no first report; pro rata
price × undelivered days ÷ 30 after 3+ missed days or an early stop; no auto-renewal). Public refund line and
contact: lib/premium/copy.ts (`REFUND_LINE`, `PREMIUM_CONTACT`).
