/**
 * Generates public/openapi.json from the live route configs in lib/x402-server.ts,
 * so prices, payTo, network, inputs and examples always match the 402s and
 * /.well-known/x402. Typed parameter schemas and non-2xx response descriptions
 * are carried over from scripts/openapi-base.json (the hand-written v1 spec).
 *
 *   npx tsx --tsconfig tsconfig.json scripts/gen-openapi.ts
 */
import fs from "node:fs";
import path from "node:path";
import * as S from "../lib/x402-server";
import { LIVE_PAID_ROUTES, CATEGORY_LABELS, routeName } from "../lib/live-catalog";
import { USDC_BASE, CDP_FACILITATOR_URL, PUBLIC_BASE_URL, CONTACT_EMAIL, SERVICE_DESCRIPTION } from "../lib/config";
import { EXAMPLES_RECORDED_AT } from "../lib/route-examples";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const OUT = path.join(__dirname, "..", "public", "openapi.json");
/** Typed parameter schemas and error descriptions from the hand-written v1 spec. */
const base: Json = JSON.parse(fs.readFileSync(path.join(__dirname, "openapi-base.json"), "utf8"));

const configs: Record<string, Json> = {};
for (const [k, f] of Object.entries(S)) if (k.endsWith("RouteConfig") && typeof f === "function") Object.assign(configs, (f as () => object)());

/** 400 bodies copied verbatim from the input validators (lib/*, app/api/*). */
const BAD_REQUEST: Record<string, Json> = {
  "/api/portfolio": { ok: false, error: "Query param address is required and must be a 0x-prefixed 40-hex EVM address (e.g. ?address=0xabc...)" },
  "/api/fetch": { ok: false, error: "Query param url is required (absolute http/https URL)", code: "missing_url" },
  "/api/http": { ok: false, error: "url is required (absolute http/https URL)", code: "missing_url" },
  "/api/extract": { ok: false, error: "url is required when html is not provided", code: "missing_input" },
  "/api/x402-check": { ok: false, error: "Query param url is required (absolute http/https URL)", code: "missing_url" },
  "/api/screenshot": { ok: false, error: "Query param url is required (absolute http/https URL)", code: "missing_url" },
  "/api/search": { ok: false, error: "Query param q is required", code: "missing_query" },
  "/api/pdf": { ok: false, error: "Query param url is required (absolute http/https URL of a PDF)", code: "missing_url" },
};

const camel = (s: string) => s.replace(/[^a-z0-9]+(.)/gi, (_, c) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^./, (c) => c.toUpperCase());
const atomic = (usd: string) => String(Math.round(Number(usd.replace(/[^0-9.]/g, "")) * 1e6));

function merge(a: Json, b: Json): Json {
  if (!a) return b;
  const ta = [a.type].flat(), tb = [b.type].flat();
  if (a.type === "object" && b.type === "object") {
    const properties: Json = { ...a.properties };
    for (const [k, v] of Object.entries<Json>(b.properties)) properties[k] = merge(properties[k], v);
    return { type: "object", properties };
  }
  if (a.type === "array" && b.type === "array") return a.items && b.items ? { type: "array", items: merge(a.items, b.items) } : a.items ? a : b;
  const types = [...new Set([...ta, ...tb])];
  const out: Json = { ...a, ...b, type: types.length === 1 ? types[0] : types };
  return out;
}

function infer(v: Json): Json {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) return v.length ? { type: "array", items: v.map(infer).reduce(merge) } : { type: "array" };
  if (typeof v === "object") {
    const properties: Json = {};
    for (const [k, x] of Object.entries(v)) properties[k] = infer(x);
    return { type: "object", properties };
  }
  if (typeof v === "number") return { type: "number" };
  return { type: typeof v };
}

/** null-only fields become "any JSON" since the example can't tell us the type. */
function widen(s: Json): Json {
  if (s.type === "null") return { description: "Null in the recorded example; may hold a value." };
  if (s.properties) for (const k of Object.keys(s.properties)) s.properties[k] = widen(s.properties[k]);
  if (s.items) s.items = widen(s.items);
  return s;
}

const tags = (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map((c) => ({
  name: CATEGORY_LABELS[c],
  description: { crypto: "Crypto market data on Base and Ethereum.", web: "Read, call and render the public web.", agent: "Tools for agents working with x402." }[c],
}));

const paths: Json = {};
const schemas: Json = {
  Error: {
    type: "object",
    description: "Error body. Errors are not charged unless the route description says otherwise (e.g. /api/http passes upstream 4xx/5xx back as data).",
    required: ["ok", "error"],
    properties: { ok: { const: false }, error: { type: "string" }, code: { type: "string", description: "Stable machine-readable error code, where the route has one." } },
  },
  PaymentRequired: {
    type: "object",
    description: "Decoded shape of the PAYMENT-REQUIRED response header: base64-decode the header value and parse it as JSON to get this x402 v2 payment challenge (the live header may also carry Bazaar discovery metadata). Not sent in the 402 body, which is empty JSON {}.",
    required: ["x402Version", "accepts"],
    properties: {
      x402Version: { const: 2 },
      resource: { type: "object", properties: { url: { type: "string" }, description: { type: "string" }, mimeType: { type: "string" } } },
      accepts: {
        type: "array",
        items: {
          type: "object",
          required: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"],
          properties: {
            scheme: { const: "exact" },
            network: { type: "string", examples: ["eip155:8453"] },
            amount: { type: "string", description: "Price in USDC atomic units (6 decimals)." },
            asset: { type: "string", description: "USDC contract on Base." },
            payTo: { type: "string" },
            maxTimeoutSeconds: { type: "integer" },
            extra: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } } },
          },
        },
      },
    },
  },
};

for (const r of LIVE_PAID_ROUTES) {
  const p = r.path.replace(/\?.*$/, "");
  const name = routeName(r);
  const methods = r.method === "GET|POST" ? ["get", "post"] : ["get"];
  paths[p] = {};
  for (const m of methods) {
    const cfg = configs[`${m.toUpperCase()} ${p}`] ?? configs[p];
    if (!cfg) throw new Error(`no config for ${m} ${p}`);
    const acc = cfg.accepts[0];
    const baz = cfg.extensions?.bazaar;
    const inSchema = baz?.schema?.properties?.input?.properties ?? {};
    const inEx = baz?.info?.input ?? {};
    const old = base.paths?.[p]?.[m] ?? {};
    const opId = `${m}${pascal(name)}`;
    const amount = atomic(acc.price);
    const op: Json = {
      operationId: opId,
      tags: [CATEGORY_LABELS[r.category]],
      summary: r.blurb,
      description: `${cfg.description}\n\nPrice: ${acc.price} USDC per call (${amount} atomic), paid with x402 v2 \`exact\` on Base. Unpaid requests get 402 with PAYMENT-REQUIRED; retry with PAYMENT-SIGNATURE.`,
      "x-payment-info": {
        protocol: "x402",
        x402Version: 2,
        scheme: acc.scheme,
        network: acc.network,
        asset: USDC_BASE,
        assetSymbol: "USDC",
        decimals: 6,
        priceUsd: acc.price,
        amount,
        payTo: acc.payTo,
        maxTimeoutSeconds: 300,
        facilitator: CDP_FACILITATOR_URL,
        discovery: `${PUBLIC_BASE_URL}/.well-known/x402`,
      },
    };
    if (m === "get") {
      const qp = inSchema.queryParams ?? { properties: {} };
      const oldParams: Json[] = old.parameters ?? [];
      const names = new Set([...Object.keys(qp.properties ?? {}), ...oldParams.map((x) => x.name)]);
      /** Body-only fields the Bazaar GET schema mentions for completeness; documented on the POST operation instead. */
      const POST_ONLY: Record<string, string[]> = { "/api/extract": ["html"], "/api/http": ["body"] };
      for (const n of POST_ONLY[p] ?? []) names.delete(n);
      const params = [...names].map((n) => {
        const o = oldParams.find((x) => x.name === n) ?? {};
        const b = qp.properties?.[n] ?? {};
        const ex = inEx.queryParams?.[n];
        return {
          name: n,
          in: "query",
          required: (qp.required ?? []).includes(n) || !!o.required,
          description: b.description ?? o.description ?? n,
          schema: o.schema ?? { type: "string", ...(b.pattern ? { pattern: b.pattern } : {}) },
          ...(ex !== undefined ? { example: ["integer", "number"].includes(o.schema?.type) ? Number(ex) : o.schema?.type === "boolean" ? ex === "true" : ex } : {}),
        };
      });
      if (params.length) op.parameters = params;
    } else {
      const bs = inSchema.body ?? {};
      const oldBody = old.requestBody?.content?.["application/json"]?.schema ?? {};
      const props: Json = {};
      for (const [k, v] of Object.entries<Json>(bs.properties ?? {})) props[k] = { ...(oldBody.properties?.[k] ?? {}), ...v };
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", required: bs.required?.length ? bs.required : oldBody.required, properties: props },
            example: inEx.body,
          },
        },
      };
      if (!op.requestBody.content["application/json"].schema.required) delete op.requestBody.content["application/json"].schema.required;
    }
    const respName = `${pascal(name)}Response`;
    const example = baz?.info?.output?.example;
    if (example && !schemas[respName]) {
      schemas[respName] = { ...widen(infer(example)), description: `Inferred from a real response recorded from GET /api/demo/${name} at ${EXAMPLES_RECORDED_AT} UTC (trimmed). Fields may be added; clients should ignore unknown fields.` };
    }
    const responses: Json = {
      "200": {
        description: "Paid success. The settlement receipt is in the PAYMENT-RESPONSE header.",
        headers: { "PAYMENT-RESPONSE": { $ref: "#/components/headers/PaymentResponse" } },
        content: { "application/json": { schema: { $ref: `#/components/schemas/${respName}` }, ...(example ? { example } : {}) } },
      },
      "402": {
        description: "Payment required (x402 v2). Not charged. The challenge is in the PAYMENT-REQUIRED header; the body is empty JSON {}.",
        headers: { "PAYMENT-REQUIRED": { $ref: "#/components/headers/PaymentRequired" } },
      },
    };
    if (BAD_REQUEST[p]) {
      responses["400"] = { description: `${(old.responses?.["400"]?.description ?? "Invalid input").replace(/\.?$/, ".")} Not charged.`, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: BAD_REQUEST[p] } } };
    }
    for (const [code, v] of Object.entries<Json>(old.responses ?? {})) {
      if (["200", "402", "400"].includes(code)) continue;
      responses[code] = { description: v.description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    }
    if (!responses["502"] && r.category === "crypto") responses["502"] = { description: "Upstream data source failed. Not charged.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    op.responses = responses;
    paths[p][m] = op;
  }
}

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Horizon Pulse",
    version: "1.1.0",
    summary: "Pay-per-call APIs for AI agents, settled in USDC on Base with x402.",
    description: `${SERVICE_DESCRIPTION}\n\nYou pay only for a successful response; errors are not charged except where an operation says so. Every paid operation carries \`x-payment-info\` with the exact price, asset, network and payTo; these match the 402 challenge and ${PUBLIC_BASE_URL}/.well-known/x402. Free fixed-input samples: GET /api/demo/{route}.\n\nAgent integration: step-by-step skill at ${PUBLIC_BASE_URL}/skill.md; guide with MCP setup at ${PUBLIC_BASE_URL}/agents (hosted MCP at ${PUBLIC_BASE_URL}/mcp for x402-aware clients, plus a local stdio MCP server in the repo's mcp/ folder that pays from your own wallet with spend caps).`,
    contact: { name: "Horizon Pulse", email: CONTACT_EMAIL, url: PUBLIC_BASE_URL },
  },
  externalDocs: { description: "Agent guide: discovery, the x402 pay flow, skill file and MCP setup", url: `${PUBLIC_BASE_URL}/agents` },
  servers: [{ url: PUBLIC_BASE_URL, description: "Production" }],
  security: [{ x402: [] }],
  tags,
  paths,
  components: {
    securitySchemes: {
      x402: {
        type: "apiKey",
        in: "header",
        name: "PAYMENT-SIGNATURE",
        description: "x402 v2 payment payload (base64 JSON), built from the 402 PAYMENT-REQUIRED challenge. No account or API key. See https://www.x402.org/.",
      },
    },
    headers: {
      PaymentRequired: {
        description: "Base64-encoded JSON x402 v2 payment challenge; decode for accepts, payTo, amount, network. Decoded shape: #/components/schemas/PaymentRequired (may also carry Bazaar discovery metadata).",
        required: true,
        schema: { type: "string", contentEncoding: "base64", contentMediaType: "application/json" },
      },
      PaymentResponse: { description: "Base64-encoded JSON settlement receipt (success, transaction, network, payer).", schema: { type: "string", contentEncoding: "base64" } },
    },
    schemas,
  },
};
fs.writeFileSync(OUT, JSON.stringify(spec, null, 2) + "\n");
console.log(`wrote ${OUT}: ${Object.keys(paths).length} paths, ${Object.values(paths).reduce((n: number, v: Json) => n + Object.keys(v).length, 0)} operations`);
