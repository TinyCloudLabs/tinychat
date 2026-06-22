/**
 * Shared model catalog: fetches RedPill's /models endpoint, parses pricing,
 * caches the result in-process for 5 minutes.
 *
 * Used by the chat router (/models annotation), the rates endpoint, and any
 * other surface that needs the upstream model list + per-model pricing.
 * Errors are surfaced as typed exceptions so route handlers can translate them
 * to the existing 500/502 contract.
 */

const REDPILL_BASE_URL = process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
// Hard ceiling on a single catalog fetch. RedPill's /models is "up" but its
// gateway has flaky TLS termination — ~30% of handshakes stall, and successful
// ones can take up to ~12s — while inference is fine. Measured 200s arrive in
// 1–12s, so 30s comfortably catches a slow-but-good response while still
// tripping the retry/serve-stale path on a true hang.
const CATALOG_FETCH_TIMEOUT_MS = 30_000;
// Total attempts per refresh (1 initial + retries). Per-attempt failure runs
// ~30% right now, so 3 attempts ≈ 97% success per refresh — enough to populate
// the cache, after which serve-stale shields callers for the rest of an outage.
const CATALOG_FETCH_ATTEMPTS = 3;
const CATALOG_RETRY_BACKOFF_MS = 300;

export interface CatalogModel {
  id: string;
  pricing: { prompt: number; completion: number } | null;
}

interface CacheEntry {
  models: CatalogModel[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

/**
 * Mislabeled models — dropped from the catalog entirely.
 *
 * Their `phala/` TEE alias serves a DIFFERENTLY-named model than the id claims
 * (confirmed 2026-06-09 via a served-model probe: each completion's attested
 * `model` name belongs to a different model family/size). We don't offer a model
 * whose label lies about what it is. The non-`phala/` versions (routed to the
 * real provider) are unaffected.
 */
const MISLABELED_BLOCKLIST: ReadonlySet<string> = new Set([
  "phala/deepseek-chat-v3.1", // serves Qwen/Qwen3.5-122B-A10B
  "phala/qwen3-30b-a3b-instruct-2507", // serves Qwen/Qwen3.6-35B-A3B
  "phala/qwen2.5-vl-72b-instruct", // serves Qwen3-VL-30B-A3B
  "phala/glm-4.7", // serves zai-org/GLM-5.1-FP8
]);

/**
 * True when the model id is on the mislabeled blocklist — a `phala/` alias that
 * serves a differently-named model than its id claims. Exported so the chat
 * gating path can refuse it directly (the `getCatalog()` prune only hides it
 * from the display catalog; a direct POST must still be rejected — see ST7).
 */
export function isBlocklistedModel(id: string): boolean {
  return MISLABELED_BLOCKLIST.has(id);
}

/**
 * Canonical picker allowlist — the ONLY models tinychat offers, in display
 * order (fast → smart, green tier then teal tier). This is the single source of
 * truth for both the picker contents (GET /api/chat/models) and the offered-
 * model gate on every relay/agent POST. A model NOT in this list is never
 * listed, never proxied, and never reachable by the agent tool path.
 *
 * Two badge tiers (see frontend completionStore.ts):
 *   GREEN ("Response verified"): a flat per-message signature path → tier 1.
 *   TEAL  ("Enclave attested"):  TEE-attestable but no flat signature → tier 2.
 *
 * Order matters: the picker preserves this order. Default = phala/qwen3.5-27b.
 */
export const PICKER_MODELS = [
  // GREEN tier (tier-1 "Response verified" / verifiable)
  "phala/qwen-2.5-7b-instruct", // fast
  "phala/qwen3.5-27b", // moderate ← DEFAULT
  "phala/glm-5.2", // smart
  // TEAL tier (tier-2 "Enclave attested" / TEE-capable, not flat-signed)
  "phala/qwen3-vl-30b-a3b-instruct", // fast
  "phala/gemma-3-27b-it", // moderate
  "phala/kimi-k2.6", // smart
] as const;

const PICKER_MODEL_SET: ReadonlySet<string> = new Set(PICKER_MODELS);

/**
 * True when the model id is an offered model — an exact member of the picker
 * allowlist. Used by the offered-model gate on every relay/agent POST and to
 * filter the display catalog (see chat.ts). Replaces the older
 * `startsWith("phala/") && !isBlocklistedModel()` heuristic so only the curated
 * six are reachable.
 */
export function isOfferedModel(id: string): boolean {
  return PICKER_MODEL_SET.has(id);
}

/** Clear the in-memory catalog cache. Exposed for tests. */
export function _resetCatalogCache(): void {
  cache = null;
}

export type CatalogErrorDetail =
  | { kind: "fetch_failed"; cause: unknown }
  | { kind: "upstream_not_ok"; statusCode: number; body: string }
  | { kind: "parse_failed"; cause: unknown };

export class CatalogFetchError extends Error {
  detail: CatalogErrorDetail;
  constructor(detail: CatalogErrorDetail) {
    super(`catalog_${detail.kind}`);
    this.name = "CatalogFetchError";
    this.detail = detail;
  }
}

/**
 * Parse a single side of RedPill's pricing payload. RedPill encodes USD per
 * token as a string (e.g. "0.0000025"); accept numbers too in case the API
 * shape ever changes. Returns null for missing/unparseable/negative values.
 */
function parsePrice(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function parsePricing(raw: unknown): CatalogModel["pricing"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { prompt?: unknown; completion?: unknown };
  const prompt = parsePrice(r.prompt);
  const completion = parsePrice(r.completion);
  if (prompt === null || completion === null) return null;
  return { prompt, completion };
}

/**
 * One upstream fetch + parse attempt. Throws a typed CatalogFetchError on any
 * failure (fetch_failed for network/timeout/missing-key, upstream_not_ok for a
 * definitive HTTP error, parse_failed for a malformed body). Does NOT touch the
 * cache — the caller decides whether to commit the result or serve stale.
 */
async function fetchCatalogOnce(apiKey: string): Promise<CatalogModel[]> {
  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(`${REDPILL_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
      // Reuse the connection across the 5-min polls so we don't pay (and gamble
      // on) a fresh TLS handshake every time — the gateway's flakiness is in the
      // handshake, so a warm connection sidesteps most of it.
      keepalive: true,
    });
  } catch (cause) {
    // Network error OR the AbortSignal.timeout firing both surface here.
    throw new CatalogFetchError({ kind: "fetch_failed", cause });
  }

  if (!upstreamRes.ok) {
    const body = await upstreamRes.text().catch(() => "");
    throw new CatalogFetchError({
      kind: "upstream_not_ok",
      statusCode: upstreamRes.status,
      body: body || upstreamRes.statusText,
    });
  }

  let data: unknown;
  try {
    data = await upstreamRes.json();
  } catch (cause) {
    throw new CatalogFetchError({ kind: "parse_failed", cause });
  }

  const raw = (data as { data?: Array<{ id?: unknown; pricing?: unknown }> }).data ?? [];
  return raw
    .filter((m) => typeof m.id === "string" && m.id)
    .filter((m) => !MISLABELED_BLOCKLIST.has(m.id as string))
    .map((m) => ({ id: m.id as string, pricing: parsePricing(m.pricing) }));
}

/**
 * Return the cached catalog, refreshing from RedPill when the cache is empty or
 * expired.
 *
 * Resilience contract (RedPill /models gateway has flaky TLS while inference is fine):
 *   - Each attempt is bounded by CATALOG_FETCH_TIMEOUT_MS.
 *   - A transient failure (fetch_failed network/timeout, or parse_failed from a
 *     body truncated by the timeout) is retried up to CATALOG_FETCH_ATTEMPTS
 *     total with a short backoff. A definitive HTTP error (upstream_not_ok) is
 *     NOT retried — retrying a real 4xx/5xx would only stall callers.
 *   - SERVE-STALE: if a refresh fails for ANY reason and a previous cache exists,
 *     the last-good list is returned silently instead of throwing. Once the
 *     catalog has ever loaded, later flakiness can never strand the picker.
 *   - CatalogFetchError is thrown ONLY when there is no cache at all (cold start
 *     with a broken upstream) so callers can degrade to PICKER_MODELS.
 */
export async function getCatalog(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const apiKey = process.env.REDPILL_API_KEY;
  if (!apiKey) {
    // Missing key is a hard misconfiguration; preserve the fetch_failed throw.
    // A pre-existing cache shouldn't paper over a key that has gone away.
    throw new CatalogFetchError({
      kind: "fetch_failed",
      cause: new Error("REDPILL_API_KEY is not configured"),
    });
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= CATALOG_FETCH_ATTEMPTS; attempt++) {
    try {
      const models = await fetchCatalogOnce(apiKey);
      cache = { models, fetchedAt: Date.now() };
      return models;
    } catch (error) {
      lastError = error;
      // Only transient failures are worth retrying; a definitive HTTP error is not.
      const retryable =
        error instanceof CatalogFetchError &&
        (error.detail.kind === "fetch_failed" || error.detail.kind === "parse_failed");
      if (!retryable || attempt === CATALOG_FETCH_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, CATALOG_RETRY_BACKOFF_MS));
    }
  }
  // Exhausted attempts (or hit a non-retryable error): serve stale or throw.
  return serveStaleOrThrow(lastError);
}

/**
 * On a failed refresh, return the last-good cache if one exists; otherwise
 * rethrow so cold-start callers can degrade. The cache age is left untouched so
 * a later successful refresh still happens once TTL has elapsed.
 */
function serveStaleOrThrow(error: unknown): CatalogModel[] {
  if (cache) {
    return cache.models;
  }
  throw error;
}
