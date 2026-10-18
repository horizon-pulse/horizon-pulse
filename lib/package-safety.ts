/**
 * Package signals check (dark route /api/package/check), npm and PyPI.
 * Public sources only, fixed hosts: registry.npmjs.org, api.npmjs.org,
 * pypi.org, pypistats.org, api.osv.dev, api.deps.dev (secondary, best effort)
 * and the CISA KEV JSON feed (cross-check only; NVD is never queried).
 * Informational; not a clearance.
 * Counsel C6 (10/18): NO npm security/advisory/audit data (npm Open Source
 * Terms bar redistributing it; vulnerability data comes from OSV.dev only, with
 * per-record attribution); no maintainer personal data (a count only);
 * pypistats cached 24 h per package.
 */
import { DATA_USER_AGENT, OSV_ATTRIBUTION, readTextCapped, BodyTooLargeError, upstashCache, type SharedCache } from "./dark-checks-shared";

export type Ecosystem = "npm" | "pypi";
export type Deps = {
  fetch: typeof fetch;
  now: () => number;
  cache?: SharedCache;
  /** Overall deadline for one check (default PACKAGE_DEADLINE_MS); tests shorten it. */
  deadlineMs?: number;
  /** Set by checkPackage: aborts every in-flight source request when the overall deadline passes. */
  signal?: AbortSignal;
};
/** One overall deadline per check (Odin re-review 10/18): sources run in parallel; whatever has not answered by then is marked missing and the answer is partial. */
export const PACKAGE_DEADLINE_MS = 20_000;
function reqSignal(deps: Deps, ms: number): AbortSignal {
  return deps.signal ? AbortSignal.any([AbortSignal.timeout(ms), deps.signal]) : AbortSignal.timeout(ms);
}
export const defaultDeps = (): Deps => ({ fetch: (...a) => fetch(...a), now: () => Date.now(), cache: upstashCache() });

const UA = { "user-agent": DATA_USER_AGENT };
export const PYPISTATS_CACHE_TTL_S = 24 * 3600;

/**
 * Only these source URLs are ever requested. npm security/advisory/audit data is
 * refused by an EXACT endpoint match on the parsed URL (host + path prefix), not a
 * substring test, so package names such as audit-ci, advisory-db or @x/advisor are
 * ordinary lookups (Odin B-1). Package names are percent-encoded into a single
 * path segment, so a name can never form the /-/npm/v1/security/ prefix.
 */
const ALLOWED_SOURCE = /^https:\/\/(registry\.npmjs\.org\/|api\.npmjs\.org\/downloads\/|pypi\.org\/pypi\/|pypistats\.org\/api\/packages\/|api\.osv\.dev\/v1\/query$|api\.deps\.dev\/v3\/(systems|projects)\/|www\.cisa\.gov\/sites\/default\/files\/feeds\/known_exploited_vulnerabilities\.json$)/;
const NPM_HOSTS = new Set(["registry.npmjs.org", "registry.npmjs.com", "api.npmjs.org", "api.npmjs.com", "www.npmjs.com", "npmjs.com"]);
/** npm's security/audit endpoints (npm audit, quick audit, bulk advisories, advisory search). */
const NPM_SECURITY_PATH = /^\/-\/(npm\/)?v1\/security(\/|$)/i;
export function isNpmSecurityEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return NPM_HOSTS.has(u.hostname.toLowerCase()) && NPM_SECURITY_PATH.test(u.pathname);
}
/** A source the check may not request. Treated like an unreachable source (502, not charged), never a 500. */
export class SourceDown extends Error {}
export class SourceNotAllowed extends SourceDown {}
export function assertAllowedSource(url: string): void {
  if (isNpmSecurityEndpoint(url) || !ALLOWED_SOURCE.test(url)) throw new SourceNotAllowed(`source not allowed: ${url.slice(0, 80)}`);
}

export const PACKAGE_METHOD =
  "Registry metadata from registry.npmjs.org or pypi.org, weekly downloads from api.npmjs.org or pypistats.org (cached 24 h), known vulnerabilities from OSV.dev (api.osv.dev/v1/query), build provenance as verified by deps.dev (and, on deep, the OpenSSF Scorecard of an attested source repository, via deps.dev) (cached 24 h), a cross-check of advisory CVEs against the CISA KEV catalog (cached 24 h), and a typosquat distance to a static list of popular names. Sources run in parallel under one 20 s deadline; a secondary source that misses it is listed in missing and the answer is marked partial; if OSV.dev cannot answer (error or deadline), no verdict is given and the call is not charged. The answer leads with verdict (no_known_issues, caution or block) by fixed rules; block is a recommendation based on the listed reasons, not a determination. No npm security or advisory data is used. Maintainers are reported as a count only.";
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

async function getJson(deps: Deps, url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown; truncated: boolean }> {
  assertAllowedSource(url);
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, headers: { ...UA, accept: "application/json", ...(init.headers as Record<string, string> | undefined) }, signal: reqSignal(deps, TIMEOUT) });
  } catch (e) {
    throw new SourceDown(`${new URL(url).host}: ${e instanceof Error ? e.message : "unreachable"}`);
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { status: 404, json: null, truncated: false };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SourceDown(`${new URL(url).host} answered ${res.status}`);
  }
  // Cap enforced while streaming, with or without content-length (Odin C3).
  let text: string;
  try {
    text = await readTextCapped(res, DOC_CAP);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return { status: res.status, json: null, truncated: true };
    throw new SourceDown(`${new URL(url).host}: ${e instanceof Error ? e.message : "read failed"}`);
  }
  try {
    return { status: res.status, json: JSON.parse(text), truncated: false };
  } catch {
    throw new SourceDown(`${new URL(url).host} returned invalid JSON`);
  }
}

type Vuln = { id: string; aliases: string[]; summary: string; severity: string | null; fixedIn: string[]; published: string | null; source: string; license: string; sourceUrl: string; recordUrl: string };

/** Per-record attribution (Counsel C6): the aggregated source, its licence and a link. */
export function osvAttribution(id: string): { source: string; license: string; sourceUrl: string; recordUrl: string } {
  const recordUrl = `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
  if (id.startsWith("GHSA-")) return { source: "GitHub Advisory Database", license: "CC-BY 4.0", sourceUrl: `https://github.com/advisories/${encodeURIComponent(id)}`, recordUrl };
  if (id.startsWith("PYSEC-")) return { source: "PyPI Advisory Database", license: "CC-BY 4.0", sourceUrl: "https://github.com/pypa/advisory-database", recordUrl };
  if (id.startsWith("MAL-")) return { source: "OpenSSF Malicious Packages", license: "Apache 2.0", sourceUrl: "https://github.com/ossf/malicious-packages", recordUrl };
  return { source: "OSV.dev", license: "see record", sourceUrl: recordUrl, recordUrl };
}
async function osv(deps: Deps, eco: Ecosystem, name: string, version: string | null): Promise<{ status: "ok"; vulns: Vuln[] } | { status: "unavailable"; error: string }> {
  try {
    assertAllowedSource("https://api.osv.dev/v1/query");
    const res = await deps.fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { ...UA, "content-type": "application/json" },
      body: JSON.stringify({ package: { name, ecosystem: eco === "npm" ? "npm" : "PyPI" }, ...(version ? { version } : {}) }),
      signal: reqSignal(deps, TIMEOUT),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: "unavailable", error: `api.osv.dev answered ${res.status}` };
    }
    const j = JSON.parse(await readTextCapped(res, DOC_CAP)) as { vulns?: Record<string, unknown>[] };
    const vulns = (j.vulns ?? []).slice(0, 100).map((v): Vuln => {
      const sev = (v.database_specific as { severity?: string } | undefined)?.severity ?? ((v.severity as { score?: string }[] | undefined)?.[0]?.score ?? null);
      const fixed = new Set<string>();
      for (const a of (v.affected as { ranges?: { events?: { fixed?: string }[] }[] }[] | undefined) ?? [])
        for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixed.add(e.fixed);
      return { id: String(v.id ?? ""), aliases: [...((v.aliases as string[] | undefined) ?? [])].map(String).sort((a, b) => Number(b.toUpperCase().startsWith("MAL-")) - Number(a.toUpperCase().startsWith("MAL-"))).slice(0, 5), summary: String(v.summary ?? "").slice(0, 300), severity: sev ? String(sev) : null, fixedIn: [...fixed].slice(0, 10), published: (v.published as string | undefined) ?? null, ...osvAttribution(String(v.id ?? "")) };
    });
    return { status: "ok", vulns };
  } catch (e) {
    return { status: "unavailable", error: `api.osv.dev: ${e instanceof Error ? e.message : "unreachable"}` };
  }
}

// ---------------------------------------------------------------------------
// deps.dev (Open Source Insights) and CISA KEV: secondary, best-effort inputs (Odin B-5)
// ---------------------------------------------------------------------------
/** Counsel wording, verbatim. Shown whenever a deps.dev-derived field is present. */
export const DEPSDEV_ATTRIBUTION = "Includes data from deps.dev (Open Source Insights, Google), generated data under CC-BY 4.0; advisories via OSV.dev, see each record's source.";
/** Counsel wording, verbatim. No CISA logo, no "CISA-verified" claim anywhere. */
export const KEV_ATTRIBUTION = "Known-exploited status from the CISA KEV catalog (CC0)";
/** Counsel re-read batch 2 (10/18), appended verbatim wherever a Scorecard score is shown (CDLA-Permissive-2.0 s.2.1). */
export const SCORECARD_ATTRIBUTION = " OpenSSF Scorecard score from the OpenSSF Scorecard project (via deps.dev), data licensed under CDLA-Permissive-2.0: https://cdla.dev/permissive-2-0/";
/** "verified" is deps.dev's own finding, not ours (Counsel re-read batch 2). */
export const BUILD_PROVENANCE_MEANING = "verified = the attestation was cryptographically verified by deps.dev (not by Horizon Pulse); unverified = an attestation is published but deps.dev did not verify it; none = no attestation known to deps.dev.";
export const DEPSDEV_CACHE_TTL_S = 24 * 3600;
export const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const KEV_TTL_MS = 24 * 3600 * 1000;
const KEV_CAP = 8_000_000;
const SIDE_TIMEOUT = 5_000;
/** relationProvenance values that come from a signed attestation, not from unverified package metadata. */
const ATTESTED_RELATION = new Set(["SLSA_ATTESTATION", "PYPI_PUBLISH_ATTESTATION", "RUBYGEMS_PUBLISH_ATTESTATION"]);

/** Only derived signals leave this module; no deps.dev response field is passed through. */
export type DepsDevSignals =
  | { status: "ok"; buildProvenance: "verified" | "unverified" | "none"; sourceRepoAttested: boolean; scorecardOverall: number | null }
  | { status: "unavailable" };

/** GET a JSON document; never throws (null on refusal, error, 404, oversize or bad JSON). */
async function sideJson(deps: Deps, url: string, cap: number): Promise<unknown | null> {
  try {
    assertAllowedSource(url);
    const res = await deps.fetch(url, { headers: { ...UA, accept: "application/json" }, signal: reqSignal(deps, SIDE_TIMEOUT) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return JSON.parse(await readTextCapped(res, cap));
  } catch {
    return null;
  }
}

type DdAttestation = { verified?: unknown };
type DdVersion = { slsaProvenances?: DdAttestation[]; attestations?: DdAttestation[]; relatedProjects?: { projectKey?: { id?: unknown }; relationProvenance?: unknown; relationType?: unknown }[] };

/** Pure derivation from a GetVersion body (exported for tests). */
export function deriveDepsDev(v: DdVersion): { buildProvenance: "verified" | "unverified" | "none"; attestedRepo: string | null } {
  const atts = [...(Array.isArray(v.slsaProvenances) ? v.slsaProvenances : []), ...(Array.isArray(v.attestations) ? v.attestations : [])];
  const buildProvenance = atts.some((a) => a?.verified === true) ? "verified" : atts.length ? "unverified" : "none";
  const rel = (Array.isArray(v.relatedProjects) ? v.relatedProjects : []).find(
    (r) => r?.relationType === "SOURCE_REPO" && typeof r.relationProvenance === "string" && ATTESTED_RELATION.has(r.relationProvenance) && typeof r.projectKey?.id === "string",
  );
  const id = rel ? String(rel.projectKey!.id) : null;
  return { buildProvenance, attestedRepo: id && /^(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+$/.test(id) ? id : null };
}

/**
 * deps.dev GetVersion (+ GetProject for the Scorecard, deep tier only, and only when
 * the source repo link comes from a verified attestation). Derived signals cached 24 h
 * (deps.dev: "Clients are expressly permitted to cache data served by the API").
 * No API key. Best effort: any failure is { status: "unavailable" } and never blocks.
 */
export async function depsDevSignals(deps: Deps, eco: Ecosystem, name: string, version: string, withScorecard: boolean): Promise<DepsDevSignals> {
  const key = `depsdev:v1:${eco}:${name}:${version}:${withScorecard ? 1 : 0}`;
  try {
    const hit = await deps.cache?.get(key);
    if (hit) return JSON.parse(hit) as DepsDevSignals;
  } catch {
    /* cache is best effort */
  }
  const v = await sideJson(deps, `https://api.deps.dev/v3/systems/${eco}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`, 2_000_000);
  if (!v || typeof v !== "object") return { status: "unavailable" };
  const d = deriveDepsDev(v as DdVersion);
  const sourceRepoAttested = d.attestedRepo !== null && d.buildProvenance === "verified";
  let scorecardOverall: number | null = null;
  if (withScorecard && sourceRepoAttested) {
    const p = (await sideJson(deps, `https://api.deps.dev/v3/projects/${encodeURIComponent(d.attestedRepo!)}`, 2_000_000)) as { scorecard?: { overallScore?: unknown } } | null;
    const sc = p?.scorecard?.overallScore;
    if (typeof sc === "number" && Number.isFinite(sc) && sc >= 0 && sc <= 10) scorecardOverall = Math.round(sc * 10) / 10;
  }
  const out: DepsDevSignals = { status: "ok", buildProvenance: d.buildProvenance, sourceRepoAttested, scorecardOverall };
  try {
    await deps.cache?.set(key, JSON.stringify(out), DEPSDEV_CACHE_TTL_S);
  } catch {
    /* cache is best effort */
  }
  return out;
}

let kevMemo: { at: number; cves: Set<string> | null } | null = null;
let kevInflight: Promise<Set<string> | null> | null = null;
/** A failed KEV fetch is remembered for 5 minutes per instance, so an outage costs one request per 5 min, not one per check (Odin re-review 10/18). */
export const KEV_NEGATIVE_TTL_MS = 5 * 60 * 1000;
export function resetKevCacheForTests(): void {
  kevMemo = null;
  kevInflight = null;
}
/** CISA KEV CVE ids, held in memory for 24 h per instance (failures 5 min). A cross-check only; null when unavailable. NVD is never queried. */
export async function kevCves(deps: Deps): Promise<Set<string> | null> {
  const now = deps.now();
  if (kevMemo && now - kevMemo.at < (kevMemo.cves ? KEV_TTL_MS : KEV_NEGATIVE_TTL_MS)) return kevMemo.cves;
  if (kevInflight) return kevInflight;
  kevInflight = (async () => {
    // The shared fetch carries only its own timeout, never the first caller's deadline signal: each
    // caller races this promise against its own deadline in runCheck, so one caller timing out cannot
    // hand an unflagged null to a second caller with time left (Odin Class A delta 10/18, LOW).
    const j = (await sideJson({ ...deps, signal: undefined }, KEV_URL, KEV_CAP)) as { vulnerabilities?: { cveID?: unknown }[] } | null;
    if (!j || !Array.isArray(j.vulnerabilities)) {
      kevMemo = { at: now, cves: null };
      return null;
    }
    const cves = new Set(j.vulnerabilities.map((x) => (typeof x?.cveID === "string" ? x.cveID.toUpperCase() : "")).filter((c) => /^CVE-\d{4}-\d{4,}$/.test(c)));
    kevMemo = { at: now, cves };
    return cves;
  })().finally(() => {
    kevInflight = null;
  });
  return kevInflight;
}

const daysBetween = (a: number, b: number) => Math.floor((b - a) / 86_400_000);

export type PkgReport = Record<string, unknown> & { exists: boolean };

// ---------------------------------------------------------------------------
// Verdict (Odin re-review 10/18): one field the answer leads with
// ---------------------------------------------------------------------------
export type Verdict = "no_known_issues" | "caution" | "block";
/** Counsel ruling 10/18, word for word. */
export const VERDICT_NOTE_NO_KNOWN_ISSUES =
  "No known issues found in the sources checked (OSV, CISA KEV, deps.dev) at the time of the check. This is not a security review or a guarantee the package is safe; review it before installing.";
/** Counsel 10/18 (PASS on a4518ba with this edit), verbatim: block is a recommendation based on the listed reasons, not a determination. */
export const VERDICT_NOTE_BLOCK =
  "Recommendation not to install, based on the reasons listed in verdictReasons. This is not a determination that the package is malicious or unsafe; review the listed reasons.";
export const VERDICT_NOTE_CAUTION =
  "Signals that need review before installing are listed in verdictReasons. This is not a security review or a determination about the package.";
export const VERDICT_NOTES: Record<Verdict, string> = { no_known_issues: VERDICT_NOTE_NO_KNOWN_ISSUES, caution: VERDICT_NOTE_CAUTION, block: VERDICT_NOTE_BLOCK };
/**
 * Fixed rules, most severe first:
 *   block   - package does not exist (hallucinated / typo name), or the requested version is not
 *             published, or OSV lists a MAL- (known malicious package) record for it, or an
 *             advisory CVE for the checked version is in the CISA KEV catalog.
 *   caution - otherwise, any warn/caution signal (typosquat distance, known vulnerabilities,
 *             first published < 30 days ago, < 100 weekly downloads, no license, install scripts,
 *             deprecated/yanked, unverified provenance attestation, low Scorecard), or the answer
 *             is partial (downloads, deps.dev or KEV missed the deadline).
 *   no_known_issues - none of the above.
 * OSV unavailable (error or past the deadline) never reaches the verdict: checkPackage returns a
 * 503 uncharged answer instead (Odin 10:05 AM ET 10/18). MAL- counts as the record id or an alias.
 */
export function packageVerdict(x: {
  exists: boolean;
  versionExists: boolean | null;
  requestedVersion: string | null;
  malicious: string[];
  kevHits: string[];
  signals: { signal: string; level: "info" | "caution" | "warn" }[];
  partial: boolean;
}): { verdict: Verdict; reasons: string[] } {
  const block: string[] = [];
  if (!x.exists) block.push("Package does not exist in the registry");
  if (x.exists && x.requestedVersion && x.versionExists === false) block.push(`Version ${x.requestedVersion} is not published`);
  if (x.malicious.length) block.push(`OSV lists a malicious-package record: ${x.malicious.join(", ")}`);
  if (x.kevHits.length) block.push(`Advisory CVE in the CISA KEV catalog: ${x.kevHits.join(", ")}`);
  if (block.length) return { verdict: "block", reasons: block };
  const caution = x.signals.filter((s) => s.level !== "info").map((s) => s.signal);
  if (x.partial) caution.push("Partial answer: some sources did not answer in time");
  if (caution.length) return { verdict: "caution", reasons: caution };
  return { verdict: "no_known_issues", reasons: [] };
}

const TIMED_OUT = Symbol("timed_out");
type TimedOut = typeof TIMED_OUT;
function race<T>(p: Promise<T>, deadline: Promise<TimedOut>): Promise<T | TimedOut> {
  p.catch(() => {}); // a source that loses the race and fails later is not an unhandled rejection
  return Promise.race([p, deadline]);
}

type Meta = { exists: boolean; latest: string | null; created: string | null; lastPublish: string | null; license: string | null; maintainers: number | null; repository: string | null; deprecated: string | null; installScripts: string[]; versions: { v: string; t: string }[]; versionExists: boolean | null; docTruncated: boolean };
const NO_META: Meta = { exists: false, latest: null, created: null, lastPublish: null, license: null, maintainers: null, repository: null, deprecated: null, installScripts: [], versions: [], versionExists: null, docTruncated: false };

async function registryMeta(deps: Deps, eco: Ecosystem, name: string, version: string | null): Promise<Meta> {
  if (eco === "npm") {
    const enc = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
    // Both registry documents in parallel (one round trip, not two).
    const [latest, full] = await Promise.all([getJson(deps, `https://registry.npmjs.org/${enc}/latest`), getJson(deps, `https://registry.npmjs.org/${enc}`)]);
    if (latest.status === 404) return { ...NO_META };
    const l = (latest.json ?? {}) as Record<string, unknown>;
    const f = (full.json ?? {}) as { time?: Record<string, string>; versions?: Record<string, unknown> };
    const time = f.time ?? {};
    const scripts = (l.scripts ?? {}) as Record<string, string>;
    const repo = l.repository as { url?: string } | string | undefined;
    let versionExists: boolean | null = version ? (f.versions ? Object.hasOwn(f.versions, version) : null) : null;
    // Packument over DOC_CAP (big packages: typescript, @types/*, aws-sdk...): ask for the one version
    // document instead, a few KB; 404 = not published (Odin Class A delta 10/18, repro lodash@99.0.0).
    // A 5xx here is SourceDown -> 502 not charged, never a guess.
    if (version && versionExists === null) {
      const one = await getJson(deps, `https://registry.npmjs.org/${enc}/${encodeURIComponent(version)}`);
      // npm resolves dist-tags here (/typescript/beta -> the beta release), but the normal path only
      // matches exact versions: require the document's own version to equal the request exactly,
      // else it is not found (block), same as the normal path (Odin 10:20 AM ET 10/18, LOW).
      const got = (one.json as { version?: unknown } | null)?.version;
      versionExists = one.status !== 404 && typeof got === "string" && got === version;
    }
    return {
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
      versionExists,
      docTruncated: full.truncated,
    };
  }
  const j = await getJson(deps, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (j.status === 404) return { ...NO_META };
  const d = (j.json ?? {}) as { info?: Record<string, unknown>; releases?: Record<string, { upload_time_iso_8601?: string; yanked?: boolean }[]> };
  const info = d.info ?? {};
  const versions = Object.entries(d.releases ?? {})
    .map(([v, files]) => ({ v, t: files.map((x) => x.upload_time_iso_8601 ?? "").filter(Boolean).sort()[0] ?? "" }))
    .filter((x) => x.t);
  const times = versions.map((x) => x.t).sort();
  const urls = (info.project_urls ?? {}) as Record<string, string>;
  const people = new Set([info.author, info.maintainer].filter((x) => typeof x === "string" && x.trim()));
  return {
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

async function weeklyDownloads(deps: Deps, eco: Ecosystem, name: string): Promise<{ lastWeek: number | null; source: string }> {
  try {
    if (eco === "npm") {
      const dl = await getJson(deps, `https://api.npmjs.org/downloads/point/last-week/${name.startsWith("@") ? name : encodeURIComponent(name)}`);
      return { lastWeek: Number((dl.json as { downloads?: number } | null)?.downloads ?? NaN) || 0, source: "api.npmjs.org" };
    }
    // pypistats updates once a day and asks callers to cache: 24 h shared cache per package (Counsel C6).
    const key = `pypistats:${name}`;
    const cached = await deps.cache?.get(key);
    let lastWeek = cached != null && /^\d+$/.test(cached) ? Number(cached) : null;
    if (lastWeek == null) {
      const dl = await getJson(deps, `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`);
      lastWeek = Number((dl.json as { data?: { last_week?: number } } | null)?.data?.last_week ?? NaN) || 0;
      await deps.cache?.set(key, String(lastWeek), PYPISTATS_CACHE_TTL_S);
    }
    return { lastWeek, source: "pypistats.org" };
  } catch {
    return { lastWeek: null, source: "unavailable" }; // downloads are best effort
  }
}

/**
 * Registry first (required: if it cannot answer, 502 not charged), then downloads, OSV,
 * deps.dev and the KEV cross-check IN PARALLEL, all under ONE overall deadline
 * (PACKAGE_DEADLINE_MS, 20 s; every source request is also aborted at the deadline).
 * A secondary source that misses it is listed in `missing` and the answer says `partial: true`;
 * OSV unavailable (error or late) is a 503, not charged, with no verdict.
 * Never throws: unexpected failures are a 502 refusal (not charged), never a 500.
 */
export async function checkPackage(input: PkgInput, tier: "base" | "deep", deps: Deps = defaultDeps()): Promise<{ ok: true; report: PkgReport } | { ok: false; status: number; code: string; error: string }> {
  const ctl = new AbortController();
  const deadlineMs = deps.deadlineMs ?? PACKAGE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<TimedOut>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort(new Error("deadline"));
      resolve(TIMED_OUT);
    }, deadlineMs);
  });
  const d: Deps = { ...deps, signal: deps.signal ? AbortSignal.any([deps.signal, ctl.signal]) : ctl.signal };
  try {
    return await runCheck(input, tier, d, deadline, deadlineMs, ctl.signal);
  } catch (e) {
    if (e instanceof SourceDown) return { ok: false, status: 502, code: "registry_unavailable", error: `${e.message}; not charged. Retry later.` };
    // Never a 500 (Odin B-1): any unexpected failure is a refused, uncharged answer.
    return { ok: false, status: 502, code: "check_failed", error: "The package check could not be completed; not charged. Retry later." };
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(input: PkgInput, tier: "base" | "deep", deps: Deps, deadline: Promise<TimedOut>, deadlineMs: number, deadlineSignal: AbortSignal): Promise<{ ok: true; report: PkgReport } | { ok: false; status: number; code: string; error: string }> {
  const { ecosystem: eco, name, version } = input;
  const squat = typosquatCheck(name, eco);
  const m = await race(registryMeta(deps, eco, name, version), deadline);
  if (m === TIMED_OUT) throw new SourceDown(`${eco === "npm" ? "registry.npmjs.org" : "pypi.org"} did not answer within ${deadlineMs / 1000} s`);
  const meta = m;

  // Everything else in parallel, under the same deadline.
  const checkedVersion = version ?? meta.latest;
  const osvP = meta.exists ? osv(deps, eco, name, checkedVersion) : Promise.resolve({ status: "ok", vulns: [] as Vuln[] } as const);
  const cvesOf = (v: Awaited<typeof osvP>) => (v.status === "ok" ? [...new Set(v.vulns.flatMap((x) => [x.id, ...x.aliases]).map((x) => x.toUpperCase()).filter((x) => /^CVE-\d{4}-\d{4,}$/.test(x)))] : []);
  const [dlR, vulnR, ddR, kevR] = await Promise.all([
    race(meta.exists ? weeklyDownloads(deps, eco, name) : Promise.resolve({ lastWeek: null, source: "unavailable" }), deadline),
    race(osvP, deadline),
    race(meta.exists && checkedVersion && (version === null || meta.versionExists !== false) ? depsDevSignals(deps, eco, name, checkedVersion, tier === "deep") : Promise.resolve(null), deadline),
    race(osvP.then((v) => (cvesOf(v).length ? kevCves(deps) : null)), deadline),
  ]);
  const late = deadlineSignal.aborted;
  const missing: string[] = [];
  const downloads = dlR === TIMED_OUT ? (missing.push("downloads"), { lastWeek: null, source: "timeout" }) : dlR;
  const vuln = vulnR === TIMED_OUT ? (missing.push("osv"), { status: "unavailable" as const, error: `api.osv.dev did not answer within ${deadlineMs / 1000} s` }) : vulnR;
  if (vulnR !== TIMED_OUT && vuln.status === "unavailable" && late) missing.push("osv");
  const depsDev: DepsDevSignals | null = ddR === TIMED_OUT ? (missing.push("deps.dev"), { status: "unavailable" }) : ddR;
  if (ddR !== TIMED_OUT && ddR?.status === "unavailable" && late) missing.push("deps.dev");
  const advisoryCves = cvesOf(vuln);
  const kev = kevR === TIMED_OUT ? (missing.push("cisa-kev"), null) : kevR;
  if (kevR !== TIMED_OUT && advisoryCves.length && kev === null && late) missing.push("cisa-kev");
  if (downloads.source === "unavailable" && meta.exists && late && !missing.includes("downloads")) missing.push("downloads");
  const partial = missing.length > 0;

  // OSV is the vulnerability source: without it there is no answer to bill (Odin 10:05 AM ET 10/18).
  // Any tier, error or past the deadline -> 503 uncharged (a non-2xx never settles); never a verdict.
  if (vuln.status === "unavailable") return { ok: false, status: 503, code: "advisory_source_unavailable", error: `Vulnerability data from OSV.dev is unavailable (${vuln.error}), so no verdict was produced; not charged. Retry later.` };

  const now = deps.now();
  const kevHits = kev ? advisoryCves.filter((c) => kev.has(c)).slice(0, 20) : [];
  // MAL- as the record id or only as an alias of another record (Odin Class A delta 10/18, LOW).
  const malicious = [...new Set(vuln.vulns.flatMap((v) => [v.id, ...v.aliases]).filter((id) => id.toUpperCase().startsWith("MAL-")))].slice(0, 10);
  const ageDays = meta.created ? daysBetween(Date.parse(meta.created), now) : null;
  const signals: { signal: string; level: "info" | "caution" | "warn" }[] = [];
  if (!meta.exists) signals.push({ signal: "Package does not exist in the registry (possible hallucinated or typo name)", level: "warn" });
  if (squat.nearest.length) signals.push({ signal: `Name is close to popular package(s): ${squat.nearest.map((h) => h.popular).join(", ")}`, level: "warn" });
  if (ageDays != null && ageDays < 30) signals.push({ signal: `First published ${ageDays} days ago`, level: "caution" });
  if (downloads.lastWeek != null && downloads.lastWeek < 100 && meta.exists) signals.push({ signal: `Low weekly downloads (${downloads.lastWeek})`, level: "caution" });
  if (meta.exists && !meta.license) signals.push({ signal: "No license declared", level: "caution" });
  if (meta.installScripts.length) signals.push({ signal: `Runs install scripts: ${meta.installScripts.join(", ")}`, level: "caution" });
  if (meta.deprecated) signals.push({ signal: `Deprecated or yanked: ${meta.deprecated}`, level: "caution" });
  if (malicious.length) signals.push({ signal: `OSV lists a malicious-package record: ${malicious.join(", ")}`, level: "warn" });
  if (vuln.status === "ok" && vuln.vulns.length) signals.push({ signal: `${vuln.vulns.length} known vulnerabilit${vuln.vulns.length === 1 ? "y" : "ies"} for ${checkedVersion ?? "this package"} (OSV.dev)`, level: "warn" });
  if (kevHits.length) signals.push({ signal: `${kevHits.length} advisory CVE${kevHits.length === 1 ? " is" : "s are"} in the CISA KEV catalog of known exploited vulnerabilities: ${kevHits.join(", ")}`, level: "warn" });
  if (depsDev?.status === "ok" && depsDev.buildProvenance === "unverified") signals.push({ signal: "A build provenance attestation is published but was not verified by deps.dev", level: "caution" });
  if (depsDev?.status === "ok" && depsDev.scorecardOverall != null && depsDev.scorecardOverall < 4) signals.push({ signal: `Low OpenSSF Scorecard for the attested source repository (${depsDev.scorecardOverall}/10, via deps.dev).${SCORECARD_ATTRIBUTION}`, level: "caution" });
  if (version && meta.versionExists === false) signals.push({ signal: `Version ${version} is not published`, level: "warn" });

  const v = packageVerdict({ exists: meta.exists, versionExists: meta.versionExists, requestedVersion: version, malicious, kevHits, signals, partial });
  const report: PkgReport = {
    verdict: v.verdict,
    verdictReasons: v.reasons,
    verdictNote: VERDICT_NOTES[v.verdict],
    partial,
    ...(partial ? { missing, partialNote: `Some sources did not answer within ${deadlineMs / 1000} s (${missing.join(", ")}); their fields are marked unavailable or timeout.` } : {}),
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
    vulnerabilities: { status: "ok", count: vuln.vulns.length, source: "api.osv.dev", checkedVersion, attribution: OSV_ATTRIBUTION },
    signals,
  };
  if (depsDev) {
    report.provenance =
      depsDev.status === "ok"
        ? {
            status: "ok",
            checkedVersion,
            buildProvenance: depsDev.buildProvenance,
            buildProvenanceMeaning: BUILD_PROVENANCE_MEANING,
            sourceRepoAttested: depsDev.sourceRepoAttested,
            ...(tier === "deep" ? { scorecardOverall: depsDev.scorecardOverall } : {}),
            source: "deps.dev",
            attribution: tier === "deep" && depsDev.scorecardOverall != null ? DEPSDEV_ATTRIBUTION + SCORECARD_ATTRIBUTION : DEPSDEV_ATTRIBUTION,
          }
        : { status: "unavailable", source: "deps.dev" };
  }
  if (advisoryCves.length) report.knownExploited = kev ? { status: "ok", cves: kevHits, attribution: KEV_ATTRIBUTION } : { status: "unavailable" };
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
}
