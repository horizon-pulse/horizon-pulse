# DRAFT listing copy for POST /api/feedback (Counsel PASS-with-edits 3:26 PM ET, E1-E4 applied; not yet in public/llms.txt or public/openapi.json)
Apply only when FEEDBACK_ROUTE_ENABLED is turned on, so public lists never point at a 404.

## llms.txt (under "## Free (not paid)", after /api/money-market-rates)
- POST `/api/feedback` — FREE (no x402, no 402). Tell us about a missing coin, data field or route. JSON body: `type` (coin, data, route or other), `text` (1-500 characters, plain text), optional `symbol`, optional `route`. Links are not followed and are stored masked. Entries are kept up to 90 days for human review only; nothing ships automatically and there is no reply. We may use what you send to improve Horizon Pulse, with no obligation or payment. Do not send personal data, secrets or keys. Limit: 5 per hour and 20 per day per caller IP address, plus a shared daily cap. Limits use a keyed hash (HMAC) of the caller's IP address; the IP address itself is not stored. The limit counters expire within 25 hours, and each stored entry keeps that hash for up to 90 days so repeat submissions can be reviewed. Answers 201, 400, 413, 415, 429 or 503.

## llms.txt MCP line (replace the hosted-MCP free-tool clause)
... the `money_market_rates` and `submit_feedback` tools are free (no challenge)

## MCP tool submit_feedback (lib/feedback.ts FEEDBACK_MCP_DESCRIPTION, flag-gated in code)
FREE (no payment). Tell Horizon Pulse about a missing coin, data field or route. Fields: type (coin, data, route or other), text (1-500 characters, plain text; links are not followed and are stored masked), optional symbol and route. Stored for human review only, for up to 90 days; nothing ships automatically and there is no reply. We may use what you send to improve Horizon Pulse, with no obligation or payment. Do not include personal data, secrets or keys. Limit: 5 per hour and 20 per day per caller IP address, plus a shared daily cap. Limits use a keyed hash (HMAC) of the caller's IP address; the IP address itself is not stored. The limit counters expire within 25 hours, and each stored entry keeps that hash for up to 90 days so repeat submissions can be reviewed.

## openapi (scripts/gen-openapi.ts, FREE block like money-market-rates)
paths["/api/feedback"].post: operationId submitFeedback; summary "Request a missing coin, data field or route (FREE, no payment)"; tags ["Free data"]; security []; x-free true;
requestBody application/json { type enum[coin,data,route,other] required, text string 1-500 required, symbol string ^[A-Za-z0-9]{2,10}$, route string ^/api/[a-z0-9-/]+$ }, additionalProperties false;
responses 201 "Stored for human review; nothing ships automatically", 400 bad field, 413 body over 2 KB, 415 not JSON, 429 rate limited (Retry-After), 503 temporarily unavailable. No 402.
