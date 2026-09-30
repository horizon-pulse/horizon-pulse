/**
 * /api/screenshot — render a public URL in headless Chromium → PNG/JPEG.
 *
 * SSRF: the top-level URL is checked with assertSafePublicUrl, and EVERY
 * sub-request the page makes (redirects, images, scripts, iframes, fetch/XHR)
 * is intercepted and re-checked; private/local/non-http(s) targets are
 * aborted. WebSocket / WebTransport / WebRTC constructors are removed in
 * every frame before page scripts run, WebRTC non-proxied UDP is disabled,
 * and any WebSocket that still opens (e.g. from a worker) is detected via CDP
 * and fails the render. The top-level host is pinned to the IP we checked
 * (--host-resolver-rules) to close DNS rebinding for the main document.
 *
 * Failures (bad input, blocked host, navigation error/timeout, oversized
 * image) return >=400 so settlement is skipped and the caller is not charged.
 */
import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser } from "puppeteer-core";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertSafePublicUrl, isBlockedIp } from "@/lib/fetch-url";

export const SHOT_NAV_TIMEOUT_MS = 12_000;
/** Whole-call budget (launch + nav + delay + capture), under maxDuration 30. */
export const SHOT_TOTAL_BUDGET_MS = 25_000;
export const SHOT_MAX_HEIGHT = 4_000;
export const SHOT_MAX_BYTES = 3_000_000; // keep base64 JSON under Vercel's 4.5MB response cap
const WIDTH_RANGE = [320, 1920] as const;
const HEIGHT_RANGE = [240, 2000] as const;

export const SCREENSHOT_METHODOLOGY = {
  engine: "Headless Chromium (@sparticuz/chromium + puppeteer-core), fresh browser per call, no cookies or storage kept.",
  load: `Navigates with waitUntil=networkidle2 (${SHOT_NAV_TIMEOUT_MS / 1000}s cap, shortened if the browser launch was slow), then an optional delayMs (max 3000, trimmed to fit) before capture. Whole call is budgeted at ${SHOT_TOTAL_BUDGET_MS / 1000}s; over budget returns 504 (not charged).`,
  limits: `Viewport width ${WIDTH_RANGE[0]}-${WIDTH_RANGE[1]}, height ${HEIGHT_RANGE[0]}-${HEIGHT_RANGE[1]}. fullPage is clipped at ${SHOT_MAX_HEIGHT}px. Image capped at ${SHOT_MAX_BYTES / 1e6}MB (PNG falls back to JPEG q70 if larger).`,
  ssrf: "Covered: the top-level URL and every HTTP(S) sub-request (redirects, assets, iframes, fetch/XHR) are checked and private, loopback, link-local and non-http(s) targets are blocked; the top-level host is pinned to the checked IP (no DNS rebinding for the main document); WebSocket, WebTransport and RTCPeerConnection are removed in every frame before page scripts run; WebRTC non-proxied UDP is disabled; any WebSocket that still opens is detected and fails the render (502, not charged). Remaining: sub-request hosts are checked by a separate DNS lookup from Chromium's (rebinding window for assets), and a WebSocket opened from a worker is detected after it connects, not prevented.",
  billing: "Billed when an image is returned, whatever HTTP status the page itself had (reported as pageStatus). Not billed: bad input, blocked host, navigation failure or timeout, or an image over the cap; those return 400/413/502/504.",
  output: "JSON with the image as base64 (imageBase64) plus mimeType, bytes, width, height, finalUrl, pageStatus, title.",
} as const;

export type ScreenshotResult = {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  pageStatus: number | null;
  title: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  fullPage: boolean;
  bytes: number;
  imageBase64: string;
  blockedRequests: number;
  elapsedMs: number;
};
export type ScreenshotError = { ok: false; error: string; code: string; status: number };

function intParam(v: string | undefined, def: number, [lo, hi]: readonly [number, number]): number | null {
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) return null;
  return n;
}

export async function takeScreenshot(input: {
  url?: string;
  width?: string;
  height?: string;
  fullPage?: string;
  format?: string;
  delayMs?: string;
}): Promise<ScreenshotResult | ScreenshotError> {
  const started = Date.now();
  const raw = input.url?.trim();
  if (!raw) return { ok: false, error: "Query param url is required (absolute http/https URL)", code: "missing_url", status: 400 };
  const width = intParam(input.width, 1280, WIDTH_RANGE);
  const height = intParam(input.height, 800, HEIGHT_RANGE);
  const delayMs = intParam(input.delayMs, 0, [0, 3000]);
  if (width == null || height == null || delayMs == null)
    return { ok: false, error: `width ${WIDTH_RANGE.join("-")}, height ${HEIGHT_RANGE.join("-")}, delayMs 0-3000 (integers)`, code: "bad_param", status: 400 };
  const fmt = (input.format ?? "png").toLowerCase();
  if (fmt !== "png" && fmt !== "jpeg" && fmt !== "jpg") return { ok: false, error: "format must be png or jpeg", code: "bad_param", status: 400 };
  const fullPage = input.fullPage === "true" || input.fullPage === "1";

  const checked = await assertSafePublicUrl(raw);
  if ("ok" in checked && checked.ok === false) return checked;
  const topHost = (checked as { url: URL }).url.hostname;
  // Pin the top-level host to one checked address so Chromium can't re-resolve it privately.
  let pinArg: string | null = null;
  if (!isIP(topHost)) {
    try {
      const a = await lookup(topHost);
      if (isBlockedIp(a.address)) return { ok: false, error: `Host ${topHost} resolves to a blocked address`, code: "host_blocked", status: 400 };
      pinArg = `--host-resolver-rules=MAP ${topHost} ${a.family === 6 ? `[${a.address}]` : a.address}`;
    } catch {
      return { ok: false, error: `DNS lookup failed for ${topHost}`, code: "host_blocked", status: 400 };
    }
  }
  const remaining = () => SHOT_TOTAL_BUDGET_MS - (Date.now() - started);
  const overBudget = (): ScreenshotError => ({ ok: false, error: `Render exceeded the ${SHOT_TOTAL_BUDGET_MS / 1000}s budget`, code: "timeout", status: 504 });

  let browser: Browser | null = null;
  let blocked = 0;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--force-webrtc-ip-handling-policy",
        ...(pinArg ? [pinArg] : []),
      ],
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: { width, height },
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36 HorizonPulseScreenshot/1.0 (+https://horizonpulse.dev)",
    );
    // Remove socket-style APIs in every frame before any page script runs.
    await page.evaluateOnNewDocument(() => {
      const g = globalThis as unknown as Record<string, unknown>;
      for (const k of ["WebSocket", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "Worker", "SharedWorker"]) {
        try {
          Object.defineProperty(g, k, { value: undefined, writable: false, configurable: false });
        } catch {
          /* ignore */
        }
      }
      try {
        const sw = (navigator as unknown as { serviceWorker?: { register?: unknown } }).serviceWorker;
        if (sw) Object.defineProperty(sw, "register", { value: () => Promise.reject(new Error("blocked")) });
      } catch {
        /* ignore */
      }
    });
    // Detect any WebSocket that still gets created (e.g. from a worker).
    let wsOpened: string | null = null;
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", (e: { url: string }) => {
      wsOpened = wsOpened ?? e.url;
    });
    await page.setRequestInterception(true);
    const safeCache = new Map<string, boolean>();
    page.on("request", async (req) => {
      const u = req.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return req.continue();
      let host = "";
      try {
        const p = new URL(u);
        if (p.protocol !== "http:" && p.protocol !== "https:") throw new Error("scheme");
        host = `${p.protocol}//${p.host}`;
      } catch {
        blocked += 1;
        return req.abort("blockedbyclient");
      }
      let ok = safeCache.get(host);
      if (ok === undefined) {
        const c = await assertSafePublicUrl(u);
        ok = !("ok" in c && c.ok === false);
        safeCache.set(host, ok);
      }
      if (!ok) {
        blocked += 1;
        return req.abort("blockedbyclient");
      }
      return req.continue();
    });

    let resp;
    try {
      const navTimeout = Math.min(SHOT_NAV_TIMEOUT_MS, remaining() - 4_000);
      if (navTimeout < 2_000) return overBudget();
      resp = await page.goto(raw, { waitUntil: "networkidle2", timeout: navTimeout });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "navigation failed";
      if (/timeout/i.test(msg)) {
        // networkidle never reached; capture what rendered if the main document loaded
        if (!page.url() || page.url() === "about:blank")
          return { ok: false, error: "Navigation timed out", code: "timeout", status: 504 };
      } else {
        return { ok: false, error: msg.slice(0, 300), code: "navigation_failed", status: 502 };
      }
    }
    const delay = Math.min(delayMs, Math.max(0, remaining() - 4_000));
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (wsOpened) return { ok: false, error: `Page opened a WebSocket (${String(wsOpened).slice(0, 120)}); render refused`, code: "websocket_blocked", status: 502 };
    if (remaining() < 2_000) return overBudget();

    const finalUrl = page.url();
    const title = (await page.title().catch(() => "")) || "";
    let docHeight = height;
    if (fullPage) {
      docHeight = Math.min(
        SHOT_MAX_HEIGHT,
        Math.max(height, (await page.evaluate(() => document.documentElement.scrollHeight).catch(() => height)) as number),
      );
    }
    const clip = { x: 0, y: 0, width, height: docHeight };
    const shoot = async (type: "png" | "jpeg", quality?: number) =>
      Buffer.from(
        await page.screenshot({
          type,
          ...(quality ? { quality } : {}),
          ...(fullPage ? { clip, captureBeyondViewport: true } : {}),
        }),
      );
    let mimeType: ScreenshotResult["mimeType"] = fmt === "png" ? "image/png" : "image/jpeg";
    let buf = fmt === "png" ? await shoot("png") : await shoot("jpeg", 80);
    if (buf.length > SHOT_MAX_BYTES) {
      if (remaining() < 1_500) return overBudget();
      buf = await shoot("jpeg", 70);
      mimeType = "image/jpeg";
    }
    if (buf.length > SHOT_MAX_BYTES)
      return { ok: false, error: `Image exceeds ${SHOT_MAX_BYTES / 1e6}MB even as JPEG; try a smaller viewport or fullPage=false`, code: "too_large", status: 413 };

    if (remaining() < 0) return overBudget();
    return {
      ok: true,
      requestedUrl: raw,
      finalUrl,
      pageStatus: resp ? resp.status() : null,
      title: title.slice(0, 300),
      mimeType,
      width,
      height: docHeight,
      fullPage,
      bytes: buf.length,
      imageBase64: buf.toString("base64"),
      blockedRequests: blocked,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : "render failed").slice(0, 300), code: "render_failed", status: 502 };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
