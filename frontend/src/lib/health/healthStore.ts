// Health spike (TC-525): daily health summaries in the user's own TinyCloud space.
//
//   KV  {APP_ID}/connectors/exo-health/{source}/daily/{YYYY-MM-DD}  → HealthDailyRecord (JSON)
//        source = "healthkit" | "health_connect", so an iPhone and an Android phone never overwrite each other.
//
// PROTOTYPE STORAGE. It sits under the `connectors/` KV grant the manifest already has, so the spike needs no
// manifest change, the same way voice notes do. That grant is wider than health data should be: the private
// agent's transcript delegation (lib/agentDelegation.ts, TRANSCRIPT_PERMISSIONS) may get and list everything
// under `connectors/`, so a user who lets the agent read meeting transcripts would also be letting it read these
// summaries. Shipping needs its own `health/` permission with its own consent line (mobile/docs/health-spike.md,
// "Storage and permissions").
//
// One record per day, overwritten on every save: today's grows during the day, and a late sync from a watch
// changes earlier days. Only days with at least one value are written. Writes are sequential (TinyCloud drops
// concurrent responses on one space).

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_KV_PREFIX, type StoreResult } from "../connectors/connectorStore";
import type { HealthDailySummaries, HealthHeartRate, HealthPlatform, HealthSource } from "./nativeHealth";

/** The KV "source" segment under connectors/. */
export const HEALTH_KV_SOURCE = "exo-health";

/** Bump when the record's shape changes. */
export const HEALTH_RECORD_SCHEMA = "xyz.tinycloud.exo.health.daily/v0";

export function healthDailyKvPrefix(source: HealthSource): string {
  return `${CONNECTORS_KV_PREFIX}/${HEALTH_KV_SOURCE}/${source}/daily/`;
}

export function healthDailyKvKey(source: HealthSource, date: string): string {
  return `${healthDailyKvPrefix(source)}${date}`;
}

export interface HealthDailyRecord {
  schema: typeof HEALTH_RECORD_SCHEMA;
  /** YYYY-MM-DD in `timeZone`. */
  date: string;
  timeZone: string;
  platform: HealthPlatform;
  source: HealthSource;
  /** null = no data (Android), or no data or not allowed (iOS: see `readStateKnowable`). Absent = not read. */
  steps?: number | null;
  sleepMinutes?: number | null;
  sleepBlocks?: number;
  heartRate?: HealthHeartRate | null;
  /** Apps or devices that recorded the values. */
  dataSources: string[];
  /** false on iOS, where HealthKit hides whether a read was allowed. */
  readStateKnowable: boolean;
  /** When the phone read the values (ISO 8601). */
  readAt: string;
}

function hasValue(record: HealthDailyRecord): boolean {
  return (
    (record.steps !== undefined && record.steps !== null)
    || (record.sleepMinutes !== undefined && record.sleepMinutes !== null)
    || (record.heartRate !== undefined && record.heartRate !== null)
  );
}

/** One record per day that has at least one value. */
export function toHealthDailyRecords(summaries: HealthDailySummaries): HealthDailyRecord[] {
  const readAt = new Date(summaries.readAt).toISOString();
  const records: HealthDailyRecord[] = [];
  for (const day of summaries.days) {
    const record: HealthDailyRecord = {
      schema: HEALTH_RECORD_SCHEMA,
      date: day.date,
      timeZone: summaries.timeZone,
      platform: summaries.platform,
      source: summaries.source,
      dataSources: [...day.sources].sort(),
      readStateKnowable: summaries.readStateKnowable,
      readAt,
    };
    if (day.steps !== undefined) record.steps = day.steps;
    if (day.sleepMinutes !== undefined) {
      record.sleepMinutes = day.sleepMinutes;
      record.sleepBlocks = day.sleepBlocks ?? 0;
    }
    if (day.heartRate !== undefined) record.heartRate = day.heartRate;
    if (hasValue(record)) records.push(record);
  }
  return records;
}

export interface HealthSaveOutcome {
  saved: string[];
  /** Days read with no value at all (not written). */
  skipped: number;
}

/** Writes each day with a value, in order; stops at the first failed write. */
export async function saveHealthDailySummaries(
  tcw: TinyCloudWeb,
  summaries: HealthDailySummaries,
): Promise<StoreResult<HealthSaveOutcome>> {
  const records = toHealthDailyRecords(summaries);
  const saved: string[] = [];
  for (const record of records) {
    const key = healthDailyKvKey(record.source, record.date);
    const put = await tcw.kv.put(key, JSON.stringify(record));
    if (!put.ok) {
      return {
        ok: false,
        error: {
          code: put.error.code ?? "STORE_ERROR",
          message: `saveHealthDailySummaries(${record.date}): ${put.error.message} (${saved.length} saved before)`,
        },
      };
    }
    saved.push(record.date);
  }
  return { ok: true, data: { saved, skipped: summaries.days.length - records.length } };
}

/** The stored record for one day, or null when there is none. */
export async function loadHealthDailyRecord(
  tcw: TinyCloudWeb,
  source: HealthSource,
  date: string,
): Promise<StoreResult<HealthDailyRecord | null>> {
  const res = await tcw.kv.get(healthDailyKvKey(source, date));
  if (!res.ok) {
    if (res.error.code === "KV_NOT_FOUND") return { ok: true, data: null };
    return { ok: false, error: { code: res.error.code ?? "STORE_ERROR", message: `loadHealthDailyRecord: ${res.error.message}` } };
  }
  const raw = res.data.data;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || (parsed as HealthDailyRecord).schema !== HEALTH_RECORD_SCHEMA) {
    return { ok: false, error: { code: "STORE_CORRUPT_HEALTH", message: "loadHealthDailyRecord: stored record is malformed" } };
  }
  return { ok: true, data: parsed as HealthDailyRecord };
}
