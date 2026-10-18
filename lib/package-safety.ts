/**
 * Package safety check (dark route /api/package/check), npm and PyPI.
 * Public sources only, fixed hosts: registry.npmjs.org, api.npmjs.org,
 * pypi.org, pypistats.org, api.osv.dev. Informational; not a clearance.
 */
export type Ecosystem = "npm" | "pypi";
export type Deps = { fetch: typeof fetch; now: () => number };
export const defaultDeps = (): Deps => ({ fetch: (...a) => fetch(...a), now: () => Date.now() });

const UA = { "user-agent": "HorizonPulse/1.0 (+https://horizonpulse.dev)" };
const DOC_CAP = 6_000_000;
const TIMEOUT = 8_000;

/** Popular names typosquats aim at (static list; distance is computed, never fetched). */
export const POPULAR: Record<Ecosystem, readonly string[]> = {
  npm: [
    "react", "react-dom", "lodash", "express", "axios", "chalk", "commander", "debug", "moment", "request", "async", "uuid",
    "typescript", "webpack", "babel-core", "@babel/core", "eslint", "prettier", "jest", "mocha", "vue", "next", "nuxt",
    "angular", "@angular/core", "rxjs", "tslib", "dotenv", "yargs", "minimist", "glob", "rimraf", "mkdirp", "fs-extra",
    "body-parser", "cors", "jsonwebtoken", "bcrypt", "bcryptjs", "mongoose", "mongodb", "mysql", "mysql2", "pg", "redis",
    "ioredis", "socket.io", "ws", "node-fetch", "cross-env", "nodemon", "semver", "colors", "underscore", "jquery",
    "bluebird", "classnames", "prop-types", "styled-components", "tailwindcss", "postcss", "autoprefixer", "sass", "less",
    "vite", "rollup", "esbuild", "parcel", "zod", "yup", "joi", "date-fns", "dayjs", "luxon", "qs", "cheerio", "puppeteer",
    "playwright", "electron", "ethers", "web3", "viem", "wagmi", "@solana/web3.js", "bignumber.js", "bn.js", "crypto-js",
    "openai", "@anthropic-ai/sdk", "langchain", "discord.js", "telegraf", "stripe", "aws-sdk", "@aws-sdk/client-s3",
    "firebase", "graphql", "apollo-server", "prisma", "@prisma/client", "sequelize", "typeorm", "knex", "winston", "pino",
    "morgan", "helmet", "passport", "multer", "sharp", "jimp", "nodemailer", "inquirer", "ora", "execa", "shelljs",
    "core-js", "regenerator-runtime", "event-stream", "coffee-script", "ua-parser-js", "node-ipc", "colors.js", "faker",
  ],
  pypi: [
    "requests", "numpy", "pandas", "urllib3", "setuptools", "six", "python-dateutil", "boto3", "botocore", "certifi",
    "idna", "charset-normalizer", "pyyaml", "typing-extensions", "cryptography", "pip", "wheel", "attrs", "pydantic",
    "jinja2", "markupsafe", "click", "flask", "django", "fastapi", "uvicorn", "starlette", "sqlalchemy", "psycopg2",
    "psycopg2-binary", "pymysql", "redis", "celery", "pytest", "tox", "black", "flake8", "mypy", "pylint", "isort",
    "scipy", "scikit-learn", "matplotlib", "seaborn", "tensorflow", "keras", "torch", "torchvision", "transformers",
    "openai", "anthropic", "langchain", "tiktoken", "httpx", "aiohttp", "beautifulsoup4", "lxml", "selenium", "scrapy",
    "pillow", "opencv-python", "colorama", "tqdm", "rich", "pyjwt", "paramiko", "docker", "kubernetes", "google-auth",
    "protobuf", "grpcio", "web3", "eth-account", "solana", "python-dotenv", "toml", "packaging", "virtualenv", "jupyter",
    "ipython", "notebook", "networkx", "sympy", "nltk", "spacy", "gensim", "xgboost", "lightgbm", "pyarrow", "polars",
  ],
};

/** Damerau-Levenshtein (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[m]![n]!;
}

/** Normalise for squat comparison: case, separators, common look-alike swaps, npm scope. */
export function squatKey(name: string, eco: Ecosystem): string {
  let s = name.toLowerCase();
  if (eco === "npm") s = s.replace(/^@[^/]+\//, "");
  return s.replace(/[-_.]+/g, "").replace(/rn/g, "m").replace(/0/g, "o").replace(/[1l|]/g, "i").replace(/vv/g, "w");
}

export type SquatHit = { popular: string; distance: number; reason: "edit_distance" | "lookalike" | "scope_swap" };
export function typosquatCheck(name: string, eco: Ecosystem): { nearest: SquatHit[]; isPopular: boolean } {
  const n = name.toLowerCase();
  const list = POPULAR[eco];
  if (list.includes(n)) return { nearest: [], isPopular: true };
  const hits: SquatHit[] = [];
  const nk = squatKey(n, eco);
  for (const p of list) {
    const pk = squatKey(p, eco);
    if (nk === pk) {
      hits.push({ popular: p, distance: 0, reason: eco === "npm" && n.includes("/") !== p.includes("/") ? "scope_swap" : "lookalike" });
      continue;
    }
    const dist = editDistance(n, p);
    const limit = p.length <= 4 ? 1 : 2;
    if (dist <= limit) hits.push({ popular: p, distance: dist, reason: "edit_distance" });
  }
  hits.sort((a, b) => a.distance - b.distance || a.popular.localeCompare(b.popular));
  return { nearest: hits.slice(0, 5), isPopular: false };
}

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+!_-]{0,63}$/;

export type PkgInput = { ecosystem: Ecosystem; name: string; version: string | null };
export function parsePkgInput(q: { ecosystem: string | null; name: string | null; version: string | null }): { ok: true; input: PkgInput } | { ok: false; error: string } {
  const eco = (q.ecosystem ?? "").trim().toLowerCase();
  if (eco !== "npm" && eco !== "pypi") return { ok: false, error: "ecosystem must be npm or pypi" };
  const name = (q.name ?? "").trim();
  if (!name || name.length > 214) return { ok: false, error: "name is required (max 214 chars)" };
  if (eco === "npm" ? !NPM_NAME.test(name) : !PYPI_NAME.test(name)) return { ok: false, error: `name is not a valid ${eco} package name` };
  const version = q.version?.trim() || null;
  if (version && !VERSION.test(version)) return { ok: false, error: "version has invalid characters" };
  return { ok: true, input: { ecosystem: eco, name: eco === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name, version } };
}

class SourceDown extends Error {}

async function getJson(deps: Deps, url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown; truncated: boolean }> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, headers: { ...UA, accept: "application/json", ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new SourceDown(`${new URL(url).host}: ${e instanceof Error ? e.message : "unreachable"}`);
  }
  if (res.status === 404) return { status: 404, json: null, truncated: false };
  if (!res.ok) throw new SourceDown(`${new URL(url).host} answered ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > DOC_CAP) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, json: null, truncated: true };
  }
  const text = await res.text();
  if (text.length > DOC_CAP) return { status: res.status, json: null, truncated: true };
  try {
    return { status: res.status, json: JSON.parse(text), truncated: false };
  } catch {
    throw new SourceDown(`${new URL(url).host} returned invalid JSON`);
  }
}

type Vuln = { id: string; aliases: string[]; summary: string; severity: string | null; fixedIn: string[]; published: string | null };
async function osv(deps: Deps, eco: Ecosystem, name: string, version: string | null): Promise<{ status: "ok"; vulns: Vuln[] } | { status: "unavailable"; error: string }> {
  try {
    const res = await deps.fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { ...UA, "content-type": "application/json" },
      body: JSON.stringify({ package: { name, ecosystem: eco === "npm" ? "npm" : "PyPI" }, ...(version ? { version } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return { status: "unavailable", error: `api.osv.dev answered ${res.status}` };
    const j = (await res.json()) as { vulns?: Record<string, unknown>[] };
    const vulns = (j.vulns ?? []).slice(0, 100).map((v): Vuln => {
      const sev = (v.database_specific as { severity?: string } | undefined)?.severity ?? ((v.severity as { score?: string }[] | undefined)?.[0]?.score ?? null);
      const fixed = new Set<string>();
      for (const a of (v.affected as { ranges?: { events?: { fixed?: string }[] }[] }[] | undefined) ?? [])
        for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixed.add(e.fixed);
      return { id: String(v.id ?? ""), aliases: ((v.aliases as string[] | undefined) ?? []).slice(0, 5), summary: String(v.summary ?? "").slice(0, 300), severity: sev ? String(sev) : null, fixedIn: [...fixed].slice(0, 10), published: (v.published as string | undefined) ?? null };
    });
    return { status: "ok", vulns };
  } catch (e) {
    return { status: "unavailable", error: `api.osv.dev: ${e instanceof Error ? e.message : "unreachable"}` };
  }
}

const daysBetween = (a: number, b: number) => Math.floor((b - a) / 86_400_000);

export type PkgReport = Record<string, unknown> & { exists: boolean };

/** Throws SourceDown only when the primary registry cannot answer (caller: 502, not charged). */
export async function checkPackage(input: PkgInput, tier: "base" | "deep", deps: Deps = defaultDeps()): Promise<{ ok: true; report: PkgReport } | { ok: false; status: number; code: string; error: string }> {
  const { ecosystem: eco, name, version } = input;
  const squat = typosquatCheck(name, eco);
  try {
    let meta: { exists: boolean; latest: string | null; created: string | null; lastPublish: string | null; license: string | null; maintainers: number | null; repository: string | null; deprecated: string | null; installScripts: string[]; versions: { v: string; t: string }[]; versionExists: boolean | null; docTruncated: boolean };
    if (eco === "npm") {
      const enc = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
      const latest = await getJson(deps, `https://registry.npmjs.org/${enc}/latest`);
      if (latest.status === 404) {
        meta = { exists: false, latest: null, created: null, lastPublish: null, license: null, maintainers: null, repository: null, deprecated: null, installScripts: [], versions: [], versionExists: null, docTruncated: false };
      } else {
        const l = (latest.json ?? {}) as Record<string, unknown>;
        const full = await getJson(deps, `https://registry.npmjs.org/${enc}`);
        const f = (full.json ?? {}) as { time?: Record<string, string>; versions?: Record<string, unknown> };
        const time = f.time ?? {};
        const scripts = (l.scripts ?? {}) as Record<string, string>;
        const repo = l.repository as { url?: string } | string | undefined;
        meta = {
          exists: true,
          latest: (l.version as string) ?? null,
          created: time.created ?? null,
          lastPublish: time.modified ?? null,
          license: typeof l.license === "string" ? l.license : ((l.license as { type?: string } | undefined)?.type ?? null),
          maintainers: Array.isArray(l.maintainers) ? l.maintainers.length : null,
          repository: typeof repo === "string" ? repo : (repo?.url ?? null),
          deprecated: typeof l.deprecated === "string" ? l.deprecated.slice(0, 300) : null,
          installScripts: ["preinstall", "install", "postinstall", "prepare"].filter((k) => typeof scripts[k] === "string"),
          versions: Object.entries(time).filter(([k]) => k !== "created" && k !== "modified").map(([v, t]) => ({ v, t })),
          versionExists: version ? (f.versions ? Object.hasOwn(f.versions, version) : null) : null,
          docTruncated: full.truncated,
        };
      }
    } else {
      const j = await getJson(deps, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      if (j.status === 404) {
        meta = { exists: false, latest: null, created: null, lastPublish: null, license: null, maintainers: null, repository: null, deprecated: null, installScripts: [], versions: [], versionExists: null, docTruncated: false };
      } else {
        const d = (j.json ?? {}) as { info?: Record<string, unknown>; releases?: Record<string, { upload_time_iso_8601?: string; yanked?: boolean }[]> };
        const info = d.info ?? {};
        const versions = Object.entries(d.releases ?? {})
          .map(([v, files]) => ({ v, t: files.map((x) => x.upload_time_iso_8601 ?? "").filter(Boolean).sort()[0] ?? "" }))
          .filter((x) => x.t);
        const times = versions.map((x) => x.t).sort();
        const urls = (info.project_urls ?? {}) as Record<string, string>;
        const people = new Set([info.author, info.maintainer].filter((x) => typeof x === "string" && x.trim()));
        meta = {
          exists: true,
          latest: (info.version as string) ?? null,
          created: times[0] ?? null,
          lastPublish: times[times.length - 1] ?? null,
          license: ((info.license_expression as string) || (info.license as string) || null)?.slice(0, 100) ?? null,
          maintainers: people.size || null,
          repository: urls.Source ?? urls.Repository ?? urls.Homepage ?? (info.home_page as string) ?? null,
          deprecated: (info.yanked as boolean) ? String(info.yanked_reason ?? "yanked") : null,
          installScripts: [],
          versions,
          versionExists: version ? Object.hasOwn(d.releases ?? {}, version) : null,
          docTruncated: j.truncated,
        };
      }
    }

    const now = deps.now();
    let downloads: { lastWeek: number | null; source: string } = { lastWeek: null, source: "unavailable" };
    if (meta.exists) {
      try {
        if (eco === "npm") {
          const dl = await getJson(deps, `https://api.npmjs.org/downloads/point/last-week/${name.startsWith("@") ? name : encodeURIComponent(name)}`);
          downloads = { lastWeek: Number((dl.json as { downloads?: number } | null)?.downloads ?? NaN) || 0, source: "api.npmjs.org" };
        } else {
          const dl = await getJson(deps, `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`);
          downloads = { lastWeek: Number((dl.json as { data?: { last_week?: number } } | null)?.data?.last_week ?? NaN) || 0, source: "pypistats.org" };
        }
      } catch {
        /* downloads are best effort */
      }
    }

    const vuln = meta.exists ? await osv(deps, eco, name, version ?? meta.latest) : ({ status: "ok", vulns: [] } as const);
    if (tier === "deep" && vuln.status === "unavailable") return { ok: false, status: 503, code: "advisory_source_unavailable", error: `${vuln.error}; deep tier needs vulnerability data, not charged. Retry later.` };

    const ageDays = meta.created ? daysBetween(Date.parse(meta.created), now) : null;
    const signals: { signal: string; level: "info" | "caution" | "warn" }[] = [];
    if (!meta.exists) signals.push({ signal: "Package does not exist in the registry (possible hallucinated or typo name)", level: "warn" });
    if (squat.nearest.length) signals.push({ signal: `Name is close to popular package(s): ${squat.nearest.map((h) => h.popular).join(", ")}`, level: "warn" });
    if (ageDays != null && ageDays < 30) signals.push({ signal: `First published ${ageDays} days ago`, level: "caution" });
    if (downloads.lastWeek != null && downloads.lastWeek < 100 && meta.exists) signals.push({ signal: `Low weekly downloads (${downloads.lastWeek})`, level: "caution" });
    if (meta.exists && !meta.license) signals.push({ signal: "No license declared", level: "caution" });
    if (meta.installScripts.length) signals.push({ signal: `Runs install scripts: ${meta.installScripts.join(", ")}`, level: "caution" });
    if (meta.deprecated) signals.push({ signal: `Deprecated or yanked: ${meta.deprecated}`, level: "caution" });
    if (vuln.status === "ok" && vuln.vulns.length) signals.push({ signal: `${vuln.vulns.length} known vulnerabilit${vuln.vulns.length === 1 ? "y" : "ies"} for ${version ?? meta.latest ?? "this package"} (OSV.dev)`, level: "warn" });
    if (version && meta.versionExists === false) signals.push({ signal: `Version ${version} is not published`, level: "warn" });

    const report: PkgReport = {
      ecosystem: eco,
      name,
      exists: meta.exists,
      requestedVersion: version,
      versionExists: meta.versionExists,
      latestVersion: meta.latest,
      firstPublished: meta.created,
      ageDays,
      lastPublished: meta.lastPublish,
      weeklyDownloads: downloads.lastWeek,
      downloadsSource: downloads.source,
      maintainerCount: meta.maintainers,
      license: meta.license,
      typosquat: { isPopularName: squat.isPopular, nearestPopular: squat.nearest },
      vulnerabilities: vuln.status === "ok" ? { status: "ok", count: vuln.vulns.length, source: "api.osv.dev", checkedVersion: version ?? meta.latest } : { status: "unavailable", error: vuln.error },
      signals,
    };
    if (tier === "deep") {
      const sorted = meta.versions.filter((x) => x.t).sort((a, b) => a.t.localeCompare(b.t));
      const last90 = sorted.filter((x) => now - Date.parse(x.t) <= 90 * 86_400_000).length;
      report.deep = {
        vulnerabilities: vuln.status === "ok" ? vuln.vulns : [],
        installScripts: meta.installScripts,
        deprecated: meta.deprecated,
        repository: meta.repository,
        releases: { total: sorted.length, last90Days: last90, latest: sorted[sorted.length - 1] ?? null, documentTooLarge: meta.docTruncated },
      };
    }
    return { ok: true, report };
  } catch (e) {
    if (e instanceof SourceDown) return { ok: false, status: 502, code: "registry_unavailable", error: `${e.message}; not charged. Retry later.` };
    throw e;
  }
}
