/**
 * FREE agent feedback route: POST /api/feedback (scope: oversight/to-odin/2026-10-21-pulse-feedback-route-scope.md,
 * Odin rulings 10/21, Sentinel scope review 10/21).
 *
 * - No x402, no 402, no charge. JSON only (415), body <= 2 KB read with a byte cap (413), strict schema (400).
 * - Fields: type (coin|data|route|other), text (1-500 chars), optional symbol, optional route. NO payer field (Odin).
 * - Text: NFC, allowlist of letters/marks/numbers/punctuation/symbols/space/\n; Cc (except \n), Cf, Co, Cn, Zl, Zp,
 *   variation selectors, tag chars and invisible fillers rejected (Sentinel MEDIUM-1). Anything HTML-like rejected.
 * - URLs/domains/IPs/schemes are never fetched: masked as [url] and flagged (Sentinel LOW-3).
 * - Odd entries are FLAGGED for review, never auto-acted on or deleted (Odin).
 * - ip_hash = HMAC-SHA256(FEEDBACK_HMAC_SECRET, "hp-feedback-ip-v1:" + ip) (Sentinel LOW-1). Secret unset -> 503, nothing stored.
 * - Rate limit per IP (5/h, 20/day) + global (500/day) in Upstash KV; KV missing/down -> 503 (fail closed).
 * - Storage: fb:v1:e:<id> (TTL 90 days) + fb:v1:idx / fb:v1:flagged zsets. Review only via scripts/feedback-review.ts.
 * - FEEDBACK_ROUTE_ENABLED default OFF -> 404. No CORS header. No LLM call in the route.
 */
import { createHmac, randomBytes } from "node:crypto";
import { callerIp } from "./caller-ip";
import { resolveSharedReplayStoreEnv } from "./xrpl-replay-store";

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

export const FEEDBACK_TYPES = ["coin", "data", "route", "other"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export const FEEDBACK_TEXT_MAX = 500;
export const FEEDBACK_BODY_MAX_BYTES = 2048;
export const FEEDBACK_TTL_S = 90 * 24 * 3600;
export const FEEDBACK_IP_PER_HOUR = 5;
export const FEEDBACK_IP_PER_DAY = 20;
export const FEEDBACK_GLOBAL_PER_DAY = 500;
export const FEEDBACK_KEY_PREFIX = "fb:v1:";
/**
 * Known prod test rows (2026-10-21; Odin note oversight/to-pulse-feedback-test-ids.md). Review-only: tagged [TEST] by
 * scripts/feedback-review.ts. NEVER deleted (they expire with the 90-day TTL); the route never reads these.
 * - fb_mviibn098eaf490cbb93: Odin flag-on probe, ~3:30 PM ET.
 */
export const FEEDBACK_TEST_IDS: ReadonlySet<string> = new Set(["fb_mviibn098eaf490cbb93"]);
/** Pulse probe miss ~3:41 PM ET (id unknown): exact type + text, created in [19:40Z, 19:42Z]. */
export const FEEDBACK_TEST_RULES = [
  { type: "coin", text: "Please add funding for PEPE", fromIso: "2026-10-21T19:40:00.000Z", toIso: "2026-10-21T19:42:00.000Z" },
] as const;

export function isFeedbackTestRow(rec: { id?: unknown; type?: unknown; text?: unknown; ts?: unknown }): boolean {
  if (typeof rec.id === "string" && FEEDBACK_TEST_IDS.has(rec.id)) return true;
  if (typeof rec.ts !== "string") return false;
  const t = Date.parse(rec.ts);
  if (!Number.isFinite(t)) return false;
  return FEEDBACK_TEST_RULES.some((r) => rec.type === r.type && rec.text === r.text && t >= Date.parse(r.fromIso) && t <= Date.parse(r.toIso));
}
export const FEEDBACK_IP_DOMAIN = "hp-feedback-ip-v1:";
const ALLOWED_KEYS = new Set(["type", "text", "symbol", "route"]);

export function feedbackEnabled(env: Env = process.env): boolean {
  const v = (env.FEEDBACK_ROUTE_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** Secret for the IP HMAC. Never logged. Too short / unset -> null (route answers 503, stores nothing). */
export function feedbackSecret(env: Env = process.env): string | null {
  const s = env.FEEDBACK_HMAC_SECRET ?? "";
  return s.length >= 32 ? s : null;
}

export function hashFeedbackIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(FEEDBACK_IP_DOMAIN + ip).digest("hex");
}

// ---------- text checks ----------

/** Invisible or format-like code points that are in allowed categories (marks / letters) but must still be refused. */
const EXTRA_DENY = /[\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u;
/** Allowlist: letters, marks, numbers, punctuation, symbols, ordinary spaces, newline. Everything else refused. */
const ALLOWED_CHAR = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\n]$/u;
const DENIED_CATEGORY = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

export function badCharReason(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    if (ch === "\n") continue;
    if (DENIED_CATEGORY.test(ch) || EXTRA_DENY.test(ch) || !ALLOWED_CHAR.test(ch)) return `character U+${cp} is not allowed`;
    // Zs other than plain space are allowed only if visible width spaces; refuse the odd ones too.
    if (/\p{Zs}/u.test(ch) && ch !== " " && ch !== "\u00A0" && ch !== "\u3000") return `character U+${cp} is not allowed`;
  }
  return null;
}

export function looksLikeHtml(text: string): boolean {
  return /<\s*[a-zA-Z\/!?]/.test(text) || /&#?[a-zA-Z0-9]{1,10};/.test(text);
}

const SCHEMES = "https?|ftps?|wss?|data|javascript|vbscript|ipfs|ipns|file|mailto|magnet|blob|about|chrome|tel|sms|ar|gopher|ldap|smb";
const URL_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:${SCHEMES}):\\S*`, "gi"),
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/\S*/gi,
  /\bwww\.\S+/gi,
  /\[[0-9a-f:.]{2,45}\](?::\d{1,5})?(?:\/\S*)?/gi,
  /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi,
  /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:\/\S*)?/g,
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b(?::\d{1,5})?(?:\/\S*)?/gi,
];

/** Replace every URL-like span with [url]. Text is never fetched or followed. */
export function maskUrls(text: string): { text: string; hadUrl: boolean } {
  let out = text;
  for (const re of URL_PATTERNS) out = out.replace(re, (m) => (m.length < 3 ? m : "[url]"));
  return { text: out, hadUrl: out !== text };
}

const INJECTION_HINT =
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|prompts?|rules?)\b|\b(system prompt|you are now|act as|developer mode|jailbreak)\b/i;

export function oddFlags(text: string): string[] {
  const flags: string[] = [];
  if (INJECTION_HINT.test(text)) flags.push("injection_like");
  if (/(.)\1{14,}/su.test(text)) flags.push("repeated_chars");
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 20 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) flags.push("all_caps");
  if (/(?:0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b)/.test(text)) flags.push("address_like");
  if ((text.match(/\p{M}/gu) ?? []).length > 30) flags.push("many_marks");
  if (/\b(private key|seed phrase|mnemonic|api[_ ]?key|password)\b/i.test(text)) flags.push("secret_like");
  return flags;
}

export type FeedbackInput = { type: FeedbackType; text: string; symbol?: string; route?: string };
export type Parsed = { ok: true; value: FeedbackInput; flags: string[] } | { ok: false; error: string };

export function parseFeedback(body: unknown): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body: must be a JSON object" };
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) return { ok: false, error: `${k.slice(0, 20)}: unknown field (allowed: type, text, symbol, route)` };
  if (typeof o.type !== "string" || !(FEEDBACK_TYPES as readonly string[]).includes(o.type)) return { ok: false, error: "type: one of coin, data, route, other" };
  if (typeof o.text !== "string") return { ok: false, error: "text: required string" };
  const raw = o.text.normalize("NFC");
  if (raw.trim().length === 0) return { ok: false, error: "text: must not be empty" };
  if ([...raw].length > FEEDBACK_TEXT_MAX) return { ok: false, error: `text: at most ${FEEDBACK_TEXT_MAX} characters` };
  const bad = badCharReason(raw);
  if (bad) return { ok: false, error: `text: ${bad}` };
  if (looksLikeHtml(raw)) return { ok: false, error: "text: HTML or markup is not accepted" };
  const out: FeedbackInput = { type: o.type as FeedbackType, text: "" };
  if (o.symbol !== undefined) {
    if (typeof o.symbol !== "string" || !/^[A-Za-z0-9]{2,10}$/.test(o.symbol)) return { ok: false, error: "symbol: 2-10 ASCII letters or digits" };
    out.symbol = o.symbol.toUpperCase();
  }
  if (o.route !== undefined) {
    if (typeof o.route !== "string" || !/^\/api\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(o.route) || o.route.length > 65)
      return { ok: false, error: "route: a path like /api/funding (lowercase letters, digits, - and /, max 65)" };
    out.route = o.route;
  }
  const m = maskUrls(raw.trim());
  out.text = m.text;
  const flags = oddFlags(raw);
  if (m.hadUrl) flags.unshift("has_url");
  return { ok: true, value: out, flags };
}

// ---------- KV ----------

export type Kv = { pipeline(cmds: (string | number)[][]): Promise<unknown[]> };

export function upstashKv(env: Env, fetchFn: FetchFn = fetch, timeoutMs = 1500): Kv | null {
  const c = resolveSharedReplayStoreEnv(env);
  if (!c) return null;
  return {
    async pipeline(cmds) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchFn(c.url.replace(/\/+$/, "") + "/pipeline", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(cmds.map((a) => a.map(String))),
          signal: ctl.signal,
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as Array<{ result?: unknown; error?: unknown }> | null;
        if (!res.ok || !Array.isArray(body) || body.some((r) => r?.error !== undefined)) throw new Error(`upstash ${res.status}`);
        return body.map((r) => r.result);
      } finally {
        clearTimeout(t);
      }
    },
  };
}

// ---------- handler ----------

export type FeedbackDeps = { env?: Env; kv?: Kv | null; now?: () => number; newId?: () => string };

const NO_STORE = { "cache-control": "no-store" };
function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  // Deliberately no Access-Control-Allow-* headers (Sentinel NOTE-2).
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE, ...extra } });
}
export const notFound = () => json(404, { ok: false, error: "not_found" });
export const methodNotAllowed = () => json(405, { ok: false, error: "method_not_allowed: POST JSON only" }, { allow: "POST" });

async function readCapped(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) (buf.set(c, off), (off += c.byteLength));
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

export function newFeedbackId(now: number): string {
  return `fb_${now.toString(36)}${randomBytes(6).toString("hex")}`;
}

export async function handleFeedback(req: Request, deps: FeedbackDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  if (!feedbackEnabled(env)) return notFound();
  if (req.method !== "POST") return methodNotAllowed();
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(ct)) return json(415, { ok: false, error: "content-type must be application/json" });

  let rawBody: string | null;
  try {
    rawBody = await readCapped(req, FEEDBACK_BODY_MAX_BYTES);
  } catch {
    return json(400, { ok: false, error: "body: invalid UTF-8" });
  }
  if (rawBody === null) return json(413, { ok: false, error: `body: at most ${FEEDBACK_BODY_MAX_BYTES} bytes` });
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, { ok: false, error: "body: invalid JSON" });
  }
  const p = parseFeedback(body);
  if (!p.ok) return json(400, { ok: false, error: p.error });

  const secret = feedbackSecret(env);
  const kv = deps.kv !== undefined ? deps.kv : upstashKv(env);
  if (!secret || !kv) return json(503, { ok: false, error: "temporarily_unavailable" });

  const now = deps.now ? deps.now() : Date.now();
  const ipHash = hashFeedbackIp(callerIp(req) ?? "unknown", secret);
  const hour = Math.floor(now / 3_600_000);
  const day = Math.floor(now / 86_400_000);
  const P = FEEDBACK_KEY_PREFIX;
  const kh = `${P}rl:h:${ipHash.slice(0, 32)}:${hour}`;
  const kd = `${P}rl:d:${ipHash.slice(0, 32)}:${day}`;
  const kg = `${P}rl:g:${day}`;
  try {
    // Sentinel LOW-1 (0a40692 review): per-IP check FIRST; the global counter is only INCR'd for an IP that is
    // under its own limit, so one IP flooding cannot burn the shared daily cap for everyone else.
    const r = await kv.pipeline([["INCR", kh], ["EXPIRE", kh, 3700], ["INCR", kd], ["EXPIRE", kd, 90_000]]);
    const [h, d] = [Number(r[0]), Number(r[2])];
    if (h > FEEDBACK_IP_PER_HOUR || d > FEEDBACK_IP_PER_DAY) {
      const retry = d > FEEDBACK_IP_PER_DAY ? (day + 1) * 86_400 - Math.floor(now / 1000) : (hour + 1) * 3600 - Math.floor(now / 1000);
      return json(429, { ok: false, error: "rate_limited", retry_after_s: retry }, { "retry-after": String(retry) });
    }
    const gr = await kv.pipeline([["INCR", kg], ["EXPIRE", kg, 90_000]]);
    const g = Number(gr[0]);
    if (g > FEEDBACK_GLOBAL_PER_DAY) {
      if (g === FEEDBACK_GLOBAL_PER_DAY + 1) console.log(JSON.stringify({ evt: "feedback_global_cap_hit", day }));
      const retry = (day + 1) * 86_400 - Math.floor(now / 1000);
      return json(429, { ok: false, error: "rate_limited", retry_after_s: retry }, { "retry-after": String(retry) });
    }
    const id = deps.newId ? deps.newId() : newFeedbackId(now);
    const record = {
      v: 1,
      id,
      ts: new Date(now).toISOString(),
      type: p.value.type,
      text: p.value.text,
      symbol: p.value.symbol ?? null,
      route: p.value.route ?? null,
      flags: p.flags,
      ip_hash: ipHash,
      status: "received",
    };
    const cmds: (string | number)[][] = [
      ["SET", `${P}e:${id}`, JSON.stringify(record), "EX", FEEDBACK_TTL_S],
      ["ZADD", `${P}idx`, now, id],
      ["ZREMRANGEBYSCORE", `${P}idx`, 0, now - FEEDBACK_TTL_S * 1000],
    ];
    if (p.flags.length) cmds.push(["ZADD", `${P}flagged`, now, id], ["ZREMRANGEBYSCORE", `${P}flagged`, 0, now - FEEDBACK_TTL_S * 1000]);
    await kv.pipeline(cmds);
    console.log(JSON.stringify({ evt: "feedback_stored", type: record.type, flagged: p.flags.length > 0 }));
    return json(201, { ok: true, id, status: "received", flagged: p.flags.length > 0, note: "Stored for human review. Nothing ships automatically." });
  } catch {
    return json(503, { ok: false, error: "temporarily_unavailable" });
  }
}

export const FEEDBACK_MCP_DESCRIPTION =
  "FREE (no payment). Tell Horizon Pulse about a missing coin, data field or route. Fields: type (coin, data, route or other), text (1-500 characters, plain text; links are not followed and are stored masked), optional symbol and route. Stored for human review only, for up to 90 days; nothing ships automatically and there is no reply. We may use what you send to improve Horizon Pulse, with no obligation or payment. Do not include personal data, secrets or keys. Limit: 5 per hour and 20 per day per caller IP address, plus a shared daily cap. Limits use a keyed hash (HMAC) of the caller's IP address; the IP address itself is not stored. The limit counters expire within 25 hours, and each stored entry keeps that hash for up to 90 days so repeat submissions can be reviewed.";
