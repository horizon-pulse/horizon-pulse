# Solana mainnet batch smoke: checklist (PREP ONLY, not run)

Script: `scripts/solana-mainnet-smoke.mts` (refuses to run unless every gate env + `--execute` is set).
Cap: deposit ≤ 0.10 USDC, 3 calls at /api/pulse's per-call price ($0.005). It's a TEST payment: excluded from revenue, buyer and call counts.

Each item needs its own tick. Funding items need **Michael's per-item OK**.

- [ ] S1. **Ledger address:** Michael sends his Ledger Solana address and confirms it with his passphrase. Set it as `SOLANA_BATCH_PAY_TO` (env only, never in git).
- [ ] S2. **Receiving USDC account (ATA):** create the USDC ATA for the Ledger address (one-time SOL rent; PayAI won't create it). *Funding item: Michael OK.* Amount: rent shown by the wallet at the time (not quoted here).
- [ ] S3. **Server keys:** operator + receiverAuthorizer signers, created under Michael's passphrase process and stored as server secrets. Not throwaway; they must be kept until every channel drains.
- [ ] S4. **Buyer wallet:** a test buyer funded with ≤ 0.11 USDC (0.10 deposit + margin) and no SOL needed (PayAI sponsors channel fees, per its docs). *Funding item: Michael OK.* Excluded from all counts.
- [ ] S5. **PayAI check (same day):** `GET https://facilitator.payai.network/supported` still lists `batch-settlement` on `solana:5eykt4…`, with admission not paused and `minInitialDeposit` ≤ 100000.
- [ ] S6. **Redis:** local or durable Redis reachable as `SOLANA_BATCH_REDIS_URL`; backup taken before the run.
- [ ] S7. **Odin Class A** sign-off reference set as `SOLANA_SMOKE_CLASS_A`; push-log entry opened.
- [ ] S8. **Michael's run OK** recorded as `SOLANA_SMOKE_APPROVAL`.
- [ ] S9. Run once. On any failure: stop, no retry without a new OK, and report.
- [ ] S10. Verify: payTo ATA USDC delta on-chain = charged total; buyer refund of the unused deposit (cooperative refund or after withdrawDelay); all tx hashes in the push-log; channel closed and rent reclaimed.
- [ ] S11. Bookkeeping: Solana counted separately from Base; this smoke is TEST (not revenue, not a buyer).
