# Examples

## `reference-agent.mjs`

Minimal Node agent for the live paid catalog on **https://horizonpulse.dev**. It reads the catalog (paths, prices, example inputs) from `/openapi.json` at runtime, so it never carries a stale route list or price.

### Unpaid discovery (default — no wallet, no spend)

```bash
cd horizon-pulse
node examples/reference-agent.mjs
```

Probes every multi-network paid route listed in `/openapi.json` with a plain `GET` (required inputs from the OpenAPI examples), expects **HTTP 402**, decodes the x402 v2 **`PAYMENT-REQUIRED`** header (via `@x402/core` + `@x402/evm` already in `package.json`), and checks the Base entry:

- `payTo` = `0x5b32c973596078a967562ca652761404f19be0e9`
- USDC on Base (`0x8335…2913`)
- network `eip155:8453`
- exact atomic amount = that operation's `x-payment-info.amount` in `/openapi.json`

Premium routes (Base USDC only, `x-premium-payment-info`) are listed but not probed or paid by this script.

### Optional paid single-route

Spends real Base USDC. Export the key only in your local shell — **never** commit it, paste it in chat, or put it in `.env` files that get checked in.

```bash
SMOKE_PRIVATE_KEY=0x... node examples/reference-agent.mjs
# optional:
SMOKE_ROUTE=/api/pulse          # default; any multi-network paid path from /openapi.json
SMOKE_BASE_URL=https://horizonpulse.dev
```

Without `SMOKE_PRIVATE_KEY`, the script stops after discovery and prints that the paid step was skipped.

### Related

- End-to-end pulse-only smoke (balance delta, stricter asserts): `scripts/smoke-pulse.mjs` / `npm run smoke:pulse`
- Catalog + prices: repo `README.md` and `/status`
