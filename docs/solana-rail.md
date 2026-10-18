# Solana USDC rail — live on Solana mainnet

Status (checked 2026-10-14): **live in production.** Every paid HTTP route's 402 has
an `exact` USDC entry for `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, at the same atomic
amount as Base, with payTo `BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz`. Settlement goes
through PayAI (`https://facilitator.payai.network`). First settlement: an operator test
payment on 2026-10-08, tx `SmsCBJftu2yHL44VQZdzYziD4bBpxb6PWH66d2H5JD4XsbGqXXRvNS2x4xvdY7tooyw7uWoLkBXGyaUjZX86DVC`
(0.005 USDC, `GET /api/pulse`; a test, not customer activity).
The rail is still behind the switch and guards below. If any guard fails, routes fall
back to their non-Solana entries.

| surface | payment rails (live check 2026-10-14) |
|---|---|
| HTTP paid routes (`/api/*`) | Base, Solana, Polygon, XRPL (e.g. `GET /api/pulse` unpaid 402 lists `eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `eip155:137`, `xrpl:0`) |
| Hosted MCP (`/mcp`, all tools incl. `discourse_split`) and the local MCP client | **Base only** (`eip155:8453`; e.g. unpaid `discourse_split` call) |

Solana payment is HTTP only. The other networks are documented separately.

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
code change + owner approval; env can only turn the rail on/off.

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
- MCP (hosted `/mcp` and the local MCP client) and the human browser-402 copy are Base only.

## Guards added 2026-10-08 (internal review follow-up)
- **(b) Token-account guard.** The Solana entry is shown only while the payTo's USDC
  token account `3v95wKFDYRxegtZQYYeUzNnPrhogaCs9UpaR4QD7MzZu` exists (read-only
  `getAccountInfo`, jsonParsed; must be an initialized SPL-Token USDC account owned by
  the payTo). Result cached 10 min (present or absent; RPC error → absent, retry
  after 60 s), re-checked in the background, so it flips on by itself after the
  account is created — no redeploy.
  RPC: `HP_SOLANA_RPC_URL` (hardened, see fix 3), default `https://api.mainnet-beta.solana.com`.
  The pinned ATA constant is re-derived at init; mismatch → rail off.
- **(c) Rejection logging.** PayAI verify-invalid / settle-failed / throws are logged
  server-side as `[solana-rail] … reason=<code>` — **reason codes only** (R1, below);
  no PayAI free text, addresses, signatures, hex or base64. The client response follows
  the failure table below (definitive rejections → exactly main's Base-only 402).
- **(e) Bazaar.** `extensions.bazaar` is stripped from incoming Solana payloads before
  PayAI sees them; Solana-only routes carry no extensions and the PayAI wrapper reports
  `extensions: []`.
- **(f) Fee payer.** PayAI's advertised `extra.feePayer` must appear in PayAI's own
  live signer list (`signers["solana:*"]` / `signers[<network>]`) from the same HTTPS
  `/supported` response. Not listed, list missing, non-https URL, or fetch failure →
  fail closed (Base-only). The rail re-fetches `/supported` every 10 min.

## Review fixes (internal review 2026-10-08, PASS WITH FIXES)

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

**Ambiguous settle → on-chain check (v2 + delta 1, Odin 12:31 PM ET 10/18).** Before answering an ambiguous settle
(other than `duplicate_settlement`), a bounded (4 s) read-only search looks for OUR payment:
- **Binding (S2):** each candidate is fetched with `encoding:"base64"`. Its MESSAGE bytes must equal exactly the message
  we verified, and the signature in the buyer's slot must equal the buyer's signature in our payload. Candidates are
  PayAI's signature (only a lookup hint: accepted only once it passes that binding) plus the recent payTo-ATA history
  with slot > the start slot. The payer in PAYMENT-RESPONSE is the account key of the buyer's slot in OUR message.
- **Freshness by chain slot (S1):** `getSlot` (confirmed) is read at request start, in parallel with init, before verify
  and settle. Bound tx at slot > start slot → deliver (confirmed). Slot ≤ start slot → 409. Wall-clock block time is
  not used anywhere on the paid path.
- **No start slot (Odin 1:19 / 1:21):** getSlot is tried up to twice, all inside the init window (each try ≤ 1.5 s and
  ≤ what is left of initTimeoutMs). If both fail, the answer is **503** `{"error":"solana_rpc_unavailable"}` (fixed
  body, `Retry-After: 5`, `Cache-Control: no-store`) right after the rail-ready check: no PayAI verify or settle, no
  handler, no replay key, nothing charged. The same payload works on retry.
- **getSlot breaker (Odin 1:39 N1):** per instance, over PAID requests (each sample = both getSlot tries failed):
  - trips on **5 consecutive** no-slot requests, or on a **rate**: ≥ 25% of ≥ 20 paid requests in the last 60 s (a
    partial outage, e.g. every 3rd read failing, never makes 5 in a row). 60 s collects a sample on a busy instance and
    ages old failures out fast; below 20 samples one or two unlucky 503s would already be ≥ 25% (20 × 25% = 5, the
    same count as the consecutive trigger). A quiet instance never reaches 20, so the consecutive trigger covers it.
  - only requests whose payload PASSED validation count (Odin 2:12 F2 / Sentinel LOW-A), for both the streak and the
    rate window: the cheap local checks (decode, version, scheme, base64 size, wire parse + signer layout) run BEFORE
    getSlot and refuse junk with `invalid_payload` without any RPC call; the requirement checks run after init, and
    only then is the request's getSlot outcome counted. A good getSlot from an invalid request can still CLOSE an open
    breaker (recovery), but never resets the streak or adds a sample.
  - on trip: HIGH ALERT `solana_start_slot_unavailable {trigger: consecutive|rate, consecutive, failed, sample,
    windowMs, suppressedRetrips}`; Solana is treated as a confirmed absence: dropped from the unpaid 402, and a paid
    Solana request gets a 402 with `rail_unavailable` (instead of the 503) — nothing verified or charged.
  - alert cooldown (Odin 2:12 F3): a re-trip less than 15 min after the last alert re-opens the breaker as usual but
    sends no alert (logged, counted in the next alert's `suppressedRetrips`). Breaker behaviour is unchanged.
  - recovery = the next good getSlot: paid requests still read it (in parallel with init, no added latency), and the
    unpaid 402 path probes it at most once per 15 s per instance (single-flight, bounded by the init window). A good
    answer closes the breaker (the 402 that ran the probe already lists Solana), re-arms the alert, clears the window.
- **Parse before verify (Odin 1:39 N2):** the preflight refuses a transaction we cannot bind later (unparseable wire
  format, or no signed buyer slot) → 402 `invalid_payload` before PayAI. `ours` (message, buyer slot +
  signature, payer) is always known after it; the old "could not read our payment → serve" branch is gone.
- **Constant checks and fee payer before getSlot (Odin 2:32 (3)/(4), Sentinel residual + INFO-B):** the local preflight
  also checks the constant requirement fields (network = Solana mainnet, payTo = the pinned payTo, asset = the USDC
  mint, amount = the route price, maxTimeoutSeconds) and that the transaction's fee payer (account key 0) equals
  `accepted.extra.feePayer`, all before getSlot / init / PayAI. After init, `accepted.extra.feePayer` must equal the
  facilitator's (PayAI's) fee payer, so a tx naming any other fee payer is refused with `invalid_payload`.
- **Signer layout by index (Odin 2:12 F1):** exactly 2 required signers and 2 signature slots; slot 0 = account key 0
  = the fee payer, which the facilitator signs at settle, so it MUST be the all-zero placeholder in the buyer's
  payload (a non-zero slot 0 → `invalid_payload` before PayAI); slot 1 = key 1 = the buyer, which must be signed.
  The old "first non-zero slot" pick bound a client-filled fee-payer placeholder as the buyer: PayAI could settle while
  our binding never matched (charged, never delivered, 502/504).
- **Reject / unavailable 402 lists every healthy rail (Odin 2:13 (4), Sentinel INFO-3):** a Solana payment that is
  refused or cannot be served gets a 402 with Base plus XRPL and Polygon when enabled and ready (each appended exactly
  as on the unpaid 402, same payTo pins), with `PAYMENT-REQUIRED.error` = reason. XRPL is listed there only if it is
  already WARM on the instance (Odin 2:32 (2), LOW-1: rail built, payTo readiness known and not a confirmed absence,
  EVAL probe passed); that path never starts XRPL init, the readiness RPC or the EVAL probe, so its time margin holds. Solana itself (Odin 2:29 (b)
  delta6) is re-offered, via the unpaid 402's own builder, ONLY for a client-caused rejection (`invalid_payload`)
  while the getSlot breaker is closed and the rail is otherwise present (token account + rail ready); it stays out on
  `rail_unavailable`, an open breaker or an absent rail. The re-offer is driven by an internal flag (`reofferSolana`)
  that only OUR two local payload checks set (shared claim v3, Sentinel LOW): a facilitator reason passed through as
  `invalid_payload` (e.g. PayAI's verify) never re-offers Solana. A `rail_unavailable` with XRPL and Polygon off or not ready
  is byte-identical to the Base-only golden reject.
- **Duplicates (S1; widened by Odin 12:51 C1):** `duplicate_settlement`, ANY facilitator 409 (any reason, or a non-JSON
  409, which the SDK reports as `Facilitator settle failed (409)`), and any reason matching `/duplicate|already|in_flight/`
  (also on a 200 `success:false` without a signature, which used to be a terminal 402): never searched, never
  delivered: 502 + reconcile (`facilitator_duplicate`, or `duplicate_settlement` for that exact reason).
- **Failed on-chain:** the terminal Base-only 402 needs `meta.err` at confirmed AND at **finalized**. Otherwise 502/504.
- **Settle SUCCESS path (Odin 12:51 (b)):** the old N1 wall-clock check (30 s skew) on PayAI's signature is replaced
  by the same start-slot + binding search (same 4 s deadline; PayAI's signature is a hint):
  - bound OUR message, exact amount, slot > start slot → the paid response;
  - bound, slot ≤ start slot → 409 `duplicate_payment` (replay of a payment already served; nothing new charged);
  - PayAI's signature resolves to a tx that is NOT ours and ours is not in the recent history, or OUR tx failed →
    502 `settlement_unconfirmed` + reconcile (`settle_success_unbound` / `settle_success_failed_on_chain`), never a 402;
  - RPC down / not indexed within the deadline → paid response (fail open, as before: PayAI confirmed the settle);
    PAYMENT-RESPONSE is **rebuilt and marked unverified** (Odin 1:39 LOW-1): `{success, transaction: <PayAI's id>,
    network, payer: <buyer key of OUR message>, extensions: {settlementVerified: false, transactionSource: "facilitator"}}`
    (the tx id can only come from PayAI: the fee payer's slot-0 signature is not in the buyer's payload). Odin 2:13:
    the marker is under the spec's `extensions` (not `extra`), and PayAI's tx id is echoed only if it is a Solana
    signature (base58 decoding to exactly 64 bytes); otherwise `transaction` is omitted;
  - our tx confirmed → PAYMENT-RESPONSE is **always rebuilt** from the chain + OUR message (tx id = our bound tx,
    payer = buyer key of OUR message), whatever PayAI's header said (Odin 1:21, always since 1:39 LOW-1);
  - no start slot cannot reach this path (503 before PayAI). The old wall-clock fallback (`settledBeforeRequest`,
    `REPLAY_CONFIRM_SKEW_MS`) was removed.
- **Reconcile:** every 502/504/409 from this path (and every 502 from the success-path binding) raises a
  `solana_reconcile` ALERT through `setSolanaAlertHook` (default `[solana-rail][ALERT] {...}` console.error line;
  deduped per payment message, i.e. the full sha256 replay key, for 25 h: Odin 1:21 / 1:39 LOW-2) and logs (every occurrence) `[solana-rail] SOLANA_RECONCILE {status, reason, fp, payer, amount,
  asset, payTo, buyerSignature[, txid]}` (public chain data only) for manual refunds.
- **Time budget (corrected Odin 12:51 C2):** a cold token-account check makes up to 2 tries × init, so the worst case is
  2 × init + 10 + 12 + 4: 31 s by default (SOLANA_WORST_CASE_MS) and 40 s at the largest accepted init timeout
  (`HP_SOLANA_INIT_TIMEOUT_MS` is now clamped to SOLANA_MAX_INIT_TIMEOUT_MS = 7 s; SOLANA_MAX_WORST_CASE_MS). Every
  route whose import graph reaches lib/solana-rail.ts (route.ts and dark route.<flag>.ts) needs maxDuration ≥ 40 s + 20 s. route.inj.ts was raised
  30 → 60 s. /mcp (30 s) is exempt: its payment path is the Base-only @x402/mcp wrapper (tests/solana-time-budget.test.ts).

No PayAI text ever reaches the client (the SDK's own 502 `{"error":"<facilitator
message>"}` is never passed through). Server logs carry the reason code and, for an
unconfirmed settle, a 16-hex fingerprint of the payment key (`fp=`) for on-chain
reconciliation; PayAI response bodies, addresses, signatures and tx bytes are not
logged (R1 below). An unconfirmed settle is never answered with 402 because a 402 invites
the client to sign and pay again (double charge).

### Replay guard (fix 2)
- Key: sha256 of the Solana transaction **message** (signature slots excluded, so a
  re-encoded tx or a tampered placeholder fee-payer signature is the same payment).
- Checked **before verify**. States: `in_flight` → `settled` / `settle_unconfirmed` /
  `settle_failed`, kept for `REPLAY_TTL_MS` = **25 h** (≥ the 300 s
  `maxTimeoutSeconds`). Released (deleted) when nothing could have been charged:
  verify rejected/failed, or the handler failed before settle.
- In-memory, **per instance**. A fully global guard needs a shared store (e.g.
  KV) = an account → owner decision. Instead, a cheap cross-instance check
  (N1, below) catches replays that land on another instance.

**PayAI duplicate handling (from PayAI's own docs, read 2026-10-08):**
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
  local guard the same payment would unlock the route repeatedly (internal review probe:
  4×200, 4 handler runs, 4 settles). Hence the local guard and its 25 h retention.
  The reference `@x402/svm` facilitator does the same with an in-memory
  `SettlementCache` (`duplicate_settlement`).

## Re-review fixes (internal re-review 2026-10-08, PASS WITH 1 FIX)

### R1 — reason codes only in logs (required)
- Verify-invalid logs `reason=<invalidReason>`, settle-failed logs `reason=<errorReason>`,
  and the decide/402 path logs `error=<code>`, each **only if** the value matches
  `/^[a-z0-9_]+$/` (≤ 80 chars); anything else is logged as `unrecognized` (or omitted).
  `invalidMessage` / `errorMessage` are dropped (also removed from the objects handed
  back to x402 core).
- Thrown PayAI errors (`VerifyError`, `SettleError`, `FacilitatorResponseError`,
  `FacilitatorTimeoutError`, plain `Facilitator <op> failed (<status>): <excerpt>`) are
  re-thrown **scrubbed** (same class, no PayAI text) at the facilitator-wrapper
  boundary for `getSupported`, `verify` and `settle`. This also covers x402 core's own
  `console.warn("Failed to fetch supported kinds from facilitator: …")`, which
  previously printed the PayAI body excerpt. Only the SDK's fixed timeout text
  (`Facilitator <op> request timed out after <n>ms`) and `failed (<status>)` survive.
- Test: `tests/solana-rereview-fixes.test.ts` — "(R1) marker never logged — …" (19
  paths through the real `HTTPFacilitatorClient`: verify ×7, settle ×9, supported ×3)
  injects `PAYAI-FREETEXT-MARKER-Zq9` into every PayAI field/body and asserts it never
  appears in any `console.*` argument; plus "(R1) safeCode keeps only plain reason codes".

### N1 — cross-instance replay check (no new account)
- Superseded (Odin 12:51 (b) / 1:19): the block-time check with a 30 s skew is removed. A settle success is checked by
  the request-start slot plus the S2 binding (see "Settle SUCCESS path" above); no start slot → 503 before PayAI.
- Tests: tests/solana-ambiguous-settle.test.ts ("delta 2 … (b)", "delta 3 …") and "(N1) genuine payment → 200; getSlot
  was read BEFORE PayAI settle" in tests/solana-rereview-fixes.test.ts.

### N2 — tinypool override
- `package.json` `"overrides": {"tinypool": "^2.1.2"}` → tinypool 1.1.1 → **2.2.0**
  (lockfile change limited to tinypool). Full suite passes on it; `npm audit` no longer
  lists GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr. `@vitest/mocker` GHSA-82fw-gwwq-j7x9
  remains (needs a vitest major; dev-only, not shipped).
- Test: "(4/N2) vitest 3.2.7 + tinypool override >=2.1.2 …" in
  `tests/solana-review-fixes.test.ts`.

### N3 — parallel cold start
- On a cold instance the token-account check and the rail init (lazy import +
  PayAI `/supported`) run in **parallel** (`Promise.all`), so the first request waits
  for the slower of the two, not the sum. Consequence: with the flag on and the token
  account still absent, `/supported` is also fetched (read-only).
- Tests: "(N3) unpaid 402: PayAI /supported is fetched while the token-account RPC is
  still in flight", "(N3) paid path cold start: same parallel init, payment still settles".

### RPC override hardening (fix 3)
`HP_SOLANA_RPC_URL` is trimmed, parsed, and must be: https; no userinfo; not an IP
literal (any IPv4 form the URL parser normalises, or IPv6); not `localhost` /
`*.localhost`; default port; hostname exactly on `SOLANA_RPC_HOST_ALLOWLIST`
(`api.mainnet-beta.solana.com` only — a dedicated provider needs an account and
owner approval, then its hostname is added in code). Anything else → rail OFF
(misconfigured). The parsed, normalised URL is what is stored and fetched. The RPC
`fetch` uses `redirect: "error"`. Never logged.

### Should-fixes
- 4: `vitest` 3.2.4 → **3.2.7** (dev only; clears GHSA-5xrq-8626-4rwp). The tinypool
  advisories are cleared by the N2 override; @vitest/mocker GHSA-82fw-gwwq-j7x9 still
  listed (needs a vitest major), dev-only, not shipped.
- 6: token-account check, PayAI `/supported` (fee payer list) refresh and the
  allowance count are **stale-while-revalidate**: once warm, a 402 answers from
  cache and the refresh runs in the background (a failed refresh still fails
  closed for the following requests). Only the very first request on a cold
  instance waits, bounded by `HP_SOLANA_INIT_TIMEOUT_MS` (both checks in parallel, N3).
- 7: PayAI deadlines: verify **10 s**, settle **12 s** (was 30 s each). PayAI itself
  may hold `/settle` up to ~100 s; a timeout here is the ambiguous 504 above.
- 9: alerts go through `setSolanaAlertHook()` (default: one
  `console.error("[solana-rail][ALERT] {...}")` line, ready for a log-drain alert):
  - `warn_rate`: ≥ 20 `[solana-rail]` warnings within 5 min (at most one alert per window);
  - `payai_allowance`: on-chain count of transactions touching payTo's USDC account
    (read-only `getSignaturesForAddress`, background, every ~10 min) reaches **80% of
    the ~650 free settlements (520)** — an upper bound (the owner's own transfers
    count too), so it alerts early, never late; also fires immediately on a PayAI
    `free_tier_exhausted` settle error. Buying credits / a PayAI account is
    owner decision.

## Bazaar
CDP/Base stays the Bazaar-indexed entry: the `extensions.bazaar` block on every 402
is byte-identical to main with the flag on (tested), and the Solana/PayAI server never
declares Bazaar. **PayAI-facilitated Solana sales do NOT count toward the Coinbase
Bazaar settlement window.**

## Blockers (history) and current limitations
Resolved:
- ~~payTo has no USDC token account~~ **Resolved 2026-10-08.** The ATA
  `3v95wKFDYRxegtZQYYeUzNnPrhogaCs9UpaR4QD7MzZu` exists. It is an initialized SPL-Token
  USDC account owned by the payTo (public RPC `getAccountInfo`, re-checked 2026-10-14). The
  token-account guard stays in place.
- ~~Go-live review gate~~ **Resolved 2026-10-08.** The rail was reviewed and switched on, and the first
  operator test settlement landed the same day.
- The @x402/svm fixes that were tracked here affect `batch-settlement` only. This rail uses
  `exact`, so they never blocked it.

Still applies:
- **PayAI facilitator allowance:** 1,000 credits per receiving wallet (lifetime, about 650
  Solana settlements per PayAI docs). Past that, PayAI needs an API key with credits.
  The allowance alert above fires at 80%.
- **The replay guard is per instance.** The N1 cross-instance check closes most of the gap,
  except a replay on another instance within 30 s of confirmation.
- **No Coinbase Bazaar credit.** PayAI-facilitated Solana sales do not count
  toward the Coinbase Bazaar settlement window.
- **No Solana MCP.** Hosted `/mcp` (all tools, including `discourse_split`) and the local MCP client are Base only.

## Backlog / follow-ups

- **Per-IP limit on Solana-paid requests: DEFERRED (Odin 2:29 PM ET 10/18, decision (c)).** Sentinel LOW-A follow-up:
  delta5 (F2) stops junk headers from reaching getSlot and from tripping the breaker, but a caller who copies the
  public requirement can still send locally valid (not really signed) payloads that cost one getSlot each. A per-IP
  (hashed) rate limit on Solana-paid requests would cap that RPC spend. Not built; revisit if RPC quota or rate-limit
  errors show up, or with the next Solana hardening pass.

## Tests / smoke
- `npm test` (vitest): flag-off identity, flag-on shape, config/pin validation,
  isolation (unpaid + paid), SDK local verify (watch-only signer, no keys), internal-review
  guards (`tests/solana-guards.test.ts`), review fixes
  (`tests/solana-review-fixes.test.ts`) and re-review fixes
  (`tests/solana-rereview-fixes.test.ts`).
- No-money smoke: `next build`, `next start` with the flag on (no CDP keys), then
  `node scripts/smoke-solana-rail.mjs <base> <out.json>` and
  `SMOKE_FLAG_ON_JSON=<out.json> npx vitest run -c vitest.smoke.config.mts`
  (read-only PayAI `/supported` + mainnet RPC reads).

## Shared claim store (Odin 12:51 PM ET 10/18, item (d); v2 with redeem-on-retry, Odin 1:39 (3))

Modeled on the XRPL replay store (`lib/xrpl-replay-store.ts`, same `UpstashReplayStore` class and credentials:
`UPSTASH_REDIS_REST_*`, or `KV_REST_API_URL`/`KV_REST_API_TOKEN`; the read-only KV token is never read).
- **Keys:** `hp:solana:replay:<sha256 of the tx message>`, TTL REPLAY_TTL_MS (25 h). Values use the XRPL encoding,
  but the `@firstSeen` number is the first request's **start SLOT** (the freshness bound), and `@lease` is wall-clock ms:
  `in_flight@<startSlot>@<claimMs>`, `settle_unconfirmed@<startSlot>` (charged-or-unknown, NOT delivered),
  `redeeming@<startSlot>@<leaseMs>!<owner>`, `settled` (DELIVERED), `settle_failed`.
- **Claim:** atomic `SET NX PX` BEFORE verify. With a shared store, only `settled` / `settle_failed` are final in the
  local map (409); anything else goes to the shared slot. Held `settled` / `settle_failed` → 409 `duplicate_payment`.
  A store error → fail closed (Base-only 402, nothing charged).
- **Redeem on retry (Odin 1:39 (3), modeled on XRPL):** a held slot that is not delivered (`settle_unconfirmed`, an
  `in_flight` older than 90 s = a dead request, or a `redeeming` lease older than 90 s) is redeemed by the retry,
  ledger-only (no PayAI verify, no settle):
  - the exact stored value is read (`GET`) and swapped by CAS to an owner-tagged `redeeming` lease; losing the CAS, a
    live lease or a live `in_flight` → 503 `payment_in_progress` (Retry-After 5);
  - `findPaymentOnChain` with no PayAI hint: OUR message bytes AND the buyer signature from THIS payload must match a
    tx in the payTo ATA history at slot > the stored start slot, exact amount;
  - paid → the route runs, the slot goes to `settled` (CAS against our lease), the response carries PAYMENT-RESPONSE
    from the chain (tx id) + OUR message (payer);
  - failed on-chain (confirmed + finalized) → `settle_failed`, Base-only 402;
  - not visible / RPC down / route error / throw → back to `settle_unconfirmed@<startSlot>` (CAS against our lease),
    502 `settlement_unconfirmed` + reconcile `redeem_not_found`; a later retry can redeem;
  - a tx at or before the stored start slot is never a candidate (not delivered, stays undelivered for a human).
  - store error on GET / the lease CAS → fail closed (Base-only 402).
- **Tracking:** every local state write is mirrored to the shared store, and every release (nothing charged) does a
  `DEL`. Writes are awaited before the answer. A failed write is logged and the slot keeps its previous value (at
  worst `in_flight`, which blocks a second delivery; it never allows one).
- **Probe:** `EVAL "return 1"` plus the self-test on a random `hp:solana:selftest:replay-eval:<id>` key (60 s TTL),
  bounded at 3 s, in parallel with the token-account check and rail init, cached (ok 10 min / fail 60 s). A failure
  means fail closed: Solana is not advertised on the 402, paid Solana gets the Base-only 402, and one HIGH ALERT
  `solana_replay_eval_unavailable {reason}` fires per episode.
- **No shared store configured:** the per-instance map only, which is unchanged behaviour.
- **/status meta:** `<meta name="hp-solana-replay-eval" content="ok|unavailable|not_applicable">` (non-secret, like
  `hp-xrpl-replay-eval`): not_applicable when the Solana rail is off or no shared store is configured.
- **Ops:** a restricted Upstash token must cover `hp:solana:*`. Otherwise the probe fails and Solana goes dark
  (fail closed, HIGH alert).
