/**
 * Agent-facing x402 v2 payment flow (honest wire protocol).
 * Base URL: https://horizonpulse.dev (canonical); vercel.app remains a backup.
 */
export function AgentHowTo() {
  return (
    <ol style={{ paddingLeft: 18, marginBottom: 0 }}>
      <li>
        Use base <code>https://horizonpulse.dev</code> (canonical). Backup:{" "}
        <code>https://horizon-pulse-seven.vercel.app</code>.
      </li>
      <li>
        <code>GET</code> a paid route without payment →{" "}
        <strong>HTTP 402</strong>. Requirements are in the{" "}
        <code>PAYMENT-REQUIRED</code> header (x402 v2); body mirrors the same
        challenge.
      </li>
      <li>
        Network is <code>eip155:8453</code> (Base mainnet). Asset is USDC on
        Base. Pay the exact <code>amount</code> (atomic, 6 decimals) to{" "}
        <code>payTo</code>.
      </li>
      <li>
        Retry the same <code>GET</code> with an x402 v2{" "}
        <code>PAYMENT-SIGNATURE</code> header (not legacy{" "}
        <code>X-PAYMENT</code> as the primary path). Facilitator verifies +
        settles, then the JSON payload returns.
      </li>
    </ol>
  );
}
