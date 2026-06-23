import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CatalogFetchError,
  PICKER_MODELS,
  _resetCatalogCache,
  getCatalog,
  isBlocklistedModel,
  isOfferedModel,
} from "../billing/catalog.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

interface StubModel {
  id: string;
  pricing?: unknown;
}

function stubModelsFetch(models: StubModel[]): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/models")) {
      state.calls += 1;
      return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return state;
}

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  _resetCatalogCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  _resetCatalogCache();
});

describe("getCatalog pricing parsing", () => {
  test("parses string-encoded USD per token to numbers", async () => {
    stubModelsFetch([
      { id: "openai/gpt-5-mini", pricing: { prompt: "0.00000025", completion: "0.000002" } },
      { id: "anthropic/claude-opus-4.1", pricing: { prompt: "0.000015", completion: "0.000075" } },
    ]);
    const catalog = await getCatalog();
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    expect(byId["openai/gpt-5-mini"].pricing).toEqual({
      prompt: 0.00000025,
      completion: 0.000002,
    });
    expect(byId["anthropic/claude-opus-4.1"].pricing).toEqual({
      prompt: 0.000015,
      completion: 0.000075,
    });
  });

  test("accepts numeric pricing too", async () => {
    stubModelsFetch([{ id: "x/y", pricing: { prompt: 0.0001, completion: 0.0002 } }]);
    const catalog = await getCatalog();
    expect(catalog[0].pricing).toEqual({ prompt: 0.0001, completion: 0.0002 });
  });

  test("missing pricing → null", async () => {
    stubModelsFetch([{ id: "no-pricing/model" }]);
    const catalog = await getCatalog();
    expect(catalog[0]).toEqual({ id: "no-pricing/model", pricing: null });
  });

  test("partial pricing (one side missing) → null", async () => {
    stubModelsFetch([{ id: "partial/model", pricing: { prompt: "0.0001" } }]);
    const catalog = await getCatalog();
    expect(catalog[0].pricing).toBeNull();
  });

  test("unparseable pricing strings → null", async () => {
    stubModelsFetch([
      { id: "bad/string", pricing: { prompt: "not-a-number", completion: "0.0001" } },
      { id: "negative/value", pricing: { prompt: "-0.0001", completion: "0.0001" } },
      { id: "empty/string", pricing: { prompt: "", completion: "0.0001" } },
    ]);
    const catalog = await getCatalog();
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    expect(byId["bad/string"].pricing).toBeNull();
    expect(byId["negative/value"].pricing).toBeNull();
    expect(byId["empty/string"].pricing).toBeNull();
  });

  test("non-object pricing field → null", async () => {
    stubModelsFetch([{ id: "weird/model", pricing: "free" }]);
    const catalog = await getCatalog();
    expect(catalog[0].pricing).toBeNull();
  });
});

describe("getCatalog cache TTL behavior", () => {
  test("repeated calls within TTL hit the cache (single upstream fetch)", async () => {
    const state = stubModelsFetch([{ id: "openai/gpt-5-mini" }]);
    const a = await getCatalog();
    const b = await getCatalog();
    const c = await getCatalog();
    expect(state.calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("_resetCatalogCache forces a re-fetch on next call", async () => {
    const state = stubModelsFetch([{ id: "openai/gpt-5-mini" }]);
    await getCatalog();
    expect(state.calls).toBe(1);
    _resetCatalogCache();
    await getCatalog();
    expect(state.calls).toBe(2);
  });
});

describe("getCatalog error handling", () => {
  test("missing REDPILL_API_KEY → CatalogFetchError(fetch_failed)", async () => {
    delete process.env.REDPILL_API_KEY;
    let thrown: unknown;
    try {
      await getCatalog();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CatalogFetchError);
    expect((thrown as CatalogFetchError).detail.kind).toBe("fetch_failed");
  });

  test("upstream non-ok → CatalogFetchError(upstream_not_ok) with status + body", async () => {
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" })) as typeof fetch;
    let thrown: unknown;
    try {
      await getCatalog();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CatalogFetchError);
    const detail = (thrown as CatalogFetchError).detail;
    expect(detail.kind).toBe("upstream_not_ok");
    if (detail.kind === "upstream_not_ok") {
      expect(detail.statusCode).toBe(429);
      expect(detail.body).toBe("rate limited");
    }
  });

  test("network failure → CatalogFetchError(fetch_failed)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    let thrown: unknown;
    try {
      await getCatalog();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CatalogFetchError);
    expect((thrown as CatalogFetchError).detail.kind).toBe("fetch_failed");
  });

  test("invalid JSON body → CatalogFetchError(parse_failed)", async () => {
    globalThis.fetch = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    let thrown: unknown;
    try {
      await getCatalog();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CatalogFetchError);
    expect((thrown as CatalogFetchError).detail.kind).toBe("parse_failed");
  });
});

describe("getCatalog resilience (timeout / retry / serve-stale)", () => {
  test("retries ONCE on a transient fetch failure, then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("network blip");
      return new Response(JSON.stringify({ data: [{ id: "phala/qwen3.5-27b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const catalog = await getCatalog();
    expect(calls).toBe(2);
    expect(catalog.map((m) => m.id)).toEqual(["phala/qwen3.5-27b"]);
  });

  test("does NOT retry an upstream_not_ok response (single fetch, throws cold)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    }) as typeof fetch;
    let thrown: unknown;
    try {
      await getCatalog();
    } catch (e) {
      thrown = e;
    }
    // No prior cache → still throws; upstream_not_ok is definitive, not retried.
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(CatalogFetchError);
    expect((thrown as CatalogFetchError).detail.kind).toBe("upstream_not_ok");
  });

  test("serves the stale cache when a post-cache refresh fetch fails", async () => {
    // First fetch succeeds and populates the cache.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "phala/qwen3.5-27b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const first = await getCatalog();
    expect(first.map((m) => m.id)).toEqual(["phala/qwen3.5-27b"]);

    // Force the cache to be considered expired so the next call refetches.
    // (CACHE_TTL_MS is 5min; fast-forward Date.now past it.)
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;

    // Now make every subsequent fetch fail (network down — also exhausts the retry).
    let refreshCalls = 0;
    globalThis.fetch = (async () => {
      refreshCalls += 1;
      throw new Error("network down");
    }) as typeof fetch;

    try {
      const stale = await getCatalog();
      // The last-good list is returned silently instead of throwing.
      expect(stale.map((m) => m.id)).toEqual(["phala/qwen3.5-27b"]);
      // fetch_failed is retried up to CATALOG_FETCH_ATTEMPTS (3) before serving stale.
      expect(refreshCalls).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  test("throws CatalogFetchError when there is NO cache at all (cold start)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    let thrown: unknown;
    try {
      await getCatalog();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CatalogFetchError);
    expect((thrown as CatalogFetchError).detail.kind).toBe("fetch_failed");
  });
});

describe("PICKER_MODELS allowlist + isOfferedModel", () => {
  test("the allowlist is exactly the curated six, in canonical fast→smart green-then-teal order", () => {
    expect([...PICKER_MODELS]).toEqual([
      "qwen/qwen-2.5-7b-instruct",
      "z-ai/glm-5.2",
      "qwen/qwen3.5-27b",
      "qwen/qwen3-vl-30b-a3b-instruct",
      "google/gemma-3-27b-it",
      "moonshotai/kimi-k2.6",
    ]);
  });

  test("isOfferedModel accepts each of the six and nothing else", () => {
    for (const id of PICKER_MODELS) {
      expect(isOfferedModel(id)).toBe(true);
    }
    // A valid TEE model that is NOT on the allowlist must be rejected (closes the
    // non-verifiable-model-reaching-agent-path gap).
    expect(isOfferedModel("phala/gpt-oss-120b")).toBe(false);
    // A blocklisted phala/* alias is also not offered.
    expect(isOfferedModel("phala/glm-4.7")).toBe(false);
    // An unoffered id (not in the curated lineup) is never offered.
    expect(isOfferedModel("openai/gpt-5-mini")).toBe(false);
  });

  test("no allowlisted model is on the mislabeled blocklist", () => {
    for (const id of PICKER_MODELS) {
      expect(isBlocklistedModel(id)).toBe(false);
    }
  });
});
