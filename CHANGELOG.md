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
