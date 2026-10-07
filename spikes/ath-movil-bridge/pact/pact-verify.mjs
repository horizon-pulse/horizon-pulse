// PACT verification for the ATH bridge. Ported from openpactprotocol/openpactprotocol @ 838c6bd (Apache-2.0):
//  - personal-agent JWT: reference/provider/src/auth/verifyPlatformJwt.ts + platformJwtTiming.ts (RS256/ES256, JWKS by iss,
//    aud, clockTolerance 30, required iss/sub/aud/iat/exp, lifetime <= 300 s, iat not > now+30)
//  - delegation token: reference/provider/src/delegation/tokens.ts verifyDelegationToken (ES256, typ "at+jwt", iss, aud) +
//    spec §5 (client_id MUST equal the personal agent's iss; grant not revoked)
//  - claim schemas: packages/protocol/src/index.ts PlatformJwtClaimsSchema, packages/protocol/src/delegation.ts DelegationTokenClaimsSchema
// Header names (spec §5): Authorization: Bearer <pa-jwt>; X-A2A-User-Delegation: Bearer <delegation-token>.
//
// NOT PACT: PACT has no purchase-type or amount-limit claim. It carries Brand-defined, space-separated scope ids. This bridge
// (the Brand) DEFINES its own scope ids: "purchase:api_call" (purchase type) and "purchase:max_usd:<n>" (per-purchase limit).
// That naming is ours, not part of PACT. Also, PACT spec says a missing scope SHOULD step up (TASK_STATE_AUTH_REQUIRED) inside A2A;
// this is a plain HTTP route, so it returns 403 instead.
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";

export const PlatformJwtClaimsSchema = z.object({ iss: z.string(), sub: z.string().min(1), aud: z.string(), iat: z.number().int(), exp: z.number().int(), jti: z.string().min(1).optional() });
export const DelegationTokenClaimsSchema = z.object({ iss: z.string().url(), aud: z.string().url(), sub: z.string().min(1), client_id: z.string().url(), scope: z.string(), grant_id: z.string().min(1), iat: z.number().int(), exp: z.number().int() });
export const DELEGATION_HEADER = "x-a2a-user-delegation";
export const PURCHASE_SCOPE = "purchase:api_call";
const parseScope = (s) => s.split(" ").filter(Boolean); // as packages/protocol/src/delegation.ts parseScope

/** registry: Map<iss, { jwks: JWTVerifyGetKey, audience }>; brand: { issuer, audience, jwks, revoked:Set<grant_id> } */
export function makePactAuthorize({ registry, brand, now = () => new Date() }) {
  return async function authorize(req, priceUsd) {
    const fail = (status, error) => ({ ok: false, status, error });
    // (1) personal-agent JWT
    const m = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
    if (!m) return fail(401, "missing personal-agent JWT");
    let pa;
    try {
      const h = decodeProtectedHeader(m[1]);
      if (h.alg !== "RS256" && h.alg !== "ES256") return fail(401, "unexpected algorithm");
      const iss = decodeJwt(m[1]).iss;
      const platform = typeof iss === "string" && registry.get(iss);
      if (!platform) return fail(401, "unknown personal-agent issuer");
      const { payload } = await jwtVerify(m[1], platform.jwks, { algorithms: ["RS256", "ES256"], issuer: iss, audience: platform.audience,
        clockTolerance: 30, currentDate: now(), requiredClaims: ["iss", "sub", "aud", "iat", "exp"] });
      pa = PlatformJwtClaimsSchema.parse(payload);
      if (pa.exp - pa.iat > 300) return fail(401, "token lifetime exceeds five minutes");
      if (pa.iat > Math.floor(now().getTime() / 1000) + 30) return fail(401, "issued in the future");
    } catch (e) { return fail(401, `personal-agent JWT: ${e.code ?? e.message}`); }
    // (2) delegation token: identifies the principal (Brand user `sub`) and the granted scopes
    const d = (req.headers[DELEGATION_HEADER] ?? "").match(/^Bearer\s+(.+)$/i);
    if (!d) return fail(401, "missing delegation token (no principal)");
    let del;
    try {
      const { payload } = await jwtVerify(d[1], brand.jwks, { algorithms: ["ES256"], issuer: brand.issuer, audience: brand.audience,
        typ: "at+jwt", currentDate: now(), requiredClaims: ["iss", "aud", "sub", "iat", "exp"] });
      del = DelegationTokenClaimsSchema.parse(payload);
    } catch (e) { return fail(401, `delegation token: ${e.code ?? e.issues?.[0]?.message ?? e.message}`); }
    if (del.client_id !== pa.iss) return fail(401, "delegation client_id != personal-agent iss");
    if (brand.revoked?.has(del.grant_id)) return fail(401, "grant revoked");
    // (3) our Brand-defined scopes
    const scopes = parseScope(del.scope);
    if (!scopes.includes(PURCHASE_SCOPE)) return fail(403, `scope ${PURCHASE_SCOPE} not granted`);
    const lim = scopes.map((s) => s.match(/^purchase:max_usd:(\d+(?:\.\d{1,2})?)$/)).find(Boolean);
    if (!lim) return fail(403, "no purchase:max_usd scope granted");
    if (Number(lim[1]) < priceUsd) return fail(403, `price ${priceUsd} exceeds granted limit ${lim[1]}`);
    return { ok: true, principal: { brandUser: del.sub, personalAgent: pa.iss, paUser: pa.sub, grantId: del.grant_id, limitUsd: Number(lim[1]) } };
  };
}
