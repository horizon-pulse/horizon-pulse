/** Page copy for /agent-promotion/preview (DRAFT, not public until Michael approves the wording). */
export const PREVIEW_COPY = {
  chip: "Agent promotion · preview (draft)",
  h1: "Make your API payable by AI agents.",
  sub: "Give us an OpenAPI spec (URL or pasted JSON) or your API docs. We draft a short x402 preview: routes an agent could pay for per call, suggested prices marked UNTESTED, an EXAMPLE 402 response, and a dry-run demo of an agent paying for one call. A person reviews every draft. Leave an email if you want the reviewed preview sent to you; with no email, nothing is sent.",
  what: [
    "Candidate routes for agents to pay per call, each with a reason",
    "Suggested per-call prices, all marked UNTESTED",
    "An EXAMPLE 402 response with a placeholder payTo (not a live wallet)",
    "A TEST dry-run transcript: nothing signed, no payment",
    "Agent-readiness gaps to fix before listing",
  ],
  limits:
    "We read only what you submit plus at most 5 unpaid GET probes. We never ask for keys. Submissions, including any email you leave, are deleted automatically after 30 days. We make no promise of calls, income or directory placement.",
} as const;
