import {
  OFFERED_CHAT_MODELS,
  type OfferedModelId,
} from "@tinyboilerplate/core";

export type ProviderHealth = "healthy" | "unhealthy" | "unknown";
export type ModelSelectionResult =
  | { model: OfferedModelId; reason: "healthy" | "health-unverified" }
  | { model: null; reason: "all-unhealthy" };

export const MODEL_HEALTH_TIMEOUT_MS = 2_000;
const PERIOD_FRESHNESS_MS = 20 * 60 * 1_000;
const HEALTHY_UPTIME = 0.99;

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExactUtcHour(value: string, parsed: number): boolean {
  return parsed % 3_600_000 === 0 && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(value);
}

/** Classify one uptime response without consulting catalog or pricing data. */
export function classifyModelHealth(
  expectedModel: OfferedModelId,
  raw: unknown,
  nowMs: number = Date.now(),
): ProviderHealth {
  if (!raw || typeof raw !== "object") return "unknown";
  const body = raw as Record<string, unknown>;
  if (body.model !== expectedModel) return "unknown";

  const periodStart = timestamp(body.period_start);
  const periodEnd = timestamp(body.period_end);
  if (
    periodStart === null ||
    periodEnd === null ||
    periodStart > periodEnd ||
    periodEnd > nowMs ||
    nowMs - periodEnd > PERIOD_FRESHNESS_MS
  ) {
    return "unknown";
  }

  if (!Array.isArray(body.providers) || body.providers.length === 0) return "unknown";
  const currentHour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const previousHour = currentHour - 3_600_000;
  const states: ProviderHealth[] = [];

  for (const provider of body.providers) {
    if (!provider || typeof provider !== "object") {
      states.push("unknown");
      continue;
    }
    const buckets = (provider as Record<string, unknown>).buckets;
    if (!Array.isArray(buckets) || buckets.length === 0) {
      states.push("unknown");
      continue;
    }

    const parsedBuckets: Array<{ at: number; uptime: unknown }> = [];
    let malformedTimestamp = false;
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") {
        malformedTimestamp = true;
        break;
      }
      const hour = (bucket as Record<string, unknown>).hour;
      const at = timestamp(hour);
      if (at === null || typeof hour !== "string" || !isExactUtcHour(hour, at)) {
        malformedTimestamp = true;
        break;
      }
      parsedBuckets.push({ at, uptime: (bucket as Record<string, unknown>).uptime });
    }
    if (malformedTimestamp) {
      states.push("unknown");
      continue;
    }

    const newestAt = Math.max(...parsedBuckets.map(({ at }) => at));
    const newest = parsedBuckets.filter(({ at }) => at === newestAt);
    const values = newest.map(({ uptime }) => uptime);
    if (
      newestAt !== currentHour &&
      newestAt !== previousHour
    ) {
      states.push("unknown");
      continue;
    }
    if (
      values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    ) {
      states.push("unknown");
      continue;
    }
    const distinct = new Set(values as number[]);
    if (distinct.size !== 1) {
      states.push("unknown");
      continue;
    }
    states.push((values[0] as number) >= HEALTHY_UPTIME ? "healthy" : "unhealthy");
  }

  if (states.includes("healthy")) return "healthy";
  if (states.every((state) => state === "unhealthy")) return "unhealthy";
  return "unknown";
}

async function fetchCandidateHealth(
  model: OfferedModelId,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ProviderHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_HEALTH_TIMEOUT_MS);
  try {
    const body = await Promise.race([
      (async () => {
        const response = await fetchImpl(
          `https://redpill.ai/api/models/${model}/uptime`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Health unavailable");
        return response.json();
      })(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Health deadline")), { once: true });
      }),
    ]);
    return classifyModelHealth(model, body, now());
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch every candidate once in parallel and choose by the static ladder. */
export async function selectChatModel(
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<ModelSelectionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const candidates = OFFERED_CHAT_MODELS.map(({ id }) => id);
  const states = await Promise.all(
    candidates.map((model) => fetchCandidateHealth(model, fetchImpl, now)),
  );
  const healthyIndex = states.indexOf("healthy");
  if (healthyIndex >= 0) return { model: candidates[healthyIndex], reason: "healthy" };
  const unknownIndex = states.indexOf("unknown");
  if (unknownIndex >= 0) {
    return { model: candidates[unknownIndex], reason: "health-unverified" };
  }
  return { model: null, reason: "all-unhealthy" };
}
