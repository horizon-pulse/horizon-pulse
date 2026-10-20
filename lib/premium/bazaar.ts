import { PUBLIC_BASE_URL } from "@/lib/config";
import { BRIEF_CLAIMS_PER_TYPE } from "./copy";
/**
 * CDP Bazaar discovery block for the $1 verified brief's unpaid 402 (Odin 9:18 AM ET, 10/20).
 * Same shape as the multi-network routes (declareDiscoveryExtension, one charged method), Base only,
 * plus the resource metadata (serviceName, tags, iconUrl) the other routes carry. Copy: narrow and true
 * (exactly the three accepted question types). Pending Counsel copy review + Odin Class A.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import DEMO from "./demo-brief-verified.json";

export const BRIEF_SERVICE_META = {
  serviceName: "Horizon Pulse",
  iconUrl: `${PUBLIC_BASE_URL}/icon.png`, // Odin 10:16: restored to match /api/x402-check/deep
  tags: ["research", "verified-brief", "x402", "gas-fees", "usdc", "base", "ethereum"],
} as const;

export const BRIEF_BAZAAR_Q_DESCRIPTION =
  "Question (required). Accepted: Base or Ethereum gas (on-chain read), USDC supply on Ethereum and Base (on-chain totalSupply), or an x402 spec fact. Anything else is refused with 422 before payment. No personal data.";

export const BRIEF_BAZAAR_OUTPUT_DESCRIPTION =
  "Verified brief (schema brief-verified/1): answer plus 2-8 claims, each with an evidence array. Charged only if at least 2 claims are confirmed in two independent sources as defined at /contracts/brief-verified; otherwise 422, unpaid. The example is a trimmed real passing brief recorded at " +
  `${DEMO.recorded_at} (GET /api/demo/brief-verified); live values differ on every call. ${BRIEF_CLAIMS_PER_TYPE}`;

/** Trimmed real recording: question, answer, status, first claim, counts. */
function example() {
  const d = DEMO as Record<string, unknown> & { claims: unknown[] };
  return { question: d.question, answer: d.answer, status: d.status, answer_by: d.answer_by, claims: d.claims.slice(0, 1), counts: d.counts };
}

export function briefBazaarExtension(): ReturnType<typeof declareDiscoveryExtension> {
  const ext = declareDiscoveryExtension({
    method: "GET",
    input: { q: "How much USDC is in circulation" }, // Counsel B1: the demo recording's exact question
    inputSchema: { properties: { q: { type: "string", description: BRIEF_BAZAAR_Q_DESCRIPTION } }, required: ["q"] },
    output: { example: example(), schema: { type: "object", description: BRIEF_BAZAAR_OUTPUT_DESCRIPTION } },
  } as never);
  const b = ext.bazaar as { schema?: { properties?: { input?: { properties?: { method?: { enum?: unknown } } } } } };
  const m = b.schema?.properties?.input?.properties?.method;
  if (m) m.enum = ["GET"]; // one charged method, as on the other routes
  return ext;
}
