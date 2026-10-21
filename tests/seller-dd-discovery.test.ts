/**
 * Seller-dd discovery (Odin Class A, 10/20): /api/seller-dd/single is listed in /.well-known/x402, openapi.json and
 * llms.txt ONLY when HP_PREMIUM_ENABLED=true AND HP_SELLER_DD_ENABLED=true; flag off -> absent and byte-identical.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docRewrites } from "@/lib/doc-rewrites";
import { DEFAULT_PAY_TO } from "@/lib/config";
import { DD_DESCRIPTION, DD_NOTICE, DD_PASS_NOTE, DD_DISPUTE_TERM, DD_RETENTION_TERM } from "@/lib/seller-dd/config";

const ON = { HP_PREMIUM_ENABLED: "true", HP_SELLER_DD_ENABLED: "true" };
const PATH = "/api/seller-dd/single";
const URL_ = `https://horizonpulse.dev${PATH}`;
const pub = (n: string) => readFileSync(path.join(__dirname, "..", "public", n), "utf8");

async function load(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const k of ["HP_PREMIUM_ENABLED", "HP_SELLER_DD_ENABLED", "HP_FREE_TIER"]) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const wk = await import("@/app/.well-known/x402/route");
  const llms = await import("@/app/free-tier/llms.txt/route");
  const oa = await import("@/app/free-tier/openapi.json/route");
  return { wk: await wk.GET().json(), llms: llms.GET(), oa: oa.GET() };
}

afterEach(() => vi.unstubAllEnvs());

describe("seller-dd discovery gating", () => {
  for (const env of [{}, { HP_PREMIUM_ENABLED: "true" }, { HP_SELLER_DD_ENABLED: "true" }, { HP_PREMIUM_ENABLED: "true", HP_SELLER_DD_ENABLED: "1" }] as Record<string, string>[]) {
    it(`flag off ${JSON.stringify(env)}: absent everywhere, no doc rewrites, static files untouched`, async () => {
      const { wk, llms, oa } = await load(env);
      expect(wk.resources).not.toContain(URL_);
      expect(wk.sellerDd).toBeUndefined();
      expect(JSON.stringify(wk)).not.toContain("seller-dd");
      expect(llms.status).toBe(404);
      expect(oa.status).toBe(404);
      expect(docRewrites(env)).toEqual([]);
      expect(pub("openapi.json")).not.toContain(PATH);
      expect(pub("llms.txt")).not.toContain(PATH);
    });
  }

  it("flag on: present in /.well-known/x402 with $5, payTo from config, Counsel copy verbatim", async () => {
    const { wk } = await load(ON);
    expect(wk.resources.filter((r: string) => r === URL_)).toHaveLength(1);
    expect(wk.sellerDd).toMatchObject({ url: URL_, method: "POST", price: "$5", amount: "5000000", network: "eip155:8453", payTo: DEFAULT_PAY_TO, description: DD_DESCRIPTION, notice: DD_NOTICE, terms: "https://horizonpulse.dev/premium-terms" });
    expect(docRewrites(ON).map((r) => r.source)).toEqual(["/llms.txt", "/openapi.json"]);
  });

  it("flag on: openapi.json = static + only the seller-dd path (and its tag)", async () => {
    const { oa } = await load(ON);
    expect(oa.status).toBe(200);
    const doc = await oa.json();
    const base = JSON.parse(pub("openapi.json"));
    const op = doc.paths[PATH].post;
    expect(op["x-premium-payment-info"]).toMatchObject({ priceUsd: "$5", amount: "5000000", network: "eip155:8453", payTo: DEFAULT_PAY_TO });
    for (const c of [DD_DESCRIPTION, DD_NOTICE, DD_PASS_NOTE, DD_DISPUTE_TERM, DD_RETENTION_TERM]) expect(op.description).toContain(c);
    const { [PATH]: _added, ...rest } = doc.paths;
    expect(rest).toEqual(base.paths);
    expect({ ...doc, paths: undefined, tags: undefined }).toEqual({ ...base, paths: undefined, tags: undefined });
    expect(doc.tags).toEqual([...base.tags, { name: "Seller due-diligence" }]);
  });

  it("flag on: llms.txt = static + only the seller-dd section", async () => {
    const { llms } = await load(ON);
    expect(llms.status).toBe(200);
    const txt = await llms.text();
    expect(txt).toContain(`| POST | ${PATH} | $5 | 5000000 | ${DD_DESCRIPTION} |`);
    expect(txt).toContain(DEFAULT_PAY_TO);
    for (const c of [DD_NOTICE, DD_PASS_NOTE, DD_DISPUTE_TERM, DD_RETENTION_TERM]) expect(txt).toContain(c);
    const start = txt.indexOf("## Seller due-diligence");
    const end = txt.indexOf("## Input bounds");
    expect(txt.slice(0, start) + txt.slice(end)).toBe(pub("llms.txt"));
  });
});
