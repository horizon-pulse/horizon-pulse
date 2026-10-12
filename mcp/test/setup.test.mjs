// Setup CLI tests: every run uses a fresh temp HOME (removed after the run); no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSetup, tomlEdit, jsonEdit, CLIENTS, parseArgs, HELP } from "../dist/setup.js";

const SKILL = "---\nname: horizon-pulse\ndescription: test skill\n---\n# body\n";
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmpHome = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hp-setup-")); made.push(d); return d; };
const quiet = () => { const lines = []; return { log: (s) => lines.push(s), lines }; };
const noFetch = async () => { throw new Error("network not allowed in tests"); };
const base = (home, extra = {}) => ({ home, fetchSkill: async () => SKILL, ...extra });
const j = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const mode = (f) => fs.statSync(f).mode & 0o777;
const URL_ = "https://horizonpulse.dev/mcp";

test("dry run writes nothing; preview shows only our entry + sha256; skill GET sha printed", async () => {
  const home = tmpHome();
  const q = quiet();
  assert.equal(await runSetup(base(home, { all: true, dryRun: true, log: q.log })), 0);
  assert.deepEqual(fs.readdirSync(home), []);
  const out = q.lines.join("\n");
  assert.match(out, /our entry after: {2}\{"type":"http","url":"https:\/\/horizonpulse\.dev\/mcp"\}/);
  assert.match(out, /file sha256 after {2}[0-9a-f]{64}/);
  assert.match(out, /Skill: GET https:\/\/horizonpulse\.dev\/skill\.md sha256 [0-9a-f]{64}/);
  assert.match(out, /Dry run: nothing was written/);
});

test("declined approval writes nothing", async () => {
  const home = tmpHome();
  assert.equal(await runSetup(base(home, { all: true, ask: async () => "n", log: () => {} })), 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("approved: documented formats; skill installed; other keys kept; backups written", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".cursor"));
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://x.example/mcp" } }, keep: 1 }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }, null, 2) + "\n");
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n');
  const q = quiet();
  assert.equal(await runSetup(base(home, { all: true, ask: async () => "y", log: q.log })), 0);
  const claude = j(path.join(home, ".claude.json"));
  assert.equal(claude.numStartups, 3);
  assert.deepEqual(claude.mcpServers["horizon-pulse"], { type: "http", url: URL_ });
  const cursor = j(path.join(home, ".cursor", "mcp.json"));
  assert.equal(cursor.keep, 1);
  assert.deepEqual(cursor.mcpServers.other, { url: "https://x.example/mcp" });
  assert.deepEqual(cursor.mcpServers["horizon-pulse"], { url: URL_ });
  assert.deepEqual(j(path.join(home, ".gemini", "settings.json")).mcpServers["horizon-pulse"], { httpUrl: URL_ });
  assert.deepEqual(j(path.join(home, ".codeium", "windsurf", "mcp_config.json")).mcpServers["horizon-pulse"], { serverUrl: URL_ });
  const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.equal(toml, 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n\n[mcp_servers.horizon-pulse]\nurl = "https://horizonpulse.dev/mcp"\n');
  for (const d of [".claude/skills", ".codex/skills", ".cursor/skills", ".gemini/skills"])
    assert.equal(fs.readFileSync(path.join(home, d, "horizon-pulse", "SKILL.md"), "utf8"), SKILL);
  assert.equal(q.lines.filter((l) => l.startsWith("backup: ")).length, 3);
});

test("FAIL-1: original file mode kept (0600 stays 0600, 0640 stays 0640); new files and backups are 0600", async () => {
  const home = tmpHome();
  const f = path.join(home, ".claude.json");
  fs.writeFileSync(f, '{"token":"secret"}\n');
  fs.chmodSync(f, 0o600);
  fs.mkdirSync(path.join(home, ".cursor"));
  const c = path.join(home, ".cursor", "mcp.json");
  fs.writeFileSync(c, "{}\n");
  fs.chmodSync(c, 0o640);
  const old = process.umask(0o022);
  try {
    const q = quiet();
    assert.equal(await runSetup(base(home, { clients: ["claude-code", "cursor", "gemini"], yes: true, log: q.log })), 0);
    assert.equal(mode(f), 0o600);
    assert.equal(mode(c), 0o640);
    assert.equal(mode(path.join(home, ".gemini", "settings.json")), 0o600);
    assert.equal(mode(path.join(home, ".claude", "skills", "horizon-pulse", "SKILL.md")), 0o600);
    for (const l of q.lines.filter((x) => x.startsWith("backup: "))) assert.equal(mode(l.slice(8)), 0o600);
  } finally {
    process.umask(old);
  }
});

test("FAIL-2: minified file stays minified; indent style + other bytes kept; 32k-line JSON previews in bounded time/memory", async () => {
  const home = tmpHome();
  const f = path.join(home, ".claude.json");
  fs.writeFileSync(f, '{"a":1,"b":[1,2]}');
  await runSetup(base(home, { clients: ["claude-code"], yes: true, noSkill: true, log: () => {} }));
  assert.equal(fs.readFileSync(f, "utf8"), '{"a":1,"b":[1,2],"mcpServers":{"horizon-pulse":{"type":"http","url":"https://horizonpulse.dev/mcp"}}}');
  const tab = jsonEdit('{\n\t"a": 1\n}\n', { url: "u" }, "x").after;
  assert.equal(tab, '{\n\t"a": 1,\n\t"mcpServers": {\n\t\t"horizon-pulse": {\n\t\t\t"url": "u"\n\t\t}\n\t}\n}\n');
  // huge file: 32k lines; preview must not include the whole file
  const big = { mcpServers: {}, history: Array.from({ length: 16000 }, (_, i) => ({ i })) };
  const home2 = tmpHome();
  fs.writeFileSync(path.join(home2, ".claude.json"), JSON.stringify(big, null, 1));
  const q = quiet();
  const t0 = Date.now();
  assert.equal(await runSetup(base(home2, { clients: ["claude-code"], dryRun: true, noSkill: true, log: q.log })), 0);
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(q.lines.join("\n").length < 4000);
});

test("idempotent: second run writes nothing and does not prompt", async () => {
  const home = tmpHome();
  await runSetup(base(home, { all: true, yes: true, log: () => {} }));
  const q = quiet();
  let asked = false;
  assert.equal(await runSetup(base(home, { all: true, ask: async () => { asked = true; return "n"; }, log: q.log })), 0);
  assert.equal(asked, false);
  assert.match(q.lines.join("\n"), /already set up/);
});

test("symlinked config: written through to its target, link kept", async () => {
  const home = tmpHome();
  const real = path.join(home, "dotfiles-claude.json");
  fs.writeFileSync(real, "{}\n");
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, path.join(home, ".claude.json"));
  assert.equal(await runSetup(base(home, { clients: ["claude-code"], yes: true, noSkill: true, log: () => {} })), 0);
  assert.ok(fs.lstatSync(path.join(home, ".claude.json")).isSymbolicLink());
  assert.deepEqual(j(real).mcpServers["horizon-pulse"], { type: "http", url: URL_ });
  assert.equal(mode(real), 0o600);
});

test("--uninstall removes only our entry + skill; --restore puts back the latest backup", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".cursor"));
  const c = path.join(home, ".cursor", "mcp.json");
  const orig = JSON.stringify({ mcpServers: { other: { url: "https://x.example/mcp" } } }, null, 2) + "\n";
  fs.writeFileSync(c, orig);
  fs.mkdirSync(path.join(home, ".codex"));
  const t = path.join(home, ".codex", "config.toml");
  fs.writeFileSync(t, 'model = "x"\n');
  await runSetup(base(home, { clients: ["cursor", "codex"], yes: true, log: () => {} }));
  assert.equal(await runSetup({ home, uninstall: true, yes: true, log: () => {} }), 0);
  assert.deepEqual(j(c), { mcpServers: { other: { url: "https://x.example/mcp" } } });
  assert.equal(fs.readFileSync(c, "utf8"), orig);
  assert.equal(fs.readFileSync(t, "utf8"), 'model = "x"\n');
  assert.ok(!fs.existsSync(path.join(home, ".cursor", "skills", "horizon-pulse", "SKILL.md"))); // its backup stays for --restore
  // restore = latest backup = the state just before uninstall (installed)
  assert.equal(await runSetup({ home, restore: true, yes: true, log: () => {} }), 0);
  assert.deepEqual(j(c).mcpServers["horizon-pulse"], { url: URL_ });
  assert.equal(fs.readFileSync(path.join(home, ".cursor", "skills", "horizon-pulse", "SKILL.md"), "utf8"), SKILL);
  const q = quiet();
  assert.equal(await runSetup({ home, uninstall: true, dryRun: true, log: q.log }), 0);
  assert.match(q.lines.join("\n"), /Dry run/);
});

test("detection: only clients whose folder exists; none -> exit 1, nothing written", async () => {
  const home = tmpHome();
  assert.equal(await runSetup(base(home, { yes: true, log: () => {} })), 1);
  assert.deepEqual(fs.readdirSync(home), []);
  fs.mkdirSync(path.join(home, ".gemini"));
  assert.equal(await runSetup(base(home, { yes: true, log: () => {} })), 0);
  assert.ok(fs.existsSync(path.join(home, ".gemini", "settings.json")));
  assert.ok(!fs.existsSync(path.join(home, ".cursor")));
});

test("invalid JSON config is refused, file untouched", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".cursor"));
  const f = path.join(home, ".cursor", "mcp.json");
  fs.writeFileSync(f, "{ not json");
  const q = quiet();
  assert.equal(await runSetup(base(home, { clients: ["cursor"], yes: true, log: q.log })), 1);
  assert.equal(fs.readFileSync(f, "utf8"), "{ not json");
  assert.match(q.lines.join("\n"), /not valid JSON/);
});

test("http url, unknown client, bad skill and offline skill are refused", async () => {
  const home = tmpHome();
  assert.equal(await runSetup(base(home, { all: true, yes: true, url: "http://horizonpulse.dev/mcp", log: () => {} })), 2);
  assert.equal(await runSetup(base(home, { clients: ["nope"], yes: true, log: () => {} })), 2);
  assert.equal(await runSetup({ home, all: true, yes: true, fetchSkill: async () => "no front matter", log: () => {} }), 1);
  assert.equal(await runSetup({ home, all: true, yes: true, fetchSkill: noFetch, log: () => {} }), 1);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(await runSetup({ home, all: true, yes: true, noSkill: true, fetchSkill: noFetch, log: () => {} }), 0);
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills")));
});

test("codex toml: header found with spacing/quotes/inline comment; replaces only our table + sub-tables", () => {
  for (const h of ["[mcp_servers.horizon-pulse]", '[ mcp_servers . "horizon-pulse" ]  # ours', "  [mcp_servers.horizon-pulse] #x"]) {
    const before = `a = 1\n${h}\nurl = "https://old"\n[mcp_servers.horizon-pulse.env]\nX = "1"\n\n[other]\nb = 2\n`;
    const { after } = tomlEdit(before, URL_);
    assert.equal(after, 'a = 1\n[mcp_servers.horizon-pulse]\nurl = "https://horizonpulse.dev/mcp"\n\n[other]\nb = 2\n', h);
    assert.equal(tomlEdit(after, URL_).after, after);
  }
  assert.equal(tomlEdit("[mcp_servers.horizon-pulse-other]\nx=1\n", URL_).after, '[mcp_servers.horizon-pulse-other]\nx=1\n\n[mcp_servers.horizon-pulse]\nurl = "https://horizonpulse.dev/mcp"\n');
  assert.equal(tomlEdit(null, "https://h/mcp").after, '[mcp_servers.horizon-pulse]\nurl = "https://h/mcp"\n');
  assert.equal(tomlEdit('a = 1\n\n[mcp_servers.horizon-pulse]\nurl = "u"\n', null).after, "a = 1\n");
});

test("args + help", () => {
  assert.deepEqual(parseArgs(["--client", "cursor,codex", "--dry-run", "--home", "/x"]), { clients: ["cursor", "codex"], dryRun: true, home: "/x" });
  assert.throws(() => parseArgs(["--bogus"]));
  assert.throws(() => parseArgs(["--uninstall", "--restore"]));
  for (const f of ["--home", "--uninstall", "--restore", "--yes", "skill.md"]) assert.ok(HELP.includes(f), f);
  assert.deepEqual(CLIENTS.map((c) => c.id), ["claude-code", "codex", "cursor", "gemini", "windsurf"]);
});

test("CLI binary: `setup --dry-run` with a temp HOME writes nothing", () => {
  const home = tmpHome();
  const sdir = tmpHome();
  const skill = path.join(sdir, "skill.md");
  fs.writeFileSync(skill, SKILL);
  const out = execFileSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "setup", "--all", "--dry-run", "--skill-file", skill], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  assert.match(out, /Dry run/);
  assert.deepEqual(fs.readdirSync(home), []);
});
