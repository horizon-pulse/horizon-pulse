/**
 * payTo single source of truth (config/payto.json): drift + freshness + env
 * guard. See README "Changing the payTo" and scripts/sync-payto.mjs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import payto from "../config/payto.json";
import { BASE_PAY_TO_BASENAME, DEFAULT_PAY_TO, getPayTo } from "@/lib/config";
import { SOLANA_PAYTO, SOLANA_PAYTO_USDC_ATA } from "@/lib/solana-config";
// @ts-expect-error plain .mjs module without type declarations
import { GENERATED, HISTORICAL, SYNC_FILES, rewrite, shortEvm, validate, values } from "../scripts/sync-payto.mjs";

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const CUR = values(payto) as Record<string, string>;

/** Tracked files (git ls-files), or a filesystem walk when git is unavailable. */
function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    const out: string[] = [];
    const skip = new Set(["node_modules", ".next", ".git", ".vercel"]);
    const walk = (d: string) => {
      for (const e of readdirSync(path.join(ROOT, d))) {
        if (skip.has(e)) continue;
        const rel = d ? `${d}/${e}` : e;
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else out.push(rel);
      }
    };
    walk("");
    return out;
  }
}

/**
 * The config before its most recent change: the committed one if the working
 * tree differs (cut-over in progress), else the version before the last commit
 * that touched it. null if there is none (first version, shallow clone, no git).
 */
function previousConfig(): typeof payto | null {
  try {
    const head = JSON.parse(execFileSync("git", ["show", "HEAD:config/payto.json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (JSON.stringify(head) !== JSON.stringify(payto)) return head;
  } catch {
    // not committed yet / no git: fall through
  }
  try {
    const shas = execFileSync("git", ["log", "--format=%H", "-n", "1", "--", "config/payto.json"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (!shas) return null;
    return JSON.parse(execFileSync("git", ["show", `${shas}~1:config/payto.json`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null; // first version of the file, shallow clone, or no git
  }
}

describe("config/payto.json is the single source", () => {
  it("is valid and drives every runtime export", () => {
    expect(() => validate(payto)).not.toThrow();
    expect(DEFAULT_PAY_TO).toBe(payto.base.payTo);
    expect(BASE_PAY_TO_BASENAME).toBe(payto.base.basename);
    expect(SOLANA_PAYTO).toBe(payto.solana.payTo);
    expect(SOLANA_PAYTO_USDC_ATA).toBe(payto.solana.usdcAta);
  });

  it("no runtime source (lib/, app/, components/) hard-codes a payTo or Basename, except historical recordings", () => {
    const offenders: string[] = [];
    for (const f of trackedFiles()) {
      if (!/^(lib|app|components)\/.*\.(ts|tsx|js|mjs)$/.test(f) || HISTORICAL.includes(f)) continue;
      const t = read(f);
      for (const k of ["base.payTo", "solana.payTo", "solana.usdcAta", "base.basename"]) {
        if (t.toLowerCase().includes(CUR[k].toLowerCase())) offenders.push(`${f}: ${k}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every synced file (docs, buyer-side pins, .env.example) carries the current values", () => {
    for (const { file, values: keys } of SYNC_FILES as { file: string; values: string[] }[]) {
      const t = read(file);
      for (const k of keys) expect(t.includes(CUR[k]), `${file} missing ${k} ${CUR[k]}`).toBe(true);
    }
  });

  it("mcp buyer-side pins equal the config (hard-coded on purpose, no env override)", () => {
    expect(read("mcp/src/config.ts")).toMatch(new RegExp(`EXPECTED_PAY_TO = "${payto.base.payTo}"`));
    expect(read("mcp/examples/demo.mjs")).toMatch(new RegExp(`PINNED_PAY_TO = "${payto.base.payTo}"`));
    expect(read("mcp/test/unpaid-test.mjs")).toMatch(new RegExp(`PAY_TO = "${payto.base.payTo}"`));
    expect(read("examples/reference-agent.mjs")).toMatch(new RegExp(`EXPECTED_PAY_TO = "${payto.base.payTo}"`));
  });

  it("no tracked file names a retired address, except the documented warnings", () => {
    const allowed = new Set([
      "config/payto.json", // the retired list itself
      "README.md", // "Do not use the retired address ..."
      "app/status/page.tsx", // "the old Safe ... is no longer used" notice
      "tests/payto-pin.test.ts",
    ]);
    const retired = [...payto.retired.base, ...payto.retired.solana].map((a) => a.toLowerCase());
    const hits = trackedFiles()
      .filter((f) => !allowed.has(f) && !/\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/.test(f))
      .filter((f) => retired.some((a) => read(f).toLowerCase().includes(a)));
    expect(hits).toEqual([]);
  });

  it("after a cut-over, no tracked file still carries the previous value (except historical recordings; re-record those)", () => {
    const prev = previousConfig();
    if (!prev) return; // config has a single version so far: nothing to compare
    const oldV = values(prev) as Record<string, string>;
    const stale = Object.keys(oldV).filter((k) => k !== "base.short" && oldV[k] !== CUR[k]);
    // Historical recordings keep the old value until re-recorded; public/openapi.json embeds the
    // recorded /api/x402-check example (lib/route-examples.ts), so it is NOT exempt: this test
    // fails until that example is re-recorded. reference-agent.mjs: PORTFOLIO_DEMO is a sample input.
    const allowed = new Set([...HISTORICAL, "examples/reference-agent.mjs"]);
    const hits: string[] = [];
    for (const f of trackedFiles()) {
      if (allowed.has(f) || /\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/.test(f)) continue;
      const t = read(f).toLowerCase();
      for (const k of stale) if (t.includes(oldV[k].toLowerCase())) hits.push(`${f}: ${k}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("generated discovery docs are fresh (byte-identical to their generators)", () => {
  it("public/llms.txt == scripts/llms.template.txt rendered with the config", async () => {
    const { renderLlms } = await import("../scripts/gen-llms");
    expect(renderLlms()).toBe(read("public/llms.txt"));
    const tpl = read("scripts/llms.template.txt");
    for (const k of ["base.payTo", "solana.payTo", "base.basename"]) expect(tpl.includes(CUR[k]), `template hard-codes ${k}`).toBe(false);
  });

  it("public/openapi.json == gen:openapi output", async () => {
    vi.stubEnv("PAY_TO", "");
    const { OPENAPI_JSON } = await import("../scripts/gen-openapi");
    expect(OPENAPI_JSON).toBe(read("public/openapi.json"));
    expect(GENERATED).toEqual(["public/llms.txt", "public/openapi.json"]);
  });
});

describe("env PAY_TO is a fail-closed guard, not a source", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("unset or empty: the config value", () => {
    vi.stubEnv("PAY_TO", "");
    expect(getPayTo()).toBe(payto.base.payTo);
    vi.stubEnv("PAY_TO", "   ");
    expect(getPayTo()).toBe(payto.base.payTo);
  });

  it("equal to the config (any case, padded): the config value", () => {
    vi.stubEnv("PAY_TO", payto.base.payTo);
    expect(getPayTo()).toBe(payto.base.payTo);
    vi.stubEnv("PAY_TO", ` ${payto.base.payTo.toUpperCase().replace("0X", "0x")}\n`);
    expect(getPayTo()).toBe(payto.base.payTo);
  });

  it("any other value throws (never pays elsewhere)", () => {
    for (const v of [
      `0x${"11".repeat(20)}`, // a different valid address
      payto.base.payTo.slice(0, -1) + "0", // one char edited
      payto.retired.base[0], // the retired treasury
      "not-an-address",
      payto.solana.payTo,
    ]) {
      vi.stubEnv("PAY_TO", v);
      expect(() => getPayTo(), v).toThrow(/PAY_TO env does not match config\/payto\.json/);
    }
  });
});

describe("sync-payto rewrite (pure; synthetic values, no real address involved)", () => {
  const OLD = { base: { payTo: `0x${"aa".repeat(20)}`, basename: "old.base.eth" }, solana: { payTo: "1".repeat(32), usdcAta: "2".repeat(32) }, retired: { base: [], solana: [] } };
  const NEW = { base: { payTo: `0x${"bb".repeat(20)}`, basename: "new.base.eth" }, solana: { payTo: "3".repeat(32), usdcAta: "4".repeat(32) }, retired: { base: [], solana: [] } };

  it("swaps full values and the short form, and nothing else", () => {
    const text = `payTo ${OLD.base.payTo} (${OLD.base.basename}); short ${shortEvm(OLD.base.payTo)}; sol ${OLD.solana.payTo} ata ${OLD.solana.usdcAta}; other 0x${"cc".repeat(20)}`;
    const { text: out, count } = rewrite(text, values(OLD), values(NEW));
    expect(out).toBe(`payTo ${NEW.base.payTo} (${NEW.base.basename}); short ${shortEvm(NEW.base.payTo)}; sol ${NEW.solana.payTo} ata ${NEW.solana.usdcAta}; other 0x${"cc".repeat(20)}`);
    expect(count).toBe(5);
  });

  it("lineFilter limits the rewrite to matching lines (keeps sample inputs)", () => {
    const text = `const EXPECTED_PAY_TO = "${OLD.base.payTo}";\nconst PORTFOLIO_DEMO = "${OLD.base.payTo}";`;
    const { text: out } = rewrite(text, values(OLD), values(NEW), /EXPECTED_PAY_TO\s*=/);
    expect(out).toBe(`const EXPECTED_PAY_TO = "${NEW.base.payTo}";\nconst PORTFOLIO_DEMO = "${OLD.base.payTo}";`);
  });

  it("validate refuses malformed or retired configs", () => {
    expect(() => validate({ ...NEW, base: { ...NEW.base, payTo: NEW.base.payTo.toUpperCase() } })).toThrow();
    expect(() => validate({ ...NEW, retired: { base: [NEW.base.payTo], solana: [] } })).toThrow();
    expect(() => validate({ ...NEW, solana: { ...NEW.solana, payTo: "0OIl" } })).toThrow();
    expect(() => validate(NEW)).not.toThrow();
  });
});
