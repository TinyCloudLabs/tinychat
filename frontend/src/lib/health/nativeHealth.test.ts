// Health spike (TC-525) JS contract. Rules:
//   1. the spike is off unless the build sets VITE_EXO_HEALTH_SPIKE=true exactly;
//   2. summaries from either platform parse to one shape; requested fields are present (null when the
//      platform had nothing, including an Android shell that dropped JSON nulls), unrequested ones absent;
//   3. malformed plugin output fails closed;
//   4. iOS never claims to know a read decision: readStateKnowable is false and a null reads "or not allowed";
//   5. read states are described truthfully per platform.

import { describe, expect, test } from "bun:test";

import {
  describeMissing,
  describeReadAuthorization,
  healthSpikeEnabled,
  parseDailySummaries,
  readHealthDailySummaries,
} from "./nativeHealth";

const android = {
  platform: "android",
  source: "health_connect",
  timeZone: "Europe/London",
  readAt: 1_791_000_000_000,
  notGranted: ["sleep"],
  days: [
    { date: "2026-10-03", steps: 6123, heartRate: { min: 52, avg: 71, max: 140 }, sleepBlocks: 0, sources: ["com.google.android.apps.fitness"] },
    // An older shell omitted nulls instead of sending JSON null.
    { date: "2026-10-04", sleepBlocks: 0, sources: [] },
  ],
};

const ios = {
  platform: "ios",
  source: "healthkit",
  timeZone: "America/New_York",
  readAt: 1_791_000_000_000,
  readStateKnowable: false,
  notGranted: [],
  days: [
    { date: "2026-10-04", steps: null, sleepMinutes: 412, sleepBlocks: 2, heartRate: null, sources: ["com.apple.health.81D1"] },
  ],
};

describe("healthSpikeEnabled", () => {
  test("only the exact string true turns the spike on", () => {
    expect(healthSpikeEnabled({})).toBe(false);
    expect(healthSpikeEnabled({ VITE_EXO_HEALTH_SPIKE: "" })).toBe(false);
    expect(healthSpikeEnabled({ VITE_EXO_HEALTH_SPIKE: "1" })).toBe(false);
    expect(healthSpikeEnabled({ VITE_EXO_HEALTH_SPIKE: "TRUE" })).toBe(false);
    expect(healthSpikeEnabled({ VITE_EXO_HEALTH_SPIKE: "true" })).toBe(true);
  });

  test("is off in this (test) build", () => {
    expect(healthSpikeEnabled()).toBe(false);
  });
});

describe("parseDailySummaries", () => {
  test("Android: requested fields are present, missing values are null, read state is knowable", () => {
    const parsed = parseDailySummaries(android);
    expect(parsed.readStateKnowable).toBe(true);
    expect(parsed.notGranted).toEqual(["sleep"]);
    expect(parsed.days[0]).toEqual({
      date: "2026-10-03",
      steps: 6123,
      sleepMinutes: null,
      sleepBlocks: 0,
      heartRate: { min: 52, avg: 71, max: 140 },
      sources: ["com.google.android.apps.fitness"],
    });
    expect(parsed.days[1]).toEqual({ date: "2026-10-04", steps: null, sleepMinutes: null, sleepBlocks: 0, heartRate: null, sources: [] });
  });

  test("iOS: read state is not knowable", () => {
    const parsed = parseDailySummaries(ios);
    expect(parsed.readStateKnowable).toBe(false);
    expect(parsed.days[0]?.steps).toBeNull();
    expect(parsed.days[0]?.sleepMinutes).toBe(412);
  });

  test("an iOS shell that does not say is still not knowable; Android defaults to knowable", () => {
    const { readStateKnowable: _ignored, ...withoutFlag } = ios;
    expect(parseDailySummaries(withoutFlag).readStateKnowable).toBe(false);
  });

  test("unrequested types stay absent", () => {
    const parsed = parseDailySummaries(android, ["steps"]);
    expect(parsed.days[0]).toEqual({ date: "2026-10-03", steps: 6123, sources: ["com.google.android.apps.fitness"] });
  });

  test("unknown notGranted entries are dropped", () => {
    expect(parseDailySummaries({ ...android, notGranted: ["sleep", "blood", 3] }).notGranted).toEqual(["sleep"]);
  });

  test("malformed output fails closed", () => {
    expect(() => parseDailySummaries(null)).toThrow();
    expect(() => parseDailySummaries({ ...android, platform: "web" })).toThrow();
    expect(() => parseDailySummaries({ ...android, source: "fitbit" })).toThrow();
    expect(() => parseDailySummaries({ ...android, days: "x" })).toThrow();
    expect(() => parseDailySummaries({ ...android, days: [{ date: "4 Oct", sources: [] }] })).toThrow();
    expect(() => parseDailySummaries({ ...android, days: [{ date: "2026-10-04", steps: -1, sources: [] }] })).toThrow();
    expect(() => parseDailySummaries({ ...android, days: [{ date: "2026-10-04", steps: "12", sources: [] }] })).toThrow();
  });
});

describe("readHealthDailySummaries", () => {
  test("asks for 7 days of every type by default and validates the answer", async () => {
    const calls: unknown[] = [];
    const parsed = await readHealthDailySummaries({}, {
      readDailySummaries: async (options) => {
        calls.push(options);
        return android;
      },
    });
    expect(calls).toEqual([{ days: 7, types: ["steps", "sleep", "heartRate"] }]);
    expect(parsed.days).toHaveLength(2);
  });
});

describe("describing read state", () => {
  test("iOS 'unknown' says the answer is hidden, not granted", () => {
    expect(describeReadAuthorization("unknown")).toContain("does not tell");
    expect(describeReadAuthorization("unknown")).not.toContain("Allowed");
    expect(describeReadAuthorization("granted")).toBe("Allowed");
    expect(describeReadAuthorization("not_determined")).toBe("Not asked yet");
  });

  test("a null means no data on Android, no data or not allowed on iOS", () => {
    expect(describeMissing(true)).toBe("no data");
    expect(describeMissing(false)).toBe("no data, or not allowed");
  });
});
