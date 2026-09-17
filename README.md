# Horizon Pulse

Pay-per-call crypto market **pulse** and **signals** for AI agents, monetized with the [x402](https://www.x402.org/) protocol on **Base mainnet** (USDC).

This repo is a Next.js App Router service ready to deploy (e.g. Vercel) and push to:

`https://github.com/horizon-pulse/horizon-pulse.git`

## What it is

- Agents hit paid HTTP endpoints.
- Unpaid requests receive **HTTP 402** with payment requirements (`payTo`, USDC asset, amount, network).
- With a valid x402 payment signature, Coinbase CDP facilitator **verifies + settles**, then the route returns live market data.
- No stubbed prices: CoinGecko for spot/OHLC; OKX for perpetual funding (Binance/Bybit are often geo-blocked on Vercel).

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

| Route | Price | Auth |
| --- | --- | --- |
| `GET /api/pulse` | **$0.005** USDC (`5000` atomic) | x402 |
| `GET /api/signals` | **$0.008** USDC (`8000` atomic) | x402 |
| `GET /status` | free | public HTML dashboard (on-chain USDC balance) |
| `GET /` | free | landing page |

### `GET /api/pulse`

Real CoinGecko spot prices for BTC / ETH / SOL with per-asset momentum, plus overall momentum / sentiment / signal.

- `runtime = 'nodejs'`
- Discovery: Bazaar extension + `outputSchema.input.discoverable: true` in payment requirements

### `GET /api/signals`

RSI(14), MACD(12,26,9), Bollinger bands from CoinGecko OHLC closes, plus OKX funding rates. Includes a `methodology` field.

- `runtime = 'nodejs'`
- Discoverable for agents

### `GET /status`

Public page showing the **current USDC balance** of the `payTo` address on Base (via public RPC / `BASE_RPC_URL`) and brief product info.

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
| `BASE_RPC_URL` | optional | overrides default Base RPC for `/status` |

Without CDP keys, endpoints still emit correct **402 payment requirements** for discovery; settlement needs CDP credentials on mainnet.

## Stack

- Next.js 16 (App Router) + TypeScript
- `@x402/next` + `@x402/core` + `@x402/evm` + `@x402/extensions`
- `@coinbase/x402` for CDP facilitator auth headers
- `viem` for treasury USDC `balanceOf` on Base

## Deploy notes

1. Create the GitHub repo / remote `https://github.com/horizon-pulse/horizon-pulse.git`.
2. Set Vercel env vars (above). Prefer PEM secret as a single line with `\n` escapes if the UI is single-line.
3. Deploy from `main`. Ensure functions use **Node.js** runtime (routes already set `export const runtime = 'nodejs'`).
4. Smoke-test: `curl -i https://YOUR_HOST/api/pulse` should return **402** with payment requirements pointing at the new `payTo`.
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

## License

Private / as designated by the horizon-pulse org.
