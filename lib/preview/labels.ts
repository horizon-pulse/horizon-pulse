/**
 * Code-written labels and disclaimers for x402 Preview reports. The LLM never writes these.
 */
export const EXAMPLE_PAY_TO = "0xYOUR_WALLET" as const;
export const EXAMPLE_LABEL = "EXAMPLE, not live" as const;
export const TEST_LABEL = "TEST/EXAMPLE: dry run, nothing signed, no payment happened" as const;
export const PRICE_LABEL = "UNTESTED" as const;

export const DISCLAIMERS: readonly string[] = [
  "This is a draft preview. A person reviews it before anything is sent to you.",
  "All suggested prices are UNTESTED estimates, not advice.",
  "The sample 402 response is an EXAMPLE: the payTo is a placeholder, not a live wallet.",
  "The agent demo is a dry run: nothing was signed and no payment happened.",
  "We make no promise of calls, income, or directory placement.",
  "We only read what you submitted plus at most 5 unpaid GET probes. Submissions are deleted after 30 days.",
];
