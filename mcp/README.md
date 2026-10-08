# Horizon Pulse MCP server (local, stdio)

An MCP server that gives your agent every live [Horizon Pulse](https://horizonpulse.dev) paid route as a tool and pays each call's x402 v2 challenge (USDC on Base) from a buyer wallet you configure, within spend caps you set.

- **Tools:** one per live route, with the same names as the hosted `https://horizonpulse.dev/mcp`: `pulse`, `signals`, `yield`, `portfolio`, `gas`, `funding`, `fetch`, `http`, `extract`, `x402_check`, `screenshot`, `search`, `pdf`. The list, inputs and prices are read at startup from `https://horizonpulse.dev/openapi.json`, so they match what the API charges.
- **Free helper tools:** `catalog` (routes, prices, caps, wallet status), `quote` (calls a route unpaid and decodes the 402, never pays), `demo` (the route's free fixed-input sample).
- **Payment:** official x402 client libraries (`@x402/core` + `@x402/evm` 2.27.0, the same version family the site runs). Unpaid call → 402 → decode `PAYMENT-REQUIRED` → sign an EIP-3009 USDC authorization → retry once with `PAYMENT-SIGNATURE` → return the JSON plus the decoded `PAYMENT-RESPONSE` receipt. Screenshots come back as MCP image content.

## Use a dedicated, low-balance wallet

The server signs USDC payments with the private key in `HP_PRIVATE_KEY`. **Use a separate wallet that holds only a few dollars of USDC on Base**, never a main or treasury wallet. The key stays on your machine (it is only read from the environment and never logged or sent anywhere; only the signed payment goes to horizonpulse.dev). No ETH is needed: the payment is a signed authorization and the facilitator pays the gas.

Without `HP_PRIVATE_KEY` the server runs in quote-only mode: every route call returns the decoded price and payTo and nothing is paid.

## Guards (always on)

Before signing, the server refuses unless all of these hold:

| Check | Rule |
| --- | --- |
| Scheme / network | `exact` on Base mainnet `eip155:8453` |
| Asset | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` via EIP-3009 |
| payTo | `0x5b32c973596078a967562ca652761404f19be0e9` (hardcoded; no environment override) |
| Price | amount ≤ the price advertised for that route in `/openapi.json` |
| Per call | amount ≤ `HP_MAX_USD_PER_CALL` (default **$0.05**; the most expensive route is $0.04) |
| Per session | total paid by this process ≤ `HP_MAX_USD_TOTAL` (default **$1**) |

It never retries a payment on its own. Error responses from Horizon Pulse are not settled (see `/llms.txt` for the two documented exceptions).

## Install

Requires Node 20+.

```sh
git clone https://github.com/horizon-pulse/horizon-pulse.git
cd horizon-pulse/mcp
npm install        # installs pinned deps and builds dist/
```

## Configure your MCP client

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and other stdio MCP clients:

```json
{
  "mcpServers": {
    "horizon-pulse": {
      "command": "node",
      "args": ["/absolute/path/to/horizon-pulse/mcp/dist/index.js"],
      "env": {
        "HP_PRIVATE_KEY": "0x...key of a dedicated, low-balance buyer wallet",
        "HP_MAX_USD_PER_CALL": "0.05",
        "HP_MAX_USD_TOTAL": "1"
      }
    }
  }
}
```

Leave `HP_PRIVATE_KEY` out to try it in quote-only mode first.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `HP_PRIVATE_KEY` | unset (quote-only) | Buyer wallet private key, 0x + 64 hex. Dedicated low-balance wallet only. |
| `HP_MAX_USD_PER_CALL` | `0.05` | Max USD paid for one call. |
| `HP_MAX_USD_TOTAL` | `1` | Max USD paid per server process. Restart resets it. |
| `HP_DRY_RUN` | unset | `1` = never pay, even with a key. |
| `HP_BASE_URL` | `https://horizonpulse.dev` | API host. Change only for local testing. |
| `HP_TIMEOUT_SECONDS` | `60` | Per-request timeout. |

## Tool results

Each route tool returns the route's JSON, then a `horizon-pulse: {...}` line with the status, `result` (`paid`, `quote`, `refused`, `error`), the settlement receipt (`transaction`, `payer`) when paid, the decoded challenge when not paid, and the session total.


## Dry-run demo

`node examples/demo.mjs [domain]` (default `horizonpulse.dev`) starts from the domain alone, discovers the routes via `/.well-known/x402`, `llms.txt` and `skill.md`, then runs this server with `HP_DRY_RUN=1` and no key: `catalog`, `quote`, then a paid tool. It prints the real 402 requirements and the exact EIP-3009 authorization a client would sign, with payTo, price and cap checks. **It never signs and never pays.** Run `npm install` first (it builds `dist/`).

## Test (no money moves)

```sh
npm test
```

Builds, then runs `test/unpaid-test.mjs`: against the live site **without a key** (tools list, 402 decoding, quote-only, per-call and session caps) and against a local 127.0.0.1 mock (wrong payTo and over-price refusals, the signing path with private key = 1, a lost response after signing counted as spent, the ignored HP_EXPECTED_PAY_TO, dry-run). Nothing is broadcast and nothing is paid. Pass `skip` to run only the mock part: `node test/unpaid-test.mjs skip`.

## Hosted alternative

`https://horizonpulse.dev/mcp` (streamable HTTP) serves the same tools, but `tools/call` returns an x402 challenge that your MCP client must pay itself. This local server is for clients that can't.

Agent skill (plain markdown, no MCP needed): https://horizonpulse.dev/skill.md
