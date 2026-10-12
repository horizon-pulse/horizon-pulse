// Setup CLI tests: every run uses a fresh temp HOME; nothing outside it is touched; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSetup, applyCodexToml, CLIENTS, lineDiff, parseArgs } from "../dist/setup.js";

const SKILL = "---\nname: horizon-pulse\ndescription: test skill\n---\n# body\n";
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "hp-setup-"));
const quiet = () => { const lines = []; return { log: (s) => lines.push(s), lines }; };
const noFetch = async () => { throw new Error("network not allowed in tests"); };
const base = (home, extra = {}) => ({ home, fetchSkill: async () => SKILL, ...extra });
const j = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("dry run writes nothing and shows a diff", async () => {
  const home = tmpHome();
  const q = quiet();
  assert.equal(await runSetup(base(home, { all: true, dryRun: true, log: q.log })), 0);
  assert.deepEqual(fs.readdirSync(home), []);
  const out = q.lines.join("\n");
  assert.match(out, /\+ {5}"horizon-pulse": \{/);
  assert.match(out, /Dry run: nothing was written/);
});

test("declined approval writes nothing", async () => {
  const home = tmpHome();
  const q = quiet();
  assert.equal(await runSetup(base(home, { all: true, ask: async () => "n", log: q.log })), 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("approved: each client gets its documented format; skill installed; other keys kept; backups written", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".cursor"));
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://x.example/mcp" } }, keep: 1 }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n');
  const q = quiet();
  assert.equal(await runSetup(base(home, { all: true, ask: async () => "y", log: q.log })), 0);
  const claude = j(path.join(home, ".claude.json"));
  assert.equal(claude.numStartups, 3);
  assert.deepEqual(claude.mcpServers["horizon-pulse"], { type: "http", url: "https://horizonpulse.dev/mcp" });
  const cursor = j(path.join(home, ".cursor", "mcp.json"));
  assert.equal(cursor.keep, 1);
  assert.deepEqual(cursor.mcpServers.other, { url: "https://x.example/mcp" });
  assert.deepEqual(cursor.mcpServers["horizon-pulse"], { url: "https://horizonpulse.dev/mcp" });
  assert.deepEqual(j(path.join(home, ".gemini", "settings.json")).mcpServers["horizon-pulse"], { httpUrl: "https://horizonpulse.dev/mcp" });
  assert.deepEqual(j(path.join(home, ".codeium", "windsurf", "mcp_config.json")).mcpServers["horizon-pulse"], { serverUrl: "https://horizonpulse.dev/mcp" });
  const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.other\]\ncommand = "a"/);
  assert.match(toml, /\[mcp_servers\.horizon-pulse\]\nurl = "https:\/\/horizonpulse\.dev\/mcp"/);
  for (const d of [".claude/skills", ".codex/skills", ".cursor/skills", ".gemini/skills"])
    assert.equal(fs.readFileSync(path.join(home, d, "horizon-pulse", "SKILL.md"), "utf8"), SKILL);
  const backups = q.lines.filter((l) => l.startsWith("backup: "));
  assert.equal(backups.length, 3);
  assert.equal(fs.readFileSync(path.join(home, ".cursor", fs.readdirSync(path.join(home, ".cursor")).find((f) => f.includes("backup"))), "utf8").includes('"keep":1'), true);
});

test("second run is idempotent: nothing to write, no prompt", async () => {
  const home = tmpHome();
  await runSetup(base(home, { all: true, yes: true, log: () => {} }));
  const q = quiet();
  let asked = false;
  assert.equal(await runSetup(base(home, { all: true, ask: async () => { asked = true; return "n"; }, log: q.log })), 0);
  assert.equal(asked, false);
  assert.match(q.lines.join("\n"), /already set up/);
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

test("codex toml: replaces only our table (incl. sub-tables), keeps the rest", () => {
  const before = 'a = 1\n[mcp_servers.horizon-pulse]\nurl = "https://old"\n[mcp_servers.horizon-pulse.env]\nX = "1"\n[other]\nb = 2\n';
  const after = applyCodexToml(before, "https://horizonpulse.dev/mcp");
  assert.match(after, /^a = 1\n\[mcp_servers\.horizon-pulse\]\nurl = "https:\/\/horizonpulse\.dev\/mcp"\n\n\[other\]\nb = 2\n$/);
  assert.equal(applyCodexToml(after, "https://horizonpulse.dev/mcp"), after);
  assert.equal(applyCodexToml(null, "https://h/mcp"), '[mcp_servers.horizon-pulse]\nurl = "https://h/mcp"\n');
});

test("args + diff helpers", () => {
  assert.deepEqual(parseArgs(["--client", "cursor,codex", "--dry-run"]), { clients: ["cursor", "codex"], dryRun: true });
  assert.throws(() => parseArgs(["--bogus"]));
  assert.equal(lineDiff("a\nb", "a\nc"), "- b\n+ c");
  assert.deepEqual(CLIENTS.map((c) => c.id), ["claude-code", "codex", "cursor", "gemini", "windsurf"]);
});

test("CLI binary: `setup --dry-run` with a temp HOME writes nothing", () => {
  const home = tmpHome();
  const skill = path.join(home, "..", `skill-${path.basename(home)}.md`);
  fs.writeFileSync(skill, SKILL);
  const out = execFileSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "setup", "--all", "--dry-run", "--skill-file", skill], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  assert.match(out, /Dry run/);
  assert.deepEqual(fs.readdirSync(home), []);
});
