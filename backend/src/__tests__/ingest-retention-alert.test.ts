import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  CONTENT_MASTER_ENV,
  ContentStore,
  InMemoryContentBlobStore,
  _resetContentMasterCache,
} from "../services/content-store.js";
import {
  IngestRetentionSweeper,
  RETENTION_RECOVERED_EVENT,
  RETENTION_STALLED_EVENT,
  type RetentionSweepTarget,
} from "../services/ingest-retention.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";

// TC-2778: "deleted within 14 days" needs a floor. A sweep that cannot read or write must raise ONE
// counts-only alert, throttled, and say so once when it recovers.

const ORIGINAL_ENV = { ...process.env };
const CONTENT_MASTER = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";
const INTERVAL = 5 * 60_000;
// Sentinels that must appear in no alert line.
const SOURCE = "fireflies";
const ADDRESS = "0xa1a1a10000000000000000000000000000000fed";
const MEETING_ID = "mtg-SENTINEL-ID-7781";

let errors: string[];
let logs: string[];
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  errors = [];
  logs = [];
  _resetWebhookTokenState();
  _resetContentMasterCache();
  process.env.LOG_HASH_SALT = LOG_SALT;
  process.env[CONTENT_MASTER_ENV] = CONTENT_MASTER;
  spies.push(spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); }));
  spies.push(spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); }));
  spies.push(spyOn(console, "warn").mockImplementation(() => {}));
});
afterEach(() => {
  while (spies.length > 0) spies.pop()!.mockRestore();
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
  _resetContentMasterCache();
});

type SweepResult = Awaited<ReturnType<RetentionSweepTarget["sweepRetention"]>>;
const clean: SweepResult = { swept: 0, bytesFreed: 0, tombstones: 0, overdue: 0, oldestOverdueAgeMs: 0 };

function sweeper(
  next: () => SweepResult | "throw",
  clock: { now: number },
  indexes: () => Promise<Array<{ source: string; address: string }>> = async () => [{ source: SOURCE, address: ADDRESS }],
) {
  const content: RetentionSweepTarget = {
    async sweepRetention() {
      const r = next();
      if (r === "throw") throw new Error(`blob store down for ${MEETING_ID} at ${ADDRESS}`);
      return r;
    },
    async sweepExpiredReplayTombstones() { return 0; },
  };
  return new IngestRetentionSweeper({ content, indexes, intervalMs: INTERVAL, now: () => clock.now });
}

const alerts = () => errors.filter((l) => l.includes(RETENTION_STALLED_EVENT));
const parsed = () => alerts().map((l) => JSON.parse(l) as Record<string, unknown>);

describe("retention sweep stall alert", () => {
  test("failing reads and writes for the whole window raise exactly one alert, with counts and nothing else", async () => {
    const clock = { now: Date.parse("2026-08-10T12:00:00.000Z") };
    const s = sweeper(() => "throw", clock);
    for (let i = 0; i < 5; i++) { await s.sweepOnce(); clock.now += INTERVAL; }
    expect(alerts()).toHaveLength(0); // 5 passes = 25 min: inside the window
    await s.sweepOnce();
    expect(alerts()).toHaveLength(1);
    const alert = parsed()[0]!;
    expect(Object.keys(alert).sort()).toEqual(
      ["alert", "consecutive_passes", "errors", "event", "indexes_unreadable", "overdue_rows", "ts"],
    );
    expect(alert).toMatchObject({ event: "retention_sweep_stalled", alert: true, errors: 1, indexes_unreadable: 0, overdue_rows: 0, consecutive_passes: 6 });
    const everything = [...errors, ...logs].join("\n");
    for (const secret of [MEETING_ID, ADDRESS, ADDRESS.slice(2, 12)]) expect(alerts().join("\n")).not.toContain(secret);
    expect(everything).not.toContain(MEETING_ID);
  });

  test("unreadable indexes and overdue rows are counted, and the alert is not repeated inside the throttle window", async () => {
    const clock = { now: Date.parse("2026-08-10T12:00:00.000Z") };
    const s = sweeper(() => ({ ...clean, unreadableIndex: true, overdue: 3, oldestOverdueAgeMs: 1000 }), clock);
    for (let i = 0; i < 6; i++) { await s.sweepOnce(); clock.now += INTERVAL; }
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({ indexes_unreadable: 1, overdue_rows: 3, errors: 0, consecutive_passes: 6 });
    for (let i = 0; i < 5; i++) { await s.sweepOnce(); clock.now += INTERVAL; }
    expect(alerts()).toHaveLength(1); // still failing, inside 30 minutes: no second line
    await s.sweepOnce();
    expect(alerts()).toHaveLength(2); // 30 minutes after the first: one reminder
    expect(parsed()[1]).toMatchObject({ consecutive_passes: 12 });
  });

  test("a clean pass after an alert clears it with one recovered line, and a later stall alerts afresh", async () => {
    const clock = { now: Date.parse("2026-08-10T12:00:00.000Z") };
    let fail = true;
    const s = sweeper(() => (fail ? "throw" : clean), clock);
    for (let i = 0; i < 6; i++) { await s.sweepOnce(); clock.now += INTERVAL; }
    expect(alerts()).toHaveLength(1);
    fail = false;
    await s.sweepOnce();
    clock.now += INTERVAL;
    await s.sweepOnce();
    expect(logs.filter((l) => l.includes(RETENTION_RECOVERED_EVENT))).toHaveLength(1);
    expect(JSON.parse(logs.find((l) => l.includes(RETENTION_RECOVERED_EVENT))!)).toMatchObject({ event: "retention_sweep_recovered" });
    fail = true;
    for (let i = 0; i < 6; i++) { await s.sweepOnce(); clock.now += INTERVAL; }
    expect(alerts()).toHaveLength(2);
    expect(parsed()[1]).toMatchObject({ consecutive_passes: 6 });
  });

  test("a row more than an hour past its deadline alerts on the first pass; a short blip never does", async () => {
    const clock = { now: Date.parse("2026-08-10T12:00:00.000Z") };
    await sweeper(() => ({ ...clean, overdue: 2, oldestOverdueAgeMs: 61 * 60_000 }), clock).sweepOnce();
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({ overdue_rows: 2, consecutive_passes: 1 });

    errors.length = 0;
    let n = 0;
    const blip = sweeper(() => (n++ < 3 ? "throw" : clean), clock);
    for (let i = 0; i < 8; i++) await blip.sweepOnce();
    expect(alerts()).toHaveLength(0);
    expect(logs.filter((l) => l.includes(RETENTION_RECOVERED_EVENT))).toHaveLength(0);
  });

  test("an unreadable index directory counts as a failing pass", async () => {
    const clock = { now: Date.parse("2026-08-10T12:00:00.000Z") };
    const s = sweeper(() => clean, clock, async () => { throw new Error("directory down"); });
    for (let i = 0; i < 6; i++) { await s.sweepOnce(); clock.now += INTERVAL; }
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({ errors: 1, consecutive_passes: 6 });
  });
});

describe("ContentStore.sweepRetention reports what it could not delete", () => {
  const T0 = Date.parse("2026-08-10T12:00:00.000Z");
  const DAY = 86_400_000;

  test("rows past their deadline that a failing blob delete leaves behind are counted as overdue with their age", async () => {
    const inner = new InMemoryContentBlobStore();
    let failRemove = true;
    const blobs = Object.assign(Object.create(inner), {
      remove: (source: string, address: string, sourceId: string) =>
        failRemove ? Promise.reject(new Error("kv down")) : inner.remove(source, address, sourceId),
    }) as InMemoryContentBlobStore;
    const clock = { now: T0 - 15 * DAY };
    const store = new ContentStore(blobs, { now: () => clock.now, master: () => CONTENT_MASTER });
    await store.upsert({
      source: SOURCE, address: ADDRESS, sourceId: MEETING_ID, kind: "transcript",
      content: { sentences: ["hello"] },
      fetchedAt: new Date(clock.now).toISOString(), receivedAt: new Date(clock.now).toISOString(), ts: new Date(clock.now).toISOString(),
    });
    clock.now = T0 + 2 * 3_600_000;
    const stuck = await store.sweepRetention({ source: SOURCE, address: ADDRESS });
    expect(stuck.swept).toBe(0);
    expect(stuck.overdue).toBe(1);
    expect(stuck.oldestOverdueAgeMs).toBeGreaterThan(3_600_000);

    failRemove = false;
    const cleared = await store.sweepRetention({ source: SOURCE, address: ADDRESS });
    expect(cleared.swept).toBe(1);
    expect(cleared.overdue).toBe(0);
    expect(cleared.oldestOverdueAgeMs).toBe(0);
  });
});
