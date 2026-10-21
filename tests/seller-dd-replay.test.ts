/**
 * Seller-DD replay set (spec §8): 12 recorded-shape sellers with deterministic verdicts. Bar: 100% expected outcomes and
 * no charge on any failure fixture. Network, chain, listing and signer are stubbed; no real payment, no network.
 */
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { USDC_BASE } from "@/lib/config";
import { MemoryPremiumStore } from "@/lib/premium/store";
import { ddKeys } from "@/lib/seller-dd/caps";
import type { FetchOut, NetDeps } from "@/lib/seller-dd/checks";
import { runSellerDd, type EngineDeps } from "@/lib/seller-dd/engine";
import { screenLists } from "@/lib/seller-dd/screen";
import { DD_NOTICE } from "@/lib/seller-dd/config";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const PAYTO = "0x" + "4e".repeat(20);
const OTHER = "0x" + "7c".repeat(20);
const key = generatePrivateKey();
const TESTER = privateKeyToAccount(key).address;
const env = { HP_DD_TESTER_KEY: key, HP_DD_TESTER_ADDRESS: TESTER, HP_DD_DENYLIST: "0x" + "de".repeat(20), HP_DD_OWN_ADDRESSES: TESTER };

const ok = (status: number, body: unknown, headers: Record<string, string> = {}): FetchOut => ({ ok: true, status, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), truncated: false, ip: "93.184.216.34", fetched_at: "2026-10-20T12:00:00.000Z" });
const pr = (o: { v?: number; amount?: string; payTo?: string; network?: string; schema?: unknown; extra?: unknown; terms?: string } = {}) =>
  ok(402, { x402Version: o.v ?? 2, resource: { url: "x", mimeType: "application/json", ...(o.terms ? { terms: o.terms } : {}) }, accepts: [{ scheme: "exact", network: o.network ?? "eip155:8453", asset: USDC_BASE, amount: o.amount ?? "10000", payTo: o.payTo ?? PAYTO, maxTimeoutSeconds: 60, extra: o.extra ?? { name: "USD Coin", version: "2" }, outputSchema: o.schema ?? { type: "object", properties: { price: { type: "number" }, symbol: { type: "string" } }, required: ["price", "symbol"] } }] });

type Fx = {
  name: string; f402: FetchOut; paid?: FetchOut; listing?: string | null; landed?: "used" | "unused" | "unknown"; expected_payTo?: string; resource?: string; terms?: FetchOut;
  expect: { pass: boolean; reason?: RegExp; paid: boolean };
};
const FIXTURES: Fx[] = [
  { name: "good seller", f402: pr(), paid: ok(200, { price: 1.5, symbol: "ETH" }), listing: PAYTO, landed: "used", expect: { pass: true, paid: true } },
  { name: "good seller, schema drift (fail is a finding, still evidenced)", f402: pr(), paid: ok(200, { foo: 1 }), listing: PAYTO, landed: "used", expect: { pass: true, paid: true } },
  { name: "stale payTo vs listing", f402: pr(), listing: OTHER, expect: { pass: false, reason: /payto_changed_vs_listing/, paid: false } },
  { name: "no listing/snapshot -> payTo not pinned", f402: pr(), listing: null, expect: { pass: false, reason: /payto_not_pinned/, paid: false } },
  { name: "buyer expected_payTo mismatch", f402: pr(), listing: PAYTO, expected_payTo: OTHER, expect: { pass: false, reason: /payto_mismatch_expected/, paid: false } },
  { name: "over-cap price", f402: pr({ amount: "100001" }), listing: PAYTO, expect: { pass: false, reason: /price_over_test_cap/, paid: false } },
  { name: "unreachable", f402: { ok: false, code: "timeout" }, expect: { pass: false, reason: /^incomplete$/, paid: false } }, // Odin 10/21: read failure -> incomplete (cause fetch_timeout)
  { name: "malformed 402", f402: ok(402, "<html>pay me</html>"), expect: { pass: false, reason: /malformed_402/, paid: false } },
  { name: "lookalike fixture (prefix4/suffix4 of tester)", f402: pr({ payTo: `0x${TESTER.slice(2, 6)}${"5".repeat(32)}${TESTER.slice(-4)}` }), listing: `0x${TESTER.slice(2, 6)}${"5".repeat(32)}${TESTER.slice(-4)}`, expect: { pass: false, reason: /payto_similar_to_listed_address/, paid: false } },
  { name: "denylisted payTo", f402: pr({ payTo: "0x" + "DE".repeat(20) }), listing: "0x" + "de".repeat(20), expect: { pass: false, reason: /payto_on_denylist/, paid: false } },
  { name: "domain in 402 extra disagrees", f402: pr({ extra: { name: "Fake USDC", version: "9" } }), listing: PAYTO, expect: { pass: false, reason: /sign_domain_mismatch/, paid: false } },
  { name: "seller fakes settle headers but our nonce never lands", f402: pr(), paid: ok(200, { price: 1, symbol: "X" }, { "x-payment-response": "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4ZmFrZSJ9", "payment-response": "fake" }), listing: PAYTO, landed: "unused", expect: { pass: false, reason: /test_pay_not_confirmed_unused/, paid: true } },
  { name: "rebinding between 402 and paid call", f402: pr(), paid: { ok: false, code: "dns_changed" }, listing: PAYTO, landed: "unused", expect: { pass: false, reason: /test_pay_not_confirmed/, paid: true } },
  { name: "x402 v1 seller -> no pay, no charge (B3)", f402: pr({ v: 1, network: "base" }), listing: PAYTO, landed: "used", expect: { pass: false, reason: /x402_v1_seller_not_supported/, paid: false } },
  { name: "http resource", f402: pr(), resource: "http://seller.example.com/api", expect: { pass: false, reason: /resource_not_https/, paid: false } },
  { name: "terms bar redistribution -> hash only, no excerpt/diff", f402: pr({ terms: "https://seller.example.com/terms" }), terms: ok(200, "You may not redistribute or benchmark this data."), paid: ok(200, { price: 1, symbol: "X" }), listing: PAYTO, landed: "used", expect: { pass: true, paid: true } },
];

function deps(fx: Fx, store: MemoryPremiumStore, calls: { paid: number; signed: number }): EngineDeps {
  const net: NetDeps = {
    get402: async (u) => (u.endsWith("/terms") ? fx.terms ?? { ok: false, code: "upstream" } : fx.f402),
    getPaid: async () => { calls.paid++; return fx.paid ?? { ok: false, code: "upstream" }; },
  };
  return {
    net,
    continuity: { lookup: async () => (fx.listing ? { payTo: fx.listing, source_url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=seller.example.com", fetched_at: "2026-10-20T12:00:00.000Z" } : null) },
    store, lists: screenLists(env), env, now: () => NOW,
    history: async () => ({ window_blocks: 9000, window_days: 0.21, unique_payers: 4, repeat_payers: 1, first_seen_block: 100, volume_usdc: "0.040000", from_block: 100, to_block: 9100, source: "base.drpc.org" }),
    landed: async () => ({ state: fx.landed ?? "unknown", nodes: ["base.drpc.org", "mainnet.base.org"] }),
    authTx: async () => "0x" + "ab".repeat(32),
    sleep: async () => undefined,
    sign: async (r, n) => { calls.signed++; const { signTestAuthorization } = await import("@/lib/seller-dd/testpay"); return signTestAuthorization(r, n, env, BigInt(Math.floor(NOW / 1000))); },
  };
}

describe("seller-dd replay (100% expected outcomes)", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", async (_n, fx) => {
    const store = new MemoryPremiumStore(); store.now = () => NOW;
    const calls = { paid: 0, signed: 0 };
    const out = await runSellerDd({ resource: fx.resource ?? "https://seller.example.com/api", expected_payTo: fx.expected_payTo ?? null, request_id: "req1", deadline: NOW + 45_000 }, deps(fx, store, calls));
    expect(out.pass).toBe(fx.expect.pass);
    if (fx.expect.reason) expect(out.reason).toMatch(fx.expect.reason);
    if (fx.name === "unreachable") expect(out.cause).toBe("fetch_timeout");
    expect(calls.paid > 0).toBe(fx.expect.paid);
    expect(out.verdict.notice).toBe(DD_NOTICE);
    const tp = (out.verdict.checks as any[]).find((c) => c.name === "test_pay");
    // C4: evidence never contains the seller's settle header values
    expect(JSON.stringify(tp)).not.toContain("0xfake");
    if (!fx.expect.pass && fx.expect.paid) expect(Number(await store.get(ddKeys.lossUsd(NOW)))).toBeGreaterThan(0); // loss ledger
    if (fx.name.startsWith("terms bar")) {
      expect(out.verdict.paid_response_excerpt).toBeUndefined();
      expect((out.verdict.checks as any[]).find((c) => c.name === "schema_match").evidence.diff).toBeUndefined();
    }
    if (fx.expect.pass) expect(tp.evidence.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("B5: history wording never claims 30 days; window reported honestly", async () => {
    const store = new MemoryPremiumStore(); store.now = () => NOW;
    const out = await runSellerDd({ resource: "https://seller.example.com/api", request_id: "w", deadline: NOW + 45_000 }, deps(FIXTURES[0]!, store, { paid: 0, signed: 0 }));
    const hst = out.verdict.history as any;
    expect(hst.window_blocks).toBe(9001); // fixture blocks 100..9100 inclusive
    expect(hst.window_note).toBe("recent window only: last 9001 Base blocks (about 5 hours), not a full history");
    expect(hst.window_note).not.toMatch(/0 days/);
    expect(hst.window_note).toContain("not a full history");
    const { DD_DESCRIPTION } = await import("@/lib/seller-dd/config");
    expect(`${JSON.stringify(out.verdict)} ${DD_DESCRIPTION}`).not.toMatch(/30[ -]?day/i);
  });
  it("Counsel item 2: window label in hours under 2 days, days otherwise, never 'about 0 days'", async () => {
    const { windowLabel } = await import("@/lib/seller-dd/engine");
    expect(windowLabel(1, 9000).text).toBe("about 5 hours");
    expect(windowLabel(1, 100).text).toBe("about 1 hour");
    expect(windowLabel(1, 86_399).text).toBe("about 48 hours");
    expect(windowLabel(1, 86_400).text).toBe("about 2 days");
    expect(windowLabel(1, 1_296_000).text).toBe("about 30 days");
  });
  it("Counsel item 3: no CDP listing -> payTo_continuity 'skipped', never 'fail'", async () => {
    const store = new MemoryPremiumStore(); store.now = () => NOW;
    const fx = FIXTURES.find((f) => f.name.startsWith("no listing"))!;
    const out = await runSellerDd({ resource: "https://seller.example.com/api", request_id: "nl", deadline: NOW + 45_000 }, deps(fx, store, { paid: 0, signed: 0 }));
    expect((out.verdict.checks as any[]).find((c) => c.name === "payTo_continuity")).toMatchObject({ result: "skipped", note: "no CDP discovery listing found for this resource" });
  });
  it("D5: excerpt capped at 200 chars; D4: no terms link -> excerpt allowed, unreadable terms -> hash only", async () => {
    const { excerptFor, termsAllowExcerpt } = await import("@/lib/seller-dd/checks");
    expect(excerptFor("x".repeat(5000), true)!.length).toBe(200);
    expect(excerptFor("secret", false)).toBeNull();
    const net = { get402: async () => ({ ok: false as const, code: "timeout" as const }), getPaid: async () => ({ ok: false as const, code: "timeout" as const }) };
    expect((await termsAllowExcerpt(null, net)).allowed).toBe(true);
    expect((await termsAllowExcerpt("https://s.example.com/terms", net)).allowed).toBe(false);
  });
  it("LOW-1: seller fake settle headers + fake tx hash in body are ignored; evidence tx is OUR AuthorizationUsed read", async () => {
    const store = new MemoryPremiumStore(); store.now = () => NOW;
    const FAKE = "0x" + "fe".repeat(32);
    const fake = (landed: "used" | "unused"): Fx => ({ name: "fake", f402: pr(), listing: PAYTO, landed, expect: { pass: landed === "used", paid: true },
      paid: ok(200, { price: 1, symbol: "X", transaction: FAKE }, { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: FAKE })).toString("base64"), "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: FAKE })).toString("base64"), "x-tx-hash": FAKE }) });
    const used = await runSellerDd({ resource: "https://seller.example.com/api", request_id: "f1", deadline: NOW + 45_000 }, deps(fake("used"), store, { paid: 0, signed: 0 }));
    const tp = (used.verdict.checks as any[]).find((c) => c.name === "test_pay");
    expect(tp.evidence.tx_hash).toBe("0x" + "ab".repeat(32));
    expect(JSON.stringify(tp)).not.toContain(FAKE);
    const unused = await runSellerDd({ resource: "https://seller2.example.com/api", request_id: "f2", deadline: NOW + 45_000 }, deps(fake("unused"), store, { paid: 0, signed: 0 }));
    expect(unused.pass).toBe(false);
    expect(unused.reason).toBe("test_pay_not_confirmed_unused");
  });
  it("INFO-1: signer gets the continuity-confirmed payTo and the reserved value as the remaining cap", async () => {
    const store = new MemoryPremiumStore(); store.now = () => NOW;
    const seen: any[] = [];
    const d = deps(FIXTURES[0]!, store, { paid: 0, signed: 0 });
    const inner = d.sign!;
    d.sign = async (r, n) => { seen.push(r); return inner(r, n); };
    await runSellerDd({ resource: "https://seller.example.com/api", request_id: "i1", deadline: NOW + 45_000 }, d);
    expect(seen[0].pinnedPayTo).toBe(PAYTO);
    expect(seen[0].remainingAtomic).toBe(10_000n);
    expect(seen[0].value).toBe(10_000n);
  });
  it("INFO-2: unconfirmed loss is tagged and released (with a 'released' entry) when the cron confirms the nonce unused", async () => {
    const store = new MemoryPremiumStore(); store.now = () => NOW;
    const fx: Fx = { ...FIXTURES[0]!, landed: "unknown" };
    const out = await runSellerDd({ resource: "https://seller.example.com/api", request_id: "u1", deadline: NOW + 45_000 }, deps(fx, store, { paid: 0, signed: 0 }));
    expect(out.pass).toBe(false);
    expect(Number(await store.get(ddKeys.lossUsd(NOW)))).toBeCloseTo(0.01);
    const entries = await store.zrangeByScore(ddKeys.loss(NOW), Number.MAX_SAFE_INTEGER, 10);
    expect(JSON.parse(entries[0]!).status).toBe("unconfirmed");
    const { reconcileOpen } = await import("@/lib/seller-dd/caps");
    const later = NOW + 600_000; store.now = () => later;
    expect(await reconcileOpen(store, async () => "unused", later)).toMatchObject({ released: 1 });
    expect(Number(await store.get(ddKeys.lossUsd(NOW)))).toBeCloseTo(0);
    const all = (await store.zrangeByScore(ddKeys.loss(NOW), Number.MAX_SAFE_INTEGER, 10)).map((e) => JSON.parse(e).status);
    expect(all).toEqual(["unconfirmed", "released"]);
  });
  it("replay set has >= 10 sellers", () => expect(FIXTURES.length).toBeGreaterThanOrEqual(10));
  it("per-host cap: 4th request to the same host in a day is not paid", async () => {
    const store = new MemoryPremiumStore(); store.now = () => NOW;
    const fx = FIXTURES[0]!;
    const calls = { paid: 0, signed: 0 };
    for (let k = 0; k < 4; k++) await runSellerDd({ resource: "https://seller.example.com/api", request_id: `q${k}`, deadline: NOW + 45_000 }, deps(fx, store, calls));
    expect(calls.paid).toBe(3);
  });
});
