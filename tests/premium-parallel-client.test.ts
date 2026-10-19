import { afterEach, describe, expect, it } from "vitest";
import { parallelExtract, parallelSearch, PARALLEL_BASE, setParallelForTests } from "@/lib/premium/parallel";

const V1_SEARCH_KEYS = new Set(["objective", "search_queries", "mode", "max_chars_total", "session_id", "client_model", "advanced_settings"]);
const V1_EXTRACT_KEYS = new Set(["urls", "objective", "search_queries", "max_chars_total", "session_id", "client_model", "advanced_settings"]);

describe("Parallel client pins (v1 API, docs.parallel.ai OpenAPI 0.1.2)", () => {
  const saved = process.env.PARALLEL_API_KEY;
  afterEach(() => {
    setParallelForTests(null);
    if (saved === undefined) delete process.env.PARALLEL_API_KEY;
    else process.env.PARALLEL_API_KEY = saved;
  });
  function capture(response: unknown) {
    const calls: { url: string; init: any }[] = [];
    setParallelForTests({ fetch: (async (url: string, init: any) => (calls.push({ url, init }), new Response(JSON.stringify(response)))) as never });
    return calls;
  }

  it("search: POST /v1/search, x-api-key header, only v1 top-level fields (max_results under advanced_settings), parses results", async () => {
    process.env.PARALLEL_API_KEY = "test-key-not-real";
    const calls = capture({ search_id: "s", session_id: "x", results: [{ url: "https://a.example/x", title: "T", publish_date: "2026-01-02", excerpts: ["e1", 3] }, { url: "ftp://bad" }] });
    const r = await parallelSearch("obj", ["q1", "q2"], 7, Date.now() + 5000);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PARALLEL_BASE}/v1/search`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["x-api-key"]).toBe("test-key-not-real");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init.body);
    for (const k of Object.keys(body)) expect(V1_SEARCH_KEYS.has(k), `unexpected top-level field ${k}`).toBe(true);
    expect(body).toEqual({ objective: "obj", search_queries: ["q1", "q2"], mode: "fast", advanced_settings: { max_results: 7 } });
    expect(r).toEqual([{ url: "https://a.example/x", title: "T", publish_date: "2026-01-02", excerpts: ["e1"] }]);
  });

  it("extract: POST /v1/extract, only v1 fields, parses results", async () => {
    process.env.PARALLEL_API_KEY = "test-key-not-real";
    const calls = capture({ extract_id: "e", results: [{ url: "https://b.example/", title: null, excerpts: ["x"] }] });
    const r = await parallelExtract("obj", ["https://b.example/"], Date.now() + 5000);
    expect(calls[0].url).toBe(`${PARALLEL_BASE}/v1/extract`);
    expect(calls[0].init.headers["x-api-key"]).toBe("test-key-not-real");
    const body = JSON.parse(calls[0].init.body);
    for (const k of Object.keys(body)) expect(V1_EXTRACT_KEYS.has(k)).toBe(true);
    expect(body).toEqual({ urls: ["https://b.example/"], objective: "obj" });
    expect(r).toEqual([{ url: "https://b.example/", title: null, publish_date: null, excerpts: ["x"] }]);
  });
});
