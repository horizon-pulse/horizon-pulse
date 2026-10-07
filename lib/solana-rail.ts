/**
 * Solana batch-settlement rail (x402 `batch-settlement` via @x402/svm 2.28.0, PayAI facilitator).
 * Scope: Odin + Michael 2026-10-07. Base per-call (`exact`, CDP) stays FIRST on every route;
 * Bazaar indexing and refunds of record stay on CDP/Base. PayAI is used for this rail only.
 *
 * OFF unless ALL are set (none are set anywhere today):
 *   SOLANA_BATCH_ENABLED=1
 *   SOLANA_BATCH_PAY_TO           Michael's Ledger Solana address (placeholder; he sends it,
 *                                 confirms with his passphrase; never hardcoded)
 *   SOLANA_BATCH_OPERATOR_KEY     voucher operator signer, base58 or JSON byte array (placeholder)
 *   SOLANA_BATCH_AUTHORIZER_KEY   receiverAuthorizer signer, same format (placeholder)
 *   SOLANA_BATCH_REDIS_URL        durable ChannelStore + BatchOperationStore (memory refused)
 * Network: SOLANA_BATCH_NETWORK=devnet (default) | mainnet. Mainnet additionally needs
 * SOLANA_BATCH_ALLOW_MAINNET=1, which is gated on Michael's passphrase confirm + Odin Class A.
 * NOTE (2026-10-07): PayAI /supported lists batch-settlement on Solana MAINNET only, so on
 * devnet the rail advertises nothing and stays inert.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { BatchSvmScheme, type BatchOperation, type BatchOperationStore, type ChannelState, type ChannelStore } from "@x402/svm/batch-settlement/server";
import { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from "@solana/kit";

export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network" as const;
/** Same polling routes as the Base spike (plan section 2). Same prices as exact. */
export const SOLANA_BATCH_ROUTES = ["/api/pulse", "/api/gas", "/api/funding", "/api/signals"] as const;

type Env = { network: Network; payTo: string; operatorKey: string; authorizerKey: string; redisUrl: string };

function readEnv(): Env | null {
  if (process.env.SOLANA_BATCH_ENABLED?.trim() !== "1") return null;
  const payTo = process.env.SOLANA_BATCH_PAY_TO?.trim();
  const operatorKey = process.env.SOLANA_BATCH_OPERATOR_KEY?.trim();
  const authorizerKey = process.env.SOLANA_BATCH_AUTHORIZER_KEY?.trim();
  const redisUrl = process.env.SOLANA_BATCH_REDIS_URL?.trim();
  if (!payTo || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo)) return null;
  if (!operatorKey || !authorizerKey || !redisUrl) return null;
  const net = (process.env.SOLANA_BATCH_NETWORK ?? "devnet").trim().toLowerCase();
  if (net === "mainnet" && process.env.SOLANA_BATCH_ALLOW_MAINNET?.trim() !== "1") return null;
  const network = (net === "mainnet" ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2) as Network;
  return { network, payTo, operatorKey, authorizerKey, redisUrl };
}

export function solanaRailEnabled(): boolean {
  return readEnv() !== null;
}
export function solanaNetwork(): Network | null {
  return readEnv()?.network ?? null;
}

async function signerFrom(key: string): Promise<KeyPairSigner> {
  const bytes = key.startsWith("[") ? Uint8Array.from(JSON.parse(key)) : Uint8Array.from(getBase58Encoder().encode(key));
  return createKeyPairSignerFromBytes(bytes);
}

/* ---------- Redis-backed stores (bigint-safe JSON, SET NX lock for atomic update) ---------- */
type RedisLike = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, o?: { NX?: true; PX?: number }): Promise<string | null>;
  del(k: string): Promise<number>;
  scanIterator(o: { MATCH?: string; COUNT?: number }): AsyncIterable<string | string[]>;
};
const enc = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $big: x.toString() } : x));
const dec = <T>(s: string | null): T | undefined =>
  s == null ? undefined : (JSON.parse(s, (_k, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x)) as T);

async function withLock<T>(r: RedisLike, key: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${key}:lock`;
  for (let i = 0; i < 200; i++) {
    if (await r.set(lock, "1", { NX: true, PX: 10_000 })) {
      try { return await fn(); } finally { await r.del(lock); }
    }
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`lock timeout ${key}`);
}

export class RedisSvmChannelStore implements ChannelStore {
  constructor(private readonly r: RedisLike, private readonly prefix: string) {}
  private k(id: string) { return `${this.prefix}ch:${id}`; }
  async get(id: string) { return dec<ChannelState>(await this.r.get(this.k(id))); }
  async put(s: ChannelState) { await this.r.set(this.k(s.channelId), enc(s)); }
  async update(id: string, fn: (c: ChannelState | undefined) => ChannelState | Promise<ChannelState>) {
    return withLock(this.r, this.k(id), async () => { const n = await fn(await this.get(id)); await this.put(n); return n; });
  }
  async list() {
    const out: ChannelState[] = [];
    for await (const keys of this.r.scanIterator({ MATCH: `${this.prefix}ch:*`, COUNT: 100 })) {
      for (const key of ([] as string[]).concat(keys)) {
        if (key.endsWith(":lock")) continue;
        const v = dec<ChannelState>(await this.r.get(key)); if (v) out.push(v);
      }
    }
    return out;
  }
}

export class RedisSvmOperationStore implements BatchOperationStore {
  constructor(private readonly r: RedisLike, private readonly prefix: string) {}
  private k(c: string, q: string) { return `${this.prefix}op:${c}:${q}`; }
  async get(c: string, q: string) { return dec<BatchOperation>(await this.r.get(this.k(c, q))); }
  async reserve(c: string, q: string, ceiling: bigint) {
    return withLock(this.r, this.k(c, q), async () => {
      const cur = await this.get(c, q);
      if (cur) return { created: false, operation: cur };
      const op: BatchOperation = { status: "reserved", channelId: c, requestId: q, ceiling };
      await this.r.set(this.k(c, q), enc(op));
      return { created: true, operation: op };
    });
  }
  async complete(op: Extract<BatchOperation, { status: "completed" }>) { await this.r.set(this.k(op.channelId, op.requestId), enc(op)); }
  async release(c: string, q: string) {
    await withLock(this.r, this.k(c, q), async () => { const cur = await this.get(c, q); if (cur?.status === "reserved") await this.r.del(this.k(c, q)); });
  }
}

function lazyRedis(url: string): RedisLike {
  let p: Promise<RedisLike> | null = null;
  const g = () => (p ??= (async () => {
    const mod = "redis";
    const { createClient } = (await import(/* webpackIgnore: true */ mod)) as { createClient: (o: { url: string }) => RedisLike & { connect(): Promise<unknown> } };
    const c = createClient({ url }); await c.connect(); return c;
  })());
  return {
    get: async (k) => (await g()).get(k),
    set: async (k, v, o) => (await g()).set(k, v, o),
    del: async (k) => (await g()).del(k),
    scanIterator: (o) => ({ async *[Symbol.asyncIterator]() { yield* (await g()).scanIterator(o); } }),
  };
}

let cached: Promise<{ scheme: BatchSvmScheme; channelStore: RedisSvmChannelStore; network: Network; payTo: string }> | null = null;

/** Async because Solana key signers are WebCrypto-backed. */
export function getSolanaRail() {
  const env = readEnv();
  if (!env) throw new Error("solana rail disabled (SOLANA_BATCH_* env not set)");
  return (cached ??= (async () => {
    const r = lazyRedis(env.redisUrl);
    const prefix = `hp:svmbatch:${env.network}:`;
    const channelStore = new RedisSvmChannelStore(r, prefix);
    const scheme = new BatchSvmScheme({
      store: channelStore,
      operationStore: new RedisSvmOperationStore(r, prefix),
      operator: await signerFrom(env.operatorKey),
      receiverAuthorizer: await signerFrom(env.authorizerKey),
      withdrawDelay: 86_400,
    });
    return { scheme, channelStore, network: env.network, payTo: env.payTo };
  })());
}

export function payaiFacilitator(): HTTPFacilitatorClient {
  return new HTTPFacilitatorClient({ url: PAYAI_FACILITATOR_URL });
}

/** Append the Solana batch option AFTER the Base exact entries (Base per-call stays first). */
export function withSolanaAccept<T extends object>(path: string, price: string, accepts: T[]): T[] {
  const env = readEnv();
  if (!env || !(SOLANA_BATCH_ROUTES as readonly string[]).includes(path)) return accepts;
  return [...accepts, { scheme: "batch-settlement", price, network: env.network, payTo: env.payTo } as unknown as T];
}
