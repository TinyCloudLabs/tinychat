// Health spike (TC-525) storage. Rules:
//   1. one KV record per day under the granted connectors/ prefix, keyed by source so an iPhone and an
//      Android phone never overwrite each other;
//   2. days with no value at all are not written;
//   3. writes are sequential and stop at the first failure, saying how many were saved;
//   4. a stored record round-trips; a missing one is null; a malformed one fails closed.

import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { APP_ID } from "../threadStore";
import {
  HEALTH_RECORD_SCHEMA,
  healthDailyKvKey,
  loadHealthDailyRecord,
  saveHealthDailySummaries,
  toHealthDailyRecords,
} from "./healthStore";
import type { HealthDailySummaries } from "./nativeHealth";

function fakeTcw(opts: { failOnPut?: number; get?: { ok: boolean; data?: unknown; code?: string } } = {}) {
  const puts: { key: string; value: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const tcw = {
    kv: {
      async put(key: string, value: string) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (opts.failOnPut === puts.length) return { ok: false, error: { code: "KV_ERROR", message: "boom" } };
        puts.push({ key, value });
        return { ok: true, data: {} };
      },
      async get(_key: string) {
        const get = opts.get ?? { ok: true, data: null };
        return get.ok ? { ok: true, data: { data: get.data } } : { ok: false, error: { code: get.code ?? "KV_ERROR", message: "nope" } };
      },
    },
  };
  return { tcw: tcw as unknown as TinyCloudWeb, puts, maxInFlight: () => maxInFlight };
}

const summaries: HealthDailySummaries = {
  platform: "android",
  source: "health_connect",
  timeZone: "Europe/London",
  readAt: Date.parse("2026-10-04T09:00:00.000Z"),
  readStateKnowable: true,
  notGranted: [],
  days: [
    { date: "2026-10-02", steps: null, sleepMinutes: null, sleepBlocks: 0, heartRate: null, sources: [] },
    { date: "2026-10-03", steps: 6123, sleepMinutes: 431, sleepBlocks: 1, heartRate: { min: 52, avg: 71, max: 140 }, sources: ["b.app", "a.app"] },
    { date: "2026-10-04", steps: 812, sleepMinutes: null, sleepBlocks: 0, heartRate: null, sources: ["a.app"] },
  ],
};

describe("health daily records", () => {
  test("keys live under the connectors/ grant, per source and day", () => {
    expect(healthDailyKvKey("health_connect", "2026-10-03")).toBe(`${APP_ID}/connectors/exo-health/health_connect/daily/2026-10-03`);
    expect(healthDailyKvKey("healthkit", "2026-10-03")).toBe(`${APP_ID}/connectors/exo-health/healthkit/daily/2026-10-03`);
  });

  test("days with no value are not records; sources are sorted; readAt is ISO", () => {
    const records = toHealthDailyRecords(summaries);
    expect(records.map((r) => r.date)).toEqual(["2026-10-03", "2026-10-04"]);
    expect(records[0]).toEqual({
      schema: HEALTH_RECORD_SCHEMA,
      date: "2026-10-03",
      timeZone: "Europe/London",
      platform: "android",
      source: "health_connect",
      steps: 6123,
      sleepMinutes: 431,
      sleepBlocks: 1,
      heartRate: { min: 52, avg: 71, max: 140 },
      dataSources: ["a.app", "b.app"],
      readStateKnowable: true,
      readAt: "2026-10-04T09:00:00.000Z",
    });
  });

  test("saves sequentially and reports skipped days", async () => {
    const { tcw, puts, maxInFlight } = fakeTcw();
    const result = await saveHealthDailySummaries(tcw, summaries);
    expect(result).toEqual({ ok: true, data: { saved: ["2026-10-03", "2026-10-04"], skipped: 1 } });
    expect(puts.map((p) => p.key)).toEqual([
      healthDailyKvKey("health_connect", "2026-10-03"),
      healthDailyKvKey("health_connect", "2026-10-04"),
    ]);
    expect(JSON.parse(puts[1]!.value)).toMatchObject({ date: "2026-10-04", steps: 812 });
    expect(maxInFlight()).toBe(1);
  });

  test("stops at the first failed write and says how far it got", async () => {
    const { tcw, puts } = fakeTcw({ failOnPut: 1 });
    const result = await saveHealthDailySummaries(tcw, summaries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("1 saved before");
    expect(puts).toHaveLength(1);
  });

  test("a stored record round-trips; missing is null; malformed fails closed", async () => {
    const record = toHealthDailyRecords(summaries)[0];
    const stored = await loadHealthDailyRecord(fakeTcw({ get: { ok: true, data: JSON.stringify(record) } }).tcw, "health_connect", "2026-10-03");
    expect(stored).toEqual({ ok: true, data: record! });

    const missing = await loadHealthDailyRecord(fakeTcw({ get: { ok: false, code: "KV_NOT_FOUND" } }).tcw, "health_connect", "2026-10-01");
    expect(missing).toEqual({ ok: true, data: null });

    const corrupt = await loadHealthDailyRecord(fakeTcw({ get: { ok: true, data: "{not json" } }).tcw, "health_connect", "2026-10-03");
    expect(corrupt.ok).toBe(false);

    const failed = await loadHealthDailyRecord(fakeTcw({ get: { ok: false, code: "AUTH_UNAUTHORIZED" } }).tcw, "health_connect", "2026-10-03");
    expect(failed.ok).toBe(false);
  });
});
