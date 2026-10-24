/**
 * Seller due-diligence discovery entries (Odin Class A, 10/20). Shown ONLY when sellerDdEnabled() (HP_PREMIUM_ENABLED=true
 * AND HP_SELLER_DD_ENABLED=true), the same gate as the route itself, so a route that 404s is never listed.
 * Flag off -> every discovery surface is byte-identical to main (tests/premium-golden.test.ts, tests/seller-dd-discovery.test.ts).
 *   - /.well-known/x402: resource URL appended + a `sellerDd` block (runtime, like the premium block).
 *   - /openapi.json and /llms.txt: public/ files stay the flag-off copy; with the flag on at build time, the beforeFiles
 *     rewrite in lib/doc-rewrites.ts serves app/free-tier/{openapi.json,llms.txt}, which append these entries.
 * Copy: DD_DESCRIPTION (Counsel PASS, copy recheck item 1), DD_NOTICE, DD_PASS_NOTE, DD_DISPUTE_TERM, DD_RETENTION_TERM,
 * all verbatim from lib/seller-dd/config.ts. Everything else is a mechanical fact read from code (price, amount,
 * network, asset, payTo, method, body fields, status codes). No new claims.
 */
import { BASE_CAIP2, CDP_FACILITATOR_URL, DEFAULT_PAY_TO, PUBLIC_BASE_URL, USDC_BASE } from "@/lib/config";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { DD_AMOUNT, DD_DESCRIPTION, DD_DISPUTE_TERM, DD_NOTICE, DD_PASS_NOTE, DD_PATH, DD_PRICE_USD, DD_RETENTION_TERM, sellerDdEnabled } from "./config";

type Env = Record<string, string | undefined>;
const TERMS_URL = `${PUBLIC_BASE_URL}/premium-terms`;
const PRICE = `$${DD_PRICE_USD}`;

export function sellerDdResources(env: Env = process.env): string[] {
  return sellerDdEnabled(env) ? [`${PUBLIC_BASE_URL}${DD_PATH}`] : [];
}

export function sellerDdWellKnownBlock(env: Env = process.env) {
  if (!sellerDdEnabled(env)) return null;
  return {
    url: `${PUBLIC_BASE_URL}${DD_PATH}`,
    method: "POST",
    price: PRICE,
    amount: DD_AMOUNT,
    network: BASE_CAIP2,
    asset: USDC_BASE,
    payTo: DEFAULT_PAY_TO,
    description: DD_DESCRIPTION,
    notice: DD_NOTICE,
    terms: TERMS_URL,
  };
}

/** The OpenAPI path item (POST; GET returns the unpaid 402 only). */
export function sellerDdOpenApiPath() {
  const err = { "application/json": { schema: { type: "object" } } };
  return {
    post: {
      operationId: "postSellerDdSingle",
      tags: ["Seller due-diligence"],
      summary: `Seller due-diligence for one x402 endpoint (${PRICE}, USDC or EURC on Base only)`,
      description: `${DD_DESCRIPTION}\n\nPrice: ${PRICE} USDC (${DD_AMOUNT} atomic), USDC or EURC on Base only: x402 v2 \`exact\` on Base (${BASE_CAIP2}). EURC prices are converted from our USD list prices. EURC is offered only when it is listed in the 402 response. ${DD_PASS_NOTE} ${DD_NOTICE} Terms: ${TERMS_URL}. ${DD_DISPUTE_TERM} ${DD_RETENTION_TERM}`,
      "x-premium-payment-info": {
        protocol: "x402",
        x402Version: 2,
        scheme: "exact",
        network: BASE_CAIP2,
        asset: USDC_BASE,
        assetSymbol: "USDC",
        decimals: 6,
        priceUsd: PRICE,
        amount: DD_AMOUNT,
        payTo: DEFAULT_PAY_TO,
        facilitator: CDP_FACILITATOR_URL,
        discovery: `${PUBLIC_BASE_URL}/.well-known/x402`,
        terms: TERMS_URL,
      },
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["resource"],
              properties: {
                resource: { type: "string", format: "uri", maxLength: 2048, description: "https URL of the x402 endpoint to check." },
                expected_payTo: { type: ["string", "null"], description: "Optional EVM address to compare with the endpoint's payTo." },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Signed JSON verdict. Charged.", content: err },
        "400": { description: "Invalid body. status no_charge, charged false.", content: err },
        "402": { description: `Payment required: PAYMENT-REQUIRED header, ${PRICE} on Base only (USDC; EURC only when listed there).`, content: err },
        "422": { description: "Charge criteria not met. status no_charge, charged false.", content: err },
        "503": { description: "Temporarily unavailable. status no_charge, charged false.", content: err },
      },
    },
  };
}

type OpenApiDoc = { paths?: Record<string, unknown>; tags?: { name: string; description?: string }[]; [k: string]: unknown };

/** openapi.json with the seller-dd path (flag on); flag off -> returned unchanged (same object). */
export function openApiWithSellerDd<T extends OpenApiDoc>(doc: T, env: Env = process.env): T {
  if (!sellerDdEnabled(env)) return doc;
  const out = JSON.parse(JSON.stringify(doc)) as T;
  out.paths = { ...(out.paths ?? {}), [DD_PATH]: sellerDdOpenApiPath() };
  if (Array.isArray(out.tags) && !out.tags.some((t) => t.name === "Seller due-diligence")) out.tags = [...out.tags, { name: "Seller due-diligence" }];
  return out;
}

export function llmsSellerDdSection(): string {
  return [
    `## Seller due-diligence (${PRICE}, USDC or EURC on Base only)`,
    "",
    "| Method | Path | Price (USDC) | Atomic (6 decimals) | Summary |",
    "| --- | --- | --- | --- | --- |",
    `| POST | ${DD_PATH} | ${PRICE} | ${DD_AMOUNT} | ${DD_DESCRIPTION} |`,
    "",
    `- Body: JSON \`{"resource": "<https x402 URL>", "expected_payTo": "<optional EVM address>"}\`. GET returns the unpaid 402 only.`,
    `- Paid only in USDC or EURC on Base (\`exact\`, \`${BASE_CAIP2}\`, payTo \`${DEFAULT_PAY_TO}\`). EURC prices are converted from our USD list prices. EURC is offered only when it is listed in the 402 response.`,
    `- ${DD_PASS_NOTE}`,
    `- ${DD_NOTICE}`,
    `- Terms: ${TERMS_URL}. ${DD_DISPUTE_TERM} ${DD_RETENTION_TERM}`,
    "",
    "",
  ].join("\n");
}

/**
 * Flag-on count line (Odin wording, Counsel condition 10/20): the number is DERIVED from the live route registry
 * (LIVE_PAID_ROUTES, which excludes the brief and seller-dd), so it always equals the live paid-route count at flag-on.
 */
export function sellerDdCountLine(n: number = LIVE_PAID_ROUTES.length): string {
  return `${n} paid routes plus the $1 verified brief and the $5 seller due-diligence check`;
}
const STATIC_COUNT_LINE_RE = /^\d+ paid routes: the \d+ in this table[^\n]*$/m;

/** llms.txt with the count line replaced and the seller-dd section inserted before "## Input bounds" (flag on); flag off -> unchanged. */
export function llmsWithSellerDd(original: string, env: Env = process.env): string {
  if (!sellerDdEnabled(env)) return original;
  original = original.replace(STATIC_COUNT_LINE_RE, `${sellerDdCountLine()} (the ${LIVE_PAID_ROUTES.length} in this table have the same price on Base, Solana, Polygon and the XRP Ledger; the brief and the seller due-diligence check are USDC or EURC on Base only).`);
  const section = llmsSellerDdSection();
  const marker = "## Input bounds";
  const i = original.indexOf(marker);
  return i >= 0 ? original.slice(0, i) + section + original.slice(i) : `${original.replace(/\n*$/, "\n\n")}${section}`;
}
