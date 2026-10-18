/**
 * Prompt-injection pattern scan (dark route /api/injection/scan).
 * Rule-based heuristics over raw text/HTML: instruction overrides, role/system
 * impersonation, exfiltration asks, tool/action coercion, hidden carriers
 * (zero-width, Unicode tag block, bidi overrides, HTML comments, CSS-hidden
 * text, long base64 blobs that decode to instructions). Informational only:
 * a low score is not a clearance. Deterministic, no model calls, nothing stored.
 */
import { guardedGet } from "./guarded-get";

export const INJECTION_MAX_TEXT_BYTES = 50_000;
export const INJECTION_MAX_URL_BYTES = 200_000;

export type Severity = "low" | "medium" | "high";
export type Finding = { rule: string; category: string; severity: Severity; excerpt: string; offset: number };
export type ScanResult = {
  riskScore: number;
  level: "none" | "low" | "medium" | "high";
  findings: Finding[];
  counts: Record<Severity, number>;
  scannedChars: number;
  truncated: boolean;
  method: string;
  note: string;
};

type Rule = { id: string; category: string; severity: Severity; re: RegExp };

const RULES: Rule[] = [
  { id: "ignore_previous", category: "instruction_override", severity: "high", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all |any |the )?(previous|prior|above|earlier|preceding|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|directions?|messages?)\b/gi },
  { id: "new_instructions", category: "instruction_override", severity: "medium", re: /\b(new|updated|real|actual|true)\s+(instructions?|system prompt|rules)\s*(:|are|follow)/gi },
  { id: "you_are_now", category: "role_impersonation", severity: "medium", re: /\byou are (now|no longer)\b|\bfrom now on,? you\b|\bact as (an? )?(unrestricted|jailbroken|developer mode|dan)\b/gi },
  { id: "fake_system_tag", category: "role_impersonation", severity: "high", re: /<\/?(system|assistant|im_start|im_end)\b[^>]*>|\[\/?(INST|SYS)\]|<<\/?SYS>>|^\s*(system|assistant)\s*:/gim },
  { id: "reveal_prompt", category: "exfiltration", severity: "high", re: /\b(reveal|print|show|output|repeat|leak)\b[^.\n]{0,30}\b(system prompt|hidden prompt|instructions above|your (initial|original) (prompt|instructions))\b/gi },
  { id: "exfil_secrets", category: "exfiltration", severity: "high", re: /\b(send|post|forward|upload|exfiltrate|email)\b[^.\n]{0,40}\b(api[ _-]?keys?|secrets?|passwords?|private keys?|seed phrases?|tokens?|credentials|env(ironment)? variables)\b/gi },
  { id: "exfil_url", category: "exfiltration", severity: "medium", re: /!\[[^\]]*\]\(https?:\/\/[^)]*(\{|%7B|\?[^)]*=)[^)]*\)/gi },
  { id: "tool_coercion", category: "action_coercion", severity: "high", re: /\b(call|invoke|run|execute|use)\b[^.\n]{0,25}\b(the )?(tool|function|shell|terminal|command|transfer|payment|wallet)\b[^.\n]{0,40}\b(without|do not|don't|never)\b[^.\n]{0,20}\b(ask(ing)?|confirm(ing|ation)?|tell(ing)?|notif(y|ying)|approv(al|e|ing))\b/gi },
  { id: "pay_or_transfer", category: "action_coercion", severity: "high", re: /\b(transfer|send|pay|approve)\b[^.\n]{0,30}\b(all|the entire|full|remaining)?\s*(funds|balance|usdc|eth|tokens?|crypto)\b[^.\n]{0,40}\b(to|into)\s+(0x[0-9a-f]{6,}|this (address|wallet))/gi },
  { id: "secrecy", category: "concealment", severity: "medium", re: /\b(do not|don't|never)\b[^.\n]{0,20}\b(tell|inform|mention|reveal to|show)\b[^.\n]{0,15}\b(the )?(user|human|operator)\b/gi },
  { id: "agent_address", category: "targeting", severity: "low", re: /\b(dear|attention|note to|instructions? for)\s+(ai|llm|assistant|agent|language model|chatbot)s?\b/gi },
];

const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF]/g;
const TAG_BLOCK = /[\u{E0000}-\u{E007F}]/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;
const CSS_HIDDEN = /<([a-z0-9]+)\b[^>]*style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?:\.0+)?\b|color\s*:\s*(?:#fff(?:fff)?|white)\b)[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/\1>/gi;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{60,}={0,2}/g;

const SEV_WEIGHT: Record<Severity, number> = { low: 8, medium: 20, high: 35 };

function excerptAt(s: string, i: number, len: number): string {
  const start = Math.max(0, i - 20);
  return s
    .slice(start, Math.min(s.length, i + Math.min(len, 100) + 20))
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(ZERO_WIDTH, "\u2423")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function runRules(text: string, offsetBase: number, carrier: string | null, out: Finding[]): void {
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = r.re.exec(text)) && n < 5) {
      n++;
      // Hidden carriers raise severity one step: the text was not meant for a human reader.
      const sev: Severity = carrier && r.severity !== "high" ? (r.severity === "low" ? "medium" : "high") : r.severity;
      out.push({ rule: carrier ? `${r.id}@${carrier}` : r.id, category: r.category, severity: sev, excerpt: excerptAt(text, m.index, m[0].length), offset: offsetBase + m.index });
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }
}

export function scanText(input: string, opts: { truncated?: boolean } = {}): ScanResult {
  const findings: Finding[] = [];
  const zw = input.match(ZERO_WIDTH)?.length ?? 0;
  const tags = input.match(TAG_BLOCK)?.length ?? 0;
  const bidi = input.match(BIDI)?.length ?? 0;
  if (zw >= 3) findings.push({ rule: "zero_width_chars", category: "hidden_carrier", severity: zw >= 20 ? "high" : "medium", excerpt: `${zw} zero-width characters`, offset: input.search(ZERO_WIDTH) });
  if (tags > 0) {
    // Unicode tag characters map 1:1 to ASCII and are invisible: decode and scan what they say.
    const decoded = [...input].filter((c) => /[\u{E0000}-\u{E007F}]/u.test(c)).map((c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000)).join("");
    findings.push({ rule: "unicode_tag_chars", category: "hidden_carrier", severity: "high", excerpt: `invisible tag text: ${excerptAt(decoded, 0, 100)}`, offset: input.search(TAG_BLOCK) });
    runRules(decoded, 0, "unicode_tags", findings);
  }
  if (bidi > 0) findings.push({ rule: "bidi_override", category: "hidden_carrier", severity: "medium", excerpt: `${bidi} bidirectional override characters`, offset: input.search(BIDI) });

  // Visible/plain text (zero-width stripped so they cannot split keywords).
  const plain = input.replace(ZERO_WIDTH, "").replace(TAG_BLOCK, "");
  runRules(plain, 0, null, findings);

  // HTML comments and CSS-hidden elements: scan their contents as hidden carriers.
  for (const m of input.matchAll(HTML_COMMENT)) runRules(m[1] ?? "", m.index ?? 0, "html_comment", findings);
  for (const m of input.matchAll(CSS_HIDDEN)) runRules((m[3] ?? "").replace(/<[^>]+>/g, " "), m.index ?? 0, "css_hidden", findings);

  // Base64 blobs that decode to readable instructions.
  let b64 = 0;
  for (const m of input.matchAll(BASE64_BLOB)) {
    if (++b64 > 20) break;
    let dec = "";
    try {
      dec = Buffer.from(m[0], "base64").toString("utf8");
    } catch {
      continue;
    }
    if (!/^[\x09\x0a\x0d\x20-\x7e]{20,}$/.test(dec)) continue;
    const before = findings.length;
    runRules(dec, m.index ?? 0, "base64", findings);
    if (findings.length > before) findings.push({ rule: "base64_instructions", category: "hidden_carrier", severity: "medium", excerpt: excerptAt(dec, 0, 80), offset: m.index ?? 0 });
  }

  // De-duplicate same rule at same offset (comment text also matches as plain text).
  const seen = new Set<string>();
  const uniq = findings.filter((f) => {
    const base = f.rule.split("@")[0];
    const k = `${base}:${f.offset}:${f.excerpt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Prefer the hidden-carrier version when the same text matched both ways.
  const hiddenKeys = new Set(uniq.filter((f) => f.rule.includes("@")).map((f) => `${f.rule.split("@")[0]}|${f.excerpt}`));
  const final = uniq.filter((f) => f.rule.includes("@") || !hiddenKeys.has(`${f.rule}|${f.excerpt}`)).slice(0, 50);

  const counts: Record<Severity, number> = { low: 0, medium: 0, high: 0 };
  let score = 0;
  for (const f of final) {
    counts[f.severity]++;
    score += SEV_WEIGHT[f.severity];
  }
  const riskScore = Math.min(100, score);
  const level = riskScore === 0 ? "none" : riskScore < 20 ? "low" : riskScore < 50 ? "medium" : "high";
  return {
    riskScore,
    level,
    findings: final,
    counts,
    scannedChars: input.length,
    truncated: opts.truncated ?? false,
    method: "Deterministic rule set (instruction override, role impersonation, exfiltration, action coercion, concealment, targeting) over plain text plus hidden carriers (zero-width, Unicode tags, bidi, HTML comments, CSS-hidden text, base64). No model calls; nothing stored.",
    note: "Informational heuristics. A low or zero score does not mean the content is free of prompt injection; treat third-party text as untrusted either way.",
  };
}

export type ScanInput = { text?: string | null; url?: string | null };
export type ScanError = { ok: false; status: number; code: string; error: string };

export async function scanInput(input: ScanInput, get: typeof guardedGet = guardedGet): Promise<({ ok: true; source: "text" | "url"; finalUrl?: string; upstreamStatus?: number } & ScanResult) | ScanError> {
  const text = typeof input.text === "string" ? input.text : null;
  const url = typeof input.url === "string" ? input.url.trim() : null;
  if ((text && url) || (!text && !url)) return { ok: false, status: 400, code: "bad_input", error: "Provide exactly one of text or url" };
  if (text != null) {
    if (Buffer.byteLength(text, "utf8") > INJECTION_MAX_TEXT_BYTES) return { ok: false, status: 413, code: "too_large", error: `text exceeds ${INJECTION_MAX_TEXT_BYTES} bytes` };
    return { ok: true, source: "text", ...scanText(text) };
  }
  const r = await get(url!, { maxBytes: INJECTION_MAX_URL_BYTES, timeoutMs: 8_000, maxRedirects: 3, headers: { Accept: "text/html, text/plain, application/json, text/markdown;q=0.9, */*;q=0.1" } });
  if (!r.ok) return { ok: false, status: r.code === "bad_url" || r.code === "host_blocked" ? 400 : r.code === "timeout" ? 504 : 502, code: r.code, error: r.error };
  if (r.status >= 400) return { ok: false, status: 502, code: "upstream", error: `Upstream returned HTTP ${r.status}` };
  return { ok: true, source: "url", finalUrl: r.finalUrl, upstreamStatus: r.status, ...scanText(r.body, { truncated: r.truncated }) };
}
