/**
 * A real recorded x402 exchange, replayed by the landing-page terminal.
 * Re-recorded 2026-10-20T14:32:04Z (UTC) (10:32 AM ET) at the live $0.002 price with the premium test wallet
 * 0xcA1e…B80e (payer only): a TEST payment, not customer revenue. Values below are copied from that call, not invented.
 */
export const RECORDED_CALL = {
  recordedAtUtc: "2026-10-20T14:32:04.898Z",
  url: "https://horizonpulse.dev/api/pulse",
  unpaidStatus: 402,
  paymentRequiredHeaderPrefix: "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50",
  accepts: {
    scheme: "exact",
    network: "eip155:8453",
    amount: "2000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x5b32c973596078a967562ca652761404f19be0e9",
  },
  paidStatus: 200,
  wallMs: 947,
  payer: "0xcA1ea48132f3E9c70331107de1866b41ED68B80e",
  tx: "0x996f11f8659f03b47cd569b1ee9f8d0afcb4261cd3935221a1f63dc6c3bb705a",
  body: {
    asOf: "2026-10-20T14:32:04.281Z",
    BTC: 82858.42,
    ETH: 2459.44,
    SOL: 107.48,
  },
} as const;
