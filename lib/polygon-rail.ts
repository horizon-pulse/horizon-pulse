/**
 * Polygon PoS USDC rail runtime (see lib/polygon-config.ts for the flag).
 *
 * Isolation (same contract as the Solana / XRPL rails):
 *   - its OWN x402ResourceServer + facilitator client (CDP on eip155:137,
 *     Polygon's Amoy facilitator on eip155:80002). The shared Base server is
 *     never touched, so Base verify/settle and the Base 402 are unchanged.
 *   - unpaid 402 / OPTIONS: one Polygon entry appended LAST; any failure →
 *     the response unchanged (same object).
 *   - paid: only requests whose PAYMENT-SIGNATURE says accepted.network ===
 *     the configured Polygon network come here; anything wrong → null and the
 *     caller serves the Base-only 402 (payment header removed).
 *   - Replay: EVM `exact` is EIP-3009 transferWithAuthorization; the nonce is
 *     consumed on-chain by USDC itself, so a replayed authorization can never
 *     settle twice (no off-chain replay store needed, unlike XRPL).
 *   - Asset is pinned (native USDC); a payload naming any other asset / payTo /
 *     amount / network is rejected before it reaches the facilitator.
 *   - No Bazaar extension on this server (Bazaar indexes the Base route).
 */
import { createFacilitatorConfig } from "@coinbase/x402";
import type { NextRequest } from "next/server";
import { NextRequest as NextRequestCtor, NextResponse } from "next/server";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RouteConfig, RoutesConfig } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { withX402 } from "@x402/next";
import { runOnPaidRail, type PaidRail } from "./paid-rail";
import { appendAccept, stripBazaar } from "./solana-rail";
import type { PolygonRailConfig } from "./polygon-config";

export const POLYGON_MAX_TIMEOUT_SECONDS = 300;
export const POLYGON_FACILITATOR_TIMEOUT_MS = 20_000;

type AppRouteHandler = (req: NextRequest) => Promise<NextResponse>;

function warn(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message.slice(0, 200)}` : "";
  console.warn(`[polygon] ${msg}${detail}`);
}

export function polygonRail(config: Pick<PolygonRailConfig, "network" | "asset" | "payTo">): PaidRail {
  return { network: config.network, asset: config.asset, payTo: config.payTo };
}

/** The one Polygon requirement for this price (atomic USDC, 6 decimals on every rail). */
export function buildPolygonRequirement(config: PolygonRailConfig, atomicUsdc: string): PaymentRequirements {
  if (!/^[1-9]\d{0,15}$/.test(atomicUsdc)) throw new Error("bad atomic amount");
  return {
    scheme: "exact",
    network: config.network,
    amount: atomicUsdc,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: POLYGON_MAX_TIMEOUT_SECONDS,
    extra: { name: config.eip712.name, version: config.eip712.version },
  } as PaymentRequirements;
}

export async function withPolygonAccept<T extends Response>(res: T, config: PolygonRailConfig, atomicUsdc: string): Promise<T | NextResponse> {
  try {
    return await appendAccept(res, buildPolygonRequirement(config, atomicUsdc));
  } catch (err) {
    warn("could not append Polygon requirement", err);
    return res;
  }
}

export function isPolygonPaymentRequest(req: NextRequest, config: Pick<PolygonRailConfig, "network">): boolean {
  try {
    const raw = req.headers.get("payment-signature");
    if (!raw || !raw.trim()) return false;
    const p = decodePaymentSignatureHeader(raw.trim()) as Partial<PaymentPayload>;
    return p?.x402Version === 2 && p?.accepted?.network === config.network;
  } catch {
    return false;
  }
}

/** Same route keys/metadata; the only accept is the Polygon one; NO extensions. */
export function buildPolygonOnlyRoutes(config: PolygonRailConfig, routes: RoutesConfig, atomicUsdc: string): RoutesConfig {
  const out: Record<string, RouteConfig> = {};
  for (const [key, cfg] of Object.entries(routes as Record<string, RouteConfig>)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extensions: _bazaar, ...rest } = cfg;
    out[key] = {
      ...rest,
      accepts: [
        {
          scheme: "exact",
          network: config.network,
          payTo: config.payTo,
          price: { amount: atomicUsdc, asset: config.asset, extra: { name: config.eip712.name, version: config.eip712.version } },
          maxTimeoutSeconds: POLYGON_MAX_TIMEOUT_SECONDS,
        },
      ],
    } as RouteConfig;
  }
  return out;
}

export type WireCheck = { ok: true } | { ok: false; reason: string };
export function validatePolygonPaymentPayload(payload: PaymentPayload, req: PaymentRequirements): WireCheck {
  if (!payload || payload.x402Version !== 2) return { ok: false, reason: "x402Version must be 2" };
  const a = payload.accepted as PaymentRequirements | undefined;
  if (!a) return { ok: false, reason: "no accepted" };
  for (const f of ["scheme", "network", "amount", "maxTimeoutSeconds"] as const)
    if (a[f] !== req[f]) return { ok: false, reason: `accepted.${f} does not match` };
  for (const f of ["asset", "payTo"] as const)
    if (typeof a[f] !== "string" || a[f].toLowerCase() !== String(req[f]).toLowerCase()) return { ok: false, reason: `accepted.${f} does not match` };
  return { ok: true };
}

let server: { key: string; server: x402ResourceServer; ready: Promise<void> | null } | null = null;
let handlers = new WeakMap<object, { key: string; handler: AppRouteHandler }>();

export function resetPolygonRailForTests(): void {
  server = null;
  handlers = new WeakMap();
}

function getServer(config: PolygonRailConfig): x402ResourceServer {
  const key = `${config.network}|${config.facilitator}`;
  if (server && server.key === key) return server.server;
  const facCfg =
    config.facilitator === "cdp"
      ? createFacilitatorConfig(process.env.CDP_API_KEY_ID?.trim() || undefined, process.env.CDP_API_KEY_SECRET?.trim() || undefined)
      : { url: config.facilitator };
  const s = new x402ResourceServer(new HTTPFacilitatorClient({ ...facCfg, timeoutMs: POLYGON_FACILITATOR_TIMEOUT_MS })).register(
    config.network,
    new ExactEvmScheme(),
  );
  server = { key, server: s, ready: null };
  return s;
}

async function ensureReady(config: PolygonRailConfig): Promise<x402ResourceServer | null> {
  const s = getServer(config);
  const entry = server!;
  if (!entry.ready) {
    entry.ready = s.initialize().catch((err) => {
      entry.ready = null; // retry next request
      throw err;
    });
  }
  try {
    await entry.ready;
    return s;
  } catch (err) {
    warn("facilitator sync failed; Polygon payment falls back to Base 402", err);
    return null;
  }
}

function withPaymentSignature(req: NextRequest, payload: PaymentPayload): NextRequest {
  const headers = new Headers(req.headers);
  headers.set("payment-signature", encodePaymentSignatureHeader(payload));
  headers.delete("x-payment");
  return new NextRequestCtor(req.url, { method: req.method, headers, body: req.body, duplex: "half" } as never);
}

/**
 * Verify + run handler + settle on the Polygon-only server. null → caller serves
 * the Base-only 402. A non-402 response (200, or a handler error) is returned.
 */
export async function handlePolygonPayment(
  req: NextRequest,
  routeHandler: AppRouteHandler,
  routes: RoutesConfig,
  atomicUsdc: string,
  config: PolygonRailConfig,
): Promise<NextResponse | null> {
  try {
    const s = await ensureReady(config);
    if (!s) return null;
    const requirement = buildPolygonRequirement(config, atomicUsdc);
    const payload = stripBazaar(decodePaymentSignatureHeader(req.headers.get("payment-signature")!.trim()) as PaymentPayload);
    const check = validatePolygonPaymentPayload(payload, requirement);
    if (!check.ok) {
      warn(`rejected Polygon payload before facilitator (${check.reason})`);
      return null;
    }
    const key = `${config.network}|${config.facilitator}|${atomicUsdc}`;
    let entry = handlers.get(routes as object);
    if (!entry || entry.key !== key) {
      entry = {
        key,
        handler: withX402(
          runOnPaidRail(() => polygonRail(config), routeHandler),
          buildPolygonOnlyRoutes(config, routes, atomicUsdc),
          s,
          undefined,
          undefined,
          false, // already initialized above
        ) as AppRouteHandler,
      };
      handlers.set(routes as object, entry);
    }
    const res = await entry.handler(withPaymentSignature(req, payload));
    if (res.status === 402) {
      warn("Polygon verify/settle refused; serving Base 402");
      return null;
    }
    return res;
  } catch (err) {
    warn("Polygon paid path threw; serving Base 402", err);
    return null;
  }
}
