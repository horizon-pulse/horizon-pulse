# HOLD: launch-day copy (branch site/refresh-2026-10-07)

**Merge only when the Solana + EURC rails are live and Odin clears Class A.** Never merge or deploy before then. Do not cite any Vercel preview URL publicly.

Base batch stays "Coming soon" (HOLD until an npm @x402 release includes #3655).

## Launch-day claims and the proof each needs before merge
| # | Claim on the page | Where | Proof required before merge | Status 2026-10-07 |
|---|---|---|---|---|
| L1 | Batch pay on Solana is **Live** | home #rails | A live **Solana mainnet** batch deposit + voucher + settle tx (PayAI) on our route, plus the refund of unused balance tx; solana-batch-rail merged and deployed; #3661 shipped or PayAI confirmation in writing | NOT TRUE YET (testnet/devnet only; mainnet smoke on HOLD) |
| L2 | Solana batch "Listed in the 402" | home #rails | A production 402 from horizonpulse.dev whose `accepts` lists `batch-settlement` on Solana mainnet after Base `exact` | NOT TRUE YET |
| L3 | "unused balance is refunded" (Solana) | home #rails | A mainnet refund/withdraw tx back to the depositor | NOT TRUE YET |
| L4 | EURC at €0.01 is **Live** | home #rails | A live **Base mainnet** EURC settle of 10000 atomic (0x60a3…db42) via CDP to the production payTo; spike/eurc merged and deployed with EURC_ALLOW_MAINNET=1; working CDP hp-testnet key (Michael); Michael's final OK | NOT TRUE YET (Base Sepolia only: 0xdbe1ebab…333e) |
| L5 | EURC "listed after USDC" in the 402 | home #rails | Production 402 shows USDC first, EURC second, amount 10000 | NOT TRUE YET |
| L6 | "Your client opts in" (spendControls.allowedAssets) | home #rails | Already verified on testnet (spike/eurc); re-verify on mainnet with the L4 settle | Testnet ✔ |
| L7 | Batch pay on Base "Coming soon / not live" | home #rails | None (true today); no date promised | ✔ |
| L8 | {13} routes listed in the x402 Bazaar | hero + Payment tile | Re-run CDP merchant lookup `pagination.total` on launch day (claims register A2; 30-day delisting) | ✔ 13 at 2026-10-07 12:06 PM ET |
| L9 | Prices, 13 routes, CDP facilitator, USDC on Base | catalog | Already derived from lib/live-catalog.ts + openapi.json; re-check openapi matches on launch day | ✔ |
| L10 | /listing-fix $49/$99, 14-day credit, quote >25 routes, no calls | #services | shared-facts lines 9–10; page live at 092f554 | ✔ |
| L11 | Revenue/customers | — | Nothing on the page claims customers or revenue (claims register B1); testnet settles are never revenue | ✔ |

Also before merge: Odin Class A review; screenshots re-rendered; FX policy and EURC off-ramp decided (both UNDECIDED today).
