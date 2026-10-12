/**
 * XRPL mainnet finish (branch xrpl-replay-store): mainnet fails closed without
 * the shared Upstash replay store; validated-tx lookup retries with bounded
 * backoff; settled payments are self-verified against the validated ledger.
 * Offline: RPC stubbed, nothing signed or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_MAINNET_ISSUER,
  XRPL_PAYTO,
  hasSharedReplayStoreEnv,
  type XrplRailConfig,
} from "@/lib/xrpl-config";
import {
  __setXrplRpcForTests,
  __setXrplTxLookupDelaysForTests,
  getXrplAccept,
  lookupValidatedTx,
  resetXrplRailForTests,
  setXrplReplayStoreForTests,
  verifySettledTx,
  xrplReplayStoreKind,
} from "@/lib/xrpl-rail";
import { MemoryReplayStore } from "@/lib/xrpl-replay-store";

const MAINNET: XrplRailConfig = {
  network: "xrpl:0",
  payTo: XRPL_PAYTO,
  asset: RLUSD_CURRENCY_HEX,
  issuer: RLUSD_MAINNET_ISSUER,
  facilitatorUrl: "https://example.invalid",
  rpcUrl: "https://xrplcluster.com/",
  initTimeoutMs: 1000,
};
const HASH = "A".repeat(64);
const cmp = (a: string, b: string) => {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("bad");
  return x === y ? 0 : x < y ? -1 : 1;
};
const REQ = { payTo: XRPL_PAYTO, amount: "0.005", asset: RLUSD_CURRENCY_HEX, extra: { issuer: RLUSD_MAINNET_ISSUER } };
const goodTx = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  validated: true,
  status: "success",
  tx_json: { TransactionType: "Payment", Destination: XRPL_PAYTO, ...over },
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_MAINNET_ISSUER, value: "0.005" }, ...meta },
});

beforeEach(() => resetXrplRailForTests());
afterEach(() => {
  __setXrplRpcForTests(null);
  __setXrplTxLookupDelaysForTests(null);
  vi.unstubAllEnvs();
});

describe("mainnet replay-store guard (fail closed)", () => {
  it("hasSharedReplayStoreEnv needs both vars and an https URL", () => {
    expect(hasSharedReplayStoreEnv({})).toBe(false);
    expect(hasSharedReplayStoreEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" })).toBe(false);
    expect(hasSharedReplayStoreEnv({ UPSTASH_REDIS_REST_TOKEN: "t" })).toBe(false);
    expect(hasSharedReplayStoreEnv({ UPSTASH_REDIS_REST_URL: "http://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" })).toBe(false);
    expect(hasSharedReplayStoreEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" })).toBe(true);
  });

  it("xrpl:0 with the in-memory store: no accepts entry, no RPC/facilitator touched", async () => {
    setXrplReplayStoreForTests(new MemoryReplayStore());
    expect(xrplReplayStoreKind()).toBe("memory");
    const rpc = vi.fn(async () => ({}));
    __setXrplRpcForTests(rpc);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getXrplAccept(MAINNET, "5000")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("shared replay store"))).toBe(true);
    warn.mockRestore();
  });
});

describe("validated-tx lookup retry (bounded backoff)", () => {
  it("retries txnNotFound / not-validated, then returns the validated result", async () => {
    __setXrplTxLookupDelaysForTests([0, 1, 1, 1]);
    const answers = [{ status: "error", error: "txnNotFound" }, { validated: false, status: "success" }, goodTx()];
    const rpc = vi.fn(async () => answers.shift());
    __setXrplRpcForTests(rpc);
    const r = await lookupValidatedTx(MAINNET, HASH);
    expect(r?.validated).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("gives up after the bounded number of tries (throws and not-found)", async () => {
    __setXrplTxLookupDelaysForTests([0, 1, 1, 1]);
    const rpc = vi.fn(async () => {
      throw new Error("down");
    });
    __setXrplRpcForTests(rpc);
    expect(await lookupValidatedTx(MAINNET, HASH)).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it("bad hash: no RPC call", async () => {
    const rpc = vi.fn();
    __setXrplRpcForTests(rpc as never);
    expect(await lookupValidatedTx(MAINNET, "zz")).toBeNull();
    expect(await lookupValidatedTx(MAINNET, undefined)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("ledger self-verification of a settled payment", () => {
  it("accepts the exact RLUSD delivery to payTo", () => {
    expect(verifySettledTx(goodTx() as never, REQ, cmp)).toBe("ok");
    expect(verifySettledTx(goodTx({}, { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_MAINNET_ISSUER, value: "0.0050" } }) as never, REQ, cmp)).toBe("ok");
  });
  it.each([
    ["missing", { validated: true }],
    ["result_not_tessuccess", goodTx({}, { TransactionResult: "tecPATH_PARTIAL" })],
    ["not_payment", goodTx({ TransactionType: "OfferCreate" })],
    ["destination_mismatch", goodTx({ Destination: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" })],
    ["unexpected_destination_tag", goodTx({ DestinationTag: 1 })],
    ["delivered_not_issued", goodTx({}, { delivered_amount: "5000" })],
    ["delivered_currency_mismatch", goodTx({}, { delivered_amount: { currency: "USD", issuer: RLUSD_MAINNET_ISSUER, value: "0.005" } })],
    ["delivered_issuer_mismatch", goodTx({}, { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: XRPL_PAYTO, value: "0.005" } })],
    ["delivered_amount_mismatch", goodTx({}, { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_MAINNET_ISSUER, value: "0.004" } })],
    ["delivered_value_unparseable", goodTx({}, { delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_MAINNET_ISSUER, value: "x" } })],
  ])("%s", (want, r) => {
    expect(verifySettledTx(r as never, REQ, cmp)).toBe(want);
  });
});
