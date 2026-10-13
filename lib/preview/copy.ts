/** Page copy for /agent-promotion/preview (DRAFT, not public until Michael approves the wording). */
export const PREVIEW_COPY = {
  chip: "Agent promotion · preview (draft)",
  h1: "See which routes could be pay-per-call.",
  sub: "Paste your API docs or an OpenAPI URL. We draft a short preview: candidate routes for x402, suggested prices marked UNTESTED, an EXAMPLE 402 response, and a dry-run demo of an agent paying for one call. A person reviews every draft before it is sent.",
  what: [
    "Candidate routes, each with a reason",
    "Suggested per-call prices, all marked UNTESTED",
    "An EXAMPLE 402 response with a placeholder payTo (not a live wallet)",
    "A TEST dry-run transcript: nothing signed, no payment",
    "Agent-readiness gaps to fix before listing",
  ],
  limits:
    "We read only what you submit plus at most 5 unpaid GET probes. We never ask for keys. Submissions are deleted after 30 days. We make no promise of calls, income or directory placement.",
} as const;
