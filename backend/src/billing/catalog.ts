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
 * Return the cached catalog, fetching from RedPill if the cache is empty or
 * expired. Throws CatalogFetchError on any failure so callers can map to the
 * appropriate 500/502 response.
 */
export async function getCatalog(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const apiKey = process.env.REDPILL_API_KEY;
  if (!apiKey) {
    throw new CatalogFetchError({
      kind: "fetch_failed",
      cause: new Error("REDPILL_API_KEY is not configured"),
    });
  }

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(`${REDPILL_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (cause) {
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
  const models: CatalogModel[] = raw
    .filter((m) => typeof m.id === "string" && m.id)
    .filter((m) => !MISLABELED_BLOCKLIST.has(m.id as string))
    .map((m) => ({ id: m.id as string, pricing: parsePricing(m.pricing) }));

  cache = { models, fetchedAt: Date.now() };
  return models;
}
