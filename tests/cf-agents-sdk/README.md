# Cloudflare Agents SDK test harness (test-only)

Isolated install of `agents@0.29.0` (needs `@modelcontextprotocol/sdk` 1.32.1; the app pins 1.31.0),
used by `tests/cf-agents-sdk-x402.test.ts`. To run that test:

    cd tests/cf-agents-sdk && npm ci

Without it the test is skipped with a clear reason and `npm test` still passes.
