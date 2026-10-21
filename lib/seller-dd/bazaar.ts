/**
 * CDP Bazaar discovery block for the Seller DD unpaid 402 (site accuracy scan finding 5, 10/21). Same pattern as the
 * brief (lib/premium/bazaar.ts): declareDiscoveryExtension, one charged method (POST, JSON body), Base only.
 * Copy: DD_DESCRIPTION and DD_PASS_NOTE verbatim from ./config. The output example is the SHAPE of a delivered verdict
 * with every seller-identifying value and hash replaced by placeholders (no real seller URL, payTo, tx or hash).
 * Discovery metadata only: accepts, price, payTo and gating are unchanged.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { DD_DESCRIPTION, DD_NOTICE, DD_PASS_NOTE } from "./config";

export const DD_BAZAAR_RESOURCE_DESCRIPTION = "https URL of the x402 endpoint to check (required).";
export const DD_BAZAAR_PAYTO_DESCRIPTION = "Optional EVM address to compare with the endpoint's payTo.";
export const DD_BAZAAR_OUTPUT_DESCRIPTION =
  `Signed JSON verdict of evidenced facts (charged) or a no_charge body (not charged). ${DD_PASS_NOTE} The example shows the shape only; seller values are placeholders.`;

/** Shape-only example: placeholders, no seller data, no hashes. */
export const DD_BAZAAR_OUTPUT_EXAMPLE = {
  status: "delivered",
  charged: true,
  v: 1,
  id: "dd_<id>",
  checked_at: "<ISO 8601 time>",
  resource: "https://<seller host>/<path>",
  completeness: "complete",
  missing_checks: [],
  checks_run: ["402_parse", "test_pay", "schema_match", "payTo_continuity", "history_and_lookalike"],
  checks: [{ name: "402_parse", result: "ok", state: "pass", note: "<what was observed>" }],
  notice: DD_NOTICE,
};

export function sellerDdBazaarExtension(): ReturnType<typeof declareDiscoveryExtension> {
  const ext = declareDiscoveryExtension({
    method: "POST",
    bodyType: "json",
    input: { resource: "https://example.com/api/paid", expected_payTo: null },
    inputSchema: {
      properties: {
        resource: { type: "string", format: "uri", maxLength: 2048, description: DD_BAZAAR_RESOURCE_DESCRIPTION },
        expected_payTo: { type: ["string", "null"], description: DD_BAZAAR_PAYTO_DESCRIPTION },
      },
      required: ["resource"],
    },
    output: { example: DD_BAZAAR_OUTPUT_EXAMPLE, schema: { type: "object", description: DD_BAZAAR_OUTPUT_DESCRIPTION } },
  } as never);
  const b = ext.bazaar as { schema?: { properties?: { input?: { properties?: { method?: { enum?: unknown } } } } } };
  const m = b.schema?.properties?.input?.properties?.method;
  if (m) m.enum = ["POST"]; // one charged method
  return ext;
}

/** Kept for tests: the description the 402 resource carries (unchanged, verbatim config). */
export const DD_BAZAAR_SERVICE_DESCRIPTION = DD_DESCRIPTION;
