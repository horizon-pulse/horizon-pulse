# XRPL RLUSD rail (branch `rail-xrpl`) — OFF by default

Status: code + tests only. Not deployed, not pushed. Go-live is gated on Odin's review.
Built on main 6922193 (Solana rail live) following the same structure as `lib/solana-rail.ts`.
Rail decisions follow `oversight/streams/horizon-pulse/xrpl-rail-feasibility-2026-10-08.md`
(RLUSD only, CAIP-2 `xrpl:0`/`xrpl:1`, testnet first, Base first). Supersedes the earlier
scaffold branch `xrpl-rlusd-flag` (2cfcef0), which was ported, not merged.

## What it does
When ON **and the payTo is ready** (see guard below), every paid route's 402 / OPTIONS gets
one more `accepts` entry, appended **last**: after the unchanged Base entry, and after the
Solana entry when that rail is on too. `accepts[]` are alternatives: a client pays exactly one.

| field | Base entry (first, unchanged) | XRPL entry (last) |
|---|---|---|
| scheme | `exact` | `exact` |
| network | `eip155:8453` | `xrpl:1` (testnet, default) / `xrpl:0` (mainnet) |
| amount | route price, atomic USDC (`"5000"`) | same USD price as an RLUSD decimal value (`"0.005"`), integer string math |
| asset | USDC | `524C555344000000000000000000000000000000` (RLUSD 160-bit hex) |
| payTo | `0x5b32…e0e9` | `r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf` (pinned) |
| maxTimeoutSeconds | 300 | 300 |
| extra | `{name,version}` | `{issuer, areFeesSponsored:false}` (+ `assetTransferMethod` if set) |
| facilitator | CDP — Bazaar + refunds | x402.org (testnet) / named allow-listed facilitator (mainnet) — XRPL only |

RLUSD issuer: mainnet `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`, testnet `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`;
both pinned in `lib/xrpl-config.ts` and cross-checked against `@x402/xrpl@2.27.0` at init.
We never emit t54's `extra.sourceTag` and reject Memos (spec forbids them).

## Switch
ON only when `HP_XRPL_ENABLED` is exactly `true` **and** `HP_XRPL_PAYTO` is exactly the pinned
`XRPL_PAYTO` (no trimming / case folding / substitution) **and** the rest of the config is valid:

| var | default | rule |
|---|---|---|
| `HP_XRPL_NETWORK` | `xrpl:1` | exactly `xrpl:1` or `xrpl:0` |
| `HP_XRPL_FACILITATOR_URL` | testnet: `https://x402.org/facilitator`; mainnet: **none (required)** | exact member of `XRPL_FACILITATOR_ALLOWLIST[network]`: testnet x402.org / t54 testnet; mainnet `https://xrpl-facilitator-mainnet.t54.ai` only |
| `HP_XRPL_RPC_URL` | testnet `https://testnet.xrpl-labs.com/`, mainnet `https://xrplcluster.com/` | https, allow-listed host for that network, no userinfo / IP / localhost / port; `redirect: "error"` |
| `HP_XRPL_ASSET_TRANSFER_METHOD` | unset (clients use `sequence`) | `sequence` / `ticketSequence` |
| `HP_XRPL_INIT_TIMEOUT_MS` | 2500 | 1–30000 |

Anything else = OFF = byte-identical to main (`tests/xrpl-flag-off.test.ts`, same golden as the
Solana rail). The payTo comes only from the code constant; changing it needs a code change +
Michael's passphrase.

## payTo readiness guard (XRPL twin of the Solana token-account guard)
The XRPL entry is shown only while, on the configured network (validated ledger, read-only
`account_info` + `account_lines`):
- the payTo account exists (activated), and has neither `lsfRequireDestTag` nor `lsfDepositAuth`;
- it has an RLUSD trust line to the issuer with limit > 0, frozen by neither side.

Cached 10 min (RPC error: 60 s), re-checked in the background, so the entry appears by itself
once Michael activates the account and adds the trust line — no redeploy. **On 2026-10-08 the
payTo returns `actNotFound` on both mainnet (xrplcluster.com) and testnet (testnet.xrpl-labs.com),
so with the flag ON today every 402 is still byte-identical to main** (tested).

## Isolation
- `@x402/xrpl` (and `xrpl`) are lazy-imported only when ON; `lib/xrpl-config.ts` imports no XRPL package.
- Separate `x402ResourceServer` whose only facilitator is the XRPL one, wrapped to v2 `exact` on the
  configured `xrpl:N`, pinned payTo / RLUSD / issuer only, reporting **no extensions** (never
  declares Bazaar). Base keeps CDP as its only facilitator.
- Unpaid: any XRPL failure (import, constants mismatch, facilitator down/hang/missing kind,
  `areFeesSponsored != false`, unexpected SDK requirement, payTo not ready) → the 402 exactly as
  it was before the XRPL step (main's Base-only, or Base+Solana when Solana is on).
- Paid: only a v2 PAYMENT-SIGNATURE whose `accepted.network` starts with `xrpl:` goes to the XRPL
  path; a static spec preflight (envelope match incl. payTo/amount/asset/issuer, Payment type,
  Destination, no NetworkID, IOU amount/SendMax rules, no Paths/DeliverMin/Memos/Delegate/partial
  payment, LastLedgerSequence, sequence/ticket rules, blob ≤ 4096 bytes) and the replay guard run
  before the facilitator. `extensions.bazaar` is stripped. Base payments never touch XRPL code.
- MCP (`/mcp`), browser-402 copy and discovery docs are unchanged (no public XRPL copy; that is class A).

### Paid-path failure table (same as the Solana rail)
| phase | what happened | client gets |
|---|---|---|
| before facilitator | rail off / payTo not ready / preflight rejects | main's exact Base-only 402 |
| before facilitator | same payment slot already in flight / settled / unconfirmed / failed-settle | **409** `{"error":"duplicate_payment"}` |
| verify | invalid, throw, timeout, malformed | main's exact Base-only 402 |
| handler | throws → re-thrown (Next 500); returns ≥ 400 → that response, no settle | as on Base |
| settle, definitive | `success:false` / 4xx `SettleError`, no tx hash, terminal reason | main's exact Base-only 402 |
| settle, ambiguous | any of the two rows below, then the validated ledger (bounded `tx` lookup) shows the exact payment closed in this request | paid response + PAYMENT-RESPONSE (XRPL_RECONCILE status 200, `settle_unconfirmed_ledger_confirmed`) |
| settle, ambiguous | any of the two rows below, then the validated ledger shows the tx not tesSUCCESS (nothing moved) | main's exact Base-only 402 (`transaction_failed`) |
| settle, ambiguous | `FacilitatorTimeoutError` (20 s), ledger can't confirm either way | **504** `{"error":"settlement_unconfirmed","retry":"same_payment","message":…}` |
| settle, ambiguous | transport error, malformed, 5xx/429/409, `settlement_pending`, `duplicate_settlement`, `success:false` with a tx hash; ledger can't confirm either way | **502** `{"error":"settlement_unconfirmed","retry":"same_payment","message":…}` |
| settle | success, ledger re-read confirms (or can't confirm: funds moved per the validated settle → ALERT `xrpl_settled_unverified` + XRPL_RECONCILE status 200) | paid response + PAYMENT-RESPONSE |
| settle | success, but the validated ledger shows the tx not tesSUCCESS | main's exact Base-only 402 (`transaction_failed`) |

Logs carry reason codes only (`/^[a-z0-9_]+$/`), never facilitator free text, addresses or blobs.

### Replay guard
- **Delivered vs not delivered (2026-10-18):** `settled` = the paid response was delivered; a duplicate of a delivered payment is the only **409**. An ambiguous settle (or an error after settle) leaves `settle_unconfirmed@<firstSeenMs>` = NOT delivered. A retry of the same payment redeems it, ledger-only (never re-submitted): one request wins the atomic compare-and-set to `redeeming@<firstSeen>@<leaseStart>` (Upstash EVAL; lease 90 s, then takeover by CAS), reads the validated ledger for its blob hash, and delivers once if the exact payment closed to payTo at/after firstSeen (−30 s skew), then marks `settled`. Closed before firstSeen → 409 (not paid through our flow), validated not tesSUCCESS → Base-only 402, not visible → 502 again (still redeemable). Busy slot (in flight / live lease) → **503** `{"error":"payment_in_progress"}` + Retry-After 5. A slot whose tx failed → Base-only 402. Values hold timestamps only; TTL stays 25 h.
- **Delta 3 (Odin Class A 11:56 AM ET 10/18):**
  - **H1, stored submitted tx:** the claim writes `in_flight@<firstSeen>#<SUBMITTED_TX_HASH>:<LastLedgerSequence>` and every later slot value keeps `#hash:lls` (public ledger data). Redemption looks up ONLY the stored hash and runs the never-landed proof ONLY on the stored hash + LLS. A retry blob only locates the slot (Account + Sequence/Ticket). This reverses the 11:44 "no hash" call. A forged or re-signed retry can no longer fail the slot. A re-signed honest retry delivers the ORIGINAL tx if it landed, or gets the 402 once the ORIGINAL's LLS has passed without it. (Delta 4 F1: a retry with another hash must be master-key signed by the same Account; see below.) Values without a stored tx (legacy, or L1 below) → bare 502, manual reconcile.
  - **N1:** on settle success, a validated re-read that CONTRADICTS the payment (destination / issuer / amount / not a Payment / another payer) → **502** + HIGH ALERT, NOT delivered; slot undelivered (a retry re-checks the ledger). Only a missing/unreadable re-read still delivers (+ HIGH ALERT, field unreadable).
  - **M1:** an `in_flight` claim older than 90 s (XRPL_IN_FLIGHT_STALE_MS, > maxDuration 60 s) belongs to a dead request: a retry takes it over by CAS and redeems it ledger-only (deliver / 402 if provably never landed / 502). Younger, or bare legacy `in_flight` → 503.
  - **L1/N5:** after an ambiguous settle we look up OUR computed blob hash only. If the facilitator named a different hash → 502 (bare body) + HIGH ALERT `xrpl_settle_hash_mismatch`, not delivered, slot undelivered WITHOUT a stored tx (manual reconcile: neither auto-delivery nor a never-landed 402 is safe when the facilitator may have submitted another tx for the slot).
  - **N3:** a redemption lease and its delivered mark carry an owner nonce (`!<hex>`); the failure reset is one atomic Lua compare-and-set (casAny) against exactly our lease value or our own delivered mark.
  - **N4:** unknown close time: the first request (success / ambiguous) delivers with the shared store because its own SDK verify proved the slot unused when the request started; redemption requires a readable close time ≥ firstSeen − 30 s because the redeemer verified nothing itself (commented in code).
  - **L3:** the redeemable 5xx body says "retry within 24 hours" (replay TTL 25 h).
- **Delta 4 (Odin 12:07 PM ET 10/18):**
  - **F1, retry binding:** a retry may redeem a stored slot ONLY if (a) its blob hashes to the stored hash, or (b) it is a validly signed tx whose SigningPubKey derives to the same Account (master key) and whose signature verifies (xrpl `decode` / `deriveAddress` / `verifySignature`, offline). Anything else (unsigned, regular-key, multisig `Signers`, bad signature, undecodable) → bare **502**, slot untouched, nothing looked up. The check runs before any lease/CAS. Already-terminal answers (settled 409, settle_failed 402, young in_flight 503) do not change state and are given regardless. An honest master-key re-signer gets the ORIGINAL's delivery (or the 402 once the ORIGINAL's LLS passed).
  - **F2, settle-success hash:** on settle success, if the facilitator's hash differs from our blob hash → **502** (bare body) + HIGH ALERT `xrpl_settle_hash_mismatch` + XRPL_RECONCILE `settle_hash_mismatch`; slot undelivered WITHOUT a stored tx (manual reconcile). Only our own hash is ever looked up; no 402 / settle_failed is derived from the facilitator hash.
  - **N6, never landed ⇒ delete:** a proven never-landed result (first request or redemption, incl. M1 takeover) atomically deletes the slot with a Lua compare-and-delete (`CAS_DELETE_SCRIPT`: GET == expected → DEL) against exactly the value this request owns (its claim value, or its owner-tagged lease). Lost compare → slot left as is. Still a Base-only 402 for that request; a re-signed payment with the same Sequence then pays normally. Stores without casDelete leave the slot to expire (never settle_failed). Also closes Sentinel F3 (a forged stale proof can no longer fail a slot).
  - **Delta 5 (Odin 12:17, decision 2):** F1(b) also requires the master key to be ENABLED: one read-only `account_info` (ledger_index validated) for the Account, bounded by XRPL_MASTER_CHECK_DEADLINE_MS = 2 s. `lsfDisableMaster` set, rpc error, unvalidated / malformed answer, network failure or timeout → bare 502 `{"error":"settlement_unconfirmed"}`, slot untouched (no lease, no lookup, no handler). F1(a) exact-hash retries never read it. Redeem worst case (init + master check + lookup + never-landed proof = XRPL_REDEEM_WORST_CASE_MS 13.5 s) ≤ XRPL_WORST_CASE_MS (tested).
  - **C1:** a test derives every `route.ts` and dark-route `route.<flag>.ts` (route.audit.ts / route.pkg.ts / route.inj.ts; delta 5) under app/ whose import graph reaches lib/xrpl-rail.ts (32 today, 3 of them dark) and asserts each exports maxDuration < XRPL_IN_FLIGHT_STALE_MS (90 s) and < XRPL_REDEEM_LEASE_MS.
- **Retry with the same payment (2026-10-18, Odin 11:44 (b)):** every redeemable 502/504 body says so: `retry:"same_payment"` plus a message naming the PAYMENT-SIGNATURE header. (Superseded by delta 3 H1 / delta 4 F1: the submitted hash is stored; a re-signed blob locates the same slot and must pass F1.) (Not golden-pinned: the goldens cover 402s only. The testnet-only memory-store 502 and the legacy no-firstSeen 502 keep the bare `{"error":"settlement_unconfirmed"}`; they are not auto-redeemable.)
- **Provably never landed (Odin 11:44 (d)):** when the ledger can't see the tx (ambiguous settle, or a redeem retry), `ledger` (validated) is read first; if its index is > the tx's LastLedgerSequence and `tx` limited to [LLS−999, LLS] answers `txnNotFound` with `searched_all:true`, the tx can never land: the slot is DELETED (delta 4 N6: atomic owner/value-checked compare-and-delete, so the same Sequence can be re-signed and paid; this replaces the earlier settle_failed / decision-4 / case-E behaviour), Base-only 402 `transaction_failed` (XRPL_RECONCILE status 402). `settle_failed` now only means "failed on the validated ledger" (sequence consumed). Anything else (not past yet, node lacks the range, RPC down) stays 502/504. Bounded 2.5 s (XRPL_LLS_CHECK_DEADLINE_MS, included in XRPL_WORST_CASE_MS).
- **EVAL probe, fail closed (Odin 11:44 (e)):** cas needs Upstash EVAL. Each instance runs `EVAL "return 1" 0` on first use (402 or paid request; cached 10 min when ok, 60 s when failing; concurrent callers share one probe). Error / timeout / wrong answer → the XRPL rail is treated as confirmed absent on that instance (no XRPL in the 402; XRPL payments get the Base-only 402 `rail_unavailable` before anything is claimed) and HIGH ALERT `xrpl_replay_eval_unavailable` fires once per failure episode. Post-deploy smoke: `node scripts/smoke-xrpl-replay-eval.mjs https://horizonpulse.dev` reads the non-secret `<meta name="hp-xrpl-replay-eval" content="ok|unavailable|not_applicable">` on /status (3 reads, all must be `ok`); no secrets needed or shown.
- **Odin 12:28 (2), replay-store self-test:** the first-use probe now runs `EVAL "return 1" 0` and then a self-test on a throwaway key `hp:xrpl:selftest:replay-eval:<random 128-bit id>` (prefix `hp:xrpl:selftest:` since Odin 12:51, so a restricted Upstash token scoped to `hp:xrpl:*` covers it; disjoint from the replay keyspace `hp:xrpl:replay:`) with a random value and a 60 s TTL. No request input is used. The steps: `SET` → CAS_DELETE_SCRIPT with a WRONG value must answer 0, and `GET` must still return the value → CAS_DELETE_SCRIPT with the RIGHT value must answer 1, and `GET` must return nil. It shares the probe cache (ok 10 min / fail 60 s / single-flight) and the meta (`ok` only if EVAL and every step pass). It fails closed exactly like an EVAL failure, with the same HIGH alert `xrpl_replay_eval_unavailable` once per episode. New reason codes: `eval_result`, `selftest_set`, `selftest_wrong_value_deleted`, `selftest_value_changed`, `selftest_delete_failed`, `selftest_not_deleted`, `timeout`; transport errors keep the error kind. The whole probe is bounded at 3 s (XRPL_EVAL_PROBE_DEADLINE_MS) and runs in parallel with rail init (cap 5 s), so the worst case is unchanged. Instance races: a fully fixed key would race, because instance B's SET would overwrite A's value and A would report a spurious failure. So the key carries each probe's random id, and each probe only ever touches its own key. The random value + CAS also mean no delete can remove another value.
- **Request binding (hotfix, Odin 5:40 PM ET 10/18; Sentinel shared-claim-v3 F1 applied to XRPL):** the blob and its hash are public once the tx validates, so F1(a) alone let a chain watcher redeem a victim's undelivered payment on the watcher's OWN request (the victim's honest retry then got 409). Now the first use stores a **request fingerprint** in the slot (`…~<64 hex>`, `lib/request-fingerprint.ts`): sha256 over `hp-rq-v1`, METHOD, pathname (as received), the query normalized (every pair, decoded, stable-sorted by key only so a repeated key keeps its value order, re-encoded; **no parameter excluded**, `free` included: it only matters on unpaid requests, and payment data never travels in the query) and sha256(body). Headers and host are not bound. Every later write of the slot (undelivered, redeeming lease, delivered mark, reset) keeps it. A redeem (F1(a) blob OR F1(b) master-key re-sign) proceeds only if the retry's fingerprint is equal:
  - **mismatch** → **409** `duplicate_payment`, `XRPL_RECONCILE` status 409 reason `redeem_fingerprint_mismatch` on **every** mismatching request, **HIGH alert `xrpl_redeem_fingerprint_mismatch`** once per slot then not again for that slot for 15 min (`XRPL_FP_ALERT_COOLDOWN_MS`; delta1 C1: in-process, so per instance, not shared across instances); slot untouched, no lease, no lookup, no handler (the paying request can still redeem). Order (delta1 L1): the local blob/signature binding first (unbound → bare 502), then the fingerprint, and only then the F1(b) master-key `account_info` read, so a mismatching request spends no RPC.
  - **Buyer-facing rule** (also in `public/llms.txt`, Payment): to redeem, a retry must resend the identical URL (same path and query) and body with the same payment; reordered distinct query keys normalize away; reordered values of a repeated key, or anything else, make a different request.
  - **legacy slot** (no fingerprint: written before this change, e.g. by 39bf241) → never auto-redeemed: bare **502**, `XRPL_RECONCILE` status 502 reason `redeem_legacy_no_fingerprint`, slot untouched (manual reconcile, as H1's "no stored tx"). Fail safe: a legacy slot can't tell the payer's retry from a watcher's replay. Old code reading a new value (deploy overlap) parses it as unknown → 503 busy, never a delivery.
  - **Limitation:** a request with no query and no body fingerprints to METHOD + path only, which a watcher can guess; the binding then guarantees only that the delivery is the same resource the payment bought (the victim's retry would still get 409). Payer authentication on redeem would close that; not in this hotfix (backlog item below).
- **Backlog (Odin 5:57 / 6:00 PM ET 10/18): required before the premium ladder ships:** routes priced **$1 or more** need **payer proof on redeem** (F1(b) master-key re-sign only, no same-blob auto-redeem) on **both rails** (XRPL and Solana). Docs only; not implemented. Tracked in `docs/solana-rail.md` → Backlog / follow-ups.
- **Odin 12:28 (1):** F1 rejections (unsigned / regular-key / multisig / bad signature / undecodable) answer the BARE `502 {"error":"settlement_unconfirmed"}`, not the redeemable body. Status, slot untouched, no lookup and no handler are unchanged.
- ALERT `xrpl_settled_unverified` is HIGH severity (`[ALERT][HIGH]`) with `field` = destination / issuer / amount / unreadable / transaction. Since delta 3 only `unreadable` is delivered; the other fields are 502 (N1).
- Key: sha256 of (network, payer `Account`, `Sequence` or `TicketSequence`) decoded from the blob —
  the slot only one transaction can ever consume, so a re-signed / re-fee'd variant is the same
  payment. Checked before verify; kept 25 h; released when nothing could have been charged.
- Per instance (a global guard needs a shared store = an account → Michael's decision). Cross-instance:
  after a successful settle, read-only `tx` gives the ledger close time; closed before this request
  started (− 30 s skew) → 409. RPC error / not validated → fail open (serve the paid response).
- The spec makes facilitator-side dedup REQUIRED; with `sequence`, a settled payment also fails
  re-verification on any instance (sequence consumed).

## Tests (`npm test`)
- `tests/xrpl-flag-off.test.ts`: 25 OFF env variants byte-identical to the golden; @x402/xrpl never
  loaded, no XRPL facilitator/RPC call; flag ON with today's unactivated payTo still byte-identical;
  no static XRPL import.
- `tests/xrpl-flag-on.test.ts`: Base first + byte-identical, RLUSD last with exact fields on all 82
  route/method/mode captures (testnet, mainnet, ticketSequence, and Base→Solana→XRPL with both rails
  on); Bazaar extensions + discovery docs unchanged; facilitator only asked `/supported` once.
- `tests/xrpl-isolation.test.ts`: unpaid failures (import, ctor, constants, tampered requirement,
  facilitator down/hang/missing kind/sponsored fees, 8 not-ready payTo states, Solana-on composition),
  readiness flips on without redeploy; paid failure table, preflight rejections, replay guard,
  cross-instance check, no facilitator text in body or logs, warn-rate alert.
- `tests/xrpl-wire-format.test.ts`: spec preflight accepts/rejects; replay-key semantics.
- `tests/xrpl-config.test.ts`: flag/pin/network/allow-list/RPC hardening, address validation vs
  xrpl.js, price conversion, constants vs the package.
Tx blobs in tests are binary-encoded but **unsigned**; payer addresses come from filler bytes. No key,
wallet, faucet, or network call is involved.

## Before this can be enabled (none of it is done; each is Michael's / Odin's call)
1. **Activate the payTo** `r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf` (≥ 1 XRP reserve; ~1.2 XRP so the trust
   line fits) and add the **RLUSD trust line** to `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` — Michael's own
   Ledger actions (Ledger Live can't do trust lines; XRP Toolkit per feasibility doc). Nothing here does it.
2. **Testnet run first** (feasibility doc): the pinned payTo must exist on testnet too for the entry to
   show there; a testnet payer wallet is a new key → Michael's OK.
3. **Mainnet facilitator choice** for `HP_XRPL_FACILITATOR_URL` (t54 hosted is the only allow-listed
   mainnet URL; t54 interop with `@x402/xrpl` is unproven; no SLA; self-hosting needs a KV account).
4. **Long-running routes vs `sequence`** (fetch/extract/screenshot/search/pdf): the spec says such servers
   SHOULD require `ticketSequence`; default here is unset (clients use `sequence`) → Odin/Michael policy.
5. XRPL settles don't index or refresh CDP Bazaar; XRPL receipts are unscreened (no OFAC/KYT); RLUSD
   issuer can freeze/claw back.

## 2026-10-12 testnet build (branch `xrpl-testnet`, Odin plan PASS + 4 fixes)

- **Per-network pinning.** `xrpl:0` ⇒ mainnet RLUSD issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` + payTo `r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf`.
  `xrpl:1` ⇒ testnet issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` + throwaway testnet payTo `rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ`.
  Any other mix is refused at config, at requirement build, and in the facilitator wrapper (`tests/xrpl-pairing.test.ts`).
- **canonicalNetwork.** Fixed XRPL table (`xrpl:0/1/2` + aliases). Any other xrpl-ish value is `unrecognized network` (`tests/market-xrpl-network.test.ts`).
- **Replay store.** `lib/xrpl-replay-store.ts`: atomic claim before verify. Upstash REST (`SET NX PX`) when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set, else per-instance memory. A claim error fails closed.
- **Testnet proof.** `/api/market/quote` was paid end-to-end via x402.org on `xrpl:1`. Replaying the same signature got 409 `duplicate_payment`.
- **Flag.** `HP_XRPL_ENABLED` stays unset in every Vercel env. The rail is OFF and every 402 is byte-identical to main.

## Mainnet finish (2026-10-12, branch xrpl-replay-store)

- xrpl:0 fails closed unless UPSTASH_REDIS_REST_URL (https) and UPSTASH_REDIS_REST_TOKEN are set (config) and the active replay store is Upstash (runtime). Memory store = testnet only.
- Validated-tx lookup after settle retries with bounded backoff (0/400/800/1300 ms, 5 s hard deadline).
- Settled payments are self-verified on the validated ledger: tesSUCCESS, Payment, Destination = payTo, no DestinationTag, meta.delivered_amount exactly the RLUSD amount from the pinned issuer. Never a 5xx after funds moved (2026-10-18): a settle success means the in-process facilitator saw the tx validated tesSUCCESS, so an unverifiable or mismatched re-read (lagging node, txnNotFound, timeout) still serves the paid response, with ALERT `xrpl_settled_unverified` and an XRPL_RECONCILE line (status 200). Only a validated answer showing the tx not tesSUCCESS (nothing moved) withholds it (Base-only 402). Testnet: checked when meta is present.

### Reconcile runbook (XRPL_RECONCILE)

Every 502/504 `settlement_unconfirmed`, and every paid response delivered without a clean ledger confirmation (status 200: `self_check_*` or `settle_unconfirmed_ledger_confirmed`), writes one log line tagged `XRPL_RECONCILE` with a JSON record: `at` (ISO), `status`, `reason`, `txHash` (settled hash, else the hash computed from the signed blob), `network`, `route`, `payer`, `slot` (sequence:N / ticket:N), `required` {currency, issuer, value} and `delivered` (delivered_amount seen, or null). To reconcile: grep the Vercel logs for `XRPL_RECONCILE`, then look up `txHash` on the ledger (`tx` on xrplcluster.com, or any explorer). If it is not found or not tesSUCCESS after its LastLedgerSequence has passed, nothing was charged: no action (the replay slot expires after 25 h). If it is validated tesSUCCESS and `delivered_amount` equals `required`, the payer paid without getting the response: refund the exact amount to `payer` from the payTo (Michael's Ledger, his action) or deliver the response for `route` manually. If the amount delivered differs, refund what arrived. Status-200 lines were already delivered: only check that the payment is on the ledger (if `self_check_*` and the tx is NOT validated tesSUCCESS to payTo, the response was given without payment: log it, no buyer action). Log each case in the push-log.
