# SPIKE: ATH Móvil agent-pay bridge (local mock only)

Research only. No real account, no signup, no funds, no deploy, no merge. Evertec has **no testing environment** ("We currently do not have a Testing environment", https://github.com/evertec/ATHM-Payment-Button-API), so this runs against a **local mock** of the documented API shapes.

Run: `node spikes/ath-movil-bridge/demo.mjs` (Node 18+, no deps). Expected last line: `DEMO PASS`. Sample: `demo-output.txt`.

Funds go from the customer's ATH Móvil account **directly to the merchant's ATH Business account**. The bridge stores only `ecommerceId`, `auth_token`, status and `referenceNumber`. It never holds, pools or routes funds.

```mermaid
sequenceDiagram
  participant A as Agent
  participant B as Bridge (our API)
  participant E as ATH Móvil API (Evertec)
  participant H as Human (ATH Móvil app)
  participant M as Merchant ATH Business acct
  A->>B: GET /api/pulse
  B->>E: POST /ecommerce/payment {publicToken,total,items}
  E-->>B: {ecommerceId, auth_token}  (status OPEN)
  B-->>A: 402 {accepts:[{scheme:"athmovil-button", amount, ecommerceId}]}
  E->>H: payment request (push / phoneNumber)
  A->>B: GET /api/pulse + X-ATH-ECOMMERCE-ID
  B-->>A: 202 OPEN (Retry-After)
  H->>E: Approve  (status CONFIRM)
  E-->>B: webhook (unsigned, treated as a hint)
  B->>E: POST /business/findPayment  -> CONFIRM
  B->>E: POST /ecommerce/authorization (Bearer auth_token)
  E->>M: debit customer, credit merchant (minus 2.25% fee, $0.06 minimum)
  E-->>B: COMPLETED {referenceNumber, fee}
  A->>B: GET /api/pulse + X-ATH-ECOMMERCE-ID
  B-->>A: 200 result (+ X-ATH-Reference)
```

Files: `mock-ath.mjs` (mock of /payment, /business/findPayment, /authorization, the webhook subscribe call, plus a mock-only `/__mock/customer` standing in for the human), `bridge.mjs` (402 → poll/webhook → verify → authorize → release), `demo.mjs` (approve path + cancel path).

Gaps vs real API (UNKNOWN until we have a merchant account): exact error codes; whether `phoneNumber` is required for a push (it is optional in the docs); webhook retry/signing (none documented); JWT/Bearer for findPayment (the README shows a bare `Bearer`); real expiry timing (timeout is 120–600 s per docs).
