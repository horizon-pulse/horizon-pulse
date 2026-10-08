# Solana USDC rail (branch `solana-rail`) — OFF by default

Status: code + tests only. Not deployed. Go-live is gated on Odin's review.

## What it does
When ON, every paid route's 402 / OPTIONS gets a **second** `accepts` entry for
USDC on Solana mainnet, after the unchanged Base entry:

| field | Base entry (first, unchanged) | Solana entry (second) |
|---|---|---|
| scheme | `exact` | `exact` |
| network | `eip155:8453` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| amount | route price, atomic USDC | **same** atomic amount (both USDCs have 6 decimals) |
| asset | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Circle USDC mint) |
| payTo | `0x5b32c973596078a967562ca652761404f19be0e9` | `BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz` (pinned) |
| maxTimeoutSeconds | 300 | 300 |
| extra | `{name:"USD Coin",version:"2"}` | `{feePayer:<PayAI fee payer>}` |
| facilitator | CDP (Coinbase) — Bazaar + refunds | PayAI (`https://facilitator.payai.network`) — Solana only |

Schema of the Solana entry: `docs/solana-accepts.schema.json`.

## Switch
ON only when `HP_SOLANA_ENABLED` is exactly `true` **and** `HP_SOLANA_PAYTO` is
exactly the pinned `SOLANA_PAYTO` in `lib/solana-config.ts` (no trimming, no case
folding, no substitution) **and** the pinned address decodes as a 32-byte base58
pubkey. `HP_SOLANA_NETWORK`, if set, must be the mainnet CAIP-2. Anything else =
OFF = byte-identical to main (`tests/x402-flag-off.test.ts`, golden from clean
main fc7e5f6). Note: Solana base58 has no checksum, so an edited address can still
be "valid"; the exact pin is what stops it. Changing the payout address requires a
code change + Michael's passphrase; env can only turn the rail on/off.

## Isolation
- `@x402/svm` (2.27.0, same line as main's `@x402/core` 2.27.0) is lazy-imported only when ON.
- Separate x402ResourceServer whose only facilitator is PayAI, wrapped to
  v2 `exact` on Solana mainnet only, reporting **no extensions** (never declares Bazaar).
- Unpaid: any Solana failure (import, PayAI down/hang/missing kind, unexpected
  requirement) → exact Base-only 402 (init bounded by `HP_SOLANA_INIT_TIMEOUT_MS`,
  default 2500 ms; failure cached 60 s).
- Paid: only a v2 PAYMENT-SIGNATURE whose `accepted.network` starts with `solana:`
  goes to the Solana path; preflight (accepted == our requirement incl. payTo, mint,
  amount, feePayer; base64 tx ≤ 1232 bytes) runs before PayAI. Any rejection /
  verify or settle failure / throw → exact Base-only 402. Base payments never touch
  Solana code.
- MCP (`/mcp`) and the human browser-402 copy are unchanged (Base only).

## Bazaar
CDP/Base stays the Bazaar-indexed entry: the `extensions.bazaar` block on every 402
is byte-identical to main with the flag on (tested), and the Solana/PayAI server never
declares Bazaar. **PayAI-facilitated Solana sales do NOT count toward the Coinbase
Bazaar settlement window.**

## Known blockers before a Solana sale can succeed
1. **payTo has no USDC token account.** x402 `exact` on Solana pays via
   `TransferChecked` into the payTo's USDC associated token account
   `3v95wKFDYRxegtZQYYeUzNnPrhogaCs9UpaR4QD7MzZu`. On 2026-10-08 (read-only RPC)
   neither the payTo account nor that ATA exists. Standard x402 clients do not
   create it, and PayAI's simulation will fail until it exists. Creating it is an
   on-chain action (~0.002 SOL rent) on Michael's side — his call.
2. Odin's clock-row-11 gate on the @x402/svm fixes (see report). Those PRs touch
   the `batch-settlement` scheme only; this rail uses `exact`.
3. PayAI free allowance: 1,000 credits per receiving wallet (lifetime, ≈650 Solana
   settlements per PayAI docs); beyond that PayAI needs an API key/credits
   (= a PayAI account; Michael's decision).

## Tests / smoke
- `npm test` (vitest): flag-off identity, flag-on shape, config/pin validation,
  isolation (unpaid + paid), SDK local verify (watch-only signer, no keys).
- No-money smoke: `next build`, `next start` with the flag on (no CDP keys), then
  `node scripts/smoke-solana-rail.mjs <base> <out.json>` and
  `SMOKE_FLAG_ON_JSON=<out.json> npx vitest run -c vitest.smoke.config.mts`
  (read-only PayAI `/supported` + mainnet RPC reads).
