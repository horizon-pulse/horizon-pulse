#!/usr/bin/env node
/**
 * Paid smoke test for Horizon Pulse GET /api/pulse (x402 on Base).
 *
 * Run (Mac mini / any Node 20+ machine with deps installed):
 *   cd horizon-pulse
 *   SMOKE_PRIVATE_KEY=0x... node scripts/smoke-pulse.mjs
 *
 * Optional:
 *   SMOKE_BASE_URL=https://horizon-pulse-seven.vercel.app
 *   BASE_RPC_URL=https://mainnet.base.org
 *
 * NEVER paste your private key into chat, commits, or screenshots.
 */

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const EXPECTED_PAY_TO = "0x5b32c973596078a967562ca652761404f19be0e9";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EXPECTED_ATOMIC = "5000"; // $0.005 USDC (6 decimals)
const EXPECTED_PRICE_USD = "$0.005";

const BASE_URL = (
  process.env.SMOKE_BASE_URL?.trim() ||
  "https://horizon-pulse-seven.vercel.app"
).replace(/\/$/, "");
const RPC_URL =
  process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const PULSE_URL = `${BASE_URL}/api/pulse`;

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function fail(msg, detail) {
  console.error(`\nERROR: ${msg}`);
  if (detail !== undefined) {
    if (typeof detail === "string") console.error(detail);
    else console.error(JSON.stringify(detail, null, 2));
  }
  process.exit(1);
}

function snippet(value, max = 800) {
  const s =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more chars)`;
}

function normalizeAddr(a) {
  return (a || "").trim().toLowerCase();
}

async function readUsdcBalance(address) {
  const client = createPublicClient({
    chain: base,
    transport: http(RPC_URL, { timeout: 15_000 }),
  });
  const raw = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return {
    atomic: raw.toString(),
    usdc: formatUnits(raw, 6),
  };
}

function loadPrivateKey() {
  const raw = process.env.SMOKE_PRIVATE_KEY?.trim();
  if (!raw) {
    console.error(`
Horizon Pulse paid smoke test — missing SMOKE_PRIVATE_KEY

Usage:
  SMOKE_PRIVATE_KEY=0x... node scripts/smoke-pulse.mjs

Optional env:
  SMOKE_BASE_URL   (default ${BASE_URL})
  BASE_RPC_URL     (default ${RPC_URL})

Expect unpaid GET ${PULSE_URL} → 402 with
  payTo  ${EXPECTED_PAY_TO}
  price  ${EXPECTED_PRICE_USD} (${EXPECTED_ATOMIC} atomic USDC on Base)

Then EIP-3009 / x402 payment signed with your local key, retry → 200 JSON.

WARN: never paste your private key in chat, git, or tickets.
`);
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    fail(
      "SMOKE_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (66 chars total).",
    );
  }
  return raw;
}

async function main() {
  console.log("=== Horizon Pulse paid smoke: /api/pulse ===");
  console.log(`Target:  ${PULSE_URL}`);
  console.log(`RPC:     ${RPC_URL}`);
  console.log(`USDC:    ${USDC_BASE}`);
  console.log(`Expect:  402 → payTo ${EXPECTED_PAY_TO}, ${EXPECTED_ATOMIC} atomic (${EXPECTED_PRICE_USD})`);

  const pk = loadPrivateKey();
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
  log("wallet", `payer ${account.address}`);

  // --- Step 1: unpaid GET → 402 ---
  log("1/ unpaid", `GET ${PULSE_URL}`);
  const unpaid = await fetch(PULSE_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const unpaidText = await unpaid.text();
  let unpaidBody;
  try {
    unpaidBody = JSON.parse(unpaidText);
  } catch {
    unpaidBody = unpaidText;
  }

  if (unpaid.status !== 402) {
    fail(`Expected HTTP 402 on unpaid GET, got ${unpaid.status}`, unpaidBody);
  }
  log("1/ unpaid", "402 received");

  const accepts = unpaidBody?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    fail("402 body missing accepts[]", unpaidBody);
  }
  const req0 = accepts[0];
  const payTo = normalizeAddr(req0.payTo);
  const amount =
    req0.maxAmountRequired ??
    req0.amount ??
    req0.maxAmount ??
    null;

  console.log(`  payTo:   ${req0.payTo}`);
  console.log(`  amount:  ${amount} atomic`);
  console.log(`  network: ${req0.network}`);
  console.log(`  asset:   ${req0.asset}`);
  console.log(`  scheme:  ${req0.scheme}`);
  console.log(`  x402:    v${unpaidBody.x402Version}`);

  if (payTo !== EXPECTED_PAY_TO) {
    fail(
      `Unexpected payTo: got ${req0.payTo}, expected ${EXPECTED_PAY_TO}`,
      unpaidBody,
    );
  }
  if (String(amount) !== EXPECTED_ATOMIC) {
    fail(
      `Unexpected amount: got ${amount}, expected ${EXPECTED_ATOMIC} atomic (${EXPECTED_PRICE_USD})`,
      unpaidBody,
    );
  }
  if (normalizeAddr(req0.asset) !== normalizeAddr(USDC_BASE)) {
    fail(`Unexpected asset: got ${req0.asset}, expected ${USDC_BASE}`, unpaidBody);
  }
  log("1/ unpaid", `OK — payTo and ${EXPECTED_PRICE_USD} match`);

  // --- Step 2: treasury balance before ---
  let balBefore;
  try {
    balBefore = await readUsdcBalance(/** @type {`0x${string}`} */ (EXPECTED_PAY_TO));
    log(
      "2/ chain",
      `payTo USDC before: ${balBefore.usdc} (${balBefore.atomic} atomic)`,
    );
  } catch (e) {
    console.warn(
      `[2/ chain] WARN: could not read payTo balance before: ${e?.message || e}`,
    );
  }

  // --- Step 3: sign EIP-3009 / x402 payment ---
  log("3/ sign", "Building x402 client (Exact EVM V1+V2) and payment payload");
  const core = new x402Client();
  // registerExactEvmScheme wires ExactEvmScheme (eip155:*) + ExactEvmSchemeV1 (base, …)
  registerExactEvmScheme(core, { signer: account });
  const httpClient = new x402HTTPClient(core);

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    unpaidBody,
  );

  let paymentPayload;
  try {
    paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  } catch (e) {
    fail(`Failed to create/sign payment payload: ${e?.message || e}`, {
      stack: e?.stack,
    });
  }
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  log(
    "3/ sign",
    `Payment header keys: ${Object.keys(paymentHeaders).join(", ") || "(none)"}`,
  );

  // --- Step 4: paid retry ---
  log("4/ paid", "Retry GET with payment signature header");
  const paid = await fetch(PULSE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...paymentHeaders,
    },
  });
  const paidText = await paid.text();
  let paidBody;
  try {
    paidBody = JSON.parse(paidText);
  } catch {
    paidBody = paidText;
  }

  let settlement;
  try {
    settlement = httpClient.getPaymentSettleResponse((name) =>
      paid.headers.get(name),
    );
  } catch {
    settlement = null;
  }

  console.log(`  HTTP status: ${paid.status}`);
  if (settlement) {
    console.log(`  settlement:  ${snippet(settlement, 600)}`);
  } else {
    // Also surface any payment-response / x-payment-response headers raw
    const settleHdr =
      paid.headers.get("payment-response") ||
      paid.headers.get("x-payment-response") ||
      paid.headers.get("PAYMENT-RESPONSE");
    if (settleHdr) console.log(`  settlement header (raw): ${settleHdr.slice(0, 200)}…`);
    else console.log("  settlement:  (no settlement header decoded)");
  }

  if (paid.status === 503) {
    fail(
      "Server returned 503 — CDP settlement likely unavailable (missing CDP keys on Vercel). Body:",
      paidBody,
    );
  }

  if (paid.status !== 200) {
    fail(
      `Expected HTTP 200 after payment, got ${paid.status}. Response body (honest):`,
      paidBody,
    );
  }

  log("4/ paid", "200 OK — market data:");
  console.log(snippet(paidBody, 1200));

  if (!paidBody || typeof paidBody !== "object") {
    fail("200 body was not JSON object", paidBody);
  }
  if (!paidBody.assets && !paidBody.overall) {
    console.warn(
      "[4/ paid] WARN: body missing expected assets/overall fields — printing as-is above",
    );
  } else {
    log("4/ paid", "JSON looks like pulse market data");
  }

  // --- Step 5: on-chain USDC move toward payTo ---
  if (balBefore) {
    log("5/ chain", "Re-reading payTo USDC (allow brief settle lag)");
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const balAfter = await readUsdcBalance(
        /** @type {`0x${string}`} */ (EXPECTED_PAY_TO),
      );
      const delta =
        BigInt(balAfter.atomic) - BigInt(balBefore.atomic);
      console.log(
        `  payTo USDC after:  ${balAfter.usdc} (${balAfter.atomic} atomic)`,
      );
      console.log(`  delta atomic:      ${delta.toString()}`);
      if (delta >= BigInt(EXPECTED_ATOMIC)) {
        log(
          "5/ chain",
          `OK — on-chain USDC toward payTo increased by ≥ ${EXPECTED_ATOMIC}`,
        );
      } else if (delta > 0n) {
        console.warn(
          `[5/ chain] WARN: balance rose by ${delta}, less than ${EXPECTED_ATOMIC} (other activity or partial?).`,
        );
      } else {
        console.warn(
          "[5/ chain] WARN: no balance increase yet — settlement may still be pending, or facilitator settled elsewhere; check settlement header / Basescan.",
        );
        if (settlement?.transaction) {
          console.log(`  settlement.transaction: ${settlement.transaction}`);
        }
      }
    } catch (e) {
      console.warn(
        `[5/ chain] WARN: could not re-read balance: ${e?.message || e}`,
      );
    }
  }

  console.log("\n=== SMOKE PASS ===");
}

main().catch((e) => {
  fail(e?.message || String(e), e?.stack);
});
