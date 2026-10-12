/**
 * `npx horizon-pulse setup`: register the hosted Horizon Pulse MCP server
 * (https://horizonpulse.dev/mcp, streamable HTTP) with local agent clients and
 * install the Horizon Pulse skill. Pattern: show the plan + a diff of every
 * file it would touch, back up each existing file, write only after approval.
 *
 * Never touches wallets, keys or money. Writes only the files listed in the
 * plan, under $HOME. Formats follow each client's own docs (see CLIENTS).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline/promises";

export const SERVER_NAME = "horizon-pulse";
export const DEFAULT_MCP_URL = "https://horizonpulse.dev/mcp";
export const DEFAULT_SKILL_URL = "https://horizonpulse.dev/skill.md";
export const SKILL_DIR_NAME = "horizon-pulse";

type Json = Record<string, unknown>;
export type Edit = { file: string; before: string | null; after: string };
export type Client = {
  id: string;
  label: string;
  /** Where the client's docs put user-scope MCP config. */
  configPath: (home: string) => string;
  /** Returns the new file text, or null when already up to date. */
  apply: (before: string | null, url: string) => string;
  /** User-scope skills folder, when the client documents one. */
  skillDir?: (home: string) => string;
  /** Detected = its home folder exists. */
  detect: (home: string) => boolean;
};

function parseJsonObject(text: string | null, file: string): Json {
  if (text == null || text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or move it, then rerun (nothing was changed).`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} is not a JSON object; nothing was changed.`);
  return v as Json;
}

/** Set obj.mcpServers[SERVER_NAME] = entry, keeping every other key. */
function jsonMcp(entry: (url: string) => Json, key = "mcpServers") {
  return (before: string | null, url: string, file = "config"): string => {
    const o = parseJsonObject(before, file);
    const cur = o[key];
    if (cur !== undefined && (typeof cur !== "object" || cur === null || Array.isArray(cur))) throw new Error(`${file}: "${key}" is not an object; nothing was changed.`);
    const servers = { ...((cur as Json) ?? {}) };
    servers[SERVER_NAME] = entry(url);
    return JSON.stringify({ ...o, [key]: servers }, null, 2) + "\n";
  };
}

/** Codex ~/.codex/config.toml: replace or append the [mcp_servers.horizon-pulse] table only. */
export function applyCodexToml(before: string | null, url: string): string {
  const text = before ?? "";
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const block = `${header}\nurl = ${JSON.stringify(url)}\n`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header || l.trim() === `[mcp_servers."${SERVER_NAME}"]`);
  if (start === -1) return (text && !text.endsWith("\n") ? text + "\n" : text) + (text.trim() ? "\n" : "") + block;
  let end = start + 1;
  // The table ends at the next header that is not one of its own sub-tables.
  while (end < lines.length && !(/^\s*\[/.test(lines[end]!) && !lines[end]!.trim().startsWith(`[mcp_servers.${SERVER_NAME}.`))) end++;
  const out = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...(end < lines.length ? ["", ...lines.slice(end)] : [""])];
  return out.join("\n");
}

export const CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code (user scope, ~/.claude.json)",
    configPath: (h) => path.join(h, ".claude.json"),
    apply: (b, u) => jsonMcp((url) => ({ type: "http", url }))(b, u, "~/.claude.json"),
    skillDir: (h) => path.join(h, ".claude", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".claude")) || fs.existsSync(path.join(h, ".claude.json")),
  },
  {
    id: "codex",
    label: "Codex CLI (~/.codex/config.toml)",
    configPath: (h) => path.join(h, ".codex", "config.toml"),
    apply: applyCodexToml,
    skillDir: (h) => path.join(h, ".codex", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".codex")),
  },
  {
    id: "cursor",
    label: "Cursor (global, ~/.cursor/mcp.json)",
    configPath: (h) => path.join(h, ".cursor", "mcp.json"),
    apply: (b, u) => jsonMcp((url) => ({ url }))(b, u, "~/.cursor/mcp.json"),
    skillDir: (h) => path.join(h, ".cursor", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".cursor")),
  },
  {
    id: "gemini",
    label: "Gemini CLI (~/.gemini/settings.json)",
    configPath: (h) => path.join(h, ".gemini", "settings.json"),
    apply: (b, u) => jsonMcp((httpUrl) => ({ httpUrl }))(b, u, "~/.gemini/settings.json"),
    skillDir: (h) => path.join(h, ".gemini", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".gemini")),
  },
  {
    id: "windsurf",
    label: "Windsurf (~/.codeium/windsurf/mcp_config.json)",
    configPath: (h) => path.join(h, ".codeium", "windsurf", "mcp_config.json"),
    apply: (b, u) => jsonMcp((serverUrl) => ({ serverUrl }))(b, u, "~/.codeium/windsurf/mcp_config.json"),
    detect: (h) => fs.existsSync(path.join(h, ".codeium", "windsurf")),
  },
];

const read = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Minimal line diff (LCS) for the preview. */
export function lineDiff(a: string | null, b: string): string {
  const x = a == null ? [] : a.split("\n");
  const y = b.split("\n");
  const n = x.length, m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { i++; j++; continue; }
    if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  return out.join("\n");
}

export function validateSkill(text: string): void {
  if (!/^---\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S+[\s\S]*?\n---/.test(text)) throw new Error("Skill file has no name/description front matter; not installing it.");
}

export type Plan = { clients: Client[]; edits: Edit[]; unchanged: string[] };

export function buildPlan(home: string, clients: Client[], url: string, skill: string | null): Plan {
  const edits: Edit[] = [];
  const unchanged: string[] = [];
  for (const c of clients) {
    const file = c.configPath(home);
    const before = read(file);
    const after = c.apply(before, url);
    if (before === after) unchanged.push(file);
    else edits.push({ file, before, after });
    if (skill != null && c.skillDir) {
      const sf = path.join(c.skillDir(home), SKILL_DIR_NAME, "SKILL.md");
      const sb = read(sf);
      if (sb === skill) unchanged.push(sf);
      else edits.push({ file: sf, before: sb, after: skill });
    }
  }
  return { clients, edits, unchanged };
}

export function renderPlan(p: Plan, home: string): string {
  const rel = (f: string) => (f.startsWith(home) ? "~" + f.slice(home.length) : f);
  const parts: string[] = [];
  for (const e of p.edits) {
    const isSkill = e.file.endsWith("SKILL.md");
    parts.push(`=== ${rel(e.file)} (${e.before == null ? "new file" : "modified; backup will be written first"})`);
    parts.push(isSkill ? `skill sha256 ${sha(e.after)} (${e.after.length} bytes)${e.before != null ? `, replaces sha256 ${sha(e.before)}` : ""}` : lineDiff(e.before, e.after));
  }
  for (const u of p.unchanged) parts.push(`=== ${rel(u)} (already up to date)`);
  return parts.join("\n");
}

/** Back up every existing file, then write. Returns backup paths. */
export function applyPlan(p: Plan, stamp = new Date().toISOString().replace(/[:.]/g, "-")): string[] {
  const backups: string[] = [];
  for (const e of p.edits) {
    if (e.before != null) {
      const b = `${e.file}.horizon-pulse-backup-${stamp}`;
      fs.copyFileSync(e.file, b);
      backups.push(b);
    }
  }
  for (const e of p.edits) {
    fs.mkdirSync(path.dirname(e.file), { recursive: true });
    const tmp = `${e.file}.horizon-pulse-tmp`;
    fs.writeFileSync(tmp, e.after);
    fs.renameSync(tmp, e.file);
  }
  return backups;
}

export type SetupOpts = {
  home?: string;
  clients?: string[];
  all?: boolean;
  url?: string;
  skillFile?: string;
  noSkill?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  fetchSkill?: (url: string) => Promise<string>;
  ask?: (q: string) => Promise<string>;
  log?: (s: string) => void;
};

export function parseArgs(argv: string[]): SetupOpts {
  const o: SetupOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--client") (o.clients ??= []).push(...val().split(","));
    else if (a === "--all") o.all = true;
    else if (a === "--url") o.url = val();
    else if (a === "--skill-file") o.skillFile = val();
    else if (a === "--no-skill") o.noSkill = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--home") o.home = val();
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export const HELP = `Usage: npx horizon-pulse setup [options]

Registers the hosted Horizon Pulse MCP server (${DEFAULT_MCP_URL}) with your
agent clients and installs the Horizon Pulse skill. Shows a diff first, backs
up every file it changes, and writes nothing until you approve.

  --client <ids>   comma list: ${CLIENTS.map((c) => c.id).join(", ")} (default: detected)
  --all            every supported client, detected or not
  --url <url>      MCP endpoint (default ${DEFAULT_MCP_URL}; https only)
  --skill-file <f> install this skill file instead of fetching ${DEFAULT_SKILL_URL}
  --no-skill       register the MCP server only
  --dry-run        show the plan and diff, write nothing
  --yes, -y        approve without the prompt (for scripted installs)

Paid tools answer with an x402 payment challenge; your client (or the local
stdio server in this package) must pay it. Setup itself never pays or signs.`;

export async function runSetup(opts: SetupOpts): Promise<number> {
  const log = opts.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const home = opts.home ?? os.homedir();
  const url = opts.url ?? DEFAULT_MCP_URL;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    log(`--url is not a URL: ${url}`);
    return 2;
  }
  if (u.protocol !== "https:") {
    log("--url must be https.");
    return 2;
  }
  let chosen: Client[];
  if (opts.clients?.length) {
    const bad = opts.clients.filter((id) => !CLIENTS.some((c) => c.id === id));
    if (bad.length) {
      log(`Unknown client: ${bad.join(", ")}. Supported: ${CLIENTS.map((c) => c.id).join(", ")}`);
      return 2;
    }
    chosen = CLIENTS.filter((c) => opts.clients!.includes(c.id));
  } else chosen = opts.all ? CLIENTS : CLIENTS.filter((c) => c.detect(home));
  if (!chosen.length) {
    log(`No supported agent client found under ${home}. Pick one with --client (${CLIENTS.map((c) => c.id).join(", ")}) or use --all.`);
    return 1;
  }

  let skill: string | null = null;
  if (!opts.noSkill) {
    try {
      skill = opts.skillFile ? fs.readFileSync(opts.skillFile, "utf8") : await (opts.fetchSkill ?? defaultFetchSkill)(DEFAULT_SKILL_URL);
      validateSkill(skill);
    } catch (e) {
      log(`Skill not available (${e instanceof Error ? e.message : String(e)}). Rerun with --skill-file <path> or --no-skill. Nothing was changed.`);
      return 1;
    }
  }

  let plan: Plan;
  try {
    plan = buildPlan(home, chosen, url, skill);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  log(`Clients: ${chosen.map((c) => c.label).join("; ")}`);
  log(`MCP server "${SERVER_NAME}" -> ${url}`);
  log(renderPlan(plan, home));
  if (!plan.edits.length) {
    log("Everything is already set up. Nothing to write.");
    return 0;
  }
  if (opts.dryRun) {
    log("Dry run: nothing was written.");
    return 0;
  }
  if (!opts.yes) {
    const ask = opts.ask ?? defaultAsk;
    const a = (await ask(`Write these ${plan.edits.length} file(s)? Existing files are backed up first. [y/N] `)).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      log("Not approved: nothing was written.");
      return 1;
    }
  }
  const backups = applyPlan(plan);
  for (const b of backups) log(`backup: ${b}`);
  log(`Wrote ${plan.edits.length} file(s). Restart your agent clients to load "${SERVER_NAME}".`);
  return 0;
}

async function defaultFetchSkill(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`GET ${url} returned ${r.status}`);
  return await r.text();
}

async function defaultAsk(q: string): Promise<string> {
  if (!process.stdin.isTTY) return "n";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}
