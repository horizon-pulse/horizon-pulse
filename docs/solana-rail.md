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
  requirement) → exact Base-only 402 (cold init bounded by `HP_SOLANA_INIT_TIMEOUT_MS`,
  default 2500 ms; failure cached 60 s; once warm, refreshes run in the background).
- Paid: only a v2 PAYMENT-SIGNATURE whose `accepted.network` starts with `solana:`
  goes to the Solana path; preflight (accepted == our requirement incl. payTo, mint,
  amount, feePayer; base64 tx ≤ 1232 bytes) and the replay guard run before PayAI.
  What the client gets is in the failure table below — in short: anything that
  fails **before money can move** → exact Base-only 402; a settle whose outcome is
  **unknown** → generic 502/504 `settlement_unconfirmed`, **never** a 402. Base
  payments never touch Solana code.
- MCP (`/mcp`) and the human browser-402 copy are unchanged (Base only).

## Guards added 2026-10-08 (Odin review follow-up)
- **(b) Token-account guard.** The Solana entry is shown only while the payTo's USDC
  token account `3v95wKFDYRxegtZQYYeUzNnPrhogaCs9UpaR4QD7MzZu` exists (read-only
  `getAccountInfo`, jsonParsed; must be an initialized SPL-Token USDC account owned by
  the payTo). Result cached 10 min (present or absent; RPC error → absent, retry
  after 60 s), re-checked in the background, so it flips on by itself after the
  account is created — no redeploy.
  RPC: `HP_SOLANA_RPC_URL` (hardened, see fix 3), default `https://api.mainnet-beta.solana.com`.
  The pinned ATA constant is re-derived at init; mismatch → rail off.
- **(c) Rejection logging.** PayAI verify-invalid / settle-failed / throws are logged
  server-side as `[solana-rail] … reason=<code>` with addresses, signatures, hex and
  base64 redacted (PayAI response bodies are not logged). The client response follows
  the failure table below (definitive rejections → exactly main's Base-only 402).
- **(e) Bazaar.** `extensions.bazaar` is stripped from incoming Solana payloads before
  PayAI sees them; Solana-only routes carry no extensions and the PayAI wrapper reports
  `extensions: []`.
- **(f) Fee payer.** PayAI's advertised `extra.feePayer` must appear in PayAI's own
  live signer list (`signers["solana:*"]` / `signers[<network>]`) from the same HTTPS
  `/supported` response. Not listed, list missing, non-https URL, or fetch failure →
  fail closed (Base-only). The rail re-fetches `/supported` every 10 min.

## Review fixes (Odin code review 2026-10-08, PASS WITH FIXES)

### Paid-path failure table (fix 1 + should-fix 8)
| phase | what happened | client gets |
|---|---|---|
| before PayAI | rail off / token account absent / preflight rejects | main's exact Base-only 402 |
| before PayAI | same payment (tx message) already in flight / settled / unconfirmed / failed-settle | **409** `{"error":"duplicate_payment"}` (no PAYMENT-REQUIRED) |
| verify (nothing charged) | `isValid:false`, any throw, `FacilitatorTimeoutError`, `FacilitatorResponseError` (malformed/invalid JSON), wrapper refusal | main's exact Base-only 402 |
| handler | route handler throws | re-thrown → Next.js 500, exactly like the Base path; nothing settled |
| handler | route returns ≥ 400 | that response, unchanged (no settle), as on Base |
| settle, **definitive** | `success:false` (or 4xx `SettleError`) with no tx signature and a terminal reason (e.g. `transaction_failed`, simulation failed, `free_tier_exhausted`) | main's exact Base-only 402 |
| settle, **ambiguous** | `FacilitatorTimeoutError` (12 s) | **504** `{"error":"settlement_unconfirmed"}` |
| settle, **ambiguous** | malformed response, transport error (`fetch failed`), `SettleError` 5xx/429/409, `settlement_pending`, `duplicate_settlement`, or `success:false` carrying a tx signature | **502** `{"error":"settlement_unconfirmed"}` |
| settle | success | the paid response + PAYMENT-RESPONSE |

No PayAI text ever reaches the client (the SDK's own 502 `{"error":"<facilitator
message>"}` is never passed through). Server logs carry the reason code and, for an
unconfirmed settle, a 16-hex fingerprint of the payment key (`fp=`) for on-chain
reconciliation; PayAI response bodies, addresses, signatures and tx bytes are not
logged. An unconfirmed settle is never answered with 402 because a 402 invites
the client to sign and pay again (double charge).

### Replay guard (fix 2)
- Key: sha256 of the Solana transaction **message** (signature slots excluded, so a
  re-encoded tx or a tampered placeholder fee-payer signature is the same payment).
- Checked **before verify**. States: `in_flight` → `settled` / `settle_unconfirmed` /
  `settle_failed`, kept for `REPLAY_TTL_MS` = **25 h** (≥ the 300 s
  `maxTimeoutSeconds`). Released (deleted) when nothing could have been charged:
  verify rejected/failed, or the handler failed before settle.
- In-memory, **per instance**. On a multi-instance deploy a replay that lands on a
  different instance is not caught locally (see PayAI behaviour below). A global
  guard needs a shared store (e.g. KV) = an account → Michael's decision.

**PayAI duplicate handling (from PayAI's own docs, read 2026-10-08;
copies in hp-tests/solana-rail-20261008/payai-*.2026-10-08.*):**
- `facilitator.payai.network/developers.md`: "`POST /settle` … Idempotent:
  re-submitting an identical body returns the original outcome rather than paying
  twice." "Terminal responses are retained for 24 hours, and signed-payload
  idempotency protects every settlement whether or not the header is present."
  `settlement_pending`, `duplicate_settlement`, 429 and 5xx are never cached.
  Optional `Idempotency-Key` header (24 h binding; concurrent same-body → 409).
- `docs.payai.network/x402/facilitators/capacity-and-limits`: a concurrent
  duplicate returns **409 `duplicate_settlement`** ("already in flight or has a
  replay marker"); `/settle` waits up to ~100 s for the on-chain outcome and then
  answers `settlement_pending`; "HTTP 200 is not proof of successful payment"
  (`success:false` may be pending).
- Consequence: PayAI will never move the money twice, but it **will report the
  original success again** for a replayed identical payload for 24 h — so without a
  local guard the same payment would unlock the route repeatedly (Odin probe P5:
  4×200, 4 handler runs, 4 settles). Hence the local guard and its 25 h retention.
  The reference `@x402/svm` facilitator does the same with an in-memory
  `SettlementCache` (`duplicate_settlement`).

### RPC override hardening (fix 3)
`HP_SOLANA_RPC_URL` is trimmed, parsed, and must be: https; no userinfo; not an IP
literal (any IPv4 form the URL parser normalises, or IPv6); not `localhost` /
`*.localhost`; default port; hostname exactly on `SOLANA_RPC_HOST_ALLOWLIST`
(`api.mainnet-beta.solana.com` only — a dedicated provider needs an account and
Michael's approval, then its hostname is added in code). Anything else → rail OFF
(misconfigured). The parsed, normalised URL is what is stored and fetched. The RPC
`fetch` uses `redirect: "error"`. Never logged.

### Should-fixes
- 4: `vitest` 3.2.4 → **3.2.7** (dev only; clears GHSA-5xrq-8626-4rwp). `npm audit`
  still lists tinypool GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr and @vitest/mocker
  GHSA-82fw-gwwq-j7x9: only fixed in vitest 5.x (major), dev-only, not shipped.
- 6: token-account check, PayAI `/supported` (fee payer list) refresh and the
  allowance count are **stale-while-revalidate**: once warm, a 402 answers from
  cache and the refresh runs in the background (a failed refresh still fails
  closed for the following requests). Only the very first request on a cold
  instance waits, bounded by `HP_SOLANA_INIT_TIMEOUT_MS`.
- 7: PayAI deadlines: verify **10 s**, settle **12 s** (was 30 s each). PayAI itself
  may hold `/settle` up to ~100 s; a timeout here is the ambiguous 504 above.
- 9: alerts go through `setSolanaAlertHook()` (default: one
  `console.error("[solana-rail][ALERT] {...}")` line, ready for a log-drain alert):
  - `warn_rate`: ≥ 20 `[solana-rail]` warnings within 5 min (at most one alert per window);
  - `payai_allowance`: on-chain count of transactions touching payTo's USDC account
    (read-only `getSignaturesForAddress`, background, every ~10 min) reaches **80% of
    the ~650 free settlements (520)** — an upper bound (Michael's own transfers
    count too), so it alerts early, never late; also fires immediately on a PayAI
    `free_tier_exhausted` settle error. Buying credits / a PayAI account is
    Michael's decision.

## Bazaar
CDP/Base stays the Bazaar-indexed entry: the `extensions.bazaar` block on every 402
is byte-identical to main with the flag on (tested), and the Solana/PayAI server never
declares Bazaar. **PayAI-facilitated Solana sales do NOT count toward the Coinbase
Bazaar settlement window.**

## Known blockers before a Solana sale can succeed
1. **payTo has no USDC token account** (the guard above keeps the rail Base-only until it exists). x402 `exact` on Solana pays via
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
  isolation (unpaid + paid), SDK local verify (watch-only signer, no keys), Odin
  guards (`tests/solana-guards.test.ts`) and review fixes
  (`tests/solana-review-fixes.test.ts`).
- No-money smoke: `next build`, `next start` with the flag on (no CDP keys), then
  `node scripts/smoke-solana-rail.mjs <base> <out.json>` and
  `SMOKE_FLAG_ON_JSON=<out.json> npx vitest run -c vitest.smoke.config.mts`
  (read-only PayAI `/supported` + mainnet RPC reads).
