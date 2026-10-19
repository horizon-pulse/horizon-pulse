/**
 * Every /api/... path a public surface lists must be a real route (Odin 10/19, review round 6:
 * the homepage showed 9 hyphenated names such as /api/x402-check-deep that 404).
 * Source of truth: app/api/**\/route.ts on disk + lib/live-catalog.ts (what /.well-known/x402 lists).
 * Surfaces: homepage, /status, /try copy line, /.well-known/x402, /llms.txt, /openapi.json, /skill.md, MCP tools.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIVE_PAID_ROUTES, routePath } from "@/lib/live-catalog";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { buildSkillMarkdown } from "@/lib/agent-skill";
import { toolsFromOpenApi } from "@/mcp/src/catalog";

const ROOT = join(__dirname, "..");

function routeFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p, `${base}/${e}`));
    else if (e === "route.ts") out.push(base);
  }
  return out;
}
const REAL = routeFiles(join(ROOT, "app/api")).map((r) => `/api${r}`);
const REAL_RX = REAL.map((r) => new RegExp(`^${r.replace(/\[[^/]+\]/g, "[^/]+")}$`));
const DEMO_SLUGS = new Set(DEMO_ROUTES.map((d) => d.route));
const LIVE = LIVE_PAID_ROUTES.map(routePath);

/** A listed path is valid if it is a real route; a /api/demo/<slug> must also be a known demo slug. */
function isReal(p: string): boolean {
  const demo = p.match(/^\/api\/demo\/([^/]+)$/);
  if (demo) return DEMO_SLUGS.has(demo[1]);
  return REAL_RX.some((rx) => rx.test(p));
}
/** /api/... tokens in free text; drops "/api/demo" with no slug and placeholder text. */
function listed(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])\/api\/[a-z0-9][a-z0-9\-/]*/g)) {
    const p = m[0].replace(/\/+$/, "");
    if (p === "/api/demo") continue;
    out.add(p);
  }
  return [...out];
}
const bad = (ps: string[]) => ps.filter((p) => !isReal(p));

describe("listed route paths are real routes", () => {
  it("source of truth: every live catalog path is a real route file", () => {
    expect(LIVE.length).toBeGreaterThan(0);
    expect(bad(LIVE)).toEqual([]);
  });

  it("/.well-known/x402 lists exactly the live catalog", async () => {
    const { GET } = await import("@/app/.well-known/x402/route");
    const doc = await GET().json();
    const paths = (doc.resources as string[]).map((u) => new URL(u).pathname);
    expect(new Set(paths)).toEqual(new Set(LIVE));
  });

  it("homepage route table shows real paths only (no hyphenated nested names)", async () => {
    const { default: HomePage } = await import("@/app/page");
    const html = renderToStaticMarkup(createElement(HomePage));
    const shown = [...html.matchAll(/<td class="r">([^<]+)<\/td>|<h3>(\/api\/[^<]+)<\/h3>/g)].map((m) => m[1] ?? m[2]);
    expect(shown.length).toBeGreaterThanOrEqual(LIVE.length);
    expect(bad(shown)).toEqual([]);
    for (const p of LIVE) expect(shown).toContain(p);
    expect(bad(listed(html))).toEqual([]);
  });

  it("/status route table shows real paths only", async () => {
    const src = readFileSync(join(ROOT, "app/status/page.tsx"), "utf8");
    expect(src).not.toMatch(/`\/api\/\$\{name\}`/);
  });

  it("/try paid-call line uses the real path for every demo slug", async () => {
    const { default: TryPage } = await import("@/app/try/page");
    const el = TryPage() as any;
    const find = (n: any): any => (n?.props?.routes ? n : [].concat(n?.props?.children ?? []).map(find).find(Boolean));
    const routes = find(el).props.routes as { route: string; path: string }[];
    expect(routes.length).toBe(DEMO_ROUTES.length);
    expect(bad(routes.map((r) => r.path))).toEqual([]);
    expect(readFileSync(join(ROOT, "components/TryPlayground.tsx"), "utf8")).not.toMatch(/\/api\/\$\{sel\}/);
  });

  it("/llms.txt lists real paths only", () => {
    expect(bad(listed(readFileSync(join(ROOT, "public/llms.txt"), "utf8")))).toEqual([]);
  });

  it("/openapi.json: every path is real and paid paths match the live catalog", () => {
    const spec = JSON.parse(readFileSync(join(ROOT, "public/openapi.json"), "utf8"));
    const paths = Object.keys(spec.paths);
    expect(bad(paths)).toEqual([]);
    const paid = paths.filter((p) => ["get", "post"].some((m) => spec.paths[p][m]?.["x-payment-info"]));
    expect(new Set(paid)).toEqual(new Set(LIVE));
  });

  it("/skill.md lists real paths only", () => {
    expect(bad(listed(buildSkillMarkdown()))).toEqual([]);
  });

  it("MCP tools (npm package, from openapi) map to real paths and real demo slugs", () => {
    const spec = JSON.parse(readFileSync(join(ROOT, "public/openapi.json"), "utf8"));
    const tools = toolsFromOpenApi(spec) as any[];
    expect(tools.length).toBe(LIVE.length);
    expect(bad(tools.map((t) => t.path))).toEqual([]);
    expect(bad(tools.filter((t) => t.demo).map((t) => `/api/demo/${t.demo}`))).toEqual([]);
    expect(tools.find((t) => t.path === "/api/batch")?.demo).toBeNull();
  });

  it("MCP tools (hosted /mcp) call real paths only", () => {
    const src = readFileSync(join(ROOT, "lib/mcp-server.ts"), "utf8");
    const calls = [...src.matchAll(/makeRequest\(\s*"([^"]+)"/g), ...src.matchAll(/:\s*"(\/api\/[^"]+)"/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(10);
    expect(bad(calls)).toEqual([]);
  });

  it("the check itself catches the bug it guards against", () => {
    expect(bad(["/api/x402-check-deep", "/api/market-search", "/api/chain-head"])).toHaveLength(3);
    expect(bad(["/api/x402-check/deep", "/api/market/search", "/api/demo/market-search"])).toEqual([]);
  });
});
