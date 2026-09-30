/**
 * A real recorded x402 exchange, replayed by the landing-page terminal.
 * Recorded 2026-09-30T20:57:24.807Z (UTC) with the project's burner test wallet: a TEST payment,
 * not customer revenue. Values below are copied from that call, not invented.
 */
export const RECORDED_CALL = {
  recordedAtUtc: "2026-09-30T20:57:24.807Z",
  url: "https://horizonpulse.dev/api/pulse",
  unpaidStatus: 402,
  paymentRequiredHeaderPrefix: "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50",
  accepts: {
    scheme: "exact",
    network: "eip155:8453",
    amount: "5000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x5b32c973596078a967562ca652761404f19be0e9",
  },
  paidStatus: 200,
  wallMs: 1099,
  payer: "0x99C4EB123bE82f38737f6D3f6ECc67Fa3c6c516F",
  tx: "0x833d0f7252da2a31ced91256227106189e12548b31aaaa0ea78f877811d74402",
  body: {
    asOf: "2026-09-30T20:57:24.149Z",
    BTC: 83627.69,
    ETH: 2679.19,
    SOL: 118.09,
  },
} as const;
