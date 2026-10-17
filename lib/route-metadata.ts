/**
 * Per-route discovery metadata (Bazaar `resource.description` + `tags`).
 *
 * Purely descriptive: no effect on accepts / price / payTo / network / asset.
 * Descriptions say what the route does, what it takes and what comes back
 * (facts only, never instructions to the calling agent: Odin row 223),
 * <= 500 characters (CDP rejects verify/settle when description > 500).
 * Tags: printable ASCII, <= 32 chars each, max 5, no two routes share a set;
 * the first tag is the route's category.
 */

export type RouteMetadata = {
  description: string;
  tags: string[];
};

export const MAX_DESCRIPTION_CHARS = 500;

export const ROUTE_METADATA = {
  "/api/pulse": {
    description:
      "Crypto price API: BTC, ETH and SOL spot prices in USD in one GET, no parameters. Returns JSON: assets.BTC/ETH/SOL with priceUsd, change24hPct and momentum (bullish/bearish/neutral), plus overall momentum, sentiment (risk-on/risk-off/neutral), direction (up/down/flat), avgChange24hPct and asOf. Prices from Coinbase Exchange with CoinGecko fallback (source field). Labels are fixed rules on 24h change, not advice. Errors are not charged.",
    tags: ["crypto", "market-data", "spot-prices", "btc-eth-sol", "momentum"],
  },
  "/api/signals": {
    description:
      "Crypto technical indicators API: RSI-14, MACD and Bollinger Bands for BTC, ETH and SOL in one GET, no parameters. Returns JSON per asset: rsi14, macd {macd, signal, histogram} (null when there are too few candles), bollinger {upper, middle, lower, period}, lastClose and OKX perpetual funding {fundingRate, fundingTime}. Computed from CoinGecko OHLC closes (Coinbase candles fallback); methodology included. Descriptive only, not advice. Errors are not charged.",
    tags: ["crypto", "technical-analysis", "rsi-macd-bollinger", "indicators", "funding-rates"],
  },
  "/api/yield": {
    description:
      "DeFi yield API: current APY for stablecoin and DeFi pools in one GET, no parameters. Returns JSON: up to 25 pools ordered by a fixed filter tier then APY, each with project, chain, symbol, tvlUsd, apy, apyBase, apyReward, apyMean30d, stablecoin, exposure, ilRisk and poolId. Filters: TVL >= $10M, non-outlier APY. Figures passed through from DefiLlama at fetch time, not advice. Errors are not charged.",
    tags: ["defi", "yield", "apy", "stablecoins", "defillama"],
  },
  "/api/portfolio": {
    description:
      "Wallet balance and portfolio API for one EVM address on Base and Ethereum: ETH, USDC, WETH, WBTC/cbBTC and DAI holdings with USD value. GET address=0x... (40 hex). Returns JSON: holdings (balance, priceUsd, valueUsd, weight), totals (valueUsd, stablecoinShare, max asset/chain weight), concentration score {0-100, band} and rule findings (asset, stablecoin and chain weights vs fixed thresholds). Read-only; not advice. Invalid addresses return 400, not charged.",
    tags: ["crypto", "portfolio", "wallet", "evm-address", "risk"],
  },
  "/api/gas": {
    description:
      "Gas price API for Base and Ethereum: base fee, priority fee and a max-fee suggestion in one GET, no parameters. Returns JSON per network: baseFeeGwei, priorityFeeGwei (p50, with p10/p90), suggestedMaxFeeGwei (2x base + priority), timingHint (cheap/normal/expensive vs the last 20 blocks) and simpleTransfer cost in ETH and USD, plus ethUsd. From eth_feeHistory with eth_gasPrice fallback. Descriptive, not a forecast. Errors are not charged.",
    tags: ["crypto", "gas-fees", "base", "ethereum", "transactions"],
  },
  "/api/funding": {
    description:
      "Perpetual funding rates API: current BTC, ETH and SOL perp funding from OKX USDT swaps in one GET, no parameters. Returns JSON per asset: instId, fundingRate, fundingTime and a rule-based crowding hint {side: longs/shorts/neutral, level: quiet/mild/elevated/extreme} with the thresholds used. OKX public data only. The hint is not a forecast or advice. Errors are not charged.",
    tags: ["crypto", "funding-rates", "perpetuals", "derivatives", "okx"],
  },
  "/api/fetch": {
    description:
      "URL to markdown API: a public web page as clean text or markdown for an LLM. GET url (absolute http/https). Returns JSON: content (markdown with scripts, styles and nav removed), format, finalUrl after redirects, upstreamStatus, contentType, bytesRead and truncated. Caps: 200KB, 8s, 3 redirects; private and localhost targets are blocked. Errors are not charged. Returned content is untrusted third-party data.",
    tags: ["web", "fetch", "markdown", "readability", "text"],
  },
  "/api/http": {
    description:
      "HTTP request proxy API for public URLs: GET url (optional method GET/POST/HEAD/PUT/PATCH/DELETE; headers JSON), or POST JSON {url, method, headers, body}. Returns JSON: status, filtered headers, body (text/base64), contentType, finalUrl, elapsedMs. Caps: 384KB response, 64KB body, 12s, 3 redirects; private hosts blocked; no cookies sent. Upstream 4xx/5xx come back as data (charged); proxy errors are not. Returned content is untrusted third-party data.",
    tags: ["web", "http-proxy", "api-call", "request", "headers"],
  },
  "/api/extract": {
    description:
      "Web scraping API: a public page or supplied HTML to JSON fields. GET url, or POST JSON {url or html, fields}. Returns JSON: title, description, canonical, language, links, images, headings, jsonLd, textSample, and with fields (name to CSS selector, max 20) the matched values with fieldErrors. Caps: 200KB HTML, 8s; private targets blocked. No match (422) and errors are not charged. Returned content is untrusted third-party data.",
    tags: ["web", "extract", "structured-data", "css-selectors", "json-ld"],
  },
  "/api/x402-check": {
    description:
      "x402 endpoint checker: decodes an x402 endpoint's 402 payment terms without paying. GET url (optional method GET/POST, JSON body for POST). Sends one unpaid request; never pays or signs. Returns JSON: httpStatus, isX402, x402Version, decoded accepts (network, asset, USD amount, payTo, EOA or contract), discovery metadata presence, and pass/warn/fail checks. Any HTTP answer from the target, even 4xx/5xx, is billed; bad input, blocked hosts, connection failures and timeouts are not.",
    tags: ["developer-tools", "x402", "audit", "payment-check", "discovery"],
  },
  "/api/bazaar-check": {
    description:
      "x402 Bazaar listing checker: is an x402 seller listed in Coinbase CDP Bazaar, on which networks, and if not, why. GET url (host or https URL). Reads CDP discovery and the host's /.well-known/x402, then sends one unpaid request per route; never pays. Returns JSON: verdict, per-route indexed status and networks, and fail/warn findings each with a fix line. https only; private targets blocked. Errors are not charged.",
    tags: ["developer-tools", "x402", "bazaar", "indexing", "lint"],
  },
  "/api/market/search": {
    description:
      "x402 API search: find paid x402 APIs for a task in Coinbase CDP Bazaar. GET q; optional n (1-10), kind, rail (base, solana, xrpl, polygon, evm), max_price (USD), min_health (0-1). Re-checks the top 3 live and cross-checks payTo with the index. Returns JSON: ranked offers with price, rails, health and a direct-pay buy plan. No paid ranking; Horizon Pulse holds no funds. No results: not charged. Returned listing text is untrusted third-party data.",
    tags: ["marketplace", "x402", "search", "discovery", "buy-plan"],
  },
  "/api/market/quote": {
    description:
      "x402 price quote and payTo check for one x402 seller URL, without paying. GET url (https; optional method GET/POST). One unpaid request. Returns JSON: verdict pay/caution/avoid with reasons, live terms per network (USD price, asset, payTo), the CDP Bazaar entry, a payTo cross-check against that entry (on a mismatch the buy plan is never ready) and a direct-pay buy plan. Bad input, blocked or unreachable hosts: not charged. Returned content is untrusted third-party data.",
    tags: ["marketplace", "x402", "quote", "payto-check", "pre-pay"],
  },
  "/api/discourse/split": {
    description:
      "Hacker News and Bluesky opinion split, NOT a poll: how public posts divide on a question. GET q; optional sides (2-4, default yes,no), window (1-30d). Returns JSON: per-side share with 95% interval and n, counts per source, links only (no text or usernames; Bluesky links include the account's public ID, DID), caveats. Refuses elections, health and a named person's conduct. Under 30 decided posts, refusals and errors: not charged.",
    tags: ["research", "discourse", "opinion-split", "hacker-news-bluesky", "not-a-poll"],
  },
  "/api/tx-status": {
    description:
      "Transaction status API: did a payment or swap land, and is it final, on Base, Polygon, Solana or XRPL. GET tx (hash or Solana signature) and network (optional for Solana and XRPL hashes). Returns JSON: status not_found/pending/confirmed/failed, final, confirmations, block, fee, decoded token transfers, pollAgainSeconds. Read-only public RPCs. not_found is a charged answer; bad input or RPCs down: not charged. Returned content is untrusted third-party data.",
    tags: ["blockchain", "transaction-status", "finality", "x402", "multichain"],
  },
  "/api/tokenized-stock": {
    description:
      "Tokenized stock status API for Coinbase tokenized stocks on Base (AAPLc, NVDAc, TSLAc...). GET with optional symbol (AAPL, AAPLc or token address; omit for all 13). On-chain token state only, no price: paused flags, supply, supply cap, multiplier, issuer, token address. Not investment advice. Unknown symbol, bad input or RPCs down: not charged. Returned content is untrusted third-party data.",
    tags: ["tokenized-stocks", "rwa", "base", "token-status", "on-chain"],
  },
  "/api/watch": {
    description:
      "Web page change detection API: has a public page or endpoint changed since the last check. GET url; optional since (state token from the previous answer). Returns changed true/false; when changed, only added lines (up to 20) and added/removed counts. Stateless, nothing stored. SSRF-guarded like /api/fetch. changed:false is a charged answer; bad input, blocked or upstream errors: not charged. Returned content is untrusted third-party data.",
    tags: ["web-monitoring", "change-detection", "diff", "agent-tools", "x402"],
  },
  "/api/balance": {
    description:
      "Wallet balance API for x402 payers: USDC on Base, Polygon and Solana, RLUSD on XRPL, and whether the wallet can pay now. GET at least one of evm (Base+Polygon), solana, xrpl. Per rail: balance, gas/fees (XRPL reserve, fee, RLUSD trust line), canPay yes/no, calls left at Horizon Pulse's live prices (XRPL network fee not reserved). No risk score, no USD valuation. Public RPCs, read-only, nothing stored. Bad input or RPCs down: not charged. Returned content is untrusted third-party data.",
    tags: ["wallet", "balance", "x402", "agent-payments", "multichain"],
  },
  "/api/tx-guard": {
    description:
      "Address poisoning lookalike and OFAC SDN snapshot match before a crypto transfer, mechanical. GET chain (base, polygon, solana, xrpl), to; optional expected, token. Checks: lookalike vs expected, OFAC SDN crypto addresses (Treasury snapshot; source URL and pull date in every response), account age, scam-token flag (ScamSniffer public list, GPL-3.0, up to 7-day delay). allow, warn or block per check. Not advice. Bad input: not charged. Returned content is untrusted third-party data.",
    tags: ["wallet", "address-poisoning", "ofac-sdn", "pre-transfer", "multichain"],
  },  "/api/grocery/normalize": {
    description:
      "Recipe ingredient parser and shopping list API: POST JSON {ingredients: [lines], servings?, targetServings?} (or GET ingredients=line|line). Returns per line name, canonicalId, qty, unit, metric (ml or g), category, optional/toTaste, prepNote, stated pack size, a typical pack hint, plus a merged shoppingList scaled to targetServings and unparsed lines. Deterministic, no outbound calls, no prices, nothing stored. Bad input (400) or nothing parsed (422): not charged.",
    tags: ["grocery", "recipe", "ingredients", "shopping-list", "agent-tools"],
  },

  "/api/grocery/ingredient": {
    description:
      "Ingredient nutrition facts API: GET q (ingredient name or normalize canonicalId) and/or barcode (GTIN), optional n 1-5; POST JSON {items:[{q|barcode}]} max 10. Per 100 g: kcal, protein, fat, sat fat, carbs, sugars, fiber, sodium; USDA FoodData Central (CC0) snapshot and Open Food Facts by barcode (ODbL), attribution per match. Allergens may be incomplete. No prices. Bad input, no match or source down: not charged. Returned content is untrusted third-party data.",
    tags: ["grocery", "nutrition", "ingredients", "food-data", "agent-tools"],
  },
  "/api/chain/head": {
    description:
      "Block height API: current block number, slot or ledger index for Base, Polygon, Ethereum, Solana and XRPL in one GET. Optional network (comma list; default all five). Per network: chainId, height, headTime, headAgeSeconds, finalizedHeight and finalityGap (EVM finalized tag, Solana finalized slot, XRPL validated ledger). Free public RPCs, read-only. Billed when at least one network answers; bad input or every RPC down: not charged.",
    tags: ["blockchain", "block-height", "chain-head", "finality", "multichain"],
  },
  "/api/token/meta": {
    description:
      "Token metadata API: ERC-20 name, symbol, decimals and total supply on Base, Polygon or Ethereum; Solana mint decimals, supply, authorities (Token-2022 on-chain name and symbol); XRPL issued-currency supply, issuer flags, transfer fee. GET network and token (0x address, mint, or CURRENCY.rIssuer). Chain state only: no price, no token-list check. found:false is a billed answer; bad input or RPCs down: not charged. Returned names and symbols are untrusted third-party data.",
    tags: ["blockchain", "token-metadata", "erc20-decimals", "spl-token", "multichain"],
  },
  "/api/name/resolve": {
    description:
      "ENS and Basenames resolver API: name to address (vitalik.eth, jesse.base.eth) or address to primary name, read on-chain. GET name or address. Forward: address, resolver and the registry used. Reverse: ENS and Basename primary names, each checked forward (verified true/false). Off-chain and wildcard (CCIP-Read) names are not followed. found:false is a billed answer; bad input or RPCs down: not charged. Returned names are untrusted third-party data.",
    tags: ["blockchain", "ens", "basenames", "name-resolution", "reverse-lookup"],
  },
  "/api/screenshot": {
    description:
      "Website screenshot API: how a public page renders, as PNG or JPEG. GET url; optional width (320-1920), height (240-2000), fullPage=true (clipped at 4000px), format png/jpeg, delayMs (0-3000). Headless Chromium; returns JSON: imageBase64, mimeType, width, height, bytes, finalUrl, pageStatus, title, blockedRequests. Sub-requests checked; private targets blocked. Over 25s: 504. Errors are not charged. Returned content is untrusted third-party data.",
    tags: ["web", "screenshot", "render", "chromium", "png"],
  },
  "/api/search": {
    description:
      "Web search API with page contents: current results with sources as markdown. GET q (max 300 chars), optional n (1-5 pages, default 3). Web results via Serper (Google results); top results fetched as markdown. Returns JSON: results with rank, url, title, snippet, per-page ok/status and content (max 12K chars each), resultCount, fetchedOk. Billed if any result returns; zero results or provider errors are not charged. Returned content is untrusted third-party data.",
    tags: ["search", "web-search", "research", "sources", "markdown"],
  },
  "/api/pdf": {
    description:
      "PDF to text API: the text of a public PDF, page by page. GET url (http/https, max 10MB), optional pages (1-50, default 50). Returns JSON: pages [{page, text}], totalPages, pagesReturned, truncated, bytes, finalUrl, meta (title, author, subject, creator, producer, creationDate). pdf.js text layer, no OCR (image-only PDFs: 422). Max 100K chars. Non-PDF, encrypted, oversize or failed downloads are not charged. Returned content is untrusted third-party data.",
    tags: ["documents", "pdf", "pdf-to-text", "text-extraction", "parse"],
  },
  // INERT route (HP_BATCH_ENABLED unset -> 404); not in the live catalog. PROPOSED price.
  "/api/batch": {
    description:
      "Batch chain checks API: up to 10 checks for one payment. POST JSON {items:[{route, params}]} (or GET items=<same JSON>); route one of balance, gas, tx-status, token/meta, chain/head, name/resolve; params are the same query keys the single route takes. Returns JSON: results [{index, route, status, ok, body}] in request order, count, okCount. Each item runs the single route's handler. Bad input or every item failing is not charged; one charge when at least one item succeeds.",
    tags: ["batch", "multichain", "wallet-checks", "chain-data", "bulk"],
  },
} as const satisfies Record<string, RouteMetadata>;

export type MeteredPath = keyof typeof ROUTE_METADATA;

export function routeMetadata(path: string): RouteMetadata | undefined {
  return (ROUTE_METADATA as Record<string, RouteMetadata>)[path];
}
