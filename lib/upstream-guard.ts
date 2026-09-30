import { NextResponse } from "next/server";

/**
 * No-charge guard: when a required USD mark is missing because an upstream
 * price source failed, return 503 so the x402 wrapper (REST: status >= 400;
 * MCP: isError) does not settle. We don't charge for broken data.
 *
 * Symbols listed in NULL_BY_DESIGN are disclosed as unpriced in methodology
 * (no keyless direct quote) and never trip the guard.
 */
export const NULL_BY_DESIGN = new Set<string>(["cbBTC"]);

export function upstreamUnavailable(
  route: string,
  missing: string[],
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "upstream_price_unavailable",
      message: `Required USD mark(s) unavailable from upstream price sources: ${missing.join(", ")}. Not charged; retry shortly.`,
      route,
      missing,
      charged: false,
      ...extra,
    },
    { status: 503, headers: { "Retry-After": "60" } },
  );
}

export function isMissing(v: unknown): boolean {
  return typeof v !== "number" || !Number.isFinite(v);
}
