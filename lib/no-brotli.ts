/**
 * TEMPORARY Brotli mitigation (CVE-2026-111497, Node < 24.22.1).
 * REMOVE once /status shows node_patched: yes.
 *
 * fetch() decodes by the RESPONSE Content-Encoding no matter what we asked
 * for, so advertising "gzip, deflate" is not enough. guardedFetch therefore
 * wraps its dispatcher: when response headers arrive (before fetch sees them
 * and before any body byte is read or decoded) any Content-Encoding other than
 * identity/gzip/x-gzip/deflate (br, zstd, unknown) aborts the request.
 * zlib's Brotli decoder is never constructed. Callers map the error to a 502
 * with code upstream_encoding, so x402 never settles: no_charge.
 */
import { Dispatcher } from "undici";

export const SAFE_ACCEPT_ENCODING = "gzip, deflate";
export const BROTLI_REFUSED_CODE = "upstream_encoding" as const;
export const BROTLI_REFUSED_ERROR =
  "Upstream replied with a refused Content-Encoding (br or unknown); body discarded without decoding. no_charge: you were not charged.";

const ALLOWED = new Set(["identity", "gzip", "x-gzip", "deflate"]);

/** True when a Content-Encoding value contains br or any coding we do not allow. */
export function isRefusedEncoding(value: string | null | undefined): boolean {
  if (value == null) return false;
  const tokens = value.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  return tokens.some((t) => !ALLOWED.has(t));
}

export function isBrotliEncoded(res: Pick<Response, "headers">): boolean {
  return isRefusedEncoding(res.headers.get("content-encoding"));
}

export class EncodingRefusedError extends Error {
  readonly code = "HP_ENCODING_REFUSED";
  constructor(readonly encoding: string) {
    super(BROTLI_REFUSED_ERROR);
    this.name = "EncodingRefusedError";
  }
}

export function findEncodingRefusedError(err: unknown): EncodingRefusedError | null {
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i++) {
    if (e instanceof EncodingRefusedError || (e as { code?: string }).code === "HP_ENCODING_REFUSED") return e as EncodingRefusedError;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Discard the body without reading/decoding it. Never throws. */
export async function discardBody(res: Pick<Response, "body">): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

function contentEncodingFromRaw(raw: unknown): string | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (String(raw[i]).toLowerCase() === "content-encoding") parts.push(String(raw[i + 1]));
    }
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k.toLowerCase() === "content-encoding") return Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  return null;
}

type AnyHandler = Record<string, unknown> & { onError?: (e: Error) => void };

function wrapHandler(handler: AnyHandler): AnyHandler {
  let abortFn: ((e: Error) => void) | null = null;
  let refused = false;
  const wrapped: AnyHandler = Object.create(handler);
  if (typeof handler.onConnect === "function") {
    wrapped.onConnect = (abort: (e: Error) => void, ...rest: unknown[]) => {
      abortFn = abort;
      return (handler.onConnect as (...a: unknown[]) => unknown).call(handler, abort, ...rest);
    };
  }
  if (typeof handler.onHeaders === "function") {
    wrapped.onHeaders = (status: number, rawHeaders: unknown, ...rest: unknown[]) => {
      const ce = contentEncodingFromRaw(rawHeaders);
      if (isRefusedEncoding(ce)) {
        refused = true;
        const err = new EncodingRefusedError(ce ?? "");
        if (abortFn) abortFn(err);
        else handler.onError?.call(handler, err);
        return false;
      }
      return (handler.onHeaders as (...a: unknown[]) => unknown).call(handler, status, rawHeaders, ...rest);
    };
  }
  if (typeof handler.onResponseStart === "function") {
    wrapped.onResponseStart = (controller: { abort: (e: Error) => void }, status: number, headers: unknown, ...rest: unknown[]) => {
      const ce = contentEncodingFromRaw(headers);
      if (isRefusedEncoding(ce)) {
        refused = true;
        controller.abort(new EncodingRefusedError(ce ?? ""));
        return;
      }
      return (handler.onResponseStart as (...a: unknown[]) => unknown).call(handler, controller, status, headers, ...rest);
    };
  }
  for (const k of ["onData", "onResponseData"]) {
    if (typeof handler[k] === "function") {
      wrapped[k] = (...a: unknown[]) => (refused ? false : (handler[k] as (...x: unknown[]) => unknown).apply(handler, a));
    }
  }
  return wrapped;
}

/** Dispatcher that refuses br/unknown Content-Encoding at header time. */
export class EncodingGuardDispatcher extends Dispatcher {
  constructor(private readonly inner: Dispatcher) {
    super();
  }
  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    return this.inner.dispatch(opts, wrapHandler(handler as unknown as AnyHandler) as unknown as Dispatcher.DispatchHandlers);
  }
  close(...a: unknown[]): never {
    return (this.inner.close as (...x: unknown[]) => never)(...a);
  }
  destroy(...a: unknown[]): never {
    return (this.inner.destroy as (...x: unknown[]) => never)(...a);
  }
}

/** Force a no-br Accept-Encoding on outbound init headers. */
export function withSafeAcceptEncoding(init: RequestInit): RequestInit {
  const out: Record<string, string> = {};
  const src = init.headers;
  if (src instanceof Headers) src.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(src)) for (const [k, v] of src) out[k] = v;
  else if (src) Object.assign(out, src as Record<string, string>);
  for (const k of Object.keys(out)) if (k.toLowerCase() === "accept-encoding") delete out[k];
  out["Accept-Encoding"] = SAFE_ACCEPT_ENCODING;
  return { ...init, headers: out };
}
