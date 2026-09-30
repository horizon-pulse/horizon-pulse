"use client";
import { useState } from "react";

const TABS: { id: string; label: string; code: string }[] = [
  {
    id: "free",
    label: "Free sample",
    code: `# Real output on a fixed input. No wallet, no payment.
curl https://horizonpulse.dev/api/demo/pulse
curl https://horizonpulse.dev/api/demo/extract`,
  },
  {
    id: "402",
    label: "See the 402",
    code: `# Any paid route without payment returns HTTP 402.
# The PAYMENT-REQUIRED header (base64 JSON, x402 v2) says
# what to pay: amount, asset (USDC on Base), payTo.
curl -i https://horizonpulse.dev/api/pulse`,
  },
  {
    id: "node",
    label: "Pay from Node",
    code: `import { x402Client, x402HTTPClient } from "@x402/core/client";
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
console.log(await r2.json()); // paid JSON, $0.005 USDC settled on Base`,
  },
];

export function CodeTabs() {
  const [on, setOn] = useState(TABS[0].id);
  const tab = TABS.find((t) => t.id === on) ?? TABS[0];
  return (
    <div className="hp-code">
      <div className="hp-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === on} className={t.id === on ? "on" : ""} onClick={() => setOn(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <pre>{tab.code}</pre>
    </div>
  );
}
