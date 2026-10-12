/**
 * `npx horizon-pulse setup`: register the hosted Horizon Pulse MCP server
 * (https://horizonpulse.dev/mcp, streamable HTTP) with local agent clients and
 * install the Horizon Pulse skill. Shows a preview of our entry in every file
 * it would touch (plus whole-file sha256 before/after), backs up each existing
 * file, writes only after approval. `--uninstall` removes only our entries;
 * `--restore` puts back the latest backup.
 *
 * Never touches wallets, keys or money. Writes only the files in the plan.
 * Config files can hold tokens: original file mode is kept, new files are 0600,
 * symlinked configs are written through to their target, and the rest of each
 * file keeps its formatting (indent style, minified, trailing newline).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline/promises";

export const SERVER_NAME = "horizon-pulse";
export const DEFAULT_MCP_URL = "https://horizonpulse.dev/mcp";
/** The skill is fetched with one GET of this URL (free, static markdown) unless --skill-file is given. */
export const DEFAULT_SKILL_URL = "https://horizonpulse.dev/skill.md";
export const SKILL_DIR_NAME = "horizon-pulse";
export const BACKUP_TAG = ".horizon-pulse-backup-";
const PREVIEW_MAX = 2000;

type Json = Record<string, unknown>;
export type Edit = { file: string; display: string; before: string | null; after: string | null; preview: string };
export type Client = {
  id: string;
  label: string;
  configPath: (home: string) => string;
  format: "json" | "toml";
  /** JSON entry per the client's docs. */
  entry: (url: string) => Json;
  skillDir?: (home: string) => string;
  detect: (home: string) => boolean;
};

const sha = (s: string | null) => (s == null ? "none" : crypto.createHash("sha256").update(s).digest("hex"));
const cap = (s: string) => (s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + `… (${s.length - PREVIEW_MAX} more chars)` : s);
const read = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);

/** Write through symlinks: the real target if the path exists, else the path itself. */
export function resolveTarget(f: string): string {
  try {
    return fs.realpathSync(f);
  } catch {
    return f;
  }
}

/* ---------------------------- JSON ---------------------------- */

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

/** Indent style of an existing file: undefined = minified (one line). */
function jsonStyle(text: string | null): { indent: string | undefined; nl: string } {
  if (text == null || text.trim() === "") return { indent: "  ", nl: "\n" };
  const nl = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
  if (!text.trim().includes("\n")) return { indent: undefined, nl };
  const m = /\n([ \t]+)\S/.exec(text);
  return { indent: m ? m[1] : "  ", nl };
}

/** Set (entry) or remove (null) mcpServers[SERVER_NAME]; every other key and the file's style are kept. */
export function jsonEdit(before: string | null, entry: Json | null, file: string, key = "mcpServers"): { after: string; was: unknown; now: unknown } {
  const o = parseJsonObject(before, file);
  const cur = o[key];
  if (cur !== undefined && (typeof cur !== "object" || cur === null || Array.isArray(cur))) throw new Error(`${file}: "${key}" is not an object; nothing was changed.`);
  const servers = { ...((cur as Json) ?? {}) };
  const was = servers[SERVER_NAME];
  if (entry) servers[SERVER_NAME] = entry;
  else delete servers[SERVER_NAME];
  if (JSON.stringify(was) === JSON.stringify(entry ?? undefined) && before != null) return { after: before, was, now: was };
  const { indent, nl } = jsonStyle(before);
  let text = JSON.stringify({ ...o, [key]: servers }, null, indent) + nl;
  if (nl === "\r\n") text = text.replace(/(?<!\r)\n/g, "\r\n");
  return { after: text, was, now: entry ?? undefined };
}

/* ---------------------------- TOML (Codex) ---------------------------- */

const OUR_HEADER = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("?)${SERVER_NAME}\\1\\s*\\]\\s*(#.*)?$`);
const OUR_SUBTABLE = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("?)${SERVER_NAME}\\1\\s*\\.`);
const ANY_HEADER = /^\s*\[/;

/** Replace (url) or remove (null) the [mcp_servers.horizon-pulse] table and its sub-tables; all other lines untouched. */
export function tomlEdit(before: string | null, url: string | null): { after: string; was: string | null; now: string | null } {
  const text = before ?? "";
  const lines = text.split("\n");
  const start = lines.findIndex((l) => OUR_HEADER.test(l));
  const block = url == null ? null : `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}`;
  if (start === -1) {
    if (block == null) return { after: text, was: null, now: null };
    const pre = text === "" ? "" : text.endsWith("\n") ? text + "\n" : text + "\n\n";
    return { after: pre + block + "\n", was: null, now: block };
  }
  let end = start + 1;
  while (end < lines.length && !(ANY_HEADER.test(lines[end]!) && !OUR_SUBTABLE.test(lines[end]!))) end++;
  // keep trailing blank lines of our block out of the table so spacing to the next table survives
  let bodyEnd = end;
  while (bodyEnd > start + 1 && lines[bodyEnd - 1]!.trim() === "") bodyEnd--;
  const was = lines.slice(start, bodyEnd).join("\n");
  if (block != null && was === block) return { after: text, was, now: block };
  let out: string[];
  if (block == null) {
    out = [...lines.slice(0, start), ...lines.slice(end)];
    while (out.length > 1 && out[out.length - 1] === "" && out[out.length - 2] === "") out.pop();
  } else out = [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(bodyEnd)];
  return { after: out.join("\n"), was, now: block };
}

/* ---------------------------- clients ---------------------------- */

export const CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code (user scope, ~/.claude.json)",
    configPath: (h) => path.join(h, ".claude.json"),
    format: "json",
    entry: (url) => ({ type: "http", url }),
    skillDir: (h) => path.join(h, ".claude", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".claude")) || fs.existsSync(path.join(h, ".claude.json")),
  },
  {
    id: "codex",
    label: "Codex CLI (~/.codex/config.toml)",
    configPath: (h) => path.join(h, ".codex", "config.toml"),
    format: "toml",
    entry: (url) => ({ url }),
    skillDir: (h) => path.join(h, ".codex", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".codex")),
  },
  {
    id: "cursor",
    label: "Cursor (global, ~/.cursor/mcp.json)",
    configPath: (h) => path.join(h, ".cursor", "mcp.json"),
    format: "json",
    entry: (url) => ({ url }),
    skillDir: (h) => path.join(h, ".cursor", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".cursor")),
  },
  {
    id: "gemini",
    label: "Gemini CLI (~/.gemini/settings.json)",
    configPath: (h) => path.join(h, ".gemini", "settings.json"),
    format: "json",
    entry: (httpUrl) => ({ httpUrl }),
    skillDir: (h) => path.join(h, ".gemini", "skills"),
    detect: (h) => fs.existsSync(path.join(h, ".gemini")),
  },
  {
    id: "windsurf",
    label: "Windsurf (~/.codeium/windsurf/mcp_config.json)",
    configPath: (h) => path.join(h, ".codeium", "windsurf", "mcp_config.json"),
    format: "json",
    entry: (serverUrl) => ({ serverUrl }),
    detect: (h) => fs.existsSync(path.join(h, ".codeium", "windsurf")),
  },
];

const skillPath = (c: Client, home: string) => (c.skillDir ? path.join(c.skillDir(home), SKILL_DIR_NAME, "SKILL.md") : null);

/** Edit our entry (url) or remove it (null). */
function configEdit(c: Client, home: string, url: string | null): Edit | null {
  const display = c.configPath(home);
  const file = resolveTarget(display);
  const before = read(file);
  if (before == null && url == null) return null;
  const show = (v: unknown) => (v === undefined || v === null ? "(none)" : typeof v === "string" ? v : JSON.stringify(v));
  let after: string, was: unknown, now: unknown;
  if (c.format === "toml") ({ after, was, now } = tomlEdit(before, url));
  else ({ after, was, now } = jsonEdit(before, url == null ? null : c.entry(url), display));
  if (after === before) return null;
  return { file, display, before, after, preview: `our entry before: ${cap(show(was))}\nour entry after:  ${cap(show(now))}` };
}

export function validateSkill(text: string): void {
  if (!/^---\r?\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S+[\s\S]*?\r?\n---/.test(text)) throw new Error("Skill file has no name/description front matter; not installing it.");
}

export type Plan = { clients: Client[]; edits: Edit[]; unchanged: string[] };

export function buildPlan(home: string, clients: Client[], url: string, skill: string | null): Plan {
  const edits: Edit[] = [];
  const unchanged: string[] = [];
  for (const c of clients) {
    const e = configEdit(c, home, url);
    if (e) edits.push(e);
    else unchanged.push(c.configPath(home));
    const sp = skillPath(c, home);
    if (skill != null && sp) {
      const sf = resolveTarget(sp);
      const sb = read(sf);
      if (sb === skill) unchanged.push(sp);
      else edits.push({ file: sf, display: sp, before: sb, after: skill, preview: `skill sha256 ${sha(skill)} (${skill.length} bytes)` });
    }
  }
  return { clients, edits, unchanged };
}

export function buildUninstallPlan(home: string, clients: Client[]): Plan {
  const edits: Edit[] = [];
  for (const c of clients) {
    const e = configEdit(c, home, null);
    if (e) edits.push(e);
    const sp = skillPath(c, home);
    if (sp && fs.existsSync(sp)) {
      const sf = resolveTarget(sp);
      edits.push({ file: sf, display: sp, before: read(sf), after: null, preview: "remove our skill file" });
    }
  }
  return { clients, edits, unchanged: [] };
}

/** Latest backup written by setup for this file (by the stamp in its name). */
export function latestBackup(file: string): string | null {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return null;
  const base = path.basename(file) + BACKUP_TAG;
  const all = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
  return all.length ? path.join(dir, all[all.length - 1]!) : null;
}

export function buildRestorePlan(home: string, clients: Client[]): Plan {
  const edits: Edit[] = [];
  for (const c of clients) {
    for (const p of [c.configPath(home), skillPath(c, home)]) {
      if (!p) continue;
      const file = resolveTarget(p);
      const b = latestBackup(file);
      if (!b) continue;
      const before = read(file);
      const after = fs.readFileSync(b, "utf8");
      if (after === before) continue;
      edits.push({ file, display: p, before, after, preview: `restore from ${path.basename(b)}` });
    }
  }
  return { clients, edits, unchanged: [] };
}

export function renderPlan(p: Plan, home: string): string {
  const rel = (f: string) => (f.startsWith(home) ? "~" + f.slice(home.length) : f);
  const parts: string[] = [];
  for (const e of p.edits) {
    const kind = e.after == null ? "delete; backup written first" : e.before == null ? "new file, mode 0600" : "modified; backup written first, file mode kept";
    parts.push(`=== ${rel(e.display)}${e.file !== e.display ? ` -> ${rel(e.file)} (symlink target)` : ""} (${kind})`);
    parts.push(e.preview);
    parts.push(`file sha256 before ${sha(e.before)}\nfile sha256 after  ${sha(e.after)}`);
  }
  for (const u of p.unchanged) parts.push(`=== ${rel(u)} (already up to date)`);
  return parts.join("\n");
}

/** Back up every existing file (same mode), then write (mode kept; new = 0600) or delete. Returns backup paths. */
export function applyPlan(p: Plan, stamp = new Date().toISOString().replace(/[:.]/g, "-")): string[] {
  const backups: string[] = [];
  const modes = new Map<string, number>();
  for (const e of p.edits) {
    if (e.before != null && fs.existsSync(e.file)) {
      const mode = fs.statSync(e.file).mode & 0o777;
      modes.set(e.file, mode);
      const b = `${e.file}${BACKUP_TAG}${stamp}`;
      fs.writeFileSync(b, fs.readFileSync(e.file), { mode: 0o600 });
      fs.chmodSync(b, 0o600); // backups may hold tokens: owner-only
      backups.push(b);
    }
  }
  for (const e of p.edits) {
    if (e.after == null) {
      fs.rmSync(e.file, { force: true });
      try {
        fs.rmdirSync(path.dirname(e.file)); // only if empty
      } catch {
        /* not empty */
      }
      continue;
    }
    const mode = modes.get(e.file) ?? 0o600;
    fs.mkdirSync(path.dirname(e.file), { recursive: true, mode: 0o700 });
    const tmp = `${e.file}.horizon-pulse-tmp-${process.pid}`;
    fs.writeFileSync(tmp, e.after, { mode });
    fs.chmodSync(tmp, mode); // umask-independent
    fs.renameSync(tmp, e.file);
  }
  return backups;
}

/* ---------------------------- CLI ---------------------------- */

export type SetupOpts = {
  home?: string;
  clients?: string[];
  all?: boolean;
  url?: string;
  skillFile?: string;
  noSkill?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  uninstall?: boolean;
  restore?: boolean;
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
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "--restore") o.restore = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.uninstall && o.restore) throw new Error("--uninstall and --restore cannot be combined");
  return o;
}

export const HELP = `Usage: npx horizon-pulse setup [options]

Registers the hosted Horizon Pulse MCP server (${DEFAULT_MCP_URL}) with your
agent clients and installs the Horizon Pulse skill (one GET of
${DEFAULT_SKILL_URL}; its sha256 is printed). Shows our entry in each file
plus whole-file sha256 before/after, backs up every file it changes, keeps
file modes and formatting, and writes nothing until you approve.

  --client <ids>   comma list: ${CLIENTS.map((c) => c.id).join(", ")} (default: detected)
  --all            every supported client, detected or not
  --url <url>      MCP endpoint (default ${DEFAULT_MCP_URL}; https only)
  --skill-file <f> install this skill file instead of fetching it
  --no-skill       register the MCP server only
  --uninstall      remove only our entry and our skill file (backups first)
  --restore        put back the latest backup setup made of each file
  --home <dir>     treat <dir> as the home folder (default: your home)
  --dry-run        show the plan, write nothing
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
  } else chosen = opts.all || opts.uninstall || opts.restore ? CLIENTS : CLIENTS.filter((c) => c.detect(home));
  if (!chosen.length) {
    log(`No supported agent client found under ${home}. Pick one with --client (${CLIENTS.map((c) => c.id).join(", ")}) or use --all.`);
    return 1;
  }

  let plan: Plan;
  try {
    if (opts.uninstall) plan = buildUninstallPlan(home, chosen);
    else if (opts.restore) plan = buildRestorePlan(home, chosen);
    else {
      let skill: string | null = null;
      if (!opts.noSkill) {
        try {
          skill = opts.skillFile ? fs.readFileSync(opts.skillFile, "utf8") : await (opts.fetchSkill ?? defaultFetchSkill)(DEFAULT_SKILL_URL);
          validateSkill(skill);
        } catch (e) {
          log(`Skill not available (${e instanceof Error ? e.message : String(e)}). Rerun with --skill-file <path> or --no-skill. Nothing was changed.`);
          return 1;
        }
        log(`Skill: ${opts.skillFile ? `file ${opts.skillFile}` : `GET ${DEFAULT_SKILL_URL}`} sha256 ${sha(skill)}`);
      }
      plan = buildPlan(home, chosen, url, skill);
      log(`MCP server "${SERVER_NAME}" -> ${url}`);
    }
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  log(`Clients: ${chosen.map((c) => c.label).join("; ")}`);
  log(renderPlan(plan, home));
  if (!plan.edits.length) {
    log(opts.uninstall ? "Nothing of ours to remove." : opts.restore ? "No backups to restore." : "Everything is already set up. Nothing to write.");
    return 0;
  }
  if (opts.dryRun) {
    log("Dry run: nothing was written.");
    return 0;
  }
  if (!opts.yes) {
    const ask = opts.ask ?? defaultAsk;
    const a = (await ask(`Apply these ${plan.edits.length} change(s)? Existing files are backed up first. [y/N] `)).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      log("Not approved: nothing was written.");
      return 1;
    }
  }
  const backups = applyPlan(plan);
  for (const b of backups) log(`backup: ${b}`);
  log(`Applied ${plan.edits.length} change(s). Restart your agent clients.`);
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
