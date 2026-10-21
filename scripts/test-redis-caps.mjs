#!/usr/bin/env node
/**
 * LOCAL ONLY (never in CI): run the seller-dd caps Lua against a throwaway local Redis OSS.
 * Needs `redis-server` on PATH. Starts it on 127.0.0.1 (random high port, no persistence), runs
 * tests-local/redis-caps.test.ts under keys hp:test:ddcap:<random>:, then FLUSHALL + shutdown nosave.
 * No cloud store, no env secrets are read.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.CI) { console.error("test-redis-caps: refusing to run in CI"); process.exit(0); }
if (spawnSync("redis-server", ["--version"]).status !== 0) { console.error("test-redis-caps: redis-server not found (apt install redis-server)"); process.exit(2); }
const port = String(20000 + Math.floor(Math.random() * 20000));
const dir = mkdtempSync(join(tmpdir(), "hp-redis-"));
const srv = spawn("redis-server", ["--bind", "127.0.0.1", "--port", port, "--save", "", "--appendonly", "no", "--protected-mode", "yes", "--dir", dir], { stdio: "ignore" });
const cli = (...a) => spawnSync("redis-cli", ["-p", port, ...a], { encoding: "utf8" });
let up = false;
for (let i = 0; i < 50 && !up; i++) { await new Promise((r) => setTimeout(r, 100)); up = cli("ping").stdout?.trim() === "PONG"; }
if (!up) { srv.kill(); console.error("test-redis-caps: redis did not start"); process.exit(2); }
console.log(`test-redis-caps: ${cli("INFO", "server").stdout.match(/redis_version:\S+/)?.[0]} on 127.0.0.1:${port}`);
const t = spawnSync("npx", ["vitest", "run", "--config", "vitest.local-redis.config.ts"], { stdio: "inherit", env: { ...process.env, HP_LOCAL_REDIS_PORT: port } });
cli("FLUSHALL"); cli("shutdown", "nosave"); srv.kill();
process.exit(t.status ?? 1);
