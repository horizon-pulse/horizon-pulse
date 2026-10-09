# Changelog

## 2026-10-09: `/api/pulse` field `overall.signal` renamed to `overall.direction`

- **Changed (response format):** `/api/pulse` no longer returns `overall.signal` (`buy` / `sell` / `hold`). It returns `overall.direction` (`up` / `down` / `flat`) instead.
- **Same computation:** the average 24h change of BTC, ETH and SOL is `up` at +2.5% or more (was `buy`), `down` at -2.5% or less (was `sell`), and `flat` otherwise (was `hold`). `overall.momentum`, `overall.sentiment`, `overall.avgChange24hPct` and the per-asset fields are unchanged.
- **Why:** "buy/sell/hold" reads as a trading recommendation. The field is a fixed rule on the 24h move, so it is now named and valued as a neutral description of the market, not a recommendation.
- **Naming note:** `momentum` was the planned name, but `overall.momentum` (`bullish` / `bearish` / `neutral`, ±1.5% threshold) already exists in the same object. To avoid a collision, the renamed field is `direction`.
- **Migration:** read `overall.direction` instead of `overall.signal`. Map `up` to the old `buy`, `down` to `sell`, and `flat` to `hold`.
- **Unchanged:** price, payTo, network, scheme and every other part of the 402 payment requirements.
- **Also in this release (description text only, no response change):** the `/api/portfolio` description now describes its output ("allocation flags (asset, stablecoin and chain weights vs fixed thresholds)") instead of "rebalance suggestions". The `/api/x402-check` description now says what is actually billed: any HTTP answer from the target, including 4xx/5xx, is a billed report; bad input, blocked hosts, connection failures and timeouts are not charged.
- **Wording (discovery text only):** the `/.well-known/x402` service description and the `/api/signals` Bazaar output label now say "technical indicators" instead of "technical signals". The route path `/api/signals` and the MACD `signal` line (the standard indicator name) are unchanged.

## 2026-10-09: `/api/portfolio` `suggestions` now holds findings only

- **Changed (response text):** each `suggestions[].message` is now a plain finding about the balances returned (for example "ETH weight 83.9% of USD value, at or above the 50% single-asset threshold."). The earlier messages contained allocation instructions (trim, raise, allocate, keep, swap, unwrap, "dry powder", "consider capping"); those are removed.
- **Unchanged:** the field name `suggestions`, its structure (`priority`, `code`, `message`), every `code` and `priority`, the thresholds (single-asset weight 35% / 50%, stablecoin share 15% / 85%, single-chain share 85%, native ETH under $5 with over $50 of other tracked tokens on that chain) and the risk score. The name `suggestions` is kept for format stability only.
- **Why:** the route describes a wallet; it does not recommend trades or allocations.
- `methodology.suggestions` now spells out the rule thresholds, and the `/api/portfolio` description says "rule findings" instead of "allocation flags".
