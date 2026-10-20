import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_BASE_DOMAIN } from "@/lib/premium/payment";
import { DD_DESCRIPTION, DD_NOTICE } from "@/lib/seller-dd/config";
import { registrableDomain, screenLists, screenPayTo } from "@/lib/seller-dd/screen";
import { ALLOWED_SIGN_KIND, freshNonce, signPolicyError, signTestAuthorization, testerStatus, type SignRequest } from "@/lib/seller-dd/testpay";
import { RECEIPT_PREFIX, receiptMessage, receiptPublicKeys, signReceipt, verifyReceipt } from "@/lib/receipt-signer";

const A = (n: string) => `0x${n.repeat(40).slice(0, 40)}`;
const PAYTO = A("ab12");
const NOW = 1_800_000_000n;
const base = (o: Partial<SignRequest> = {}): SignRequest => ({ kind: ALLOWED_SIGN_KIND, requestedDomain: { name: "USD Coin", version: "2" }, network: "eip155:8453", asset: USDC_BASE, to: PAYTO, pinnedPayTo: PAYTO, value: 10_000n, remainingAtomic: 100_000n, validAfter: 0n, validBefore: NOW + 240n, ...o });

describe("seller-dd copy (Counsel)", () => {
  it("402 description is under 500 chars and carries Counsel's exact sentences", () => {
    expect(DD_DESCRIPTION.length).toBeLessThan(500);
    expect(DD_DESCRIPTION).toContain("Facts, not endorsement; no warranty. Not affiliated with the seller checked. $5.");
    expect(DD_DESCRIPTION).toContain("No charge unless the test payment succeeds and at least 3 of the other 4 checks complete.");
  });
  it("notice is verbatim (D1 contact)", () => {
    expect(DD_NOTICE).toBe("Technical facts as observed at checked_at, with evidence. Not an endorsement, rating, recommendation or warranty. Horizon Pulse is not affiliated with the seller checked. Not financial advice. Disputes or corrections: horizonpulse.co@proton.me.");
  });
  it("no characterising words in copy (Counsel §6)", () => {
    for (const w of ["scam", "fraud", "trustworthy", " safe"]) expect(`${DD_DESCRIPTION} ${DD_NOTICE}`.toLowerCase()).not.toContain(w);
  });
});

describe("screen (exact strings + L-4 similarity)", () => {
  const env = { HP_DD_DENYLIST: A("dead"), HP_DD_OWN_ADDRESSES: A("0aa0") };
  const lists = screenLists(env)!;
  it("unset or malformed lists -> unavailable (fail closed)", () => {
    expect(screenLists({})).toBeNull();
    expect(screenLists({ HP_DD_DENYLIST: "0x12", HP_DD_OWN_ADDRESSES: A("0aa0") })).toBeNull();
  });
  it("exact denylist (case-normalised) -> fail, no pay", () => expect(screenPayTo(A("DEAD"), lists)).toMatchObject({ result: "fail", pay_allowed: false, code: "payto_on_denylist" }));
  it("our own payTo -> fail, no pay", () => expect(screenPayTo(DEFAULT_PAY_TO, lists)).toMatchObject({ pay_allowed: false, code: "payto_is_own_address" }));
  it("prefix-4/suffix-4 lookalike of our payTo -> warn, NO PAY, never allow", () => {
    const look = `0x${DEFAULT_PAY_TO.slice(2, 6)}${"7".repeat(32)}${DEFAULT_PAY_TO.slice(-4)}`;
    expect(screenPayTo(look, lists)).toMatchObject({ result: "warn", pay_allowed: false });
  });
  it("prefix-only similarity is not a match (no prefix matching)", () => {
    const p = `0x${DEFAULT_PAY_TO.slice(2, 6)}${"7".repeat(36)}`;
    expect(screenPayTo(p, lists).pay_allowed).toBe(true);
  });
  it("L-2 registrable domain", () => {
    expect(registrableDomain("api.a.example.com")).toBe("example.com");
    expect(registrableDomain("x.y.example.co.uk")).toBe("example.co.uk");
  });
});

describe("C1 signing scope", () => {
  it.each(["permit", "approve", "permit2", "setApprovalForAll", "increaseAllowance", "raw_transaction", "personal_sign", "typed_data"])("refuses %s", (kind) => {
    expect(signPolicyError(base({ kind }), NOW)).toBe("signing_scope_refused");
  });
  it("value over $0.10, over remaining reservation, zero -> refuse", () => {
    expect(signPolicyError(base({ value: 100_001n }), NOW)).toBe("value_over_cap");
    expect(signPolicyError(base({ value: 50_000n, remainingAtomic: 40_000n }), NOW)).toBe("value_over_cap");
    expect(signPolicyError(base({ value: 0n }), NOW)).toBe("value_over_cap");
  });
  it("a 402 'max' amount (uint256 max) is never signed", () => expect(signPolicyError(base({ value: 2n ** 256n - 1n }), NOW)).toBe("value_over_cap"));
  it("wrong chain / asset / domain in 402 extra -> refuse", () => {
    expect(signPolicyError(base({ network: "eip155:1" }), NOW)).toBe("network_not_base");
    expect(signPolicyError(base({ asset: A("1234") }), NOW)).toBe("asset_not_base_usdc");
    expect(signPolicyError(base({ requestedDomain: { name: "USDC", version: "2" } }), NOW)).toBe("domain_mismatch");
    expect(signPolicyError(base({ requestedDomain: { chainId: 1 } }), NOW)).toBe("domain_mismatch");
    expect(signPolicyError(base({ requestedDomain: { verifyingContract: A("9999") } }), NOW)).toBe("domain_mismatch");
  });
  it("validBefore beyond now+5min or past; validAfter in future -> refuse", () => {
    expect(signPolicyError(base({ validBefore: NOW + 301n }), NOW)).toBe("valid_before_out_of_range");
    expect(signPolicyError(base({ validBefore: NOW }), NOW)).toBe("valid_before_out_of_range");
    expect(signPolicyError(base({ validAfter: NOW + 10n }), NOW)).toBe("valid_after_in_future");
  });
  it("to != pinned payTo -> refuse", () => expect(signPolicyError(base({ to: A("cd34") }), NOW)).toBe("to_not_pinned_payto"));
  it("10k nonces unique, 32 bytes, not derived from seller input", () => {
    const s = new Set<string>();
    for (let i = 0; i < 10_000; i++) s.add(freshNonce());
    expect(s.size).toBe(10_000);
    expect([...s][0]).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("signs only TransferWithAuthorization with OUR domain; recovers to the tester", async () => {
    const key = generatePrivateKey();
    const addr = privateKeyToAccount(key).address;
    const env = { HP_DD_TESTER_KEY: key, HP_DD_TESTER_ADDRESS: addr };
    const nonce = freshNonce();
    const r = await signTestAuthorization(base({ requestedDomain: { name: "USD Coin", version: "2" } }), nonce, env, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const who = await recoverTypedDataAddress({ domain: USDC_BASE_DOMAIN, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: { from: addr, to: PAYTO as `0x${string}`, value: 10_000n, validAfter: 0n, validBefore: NOW + 240n, nonce: nonce as `0x${string}` }, signature: r.signature as `0x${string}` });
    expect(who).toBe(addr);
    expect(JSON.stringify(r)).not.toContain(key.slice(2));
  });
  it("derived address mismatch -> tester unavailable, nothing signed", async () => {
    const env = { HP_DD_TESTER_KEY: generatePrivateKey(), HP_DD_TESTER_ADDRESS: A("1111") };
    expect(await testerStatus(env)).toEqual({ ok: false, code: "tester_address_mismatch" });
    expect(await signTestAuthorization(base(), freshNonce(), env, NOW)).toEqual({ ok: false, code: "tester_address_mismatch" });
  });
});

describe("C5 receipt signer", () => {
  const seed = "11".repeat(32);
  const env = { HP_RECEIPT_SIGNING_KEY: seed };
  it("round-trip sign/verify with the published key; tamper fails", () => {
    const body = { v: 1, id: "dd_x", checks: [{ name: "402_parse" }] };
    const sig = signReceipt("seller-dd", body, env);
    const x = receiptPublicKeys(env)!.keys[0]!.x;
    expect(verifyReceipt("seller-dd", body, sig, x)).toBe(true);
    expect(verifyReceipt("seller-dd", { ...body, id: "dd_y" }, sig, x)).toBe(false);
    expect(verifyReceipt("fetch", body, sig, x)).toBe(false);
  });
  it("kind not on allowlist and raw bytes are rejected", () => {
    expect(() => signReceipt("payment" as never, {}, env)).toThrow("receipt_kind_not_allowed");
    expect(() => receiptMessage("seller-dd", Buffer.from("raw"))).toThrow();
    expect(() => receiptMessage("seller-dd", "raw" as never)).toThrow();
  });
  it("message carries the hp-receipt-v1 prefix", () => expect(receiptMessage("seller-dd", { a: 1 }).toString().startsWith(RECEIPT_PREFIX + "seller-dd\n")).toBe(true));
  it("missing key -> fixed error, no key material", () => expect(() => signReceipt("seller-dd", {}, {})).toThrow("receipt_signer_unavailable"));
  it("receipt key is not a payment key (an EVM key in the receipt var is refused)", () => {
    expect(() => signReceipt("seller-dd", {}, { HP_RECEIPT_SIGNING_KEY: generatePrivateKey() })).toThrow("receipt_signer_unavailable");
  });
  it("static: receipt key env read only in lib/receipt-signer; dd-tester key only in lib/seller-dd/testpay", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!/node_modules|\.next|tests/.test(p)) walk(p); } else if (/\.(ts|tsx|mjs|js)$/.test(f)) files.push(p); } };
    walk("lib"); walk("app"); walk("scripts");
    const hits = (needle: string) => files.filter((f) => readFileSync(f, "utf8").includes(needle));
    expect(hits("HP_RECEIPT_SIGNING_KEY")).toEqual([join("lib", "receipt-signer.ts")]);
    expect(hits("HP_DD_TESTER_KEY")).toEqual([join("lib", "seller-dd", "testpay.ts")]);
  });
});
