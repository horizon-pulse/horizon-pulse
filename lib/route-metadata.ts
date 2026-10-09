/**
 * Per-route discovery metadata (Bazaar `resource.description` + `tags`).
 *
 * Purely descriptive: no effect on accepts / price / payTo / network / asset.
 * Descriptions are agent instructions (when to call, how, what comes back),
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
      "Crypto market data. Use when you need current BTC, ETH and SOL spot prices in USD. Call GET with no parameters. Returns JSON: assets.BTC/ETH/SOL with priceUsd, change24hPct and momentum (bullish/bearish/neutral), plus overall momentum, sentiment (risk-on/risk-off/neutral), signal (buy/sell/hold) and avgChange24hPct, and asOf. Prices from Coinbase Exchange, CoinGecko fallback (source field). Labels are fixed rules on 24h change, not advice. Errors are not charged.",
    tags: ["crypto", "market-data", "spot-prices", "btc-eth-sol", "momentum"],
  },
  "/api/signals": {
    description:
      "Crypto market data: technical indicators. Use when you need indicators for BTC, ETH and SOL rather than just prices. Call GET with no parameters. Returns JSON per asset: rsi14, macd {macd, signal, histogram} (null when there are too few candles), bollinger {upper, middle, lower, period}, lastClose and OKX perpetual funding {fundingRate, fundingTime}. Computed from CoinGecko OHLC closes (Coinbase candles fallback); methodology included. Descriptive only, not advice. Errors are not charged.",
    tags: ["crypto", "technical-analysis", "rsi-macd-bollinger", "indicators", "funding-rates"],
  },
  "/api/yield": {
    description:
      "DeFi yields. Use when you need to compare current DeFi pool yields, especially stablecoin or single-asset pools. Call GET with no parameters. Returns JSON: up to 25 pools ranked by preference tier then APY, each with project, chain, symbol, tvlUsd, apy, apyBase, apyReward, apyMean30d, stablecoin, exposure, ilRisk and poolId. Filters: TVL >= $10M, non-outlier APY. Figures passed through from DefiLlama at fetch time, not advice. Errors are not charged.",
    tags: ["defi", "yield", "apy", "stablecoins", "defillama"],
  },
  "/api/portfolio": {
    description:
      "Crypto wallet analysis. Use when you need the token holdings and USD value of one EVM address. Call GET with required address=0x... (40 hex). Reads Base and Ethereum via RPC: native ETH, USDC, WETH, WBTC/cbBTC, DAI. Returns JSON: holdings (balance, priceUsd, valueUsd, weight), totals (valueUsd, stablecoinShare, max asset/chain weight), risk {score 0-100, band} and rule-based rebalance suggestions. Read-only; not advice. Invalid addresses return 400 and are not charged.",
    tags: ["crypto", "portfolio", "wallet", "evm-address", "risk"],
  },
  "/api/gas": {
    description:
      "Blockchain gas fees. Use before sending a transaction on Base or Ethereum to choose fees and timing. Call GET with no parameters. Returns JSON per network: baseFeeGwei, priorityFeeGwei (p50, with p10/p90), suggestedMaxFeeGwei (2x base + priority), timingHint (cheap/normal/expensive vs the last 20 blocks) and simpleTransfer cost in ETH and USD, plus ethUsd. From eth_feeHistory with eth_gasPrice fallback. Descriptive, not a forecast. Errors are not charged.",
    tags: ["crypto", "gas-fees", "base", "ethereum", "transactions"],
  },
  "/api/funding": {
    description:
      "Crypto derivatives data. Use when you need current perpetual futures funding rates for BTC, ETH and SOL. Call GET with no parameters. Returns JSON per asset from OKX USDT swaps: instId, fundingRate, fundingTime and a rule-based crowding hint {side: longs/shorts/neutral, level: quiet/mild/elevated/extreme} with the thresholds used. OKX public data only. The hint is not a forecast or advice. Errors are not charged.",
    tags: ["crypto", "funding-rates", "perpetuals", "derivatives", "okx"],
  },
  "/api/fetch": {
    description:
      "Web page to text. Use when you need to read a public web page as clean text or markdown for an LLM. Call GET with required url (absolute http/https). Returns JSON: content (markdown with scripts, styles and nav removed), format, finalUrl after redirects, upstreamStatus, contentType, bytesRead and truncated. Caps: 200KB, 8s, 3 redirects; private and localhost targets are blocked. For raw status, headers and body use /api/http. Errors are not charged.",
    tags: ["web", "fetch", "markdown", "readability", "text"],
  },
  "/api/http": {
    description:
      "HTTP proxy. Use when you need to call a public URL or API and get the raw response. GET with required url (optional method, headers as JSON string), or POST a JSON body {url, method, headers, body}. Methods: GET, POST, HEAD, PUT, PATCH, DELETE. Returns JSON: status, filtered headers, body (text or base64), contentType, finalUrl, elapsedMs. Caps: 384KB response, 64KB body, 12s, 3 redirects; private targets blocked. Upstream 4xx/5xx come back as data (charged); proxy errors are not.",
    tags: ["web", "http-proxy", "api-call", "request", "headers"],
  },
  "/api/extract": {
    description:
      "Web page to structured fields. Use when you need specific data from a page, not its full text. GET with required url, or POST JSON {url or html, fields}. Returns JSON: title, description, canonical, language, links, images, headings, jsonLd, textSample, and with fields (map of name to CSS selector, max 20) the matched values with fieldErrors. Caps: 200KB HTML, 8s; private targets blocked. If no requested field matches it returns 422 and is not charged. Errors are not charged.",
    tags: ["web", "extract", "structured-data", "css-selectors", "json-ld"],
  },
  "/api/x402-check": {
    description:
      "x402 developer tool. Use before paying an unknown x402 endpoint, or to debug your own. GET with required url (optional method GET/POST, body JSON for POST probes). Sends one unpaid request and never pays. Returns JSON: httpStatus, isX402, x402Version, decoded accepts (network, asset label, amount in USD, payTo and whether payTo is an EOA or contract), discovery metadata presence, and pass/warn/fail checks with a summary. Private targets are blocked. Errors are not charged.",
    tags: ["developer-tools", "x402", "audit", "payment-check", "discovery"],
  },
  "/api/screenshot": {
    description:
      "Web page screenshot. Use when you need to see how a public page renders. GET with required url; optional width (320-1920), height (240-2000), fullPage=true (clipped at 4000px), format png/jpeg, delayMs (0-3000). Renders in headless Chromium and returns JSON: imageBase64, mimeType, width, height, bytes, finalUrl, pageStatus, title and blockedRequests. Every sub-request is checked; private targets blocked. Over the 25s budget returns 504. Errors are not charged.",
    tags: ["web", "screenshot", "render", "chromium", "png"],
  },
  "/api/search": {
    description:
      "Web search with page contents. Use when you need current information from the web with sources to cite. GET with required q (max 300 chars) and optional n (1-5 pages, default 3). Searches Google results via Serper, then fetches each top result as clean markdown. Returns JSON: results with rank, url, title, snippet, per-page ok/status and content (up to 12K chars each), plus resultCount and fetchedOk. Billed when at least one result returns; zero results or provider errors are not charged.",
    tags: ["search", "web-search", "research", "sources", "markdown"],
  },
  "/api/pdf": {
    description:
      "PDF to text. Use when you need the text of a public PDF document. GET with required url (http/https, max 10MB) and optional pages (1-50, default 50). Returns JSON: pages [{page, text}], totalPages, pagesReturned, truncated, bytes, finalUrl and meta (title, author, subject, creator, producer, creationDate). Reads the PDF text layer with pdf.js; no OCR, so scanned image-only PDFs return 422. Max 100K chars. Not a PDF, encrypted, too large or failed downloads are not charged.",
    tags: ["documents", "pdf", "pdf-to-text", "text-extraction", "parse"],
  },
} as const satisfies Record<string, RouteMetadata>;

export type MeteredPath = keyof typeof ROUTE_METADATA;

export function routeMetadata(path: string): RouteMetadata | undefined {
  return (ROUTE_METADATA as Record<string, RouteMetadata>)[path];
}
