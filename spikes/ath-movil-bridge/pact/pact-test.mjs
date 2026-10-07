// PACT gate tests against the local ATH mock. Keys are generated in-memory (throwaway); nothing leaves the box.
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { startMockAth } from "../mock-ath.mjs";
import { startBridge } from "../bridge.mjs";
import { makePactAuthorize, PURCHASE_SCOPE } from "./pact-verify.mjs";

const PA_ISS = "https://pa.example.test", BRAND = "https://bridge.example.test", AUD = "https://bridge.example.test/a2a";
const jwks = async (pub, kid) => createLocalJWKSet({ keys: [{ ...(await exportJWK(pub)), kid, alg: "ES256", use: "sig" }] });
const pa = await generateKeyPair("ES256"), br = await generateKeyPair("ES256"), rogue = await generateKeyPair("ES256");
const registry = new Map([[PA_ISS, { jwks: await jwks(pa.publicKey, "pa1"), audience: AUD }]]);
const brand = { issuer: BRAND, audience: AUD, jwks: await jwks(br.publicKey, "br1"), revoked: new Set(["g-revoked"]) };
const t = () => Math.floor(Date.now() / 1000);

const paJwt = ({ key = pa.privateKey, iat = t(), exp = t() + 120 } = {}) =>
  new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "pa1" }).setIssuer(PA_ISS).setSubject("pa-user-123").setAudience(AUD).setIssuedAt(iat).setExpirationTime(exp).sign(key);
const delTok = ({ key = br.privateKey, scope = `${PURCHASE_SCOPE} purchase:max_usd:1.00`, sub = "brand-user-42", exp = t() + 600, grant = "g-1", client = PA_ISS } = {}) => {
  const claims = { client_id: client, scope, grant_id: grant };
  let j = new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "br1", typ: "at+jwt" }).setIssuer(BRAND).setAudience(AUD).setIssuedAt(t() - 5).setExpirationTime(exp);
  if (sub !== null) j = j.setSubject(sub);
  return j.sign(key);
};

const ath = await startMockAth();
const bridge = await startBridge({ athUrl: ath.url, publicToken: "MOCK_PUBLIC_TOKEN", priceUsd: 0.25, authorize: makePactAuthorize({ registry, brand }) });
const cases = [
  ["valid credential, $1.00 limit ≥ $0.25", "pass", async () => ({ a: await paJwt(), d: await delTok() })],
  ["valid, limit exactly $0.25", "pass", async () => ({ a: await paJwt(), d: await delTok({ scope: `${PURCHASE_SCOPE} purchase:max_usd:0.25` }) })],
  ["bad signature (PA JWT signed by rogue key)", "fail", async () => ({ a: await paJwt({ key: rogue.privateKey }), d: await delTok() })],
  ["bad signature (delegation signed by rogue key)", "fail", async () => ({ a: await paJwt(), d: await delTok({ key: rogue.privateKey }) })],
  ["expired PA JWT", "fail", async () => ({ a: await paJwt({ iat: t() - 400, exp: t() - 200 }), d: await delTok() })],
  ["expired delegation token", "fail", async () => ({ a: await paJwt(), d: await delTok({ exp: t() - 60 }) })],
  ["wrong purchase type (scope orders:read only)", "fail", async () => ({ a: await paJwt(), d: await delTok({ scope: "orders:read purchase:max_usd:1.00" }) })],
  ["over limit ($0.10 < $0.25)", "fail", async () => ({ a: await paJwt(), d: await delTok({ scope: `${PURCHASE_SCOPE} purchase:max_usd:0.10` }) })],
  ["missing principal (no delegation token)", "fail", async () => ({ a: await paJwt(), d: null })],
  ["missing principal (delegation without sub)", "fail", async () => ({ a: await paJwt(), d: await delTok({ sub: null }) })],
  ["client_id != PA iss", "fail", async () => ({ a: await paJwt(), d: await delTok({ client: "https://other.example.test" }) })],
  ["revoked grant", "fail", async () => ({ a: await paJwt(), d: await delTok({ grant: "g-revoked" }) })],
];
const rows = []; let allOk = true;
for (const [name, expect, mk] of cases) {
  const { a, d } = await mk(); const before = (await fetch(ath.url + "/__count").catch(() => null), bridge.orders.size);
  const h = { authorization: `Bearer ${a}` }; if (d) h["x-a2a-user-delegation"] = `Bearer ${d}`;
  const r = await fetch(bridge.url + "/api/pulse", { headers: h }); const j = await r.json();
  const athIssued = bridge.orders.size > before;
  const got = r.status === 402 && athIssued ? "pass" : "fail";
  const ok = got === expect && (expect === "fail" ? !athIssued : true);
  allOk &&= ok;
  rows.push({ case: name, expected: expect, http: r.status, athRequestIssued: athIssued, result: ok ? "OK" : "MISMATCH", detail: j.error ?? `principal=${[...bridge.orders.values()].at(-1)?.principal?.brandUser}` });
}
console.table(rows);
console.log(allOk ? "PACT TESTS PASS" : "PACT TESTS FAIL");
ath.srv.close(); bridge.srv.close();
process.exit(allOk ? 0 : 1);
