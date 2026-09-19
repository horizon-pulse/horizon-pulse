# Horizon Pulse

Pay-per-call crypto market **pulse**, **signals**, **funding**, **yield** rankings, **portfolio** risk, and **gas** for AI agents, monetized with the [x402](https://www.x402.org/) protocol on **Base mainnet** (USDC).

This repo is a Next.js App Router service ready to deploy (e.g. Vercel) and push to:

`https://github.com/horizon-pulse/horizon-pulse.git`

## Public host

| Role | URL |
| --- | --- |
| **Canonical** | `https://horizonpulse.dev` |
| **Backup (Vercel)** | `https://horizon-pulse-seven.vercel.app` |

Prefer **horizonpulse.dev** in agent docs, OpenAPI, and clients. The `*.vercel.app` URL remains a working fallback.

## What it is

- Agents hit **six** live paid HTTP endpoints (catalog frozen — see below).
- Unpaid requests receive **HTTP 402** with x402 **v2** requirements: canonical wire is the **`PAYMENT-REQUIRED`** header; network is CAIP-2 **`eip155:8453`** (Base); asset is Base USDC; `payTo` is the treasury below.
- Retry with an x402 v2 **`PAYMENT-SIGNATURE`** header. Coinbase CDP facilitator **verifies + settles**, then the route returns live market data.
- No stubbed prices or fake APYs: CoinGecko for spot/OHLC; OKX for perpetual funding (Binance/Bybit are often geo-blocked on Vercel); DefiLlama for yield pools; public RPC `balanceOf` for portfolio (real balances only); `eth_feeHistory` / `eth_gasPrice` for gas (real fees only).
- Never invent metrics; never advertise routes that 404; never cite an old Safe balance — `/status` reads live USDC `balanceOf` on `payTo`.

## Catalog status (post first settlement)

| Fact | Value |
| --- | --- |
| **Live paid routes** | exactly **6** (table below) |
| **First settle** | `/api/pulse` **$0.005** — tx `0xedbd1a51…` |
| **Policy** | **Frozen** — no new endpoints, no price changes |

Coming-soon / placeholder / 404 routes are **not** listed on `/`, `/status`, or this README.

## Agent how-to (x402 v2)

1. **`GET`** a paid route with no payment → **HTTP 402**.
2. Read **`PAYMENT-REQUIRED`** (v2). Confirm `network` = `eip155:8453`, USDC on Base, exact atomic `amount`, and `payTo`.
3. Sign and retry the same **`GET`** with **`PAYMENT-SIGNATURE`** (v2 primary; do not rely on legacy `X-PAYMENT` as the settle path).
4. On success: facilitator settles on Base; response body is the live JSON for that route.

Optional: `OPTIONS` on a paid route returns discovery + the same `PAYMENT-REQUIRED` challenge without charging.

## Treasury (payTo)

| Field | Value |
| --- | --- |
| **payTo** | `0x5b32c973596078a967562ca652761404f19be0e9` |
| **USDC (Base)** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **Network** | `base` (CAIP-2 `eip155:8453`) |
| **Facilitator** | `https://api.cdp.coinbase.com/platform/v2/x402` |

Do **not** use the retired address `0xe16A1b12404cB2EbC6e783beCA6E2A9253c3dC7E`.

`PAY_TO` may be overridden via env, but defaults to the treasury above.

## Endpoints

**Paid (6 — frozen catalog):**

| Route | Price | Auth |
| --- | --- | --- |
| `GET /api/pulse` | **$0.005** USDC (`5000` atomic) | x402 v2 |
| `GET /api/signals` | **$0.015** USDC (`15000` atomic) | x402 v2 |
| `GET /api/yield` | **$0.02** USDC (`20000` atomic) | x402 v2 |
| `GET /api/portfolio?address=0x…` | **$0.04** USDC (`40000` atomic) | x402 v2 |
| `GET /api/gas` | **$0.01** USDC (`10000` atomic) | x402 v2 |
| `GET /api/funding` | **$0.01** USDC (`10000` atomic) | x402 v2 |

**Free (not paid APIs):**

| Route | Auth |
| --- | --- |
| `GET /status` | public HTML — **live** USDC `balanceOf` on `payTo` (honest RPC error if fetch fails) |
| `GET /` | landing — same six routes + agent how-to |

### `GET /api/pulse`

Real CoinGecko spot prices for BTC / ETH / SOL with per-asset momentum, plus overall momentum / sentiment / signal.

- `runtime = 'nodejs'`
- Discovery: Bazaar extension + `outputSchema.input.discoverable: true` in payment requirements

### `GET /api/signals`

RSI(14), MACD(12,26,9), Bollinger bands from CoinGecko OHLC closes, plus OKX funding rates. Includes a `methodology` field.

- `runtime = 'nodejs'`
- Discoverable for agents

### `GET /api/yield`

Ranked DeFi yield pools from the public DefiLlama yields API (`https://yields.llama.fi/pools`).

- Hard filter: **TVL ≥ $10M**; exclude non-finite APY and DefiLlama `outlier` pools
- Preference: keep **stablecoin** and/or **single-asset** (`exposure === "single"`) pools
- Transparent ranking: `preferenceTier` DESC (2 = stablecoin+single, 1 = either), then **APY** DESC, then **TVL** DESC
- Every response includes a `methodology` object (also on error bodies)
- Price: **$0.02** USDC (`20000` atomic)
- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- Unpaid GET → **402** + **`PAYMENT-REQUIRED`** (v2, `eip155:8453`) · `payTo` `0x5b32c973596078a967562ca652761404f19be0e9`

### `GET /api/portfolio`

On-chain portfolio snapshot for **one EVM address** (`?address=0x…`, required).

- Networks: **Base + Ethereum mainnet** (public RPCs; optional `BASE_RPC_URL` / `ETH_RPC_URL` with failover)
- Tokens: native ETH; USDC, WETH, DAI on both chains; **WBTC** on Ethereum; **cbBTC** on Base (honest substitute — Base has no BitGo WBTC)
- USD marks via CoinGecko; **real balances only** — if an RPC fails, that network is marked failed in `networks[]` / `warnings`
- Rule-based **risk score** (0–100) and **rebalancing suggestions** with transparent formulas in `methodology`
- Price: **$0.04** USDC (`40000` atomic)
- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- Unpaid GET → **402** + **`PAYMENT-REQUIRED`** (v2, `eip155:8453`) · `payTo` `0x5b32c973596078a967562ca652761404f19be0e9`

### `GET /api/gas`

Live gas snapshot for **Base** and **Ethereum** from public RPCs.

- Prefers `eth_feeHistory` (last 20 blocks, reward percentiles 10/50/90): `baseFeeGwei`, `priorityFeeGwei` (p50), `suggestedMaxFeeGwei` (= 2×baseFee + priority)
- Falls back to `eth_gasPrice` when feeHistory is unavailable
- Transparent `timingHint`: **cheap** / **normal** / **expensive** from percentile rank of the latest confirmed baseFee within the feeHistory window (<33 / 33–67 / >67); documented in `methodology` — not a forecast
- Optional ETH USD via CoinGecko for a simple 21k-gas transfer cost estimate (`simpleTransfer.costUsd`)
- Price: **$0.01** USDC (`10000` atomic)
- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- Unpaid GET → **402** + **`PAYMENT-REQUIRED`** (v2, `eip155:8453`) · `payTo` `0x5b32c973596078a967562ca652761404f19be0e9`

### `GET /api/funding`

Live perpetual **funding rates** for BTC / ETH / SOL from **OKX** (same source as `/api/signals`; Vercel-friendly — **not** Binance/Bybit).

- Reuses `lib/okx.ts` (`fetchAllFunding`)
- Transparent `methodology` on every response (including errors)
- Optional **crowding** hint from funding sign + magnitude only (rules: quiet / mild / elevated / extreme; side longs/shorts/neutral) — not a forecast
- Honesty: **real OKX data only**
- Price: **$0.01** USDC (`10000` atomic) — cheap poll product for agents
- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- Unpaid GET → **402** + **`PAYMENT-REQUIRED`** (v2, `eip155:8453`) · `payTo` `0x5b32c973596078a967562ca652761404f19be0e9`

### `GET /status`

Public page showing the **live USDC balance** of the `payTo` address on Base (via public RPC / `BASE_RPC_URL` `balanceOf`) plus the frozen six-route catalog and agent how-to.

- On RPC failure the page shows an **honest error** — it does **not** fall back to a cached or old Safe balance.
- First settle noted as `/api/pulse` $0.005 (`0xedbd1a51…`); catalog frozen.

## Local development

Requires **Node.js 20+** (tested on 20.19).


```bash
cd horizon-pulse
cp .env.example .env.local
# fill CDP_API_KEY_ID + CDP_API_KEY_SECRET for verify/settle
npm install
npm run dev
```

```bash
npm run build && npm start
```

## Environment variables (Vercel / production)

Copy from `.env.example`:

| Variable | Required | Notes |
| --- | --- | --- |
| `X402_NETWORK` | recommended | `base` |
| `PAY_TO` | optional | defaults to `0x5b32c973596078a967562ca652761404f19be0e9` |
| `CDP_API_KEY_ID` | for settle | Coinbase Developer Platform |
| `CDP_API_KEY_SECRET` | for settle | PKCS8 PEM (store safely; never commit) |
| `BASE_RPC_URL` | optional | overrides default Base RPC for `/status` + `/api/portfolio` + `/api/gas` |
| `ETH_RPC_URL` | optional | overrides default Ethereum RPC for `/api/portfolio` + `/api/gas` |

Without CDP keys:
- Unpaid **GET** and **OPTIONS** still return correct **402 / discovery** with v2 **`PAYMENT-REQUIRED`** (`payTo`, `eip155:8453`, USDC amount) — no CDP required for discovery.
- Requests that include **`PAYMENT-SIGNATURE`** (or legacy `X-PAYMENT`) receive **503** until `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` are set on Vercel (settlement path).
- Do **not** expect live GET to 500 when CDP is missing; that was a prior bug fixed by gating `withX402` behind payment + CDP credentials.

## Stack

- Next.js 16 (App Router) + TypeScript
- `@x402/next` + `@x402/core` + `@x402/evm` + `@x402/extensions`
- `@coinbase/x402` for CDP facilitator auth headers
- `viem` for treasury USDC `balanceOf` on Base, portfolio balances, and gas feeHistory on Base + Ethereum

## Deploy notes

1. Create the GitHub repo / remote `https://github.com/horizon-pulse/horizon-pulse.git`.
2. Set Vercel env vars (above). Prefer PEM secret as a single line with `\n` escapes if the UI is single-line.
3. Deploy from `main`. Ensure functions use **Node.js** runtime (routes already set `export const runtime = 'nodejs'`).
4. Smoke-test: `curl -i https://horizonpulse.dev/api/pulse` (or `/api/yield`, `/api/portfolio`, `/api/gas`, `/api/funding`) should return **402** with payment requirements pointing at the new `payTo`.
5. Confirm `/status` shows the treasury balance for `0x5b32…e0e9`.

## Push (from this workspace)

This scaffold does **not** push for you (no credentials). From a machine with GitHub auth:

```bash
cd /workspace/horizon-pulse
git init
git add .
git commit -m "feat: Horizon Pulse x402 API with new Base treasury"
git branch -M main
git remote add origin https://github.com/horizon-pulse/horizon-pulse.git
git push -u origin main
```

If the remote already has history:

```bash
git remote add origin https://github.com/horizon-pulse/horizon-pulse.git
git fetch origin
git pull origin main --rebase   # or merge, as appropriate
git push -u origin main
```


## Paid smoke test (`/api/pulse`)

End-to-end check against production (or `SMOKE_BASE_URL`): unpaid **402** → sign EIP-3009 / x402 with a local key → paid **200** + on-chain USDC toward `payTo`.

```bash
cd horizon-pulse
npm install   # if needed; uses existing @x402/* + viem
SMOKE_PRIVATE_KEY=0x... node scripts/smoke-pulse.mjs
# or: npm run smoke:pulse
```

Optional:

```bash
SMOKE_BASE_URL=https://horizonpulse.dev
# backup: https://horizon-pulse-seven.vercel.app
BASE_RPC_URL=https://mainnet.base.org
```

**Never paste your private key in chat, commits, or screenshots.** Export it only in your local shell (e.g. Mac mini). Without `SMOKE_PRIVATE_KEY`, the script exits with usage help (safe dry-run).

## License

Private / as designated by the horizon-pulse org.
