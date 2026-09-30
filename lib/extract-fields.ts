/**
 * Selector-based field extraction for /api/extract (`fields` option).
 *
 * fields: { name: "css selector" | { selector, attr?, all?, limit? } }
 *   attr: "text" (default, whitespace-collapsed), "html" (inner HTML), or any
 *         attribute name (href/src/action/poster are resolved to absolute URLs).
 *   all:  return every match as an array (limit 1-50, default 20).
 * Up to 20 fields. Each field succeeds or fails on its own: value null plus
 * fieldErrors[name]. The call is billed only when at least one field matched.
 */
import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import vm from "node:vm";
import { getAttributeValue, getInnerHTML } from "domutils";

export const FIELDS_MAX = 20;
export const FIELD_SELECTOR_MAX = 300;
export const FIELD_ALL_MAX = 50;
export const FIELD_ALL_DEFAULT = 20;
export const FIELD_VALUE_MAX_CHARS = 2_000;
export const FIELDS_BUDGET_MS = 2_000;

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ATTR_RE = /^[A-Za-z_:][-A-Za-z0-9_:.]{0,63}$/;
const URL_ATTRS = new Set(["href", "src", "action", "poster", "data-src", "cite"]);

export type FieldSpec = { selector: string; attr: string; all: boolean; limit: number };
export type FieldSpecs = Record<string, FieldSpec>;
export type FieldValue = string | string[] | null;
export type FieldErrorCode = "bad_selector" | "no_match" | "attr_missing" | "time_budget" | "eval_failed" | "document_too_deep";
export type FieldsResult = {
  fields: Record<string, FieldValue>;
  fieldErrors: Record<string, { code: FieldErrorCode; error: string }>;
  matchedFields: number;
  requestedFields: number;
};

/** Validate the fields option (object, or JSON string from GET). Runs before any fetch. */
export function parseFieldSpecs(raw: unknown): { ok: true; specs: FieldSpecs | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, specs: null };
  let v = raw;
  if (typeof v === "string") {
    if (v.length > 16_000) return { ok: false, error: "fields JSON too long (max 16000 chars)" };
    try { v = JSON.parse(v); } catch { return { ok: false, error: "fields must be a JSON object (URL-encode it on GET)" }; }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "fields must be an object of name → selector" };
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, error: "fields is empty" };
  if (entries.length > FIELDS_MAX) return { ok: false, error: `Too many fields (${entries.length}); max ${FIELDS_MAX}` };
  const specs: FieldSpecs = {};
  for (const [name, spec] of entries) {
    if (!NAME_RE.test(name)) return { ok: false, error: `Field name "${name.slice(0, 64)}" must match ${NAME_RE.source}` };
    let s: FieldSpec;
    if (typeof spec === "string") s = { selector: spec, attr: "text", all: false, limit: 1 };
    else if (spec && typeof spec === "object" && !Array.isArray(spec)) {
      const o = spec as Record<string, unknown>;
      if (typeof o.selector !== "string") return { ok: false, error: `fields.${name}.selector must be a string` };
      const attr = o.attr === undefined ? "text" : o.attr;
      if (typeof attr !== "string" || !(attr === "text" || attr === "html" || ATTR_RE.test(attr)))
        return { ok: false, error: `fields.${name}.attr must be "text", "html", or an attribute name` };
      if (o.all !== undefined && typeof o.all !== "boolean") return { ok: false, error: `fields.${name}.all must be boolean` };
      const all = o.all === true;
      let limit = all ? FIELD_ALL_DEFAULT : 1;
      if (o.limit !== undefined) {
        if (!Number.isInteger(o.limit) || (o.limit as number) < 1 || (o.limit as number) > FIELD_ALL_MAX)
          return { ok: false, error: `fields.${name}.limit must be an integer 1-${FIELD_ALL_MAX}` };
        limit = o.limit as number;
      }
      s = { selector: o.selector, attr, all, limit };
    } else return { ok: false, error: `fields.${name} must be a selector string or {selector, attr?, all?, limit?}` };
    s.selector = s.selector.trim();
    if (!s.selector || s.selector.length > FIELD_SELECTOR_MAX)
      return { ok: false, error: `fields.${name} selector must be 1-${FIELD_SELECTOR_MAX} chars` };
    if ((s.selector.toLowerCase().match(/:has\(/g) ?? []).length > 1)
      return { ok: false, error: `fields.${name} selector may use :has() at most once` };
    specs[name] = s;
  }
  return { ok: true, specs };
}

/** Iterative text collector (domutils.textContent recurses and overflows on very deep DOMs). */
function textOf(root: unknown): string {
  const out: string[] = [];
  let len = 0;
  const stack: unknown[] = [root];
  while (stack.length && len < FIELD_VALUE_MAX_CHARS * 4) {
    const n = stack.pop() as { type?: string; data?: string; children?: unknown[] };
    if (n.type === "text" && typeof n.data === "string") { out.push(n.data); len += n.data.length; }
    else if (n.type !== "comment" && Array.isArray(n.children)) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out.join("");
}

export const FIELDS_MAX_DEPTH = 256;

/** Iterative max element depth, stopping early once over the cap. */
function tooDeep(root: unknown): boolean {
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (d > FIELDS_MAX_DEPTH) return true;
    const kids = (n as { children?: unknown[] }).children;
    if (Array.isArray(kids)) for (const k of kids) stack.push([k, d + 1]);
  }
  return false;
}

/**
 * Run synchronous selector work under a hard wall-clock limit. vm's timeout
 * terminates any JS running inside the call (including host functions), so a
 * pathological selector (e.g. nth-last-child + sibling combinators on a huge
 * list) cannot pin the function past the fields budget.
 */
const vmCtx = vm.createContext({});
function underBudget<T>(fn: () => T, started: number): T {
  const remaining = Math.max(1, FIELDS_BUDGET_MS - (Date.now() - started));
  (vmCtx as { __fn?: () => T }).__fn = fn;
  try {
    return vm.runInContext("__fn()", vmCtx, { timeout: remaining }) as T;
  } finally {
    (vmCtx as { __fn?: unknown }).__fn = undefined;
  }
}
const isTimeout = (e: unknown) => (e as { code?: string })?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";

const clip = (s: string) => (s.length > FIELD_VALUE_MAX_CHARS ? s.slice(0, FIELD_VALUE_MAX_CHARS) : s);

export function evaluateFields(html: string, specs: FieldSpecs, baseUrl?: string): FieldsResult {
  const started = Date.now();
  const doc = parseDocument(html, { decodeEntities: true });
  const out: FieldsResult = { fields: {}, fieldErrors: {}, matchedFields: 0, requestedFields: Object.keys(specs).length };
  if (tooDeep(doc)) {
    for (const name of Object.keys(specs)) {
      out.fields[name] = null;
      out.fieldErrors[name] = { code: "document_too_deep", error: `Page nests elements deeper than ${FIELDS_MAX_DEPTH} levels; selectors not evaluated` };
    }
    return out;
  }
  for (const [name, spec] of Object.entries(specs)) {
    out.fields[name] = null;
    if (Date.now() - started > FIELDS_BUDGET_MS) {
      out.fieldErrors[name] = { code: "time_budget", error: `Skipped: ${FIELDS_BUDGET_MS}ms selector budget used` };
      continue;
    }
    type El = Parameters<typeof getInnerHTML>[0];
    try {
      let nodes: El[];
      try {
        nodes = underBudget(() => selectAll(spec.selector, doc as never) as unknown as El[], started);
      } catch (err) {
        if (isTimeout(err)) { out.fieldErrors[name] = { code: "time_budget", error: `Selector exceeded the ${FIELDS_BUDGET_MS}ms budget` }; continue; }
        out.fieldErrors[name] = { code: "bad_selector", error: (err instanceof Error ? err.message : "invalid selector").slice(0, 200) };
        continue;
      }
      if (nodes.length === 0) {
        out.fieldErrors[name] = { code: "no_match", error: "Selector matched no elements" };
        continue;
      }
      const vals: string[] = [];
      for (const el of nodes.slice(0, spec.limit)) {
        let v: string | undefined;
        if (spec.attr === "text") v = textOf(el).replace(/\s+/g, " ").trim();
        else if (spec.attr === "html") v = getInnerHTML(el).trim();
        else {
          v = getAttributeValue(el as never, spec.attr);
          if (v !== undefined && baseUrl && URL_ATTRS.has(spec.attr.toLowerCase())) {
            try { v = new URL(v, baseUrl).toString(); } catch {}
          }
        }
        if (v !== undefined) vals.push(clip(v));
      }
      if (vals.length === 0) {
        out.fieldErrors[name] = { code: "attr_missing", error: `Matched ${nodes.length} element(s) but none has attribute "${spec.attr}"` };
        continue;
      }
      out.fields[name] = spec.all ? vals : vals[0];
      out.matchedFields++;
    } catch (err) {
      out.fields[name] = null;
      if (isTimeout(err)) { out.fieldErrors[name] = { code: "time_budget", error: `Selector exceeded the ${FIELDS_BUDGET_MS}ms budget` }; continue; }
      out.fieldErrors[name] = { code: "eval_failed", error: `Selector evaluation failed (${err instanceof RangeError ? "document too deeply nested" : "internal error"})` };
    }
  }
  return out;
}
