#!/usr/bin/env node
/**
 * npm run sync:payto [-- --check]
 *
 * Propagates config/payto.json (the single source of truth for payTo) to the
 * places that cannot import it: hand-written docs, deliberate buyer-side pins
 * (mcp/, examples/), .env.example. Then regenerates public/llms.txt and
 * public/openapi.json and the byte-capture golden fixtures.
 *
 * Old values come from the committed config (`git show HEAD:config/payto.json`);
 * new values from the working-tree config. Exact string replacement only
 * (full value + the `0x5b32…e0e9` short form), on the explicit file list
 * below. It NEVER touches historical recordings (lib/recorded-call.ts,
 * lib/route-examples.ts, lib/agent-demo.ts), which must be re-recorded at a
 * cut-over, and it never edits the literal tripwire tests/payto-pin.test.ts:
 * that edit is deliberate and by hand.
 *
 *   --check   print what would change; write nothing, run nothing.
 *
 * A value change is a cut-over (Class A, highest-risk): Michael's approval
 * (Solana: his fresh passphrase), Odin review, test payment on each rail,
 * Vercel PAY_TO / HP_SOLANA_PAYTO in the same window. See README.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = "config/payto.json";

/**
 * Files that carry payTo text and cannot import the config. `values` = config
 * keys that must appear in the file (checked by tests/payto-single-source.test.ts).
 * `lineFilter`: only lines matching it are rewritten (other lines keep their value).
 */
export const SYNC_FILES = [
  { file: "README.md", values: ["base.payTo", "base.basename", "solana.payTo", "base.short"] },
  { file: "docs/solana-rail.md", values: ["base.payTo", "solana.payTo", "solana.usdcAta"] },
  { file: "docs/solana-accepts.schema.json", values: ["solana.payTo"] },
  { file: "examples/README.md", values: ["base.payTo"] },
  { file: "examples/reference-agent.mjs", values: ["base.payTo"], lineFilter: /EXPECTED_PAY_TO\s*=/ },
  { file: "mcp/README.md", values: ["base.payTo"] },
  { file: "mcp/src/config.ts", values: ["base.payTo"] },
  { file: "mcp/examples/demo.mjs", values: ["base.payTo"] },
  { file: "mcp/test/unpaid-test.mjs", values: ["base.payTo"] },
  { file: ".env.example", values: ["base.payTo", "solana.payTo"] },
];

/** Generated outputs (from config at generation time; freshness-tested). */
export const GENERATED = ["public/llms.txt", "public/openapi.json"];

/** Historical recordings: keep the value that was true when recorded. Never synced. */
export const HISTORICAL = ["lib/recorded-call.ts", "lib/route-examples.ts", "lib/agent-demo.ts"];

const EVM = /^0x[0-9a-f]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** `0x5b32…e0e9` style short form used in copy. */
export const shortEvm = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Flatten a config into the replaceable values (key -> string). */
export function values(cfg) {
  return {
    "base.payTo": cfg.base.payTo,
    "base.short": shortEvm(cfg.base.payTo),
    "base.basename": cfg.base.basename,
    "solana.payTo": cfg.solana.payTo,
    "solana.usdcAta": cfg.solana.usdcAta,
  };
}

export function validate(cfg) {
  const bad = [];
  if (!EVM.test(cfg?.base?.payTo ?? "")) bad.push("base.payTo (lower-case 0x + 40 hex)");
  if (!String(cfg?.base?.basename ?? "").endsWith(".base.eth")) bad.push("base.basename");
  if (!B58.test(cfg?.solana?.payTo ?? "")) bad.push("solana.payTo");
  if (!B58.test(cfg?.solana?.usdcAta ?? "")) bad.push("solana.usdcAta");
  if ((cfg?.retired?.base ?? []).includes(cfg?.base?.payTo)) bad.push("base.payTo is retired");
  if ((cfg?.retired?.solana ?? []).includes(cfg?.solana?.payTo)) bad.push("solana.payTo is retired");
  if (bad.length) throw new Error(`config/payto.json invalid: ${bad.join(", ")}`);
  return cfg;
}

/** Apply old -> new replacements to one file's text. Returns { text, count }. */
export function rewrite(text, oldV, newV, lineFilter) {
  const pairs = Object.keys(newV).filter((k) => oldV[k] !== newV[k]).map((k) => [oldV[k], newV[k]]);
  let count = 0;
  const swap = (s) => {
    for (const [o, n] of pairs) {
      const parts = s.split(o);
      count += parts.length - 1;
      s = parts.join(n);
    }
    return s;
  };
  const out = lineFilter ? text.split("\n").map((l) => (lineFilter.test(l) ? swap(l) : l)).join("\n") : swap(text);
  return { text: out, count };
}

function main() {
  const check = process.argv.includes("--check");
  const cur = validate(JSON.parse(readFileSync(path.join(ROOT, CONFIG_PATH), "utf8")));
  let prev = cur;
  try {
    prev = JSON.parse(execFileSync("git", ["show", `HEAD:${CONFIG_PATH}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    console.log(`(no committed ${CONFIG_PATH} at HEAD; treating the working-tree config as unchanged)`);
  }
  const oldV = values(prev);
  const newV = values(cur);
  const changed = Object.keys(newV).filter((k) => oldV[k] !== newV[k]);
  console.log(changed.length ? `changed: ${changed.map((k) => `${k} ${oldV[k]} -> ${newV[k]}`).join("; ")}` : "no payTo value change (refresh only)");

  for (const { file, lineFilter } of SYNC_FILES) {
    const p = path.join(ROOT, file);
    const before = readFileSync(p, "utf8");
    const { text, count } = rewrite(before, oldV, newV, lineFilter);
    if (count) console.log(`${check ? "would rewrite" : "rewrote"} ${file}: ${count} replacement(s)`);
    if (!check && text !== before) writeFileSync(p, text);
  }
  if (check) return;

  const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  // Generators read the config; PAY_TO must not be set to anything else here.
  run("npm", ["run", "gen:llms"], { PAY_TO: "" });
  run("npm", ["run", "gen:openapi"], { PAY_TO: "" });
  if (changed.length) {
    // Byte-capture goldens: the fixture diff must be ONLY old -> new swaps.
    run("npx", ["vitest", "run", "tests/x402-flag-off.test.ts"], { UPDATE_GOLDEN: "1", PAY_TO: "" });
    run("npx", ["vitest", "run", "tests/payto-refactor-golden.test.ts"], { UPDATE_PAYTO_GOLDEN: "1", PAY_TO: "" });
    console.log(
      "\nNEXT (by hand, same commit): update the literals in tests/payto-pin.test.ts; re-record " +
        HISTORICAL.join(", ") +
        "; review `git diff` (fixtures must differ only by the address swap); then `npm test`.",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
