/**
 * Human-readable 402 page for real browser navigations only.
 *
 * Agents and programmatic clients get the exact same 402 as before. A request
 * counts as a browser navigation only when ALL hold:
 *   - Sec-Fetch-Mode: navigate
 *   - Accept explicitly lists text/html
 *   - Accept does not mention json anywhere
 * Accept: *\/*, a missing Accept, or any JSON-listing Accept → unchanged JSON.
 *
 * The PAYMENT-REQUIRED header is taken from the same 402 response, so it is
 * identical in both modes. Static inline HTML: no scripts, no external assets.
 */
import { NextRequest, NextResponse } from "next/server";

export function isBrowserNavigation(req: NextRequest): boolean {
  const mode = (req.headers.get("sec-fetch-mode") ?? "").toLowerCase();
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  return mode === "navigate" && accept.includes("text/html") && !accept.includes("json");
}

/** Copy of req for the x402 library with Accept forced to JSON (library's non-browser path). */
export function asJsonRequest(req: NextRequest): NextRequest {
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json");
  return new NextRequest(req.url, { method: req.method, headers });
}

const VARY = "Accept, Sec-Fetch-Mode";

export function withVary(res: Response): Response {
  if (res.status === 402) {
    const prev = res.headers.get("vary");
    res.headers.set("vary", prev ? `${prev}, ${VARY}` : VARY);
  }
  return res;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function browser402(
  paid: Response,
  info: { resource: string; description: string; priceUsd: string },
): Response {
  const route = info.resource.replace(/^\/api\//, "");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(info.resource)} · Horizon Pulse</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#111}code{background:#f2f2f2;padding:1px 5px;border-radius:4px}.p{font-size:20px;font-weight:600}a{color:#0b57d0}small{color:#555}</style>
</head><body>
<h1>${esc(info.resource)}</h1>
<p>${esc(info.description)}</p>
<p class="p">${esc(info.priceUsd)} per call</p>
<p>This is a paid API for AI agents. Agents pay per call in USDC on Base using the x402 protocol (HTTP 402 + <code>PAYMENT-REQUIRED</code> header). There is no human checkout, signup, or API key.</p>
<p><a href="/api/demo/${esc(route)}">See a free sample of real output</a> · <a href="/llms.txt">Agent docs (llms.txt)</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/">Horizon Pulse</a></p>
<p><small>Status 402 Payment Required. Programmatic clients: read the PAYMENT-REQUIRED response header.</small></p>
</body></html>`;
  const headers = new Headers(paid.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  return new Response(html, { status: paid.status, headers });
}
