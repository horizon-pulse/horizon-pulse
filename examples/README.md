# Examples

## `reference-agent.mjs`

Minimal Node agent for the frozen six-route catalog on **https://horizonpulse.dev**.

### Unpaid discovery (default — no wallet, no spend)

```bash
cd horizon-pulse
node examples/reference-agent.mjs
```

Probes each live route with a plain `GET`, expects **HTTP 402**, decodes the x402 v2 **`PAYMENT-REQUIRED`** header (via `@x402/core` + `@x402/evm` already in `package.json`), and checks:

- `payTo` = `0x5b32c973596078a967562ca652761404f19be0e9`
- USDC on Base (`0x8335…2913`)
- network `eip155:8453`
- exact atomic amount for that route

`/api/portfolio` is probed with a demo `?address=` (the interim `payTo`); swap in any EVM address when you pay for real.

### Optional paid single-route

Spends real Base USDC. Export the key only in your local shell — **never** commit it, paste it in chat, or put it in `.env` files that get checked in.

```bash
SMOKE_PRIVATE_KEY=0x... node examples/reference-agent.mjs
# optional:
SMOKE_ROUTE=/api/pulse          # default; any of the six paths
SMOKE_BASE_URL=https://horizonpulse.dev
```

Without `SMOKE_PRIVATE_KEY`, the script stops after discovery and prints that the paid step was skipped.

### Related

- End-to-end pulse-only smoke (balance delta, stricter asserts): `scripts/smoke-pulse.mjs` / `npm run smoke:pulse`
- Catalog + prices: repo `README.md` and `/status`
