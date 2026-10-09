/**
 * Bazaar `output.example` per paid route.
 *
 * EXAMPLES, not live data: each one is a trimmed copy of a real response
 * recorded from the free fixed-input twin GET https://horizonpulse.dev/api/demo/<route>
 * on 2026-10-01 ~14:36 UTC (asOf fields show the exact time). Fields were
 * dropped to keep the PAYMENT-REQUIRED header small (methodology, priced,
 * long arrays/bodies; truncated strings end in "…"); no value was invented
 * or edited. Live values change on every call. Raw recordings:
 * hp-tests/demo-samples-20261001/ (box only, not in the repo).
 *
 * 2026-10-09: in /api/pulse the recorded key overall.signal ("hold") is shown
 * under its new name overall.direction ("flat"), same rule (see CHANGELOG.md).
 * In /api/portfolio the suggestions[0].message text is re-rendered in the new
 * findings-only wording from the same recorded inputs (ETH 83.9%, code
 * concentration_high). No other value changed.
 *
 * /api/bazaar-check was recorded later (EXAMPLE_RECORDED_AT_BY_PATH) from a
 * local build of its branch: GET /api/demo/bazaar-check against horizonpulse.dev.
 */

export const EXAMPLES_RECORDED_AT = "2026-10-01T14:36Z" as const;

/** Routes added after the 2026-10-01 recording, with their own recording time (UTC). */
export const EXAMPLE_RECORDED_AT_BY_PATH: Record<string, string> = {
  "/api/bazaar-check": "2026-10-09T16:38Z",
};

export function exampleRecordedAt(path: string): string {
  return EXAMPLE_RECORDED_AT_BY_PATH[path] ?? EXAMPLES_RECORDED_AT;
}

export const OUTPUT_EXAMPLES: Record<string, Record<string, unknown>> = {
  "/api/pulse": {
    "ok": true,
    "source": "coinbase",
    "asOf": "2026-10-01T14:36:42.113Z",
    "assets": {
      "BTC": {
        "id": "bitcoin",
        "priceUsd": 84092.26,
        "change24hPct": 0.40332180519101707,
        "momentum": "neutral"
      },
      "ETH": {
        "id": "ethereum",
        "priceUsd": 2695,
        "change24hPct": 0.6776596460031482,
        "momentum": "neutral"
      },
      "SOL": {
        "id": "solana",
        "priceUsd": 117.79,
        "change24hPct": -0.8084210526315737,
        "momentum": "neutral"
      }
    },
    "overall": {
      "momentum": "neutral",
      "sentiment": "neutral",
      "direction": "flat",
      "avgChange24hPct": 0.09085346618753054
    }
  },
  "/api/signals": {
    "ok": true,
    "asOf": "2026-10-01T14:36:42.828Z",
    "assets": {
      "BTC": {
        "rsi14": 74.6303843022904,
        "macd": null,
        "bollinger": {
          "upper": 88132.02721674947,
          "middle": 71862.85,
          "lower": 55593.672783250535,
          "period": 20
        },
        "lastClose": 84442,
        "funding": {
          "instId": "BTC-USDT-SWAP",
          "fundingRate": 8.50403758528e-05,
          "fundingTime": "1790870400000",
          "venue": "okx"
        }
      },
      "ETH": {
        "rsi14": 78.943937124236,
        "macd": null,
        "bollinger": {
          "upper": 2868.5199493803807,
          "middle": 2201.9800000000005,
          "lower": 1535.4400506196203,
          "period": 20
        },
        "lastClose": 2686.91,
        "funding": {
          "instId": "ETH-USDT-SWAP",
          "fundingRate": 6.42085539106e-05,
          "fundingTime": "1790870400000",
          "venue": "okx"
        }
      }
    }
  },
  "/api/yield": {
    "ok": true,
    "source": "defillama",
    "asOf": "2026-10-01T14:36:44.086Z",
    "meta": {
      "scanned": 17001,
      "afterTvlFilter": 816,
      "afterPreferenceFilter": 686,
      "returned": 25
    },
    "pools": [
      {
        "rank": 1,
        "poolId": "edf44260-d78f-5dab-853a-f89c4f523169",
        "chain": "Ethereum",
        "project": "axis",
        "symbol": "SUSDX",
        "tvlUsd": 37488444,
        "apy": 25.85643,
        "apyBase": 25.85643,
        "apyReward": null,
        "apyMean30d": 23.14246,
        "stablecoin": true,
        "exposure": "single",
        "ilRisk": "no",
        "poolMeta": null,
        "preferenceTier": 2,
        "preferenceReason": "stablecoin + single-asset"
      },
      {
        "rank": 2,
        "poolId": "9fe33fd6-d3f3-4dbe-9187-7bff012e79f5",
        "chain": "Ethereum",
        "project": "pendle-v2",
        "symbol": "APYUSD",
        "tvlUsd": 19815029,
        "apy": 15.60566,
        "apyBase": 15.60566,
        "apyReward": null,
        "apyMean30d": 14.44087,
        "stablecoin": true,
        "exposure": "single",
        "ilRisk": "no",
        "poolMeta": "For buying PT-apyUSD-05NOV2026",
        "preferenceTier": 2,
        "preferenceReason": "stablecoin + single-asset"
      }
    ]
  },
  "/api/portfolio": {
    "ok": true,
    "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    "asOf": "2026-10-01T14:36:45.419Z",
    "holdings": [
      {
        "network": "base",
        "chainId": 8453,
        "symbol": "USDC",
        "kind": "erc20",
        "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "decimals": 6,
        "balanceAtomic": "43286078",
        "balance": "43.286078",
        "stablecoin": true,
        "priceUsd": 1,
        "valueUsd": 43.286078,
        "weight": 0.0015226151828024019
      },
      {
        "network": "ethereum",
        "chainId": 1,
        "symbol": "ETH",
        "kind": "native",
        "contract": null,
        "decimals": 18,
        "balanceAtomic": "5715987139328012679",
        "balance": "5.715987139328012679",
        "stablecoin": false,
        "priceUsd": 2696.21,
        "valueUsd": 15411.50168492758,
        "weight": 0.5421093233546252
      }
    ],
    "totals": {
      "valueUsd": 28428.77076815375,
      "stablecoinShare": 0.003485316759255355,
      "maxAssetWeight": 0.83884957651361,
      "maxAssetSymbol": "ETH",
      "maxChainWeight": 0.682574246168484,
      "maxChain": "ethereum"
    },
    "risk": {
      "score": 85,
      "band": "high"
    },
    "suggestions": [
      {
        "priority": "high",
        "code": "concentration_high",
        "message": "ETH weight 83.9% of USD value, at or above the 50% single-asset threshold."
      }
    ]
  },
  "/api/gas": {
    "ok": true,
    "asOf": "2026-10-01T14:36:44.639Z",
    "ethUsd": 2699.12,
    "networks": [
      {
        "network": "base",
        "chainId": 8453,
        "ok": true,
        "baseFeeGwei": "0.005",
        "priorityFeeGwei": "0.001",
        "priorityFeePercentilesGwei": {
          "p10": "0.000000079",
          "p50": "0.001",
          "p90": "0.01"
        },
        "suggestedMaxFeeGwei": "0.011",
        "timingHint": "normal",
        "simpleTransfer": {
          "gasLimit": 21000,
          "costWei": "231000000000",
          "costEth": "0.000000231",
          "costUsd": 0.000623
        }
      },
      {
        "network": "ethereum",
        "chainId": 1,
        "ok": true,
        "baseFeeGwei": "0.47866594",
        "priorityFeeGwei": "0.244726498",
        "priorityFeePercentilesGwei": {
          "p10": "0.001003273",
          "p50": "0.244726498",
          "p90": "2"
        },
        "suggestedMaxFeeGwei": "1.202058378",
        "timingHint": "expensive",
        "simpleTransfer": {
          "gasLimit": 21000,
          "costWei": "25243225938000",
          "costEth": "0.000025243225938",
          "costUsd": 0.068134
        }
      }
    ]
  },
  "/api/funding": {
    "ok": true,
    "source": "okx",
    "asOf": "2026-10-01T14:36:45.068Z",
    "assets": {
      "BTC": {
        "instId": "BTC-USDT-SWAP",
        "fundingRate": 8.50403758528e-05,
        "fundingTime": "1790870400000",
        "crowding": {
          "side": "longs",
          "level": "mild"
        }
      },
      "SOL": {
        "instId": "SOL-USDT-SWAP",
        "fundingRate": -4.39448031955e-05,
        "fundingTime": "1790870400000",
        "crowding": {
          "side": "neutral",
          "level": "quiet"
        }
      }
    }
  },
  "/api/fetch": {
    "ok": true,
    "requestedUrl": "https://example.com",
    "finalUrl": "https://example.com/",
    "upstreamStatus": 200,
    "contentType": "text/html; charset=utf-8",
    "format": "markdown",
    "truncated": false,
    "bytesRead": 713,
    "content": "# Example Domain\n\nThis domain is for use in documentation examples without needing permission. This is not a service, avoid relying on it for testing and monitoring purposes.\n Learn more"
  },
  "/api/http": {
    "ok": true,
    "status": 200,
    "headers": {
      "content-type": "text/html; charset=utf-8",
      "last-modified": "Mon, 28 Sep 2026 16:19:32 GMT",
      "server": "cloudflare"
    },
    "body": "<!doctype html><html lang=en><head><meta charset=utf-8><link rel=icon href=data:,><meta name=viewport content=\"width=dev…",
    "bodyEncoding": "text",
    "contentType": "text/html; charset=utf-8",
    "finalUrl": "https://example.com/",
    "truncated": false,
    "bytesRead": 713,
    "elapsedMs": 10
  },
  "/api/extract": {
    "ok": true,
    "url": "https://horizonpulse.dev/",
    "finalUrl": "https://horizonpulse.dev/",
    "title": "Horizon Pulse",
    "description": "Pay-per-call APIs for AI agents via x402 on Base: web fetch, HTTP proxy, page extract, and crypto market data.",
    "language": "en",
    "links": [
      {
        "href": "https://horizonpulse.dev/",
        "text": "Horizon Pulse"
      },
      {
        "href": "https://horizonpulse.dev/#catalog",
        "text": "Catalog"
      }
    ],
    "headings": [
      {
        "level": 1,
        "text": "Pay-per-call APIs built for agents."
      },
      {
        "level": 2,
        "text": "Thirteen routes. One protocol."
      }
    ],
    "textSample": "# Horizon Pulse\n\nLive on Base · x402 v2\n# Pay-per-call APIs\n built for agents.\n\n13 routes for market data, the web and d…",
    "fields": {
      "heading": "Pay-per-call APIsbuilt for agents.",
      "links": [
        "https://horizonpulse.dev/",
        "https://horizonpulse.dev/#catalog",
        "https://horizonpulse.dev/#how"
      ]
    },
    "fieldErrors": {},
    "matchedFields": 2,
    "requestedFields": 2,
    "elapsedMs": 120
  },
  "/api/bazaar-check": {
      "ok": true,
      "source": "bazaar-check",
      "asOf": "2026-10-09T16:38:45.681Z",
      "target": {
          "input": "horizonpulse.dev",
          "host": "horizonpulse.dev",
          "origin": "https://horizonpulse.dev"
      },
      "verdict": "fully_indexed",
      "summary": {
          "routesListed": 13,
          "routesProbed": 13,
          "indexed": 13,
          "notIndexed": 0,
          "indexedOnBase": 13,
          "indexedOnSolana": 13,
          "fail": 0,
          "warn": 0
      },
      "wellKnown": {
          "url": "https://horizonpulse.dev/.well-known/x402",
          "httpStatus": 200,
          "found": true,
          "entries": 15
      },
      "index": {
          "payTos": [
              {
                  "network": "eip155:8453",
                  "payTo": "0x5b32c973596078a967562ca652761404f19be0e9",
                  "indexedTotalForPayTo": 13,
                  "indexedOnHost": 13
              },
              {
                  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                  "payTo": "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz",
                  "indexedTotalForPayTo": 13,
                  "indexedOnHost": 13
              }
          ],
          "searchHitsOnHost": 13
      },
      "routes": [
          {
              "url": "https://horizonpulse.dev/api/pulse",
              "methods": [
                  "GET"
              ],
              "probed": true,
              "indexed": true,
              "indexedNetworks": [
                  "base",
                  "solana"
              ],
              "advertisedNetworks": [
                  "base",
                  "solana"
              ],
              "lastIndexed": "2026-10-08T21:10:33.046Z",
              "findings": []
          },
          {
              "url": "https://horizonpulse.dev/api/signals",
              "methods": [
                  "GET"
              ],
              "probed": true,
              "indexed": true,
              "indexedNetworks": [
                  "base",
                  "solana"
              ],
              "advertisedNetworks": [
                  "base",
                  "solana"
              ],
              "lastIndexed": "2026-10-09T15:20:10.271Z",
              "findings": []
          }
      ],
      "findings": [],
      "elapsedMs": 1707
  },
  "/api/x402-check": {
    "ok": true,
    "target": "https://horizonpulse.dev/api/pulse",
    "method": "GET",
    "httpStatus": 402,
    "isX402": true,
    "x402Version": 2,
    "challengeSource": "header",
    "accepts": [
      {
        "network": "eip155:8453",
        "assetLabel": "USDC (Base)",
        "amountUsd": "$0.005",
        "payTo": "0x5b32c973596078a967562ca652761404f19be0e9",
        "payToType": "eoa"
      }
    ],
    "discovery": {
      "present": true,
      "method": "GET",
      "hasInputSchema": true,
      "hasOutputExample": true
    },
    "checks": [
      {
        "id": "status_402",
        "level": "pass"
      },
      {
        "id": "challenge",
        "level": "pass"
      },
      {
        "id": "version",
        "level": "pass"
      },
      {
        "id": "payto_type",
        "level": "info"
      },
      {
        "id": "discovery",
        "level": "pass"
      }
    ],
    "summary": {
      "pass": 4,
      "warn": 0,
      "fail": 0
    },
    "elapsedMs": 201
  },
  "/api/screenshot": {
    "ok": true,
    "requestedUrl": "https://horizonpulse.dev",
    "finalUrl": "https://horizonpulse.dev/",
    "pageStatus": 200,
    "title": "Horizon Pulse",
    "mimeType": "image/png",
    "width": 1280,
    "height": 800,
    "fullPage": false,
    "bytes": 133636,
    "imageBase64": "iVBORw0KGgoAAAAN…",
    "blockedRequests": 0,
    "elapsedMs": 5818
  },
  "/api/search": {
    "ok": true,
    "query": "x402 payment protocol",
    "provider": "serper (Google results)",
    "n": 2,
    "resultCount": 2,
    "fetchedOk": 2,
    "results": [
      {
        "rank": 1,
        "url": "https://x402.org/",
        "title": "x402",
        "snippet": "x402 enables instant, low-cost payments for digital services. It's designed for API monetization, agentic commerce, paywalled content, and any scenario. The ...",
        "ok": true,
        "status": 200,
        "format": "markdown",
        "truncated": false,
        "content": "# x402\n\nClose Search\n\n# x402\n\nx402 is an open, neutral standard for internet-native payments. It absolves the Internet’s…"
      }
    ],
    "elapsedMs": 1860
  },
  "/api/pdf": {
    "ok": true,
    "requestedUrl": "https://horizonpulse.dev/sample.pdf",
    "finalUrl": "https://horizonpulse.dev/sample.pdf",
    "bytes": 858,
    "totalPages": 1,
    "pagesReturned": 1,
    "truncated": false,
    "meta": {
      "title": "Horizon Pulse sample PDF",
      "author": "Horizon Pulse"
    },
    "pages": [
      {
        "page": 1,
        "text": "Horizon Pulse sample PDF\nPay-per-call APIs for AI agents over x402 (USDC on Base).\nThis file is the fixed input for the free /api/demo/pdf sample."
      }
    ]
  }
};
