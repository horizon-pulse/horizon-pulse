/**
 * Prompt-injection heuristics scan (dark route /api/injection/scan).
 * Rule-based heuristics over raw text/HTML: instruction overrides, role/system
 * impersonation, exfiltration asks, tool/action coercion, hidden carriers
 * (zero-width, Unicode tag block, bidi overrides, HTML comments, CSS-hidden
 * text, long base64 blobs that decode to instructions). Informational only:
 * a low score is not a clearance. Deterministic, no model calls, nothing stored.
 */
import { guardedGet } from "./guarded-get";

export const INJECTION_METHOD =
  "Deterministic rule set (instruction override, role impersonation, exfiltration, action coercion, concealment, targeting) over plain text plus hidden carriers (zero-width, Unicode tags, bidi, HTML comments, CSS-hidden text, base64). URL mode: one GET of the submitted public URL through the SSRF guard (max 200 KB, 3 redirects). No model calls; nothing stored.";
export const INJECTION_MAX_TEXT_BYTES = 50_000;
export const INJECTION_MAX_URL_BYTES = 200_000;

export type Severity = "low" | "medium" | "high";
export type Finding = { rule: string; category: string; severity: Severity; excerpt: string; offset: number };
export type ScanResult = {
  riskScore: number;
  /** Counsel C4: a zero score is "no_patterns_matched", never "none". */
  level: "no_patterns_matched" | "low" | "medium" | "high";
  findings: Finding[];
  counts: Record<Severity, number>;
  scannedChars: number;
  truncated: boolean;
  /** true when the per-scan time budget ran out; findings are partial. */
  budgetExceeded: boolean;
  method: string;
  note: string;
};

/** Every pattern is bounded (no unbounded quantifier next to an overlapping one): linear-ish per start (Odin C1 HIGH, ReDoS). `test` refines a match in code instead of in the regex. */
type Rule = { id: string; category: string; severity: Severity; re: RegExp; test?: (m: RegExpExecArray) => boolean };
/** Wall-clock budget per scan; past it the scan stops and returns what it found, marked budgetExceeded. */
export const SCAN_BUDGET_MS = 2_000;

const RULES: Rule[] = [
  { id: "ignore_previous", category: "instruction_override", severity: "high", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all |any |the )?(previous|prior|above|earlier|preceding|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|directions?|messages?)\b/gi },
  { id: "new_instructions", category: "instruction_override", severity: "medium", re: /\b(new|updated|real|actual|true)\s+(instructions?|system prompt|rules)\s*(:|are|follow)/gi },
  { id: "you_are_now", category: "role_impersonation", severity: "medium", re: /\byou are (now|no longer)\b|\bfrom now on,? you\b|\bact as (an? )?(unrestricted|jailbroken|developer mode|dan)\b/gi },
  { id: "fake_system_tag", category: "role_impersonation", severity: "high", re: /<\/?(system|assistant|im_start|im_end)\b[^>\n]{0,200}>|\[\/?(INST|SYS)\]|<<\/?SYS>>|^\s*(system|assistant)\s*:/gim },
  { id: "reveal_prompt", category: "exfiltration", severity: "high", re: /\b(reveal|print|show|output|repeat|leak)\b[^.\n]{0,30}\b(system prompt|hidden prompt|instructions above|your (initial|original) (prompt|instructions))\b/gi },
  { id: "exfil_secrets", category: "exfiltration", severity: "high", re: /\b(send|post|forward|upload|exfiltrate|email)\b[^.\n]{0,40}\b(api[ _-]?keys?|secrets?|passwords?|private keys?|seed phrases?|tokens?|credentials|env(ironment)? variables)\b/gi },
  { id: "exfil_url", category: "exfiltration", severity: "medium", re: /!\[[^\]\n]{0,200}\]\((https?:\/\/[^)\s]{1,800})\)/gi, test: (m) => /\{|%7B|\?[^=]{0,800}=/i.test(m[1] ?? "") },
  { id: "tool_coercion", category: "action_coercion", severity: "high", re: /\b(call|invoke|run|execute|use)\b[^.\n]{0,25}\b(the )?(tool|function|shell|terminal|command|transfer|payment|wallet)\b[^.\n]{0,40}\b(without|do not|don't|never)\b[^.\n]{0,20}\b(ask(ing)?|confirm(ing|ation)?|tell(ing)?|notif(y|ying)|approv(al|e|ing))\b/gi },
  { id: "pay_or_transfer", category: "action_coercion", severity: "high", re: /\b(transfer|send|pay|approve)\b[^.\n]{0,30}\b(all|the entire|full|remaining)?\s*(funds|balance|usdc|eth|tokens?|crypto)\b[^.\n]{0,40}\b(to|into)\s+(0x[0-9a-f]{6,}|this (address|wallet))/gi },
  { id: "secrecy", category: "concealment", severity: "medium", re: /\b(do not|don't|never)\b[^.\n]{0,20}\b(tell|inform|mention|reveal to|show)\b[^.\n]{0,15}\b(the )?(user|human|operator)\b/gi },
  { id: "agent_address", category: "targeting", severity: "low", re: /\b(dear|attention|note to|instructions? for)\s+(ai|llm|assistant|agent|language model|chatbot)s?\b/gi },
];

const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF]/g;
const TAG_BLOCK = /[\u{E0000}-\u{E007F}]/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const CSS_HIDDEN = /<([a-z0-9]{1,10})\b[^>]{0,300}?\bstyle\s*=\s*["']([^"'>]{0,500})["'][^>]{0,300}>([\s\S]{0,2000}?)<\/\1>/gi;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?:\.0+)?\b|color\s*:\s*(?:#fff(?:fff)?|white)\b/i;

/** HTML comments by indexOf (linear; an unclosed "<!--" ends the scan instead of rescanning to the end per start). */
function* htmlComments(s: string, max = 200): Generator<{ body: string; index: number }> {
  let i = 0;
  let n = 0;
  while (n < max) {
    const a = s.indexOf("<!--", i);
    if (a < 0) return;
    const b = s.indexOf("-->", a + 4);
    if (b < 0) return;
    yield { body: s.slice(a + 4, b), index: a };
    i = b + 3;
    n++;
  }
}
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

type Budget = { deadline: number; exceeded: boolean; now: () => number };
function runRules(text: string, offsetBase: number, carrier: string | null, out: Finding[], budget: Budget): void {
  for (const r of RULES) {
    if (budget.now() > budget.deadline) {
      budget.exceeded = true;
      return;
    }
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    let tries = 0;
    while (n < 5 && tries++ < 200 && (m = r.re.exec(text))) {
      if (m[0].length === 0) r.re.lastIndex++;
      if (r.test && !r.test(m)) continue;
      n++;
      // Hidden carriers raise severity one step: the text was not meant for a human reader.
      const sev: Severity = carrier && r.severity !== "high" ? (r.severity === "low" ? "medium" : "high") : r.severity;
      out.push({ rule: carrier ? `${r.id}@${carrier}` : r.id, category: r.category, severity: sev, excerpt: excerptAt(text, m.index, m[0].length), offset: offsetBase + m.index });
    }
  }
}

export function scanText(input: string, opts: { truncated?: boolean; budgetMs?: number; now?: () => number } = {}): ScanResult {
  const now = opts.now ?? (() => performance.now());
  const budget: Budget = { deadline: now() + (opts.budgetMs ?? SCAN_BUDGET_MS), exceeded: false, now };
  const findings: Finding[] = [];
  const zw = input.match(ZERO_WIDTH)?.length ?? 0;
  const tags = input.match(TAG_BLOCK)?.length ?? 0;
  const bidi = input.match(BIDI)?.length ?? 0;
  if (zw >= 3) findings.push({ rule: "zero_width_chars", category: "hidden_carrier", severity: zw >= 20 ? "high" : "medium", excerpt: `${zw} zero-width characters`, offset: input.search(ZERO_WIDTH) });
  if (tags > 0) {
    // Unicode tag characters map 1:1 to ASCII and are invisible: decode and scan what they say.
    const decoded = [...input].filter((c) => /[\u{E0000}-\u{E007F}]/u.test(c)).map((c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000)).join("");
    findings.push({ rule: "unicode_tag_chars", category: "hidden_carrier", severity: "high", excerpt: `invisible tag text: ${excerptAt(decoded, 0, 100)}`, offset: input.search(TAG_BLOCK) });
    runRules(decoded, 0, "unicode_tags", findings, budget);
  }
  if (bidi > 0) findings.push({ rule: "bidi_override", category: "hidden_carrier", severity: "medium", excerpt: `${bidi} bidirectional override characters`, offset: input.search(BIDI) });

  // Visible/plain text (zero-width stripped so they cannot split keywords).
  const plain = input.replace(ZERO_WIDTH, "").replace(TAG_BLOCK, "");
  runRules(plain, 0, null, findings, budget);

  // HTML comments and CSS-hidden elements: scan their contents as hidden carriers.
  for (const c of htmlComments(input)) {
    if (budget.exceeded) break;
    runRules(c.body, c.index, "html_comment", findings, budget);
  }
  let hiddenN = 0;
  for (const m of input.matchAll(CSS_HIDDEN)) {
    if (budget.exceeded || ++hiddenN > 200 || now() > budget.deadline) break;
    if (!HIDDEN_STYLE.test(m[2] ?? "")) continue;
    runRules((m[3] ?? "").replace(/<[^>]{0,500}>/g, " "), m.index ?? 0, "css_hidden", findings, budget);
  }

  // Base64 blobs that decode to readable instructions.
  let b64 = 0;
  for (const m of input.matchAll(BASE64_BLOB)) {
    if (++b64 > 20 || budget.exceeded) break;
    let dec = "";
    try {
      dec = Buffer.from(m[0], "base64").toString("utf8");
    } catch {
      continue;
    }
    if (!/^[\x09\x0a\x0d\x20-\x7e]{20,}$/.test(dec)) continue;
    const before = findings.length;
    runRules(dec, m.index ?? 0, "base64", findings, budget);
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
  const level = riskScore === 0 ? "no_patterns_matched" : riskScore < 20 ? "low" : riskScore < 50 ? "medium" : "high";
  return {
    riskScore,
    level,
    findings: final,
    counts,
    scannedChars: input.length,
    truncated: opts.truncated ?? false,
    budgetExceeded: budget.exceeded,
    method: INJECTION_METHOD,
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
  if (!r.ok) return { ok: false, status: r.code === "opted_out" ? 403 : r.code === "bad_url" || r.code === "host_blocked" ? 400 : r.code === "timeout" ? 504 : 502, code: r.code === "opted_out" ? "target_opted_out" : r.code, error: r.error };
  if (r.status >= 400) return { ok: false, status: 502, code: "upstream", error: `Upstream returned HTTP ${r.status}` };
  return { ok: true, source: "url", finalUrl: r.finalUrl, upstreamStatus: r.status, ...scanText(r.body, { truncated: r.truncated }) };
}
