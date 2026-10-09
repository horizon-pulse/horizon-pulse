# Horizon Pulse: connection and payment notes

## Endpoint

- Hosted MCP server: https://horizonpulse.dev/mcp (MCP Streamable HTTP;
  clients must accept both `application/json` and `text/event-stream`).
- This pack's MCP entry runs mcp-remote 0.14.3 through npx as a stdio bridge
  to that URL. Clients that speak Streamable HTTP directly can use the
  URL as-is.
- No API key, account or signup.

## What a tool call returns

- Paid: the tool's JSON result.
- Not paid: an x402 v2 payment request (`x402Version: 2`, `accepts` with
  scheme `exact`, network `eip155:8453` (Base mainnet), asset USDC on Base
  (Circle's contract), payTo
  `0x5b32c973596078a967562ca652761404f19be0e9`, and the amount in USDC
  atomic units). Nothing is charged for it.

## Paying

- The hosted MCP endpoint takes payment in USDC on Base only.
- An x402-capable MCP client signs the payment and retries the call.
- Alternative: the open-source local stdio server in
  https://github.com/horizon-pulse/horizon-pulse/tree/main/mcp signs payments
  from a wallet key you supply (`HP_PRIVATE_KEY`), with per-call and
  per-session spend caps. Use a dedicated low-balance wallet, never a main
  wallet. Without a key it runs quote-only.

## References

- Prices and routes: https://horizonpulse.dev/.well-known/x402
- Agent docs: https://horizonpulse.dev/llms.txt
- OpenAPI: https://horizonpulse.dev/openapi.json
