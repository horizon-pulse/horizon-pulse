/**
 * Shared notarised-receipt signer (seller-dd spec §10, Sentinel C5). ONE engine for every signed Horizon Pulse receipt.
 *
 *  - ed25519 key material in its own env var (HP_RECEIPT_SIGNING_KEY: 32-byte seed as 64 hex chars). It is never derived
 *    from, shared with or reused as any payment key (payTo, premium test, burner, dd-tester, any Solana payer). This module
 *    is the ONLY place that env var is read (static check: tests/seller-dd-unit.test.ts, "static: receipt key env read only ...").
 *  - Signs only a domain-separated message: "hp-receipt-v1\n" + kind + "\n" + sha256(canonical body) (hex).
 *    `kind` must be on the allowlist; raw caller bytes are never signed.
 *  - The key is never printed, logged or written anywhere. Errors carry fixed codes only.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

export const RECEIPT_PREFIX = "hp-receipt-v1\n";
export const RECEIPT_KINDS = ["seller-dd", "fetch"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];
const KEY_ENV = "HP_RECEIPT_SIGNING_KEY";

type Env = Record<string, string | undefined>;
/** PKCS#8 DER prefix for a raw ed25519 seed (RFC 8410). */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** Deterministic JSON: object keys sorted at every depth, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function receiptMessage(kind: string, body: unknown): Buffer {
  if (!(RECEIPT_KINDS as readonly string[]).includes(kind)) throw new Error("receipt_kind_not_allowed");
  if (body === null || typeof body !== "object" || Buffer.isBuffer(body) || body instanceof Uint8Array || Array.isArray(body))
    throw new Error("receipt_body_must_be_object");
  return Buffer.from(`${RECEIPT_PREFIX}${kind}\n${sha256Hex(canonicalJson(body))}`, "utf8");
}

function keys(env: Env): { priv: KeyObject; pub: KeyObject; kid: string } | null {
  const raw = (env[KEY_ENV] ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  try {
    const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(raw, "hex")]), format: "der", type: "pkcs8" });
    const pub = createPublicKey(priv);
    const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
    return { priv, pub, kid: `hp-r1-${sha256Hex(spki).slice(0, 16)}` };
  } catch {
    return null;
  }
}

export function receiptSignerReady(env: Env = process.env): boolean {
  return keys(env) !== null;
}

export type ReceiptSig = { alg: "ed25519"; kid: string; value: string };
/** Throws a fixed-code error (never key material) when the key is missing or the kind/body is refused. */
export function signReceipt(kind: ReceiptKind, body: Record<string, unknown>, env: Env = process.env): ReceiptSig {
  const msg = receiptMessage(kind, body);
  const k = keys(env);
  if (!k) throw new Error("receipt_signer_unavailable");
  return { alg: "ed25519", kid: k.kid, value: edSign(null, msg, k.priv).toString("base64url") };
}

/** Public key set for /.well-known/hp-receipt-keys (x = raw 32-byte key, base64url). */
export function receiptPublicKeys(env: Env = process.env): { keys: { kid: string; kty: "OKP"; crv: "Ed25519"; x: string }[]; message_format: string } | null {
  const k = keys(env);
  if (!k) return null;
  const jwk = k.pub.export({ format: "jwk" }) as { x: string };
  return { keys: [{ kid: k.kid, kty: "OKP", crv: "Ed25519", x: jwk.x }], message_format: 'utf8("hp-receipt-v1\\n" + kind + "\\n" + hex(sha256(canonical_json(body_without_sig))))' };
}

export function verifyReceipt(kind: string, body: Record<string, unknown>, sig: ReceiptSig, publicX: string): boolean {
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicX }, format: "jwk" });
    return edVerify(null, receiptMessage(kind, body), pub, Buffer.from(sig.value, "base64url"));
  } catch {
    return false;
  }
}
