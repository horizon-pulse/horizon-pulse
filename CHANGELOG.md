# Changelog

## BREAKING (response field): /api/pulse overall.signal removed, replaced by overall.direction

- **Breaking:** `/api/pulse` responses no longer contain `overall.signal`. Clients that read it must switch to `overall.direction`. Nothing else in the response shape changed.
- **New field:** `overall.direction` is one of `up` / `down` / `flat` (OpenAPI enum).
- **Same computation:** the average 24h change of BTC, ETH and SOL is `up` at +2.5% or more (was `buy`), `down` at -2.5% or less (was `sell`), and `flat` otherwise (was `hold`). `overall.momentum`, `overall.sentiment`, `overall.avgChange24hPct` and the per-asset fields are unchanged.
- **Why:** "buy/sell/hold" reads as a trading recommendation. The field is a fixed rule on the 24h move, so it is now named and valued as a neutral description of the market, not a recommendation.
- **Naming note:** `overall.momentum` (`bullish` / `bearish` / `neutral`, ±1.5% threshold) already exists in the same object, so the renamed field is `direction` rather than `momentum`.
- **Migration:** read `overall.direction` instead of `overall.signal`; `up` = old `buy`, `down` = old `sell`, `flat` = old `hold`.
- **Unchanged:** price, payTo, network, scheme and every other part of the 402 payment requirements.

## 2026-10-09: `/api/portfolio` `suggestions` now holds rule findings only

- **Changed (response text, not shape):** each `suggestions[].message` is now a plain finding about the balances returned, for example "ETH weight 83.9% of USD value, at or above the 50% single-asset threshold." The earlier messages contained allocation instructions (trim, raise, allocate, keep, swap, unwrap, "dry powder", "consider capping"); those are removed.
- **Unchanged:** the field name `suggestions`, its structure (`priority`, `code`, `message`), every `code` and `priority`, the thresholds (single-asset weight 35% / 50%, stablecoin share 15% / 85%, single-chain share 85%, native ETH under $5 with over $50 of other tracked tokens on that chain) and the risk score. The name `suggestions` is kept for format stability only.
- **Descriptions:** the route description, catalog summary and OpenAPI summary now say "rule findings vs fixed thresholds" instead of "rebalance suggestions". `methodology.suggestions` spells out the thresholds.
- **Why:** the route describes a wallet; it does not recommend trades or allocations.

## 2026-10-09: description text only (no response change)

- **`/api/x402-check`:** the description now says what is actually billed: any HTTP answer from the target, including 4xx/5xx, is a billed report; bad input, blocked hosts, connection failures and timeouts are not charged. It previously said "Errors are not charged".
- **`/.well-known/x402`:** the service description says "technical indicators" instead of "technical signals". The route path `/api/signals` and the MACD `signal` line (the standard indicator name) are unchanged.
