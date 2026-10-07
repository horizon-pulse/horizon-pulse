/**
 * SPIKE (Base Sepolia only, TESTNET): x402 `batch-settlement` rail next to the
 * existing per-call `exact` pricing. Odin redirect 2026-10-07, Michael approved
 * draft/spike only. NOT for mainnet. Do not merge without Odin Class A sign-off.
 *
 * Disabled unless ALL are set:
 *   BATCH_SPIKE_ENABLED=1
 *   BATCH_SPIKE_RECEIVER          0x… Base Sepolia payTo (placeholder; Michael provides)
 *   BATCH_SPIKE_AUTHORIZER_KEY    receiverAuthorizer signing key (placeholder; needs
 *                                 Michael's passphrase to create; never committed)
 *   BATCH_SPIKE_REDIS_URL         durable channel storage (Redis/Upstash). In-memory is
 *                                 refused because Vercel functions are not durable.
 * No key, wallet or address is created or hardcoded here.
 */
import type { Network } from "@x402/core/types";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import {
  RedisChannelStorage,
  type RedisChannelStorageClient,
} from "@x402/evm/batch-settlement/server/redis-storage";
import { privateKeyToAccount } from "viem/accounts";

export const BASE_SEPOLIA_CAIP2 = "eip155:84532" as Network;
/** Routes that suit repeat polling (see plan section 2). */
export const BATCH_SPIKE_ROUTES = ["/api/pulse", "/api/gas", "/api/funding", "/api/signals"] as const;
/** Spike keeps the same price as exact; sub-cent ideas stay in the plan until approved. */
const WITHDRAW_DELAY_SECS = 86_400;

type Env = { receiver: `0x${string}`; authorizerKey: `0x${string}`; redisUrl: string };

function readEnv(): Env | null {
  if (process.env.BATCH_SPIKE_ENABLED?.trim() !== "1") return null;
  const receiver = process.env.BATCH_SPIKE_RECEIVER?.trim().toLowerCase();
  const authorizerKey = process.env.BATCH_SPIKE_AUTHORIZER_KEY?.trim();
  const redisUrl = process.env.BATCH_SPIKE_REDIS_URL?.trim();
  if (!receiver || !/^0x[a-f0-9]{40}$/.test(receiver)) return null;
  if (!authorizerKey || !/^0x[a-fA-F0-9]{64}$/.test(authorizerKey)) return null;
  if (!redisUrl) return null;
  return { receiver: receiver as `0x${string}`, authorizerKey: authorizerKey as `0x${string}`, redisUrl };
}

export function batchSpikeEnabled(): boolean {
  return readEnv() !== null;
}

/** Lazy Redis adapter: connects on first use, so module load never opens a socket. */
function lazyRedis(url: string): RedisChannelStorageClient {
  let clientP: Promise<RedisChannelStorageClient> | null = null;
  const get = () => {
    clientP ??= (async () => {
      // `redis` (node-redis v4+) is NOT a dependency yet; add it on this branch
      // before a testnet run. Indirect specifier keeps typecheck/build green.
      const mod = "redis";
      const { createClient } = (await import(/* webpackIgnore: true */ mod)) as {
        createClient: (o: { url: string }) => RedisChannelStorageClient & { connect(): Promise<unknown> };
      };
      const c = createClient({ url });
      await c.connect();
      return c;
    })();
    return clientP;
  };
  return {
    get: async (k) => (await get()).get(k),
    set: async (k, v, o) => (await get()).set(k, v, o),
    del: async (k) => (await get()).del(k),
    eval: async (s, o) => (await get()).eval(s, o),
    scanIterator: (o) => ({
      async *[Symbol.asyncIterator]() {
        yield* (await get()).scanIterator(o);
      },
    }),
  };
}

let cached: BatchSettlementEvmScheme | null = null;

export function getBatchScheme(): BatchSettlementEvmScheme {
  const env = readEnv();
  if (!env) throw new Error("batch spike disabled (BATCH_SPIKE_* env not set)");
  if (cached) return cached;
  const account = privateKeyToAccount(env.authorizerKey);
  cached = new BatchSettlementEvmScheme(env.receiver, {
    storage: new RedisChannelStorage({ client: lazyRedis(env.redisUrl), keyPrefix: "hp:batch:sepolia:" }),
    receiverAuthorizerSigner: {
      address: account.address,
      signTypedData: (p) => account.signTypedData(p as Parameters<typeof account.signTypedData>[0]),
    },
    withdrawDelay: WITHDRAW_DELAY_SECS,
  });
  return cached;
}

export function getBatchReceiver(): `0x${string}` | null {
  return readEnv()?.receiver ?? null;
}

/**
 * Append a Base Sepolia batch-settlement option to a route's accepts when the
 * spike is enabled. The mainnet `exact` entries are untouched and stay first.
 */
export function withBatchAccept<T extends object>(path: string, price: string, accepts: T[]): T[] {
  const receiver = getBatchReceiver();
  if (!receiver || !(BATCH_SPIKE_ROUTES as readonly string[]).includes(path)) return accepts;
  return [
    ...accepts,
    { scheme: "batch-settlement", price, network: BASE_SEPOLIA_CAIP2, payTo: receiver } as unknown as T,
  ];
}
