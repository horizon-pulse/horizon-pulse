# Changelog

## 2026-10-13: HEAD is never charged; bazaar-check labels Polygon and XRPL

- **Fixed:** a HEAD request to a paid route now returns the same 402 as GET, byte for byte (the PAYMENT-REQUIRED header, including the bazaar method, which is GET). A HEAD that carries a payment header (PAYMENT-SIGNATURE or X-PAYMENT) is served as that unpaid 402: no verify, no settle, on any rail. Before, a paid HEAD could settle and return no body.
- **Changed (`/api/bazaar-check` response values):** `networkLabel` now returns `polygon` for `eip155:137` and `xrpl` for `xrpl:0`. Before, these two networks came back as their raw CAIP-2 ids. Clients matching on `eip155:137` / `xrpl:0` in label fields should also accept `polygon` / `xrpl`. Other networks are unchanged.
- **New (additive):** bazaar-check `summary.indexedOnPolygon` / `summary.indexedOnXrpl`, read-only Polygon USDC and XRPL RLUSD on-chain checks, and a methodology line: on XRPL, `holdsUsdc` means the payTo holds RLUSD.
- **Docs:** llms.txt documents the PAYMENT-RESPONSE receipt (tx hash, network, payer) and that HEAD is never charged; the MCP `market_search` rail parameter lists base|solana|xrpl|evm|polygon|<CAIP-2>.
- **Unchanged:** prices, payTo and the GET 402 bytes on every route.

## 2026-10-12 (branch market-mvp, not deployed): agent marketplace MVP, two new paid routes

- **New:** `GET /api/market/search` ($0.005, untested price): x402 offers from CDP Bazaar discovery (plus our own catalog, no boost), ranked by relevance, the index's order, a live re-check, recency and distinct payers. No paid placement, no featured listings. The top 3 are re-checked live with one unpaid request each, and their live payTo is cross-checked against the index entry. Every result has a direct-pay buy plan; Horizon Pulse holds no funds and takes no fee.
- **New:** `GET /api/market/quote` ($0.005, untested price): live 402 terms for one x402 resource (per network: USD price, asset, payTo; Base and Solana), the CDP Bazaar entry, a payTo cross-check and a `pay` / `caution` / `avoid` verdict. A payTo mismatch is always `avoid`, with no ready buy plan.
- **MCP:** hosted `/mcp` and the stdio server gain `market_search` and `market_quote`, with the same payment terms and output as REST.
- **Safety:** listing text is untrusted data. It is returned labelled; hidden characters (zero-width, bidi, Unicode tag U+E0000–E007F, soft hyphen, U+061C, U+180E, variation selectors) are stripped; instruction-like text (also after folding homoglyphs, fullwidth and letter-spacing) sets `injectionSuspect`, is removed from titles and blanks the description (`injectionSuspect:false` is not a safety guarantee); links in listings are never followed. Only the listed resource URL is requested, https only, with the SSRF guard on every hop. The deadline counts from request arrival (18s, 3s-left rule).
- **Unchanged:** every existing route's 402 / OPTIONS bytes, prices and payTo (golden fixture: 44/44 pre-existing keys per mode identical).
- **Class A v2 fixes (same branch):** networks are compared in one form before the payTo cross-check (`base` = `eip155:8453`, `solana` = Solana mainnet genesis), so a payTo hijack behind an alias is a mismatch, never partial. A buy plan is `ready` only on a FULL payTo match; a partial match lists only the networks that agree and is never ready; no network in common = unverified. Search probes are cached 60s per method + URL, with at most 2 probes per host per search and 6 fresh probes per host per minute (quote always probes fresh). The skill.md / llms.txt third-party payment rule is stricter (operator policy must explicitly allow third-party sellers; quote verdict `pay` moments ago; fresh 402 identical). The search example is re-recorded on a query that returns only our own route.

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
