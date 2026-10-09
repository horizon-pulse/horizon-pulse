# hq-pack-horizon-pulse

An [HQ](https://hqforwork.com) pack that connects the hosted Horizon Pulse MCP
server (https://horizonpulse.dev/mcp) and adds a skill telling HQ agents when
to use it.

## Install

```bash
hq install github:horizon-pulse/horizon-pulse#packs/hq-pack-horizon-pulse
```

## What it contributes

- `mcp/horizon-pulse.json`: the `horizon-pulse` MCP server (stdio bridge to the
  hosted Streamable HTTP endpoint via `mcp-remote@0.14.3`).
- `skills/horizon-pulse`: when to use each tool, and how payment works.
- `knowledge/horizon-pulse`: connection details and payment notes.

## Payment

Tools are paid per call over x402 v2 in USDC on Base. A paid tool called
without payment returns an x402 payment request (price, asset, pay-to address)
instead of a result, and nothing is charged. Getting results needs an
x402-capable MCP client and a dedicated low-balance wallet. See
`knowledge/horizon-pulse/README.md`.
