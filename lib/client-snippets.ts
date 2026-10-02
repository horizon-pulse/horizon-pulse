/** Copy-paste client snippets shared by the homepage terminal and /docs. */
export const CODE: Record<string, { title: string; code: string }> = {
  curl: {
    title: "shell",
    code: `# Free twin of every route: real output on a fixed input, no payment
curl https://horizonpulse.dev/api/demo/pulse

# Paid route without payment: HTTP 402 + PAYMENT-REQUIRED (base64 JSON, x402 v2)
curl -i https://horizonpulse.dev/api/pulse

# Machine-readable catalog
curl https://horizonpulse.dev/.well-known/x402`,
  },
  node: {
    title: "agent.mjs",
    code: `// npm i @x402/core@2.27.0 @x402/evm@2.27.0 viem@2.37.5
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const http = new x402HTTPClient(
  new x402Client().register("eip155:8453", new ExactEvmScheme(account)),
);

const url = "https://horizonpulse.dev/api/pulse";
const r1 = await fetch(url); // 402 + PAYMENT-REQUIRED
const req = http.getPaymentRequiredResponse((h) => r1.headers.get(h), await r1.json());
const payload = await http.createPaymentPayload(req);
const r2 = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
console.log(r2.status, (await r2.json()).assets.BTC.priceUsd); // 200, $0.005 USDC on Base`,
  },
  python: {
    title: "agent.py",
    code: `# pip install "x402[requests,evm]==2.25.0"
import os
from eth_account import Account
from x402 import x402ClientSync
from x402.http.clients import x402_requests
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mechanisms.evm.signers import EthAccountSigner

client = x402ClientSync()
register_exact_evm_client(client, EthAccountSigner(Account.from_key(os.environ["PRIVATE_KEY"])))

session = x402_requests(client)  # pays the 402 and retries automatically
r = session.get("https://horizonpulse.dev/api/pulse")
print(r.status_code, r.json()["assets"]["BTC"]["priceUsd"])  # 200, $0.005 USDC on Base`,
  },
  mcp: {
    title: "mcp config",
    code: `{
  "mcpServers": {
    "horizon-pulse": { "url": "https://horizonpulse.dev/mcp" }
  }
}

// Streamable HTTP, stateless, POST. No API key, no extra headers.
// initialize and tools/list are free. tools/call returns the same
// x402 challenge as REST; pay it with any x402-aware MCP client.`,
  },
};
