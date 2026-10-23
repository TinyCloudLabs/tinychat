import { describe, expect, spyOn, test, vi } from "bun:test";
import { runExoRetentionSweep, startExoRetentionSweepTimer } from "../exo/retention-sweep.js";
import { EXO_NAMESPACE, JOB_MESSAGE, createMemoryExoLedger, type ExoJobRecord } from "../exo/mailbox.js";
import { EXO_MIRROR_JOBS_PREFIX, mirrorJobKey } from "../exo/stores.js";

const OWNER = `0x${"a".repeat(40)}`;
const OTHER_OWNER = `0x${"b".repeat(40)}`;
const JOB_ID = "0b1a2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_JOB_ID = "1c2b3d4e-5f60-4a7b-9c8d-0e1f2a3b4c5d";
const NOW = Date.parse("2026-02-01T00:00:00.000Z");
const EXPIRED_AT = "2025-12-01T00:00:00.000Z";
const FRESH_AT = "2026-01-30T00:00:00.000Z";

function jobRecord(jobId: string, updatedAt: string): ExoJobRecord {
  return {
    v: 1,
    jobId,
    capability: "sync-google",
    state: "done",
    code: "accepted",
    message: JOB_MESSAGE.accepted,
    createdAt: updatedAt,
    updatedAt,
  };
}

function fakeKv(initial: Record<string, unknown> = {}) {
  const entries = new Map<string, unknown>(Object.entries(initial));
  const deleted: string[] = [];
  let listFails = false;
  return {
    entries,
    deleted,
    failList() {
      listFails = true;
    },
    async get(key: string) {
      if (!entries.has(key)) {
        return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      }
      return { ok: true, data: { data: entries.get(key), headers: { etag: '"etag"' } } };
    },
    async list(prefix: string) {
      if (listFails) {
        return { ok: false, error: { code: "KV_UNAVAILABLE", service: "kv", message: "down" } };
      }
      return { ok: true, data: { keys: [...entries.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async delete(key: string) {
      deleted.push(key);
      entries.delete(key);
      return { ok: true, data: {} };
    },
  };
}

function fakePorts(options: { active?: string[]; removeFails?: string[]; requestRemoveFails?: string[] } = {}) {
  const active = new Set(options.active ?? []);
  const removeFails = new Set(options.removeFails ?? []);
  const requestRemoveFails = new Set(options.requestRemoveFails ?? []);
  const removed: Array<[string, string]> = [];
  const requestsRemoved: Array<[string, string]> = [];
  const order: string[] = [];
  return {
    removed,
    requestsRemoved,
    order,
    ports: {
      grants: { isActive: async (owner: string) => active.has(owner) },
      ledger: createMemoryExoLedger(),
      requests: {
        get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: "not found" } }),
        remove: async (owner: string, path: string) => {
          const jobId = path.slice(path.lastIndexOf("/") + 1);
          if (requestRemoveFails.has(jobId)) throw new Error("request remove failed");
          requestsRemoved.push([owner, path]);
          order.push(`request:${jobId}`);
        },
      },
      jobs: {
        remove: async (owner: string, jobId: string) => {
          if (removeFails.has(jobId)) throw new Error("remove failed");
          removed.push([owner, jobId]);
          order.push(`job:${jobId}`);
        },
      },
    },
  };
}

function mirrorEntries(...records: Array<[string, string, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [owner, jobId, updatedAt] of records) {
    out[mirrorJobKey(owner, jobId)] = jobRecord(jobId, updatedAt);
  }
  return out;
}

describe("exo retention sweep: expiry", () => {
  test("an expired mirror with no active grant is deleted from the backend space only", async () => {
    const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, EXPIRED_AT]));
    const { ports, removed } = fakePorts();

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 1, skipped: 0, failed: 0 });
    expect(kv.deleted).toEqual([mirrorJobKey(OWNER, JOB_ID)]);
    expect(removed).toEqual([]);
  });

  test("an expired mirror with an active grant goes through jobs.remove for the owner", async () => {
    const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, EXPIRED_AT]));
    const { ports, removed } = fakePorts({ active: [OWNER] });

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 1, skipped: 0, failed: 0 });
    expect(removed).toEqual([[OWNER, JOB_ID]]);
    expect(kv.deleted).toEqual([]);
  });

  test("a mirror inside the retention window is kept", async () => {
    const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, FRESH_AT]));
    const { ports, removed } = fakePorts();

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 0, skipped: 1, failed: 0 });
    expect(kv.deleted).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("a mirror whose record cannot be parsed is kept, not guessed at", async () => {
    const kv = fakeKv({ [mirrorJobKey(OWNER, JOB_ID)]: { v: 2, garbage: true } });
    const { ports } = fakePorts();

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 0, skipped: 1, failed: 0 });
    expect(kv.deleted).toEqual([]);
  });

  test("keys that are not mirror job keys are skipped without any read", async () => {
    const kv = fakeKv({
      [`${EXO_MIRROR_JOBS_PREFIX}not-an-owner/${JOB_ID}`]: jobRecord(JOB_ID, EXPIRED_AT),
      [`${EXO_MIRROR_JOBS_PREFIX}${OWNER}/not-a-request-id`]: jobRecord(JOB_ID, EXPIRED_AT),
    });
    const { ports } = fakePorts();

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 0, skipped: 2, failed: 0 });
    expect(kv.deleted).toEqual([]);
  });

  test("one record that fails to remove is counted and the pass continues to the next", async () => {
    const kv = fakeKv(
      mirrorEntries([OWNER, JOB_ID, EXPIRED_AT], [OWNER, OTHER_JOB_ID, EXPIRED_AT]),
    );
    const { ports, removed } = fakePorts({ active: [OWNER], removeFails: [JOB_ID] });

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 1, skipped: 0, failed: 1 });
    expect(removed).toEqual([[OWNER, OTHER_JOB_ID]]);
  });

  test("an active owner's expired job: the request record is removed before the job record", async () => {
    const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, EXPIRED_AT]));
    const { ports, order, requestsRemoved, removed } = fakePorts({ active: [OWNER] });

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 1, skipped: 0, failed: 0 });
    expect(order).toEqual([`request:${JOB_ID}`, `job:${JOB_ID}`]);
    expect(requestsRemoved).toEqual([[OWNER, `${EXO_NAMESPACE}/requests/sync-google/${JOB_ID}`]]);
    expect(removed).toEqual([[OWNER, JOB_ID]]);
  });

  test("when the request record cannot be removed, the job record is kept so a replay still finds it", async () => {
    const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, EXPIRED_AT]));
    const { ports, removed, order } = fakePorts({ active: [OWNER], requestRemoveFails: [JOB_ID] });

    const pass = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(pass).toEqual({ removed: 0, skipped: 0, failed: 1 });
    expect(removed).toEqual([]);
    expect(order).toEqual([]);
  });

  test("a second pass after removal finds nothing left to remove", async () => {
    const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, EXPIRED_AT], [OTHER_OWNER, OTHER_JOB_ID, FRESH_AT]));
    const { ports } = fakePorts();

    const first = await runExoRetentionSweep({ kv, ports, now: () => NOW });
    const second = await runExoRetentionSweep({ kv, ports, now: () => NOW });

    expect(first).toEqual({ removed: 1, skipped: 1, failed: 0 });
    expect(second).toEqual({ removed: 0, skipped: 1, failed: 0 });
  });

  test("a failed list rejects the pass and does not write anything", async () => {
    const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, EXPIRED_AT]));
    kv.failList();
    const { ports } = fakePorts();

    await expect(runExoRetentionSweep({ kv, ports, now: () => NOW })).rejects.toThrow();
    expect(kv.deleted).toEqual([]);
  });
});

describe("exo retention sweep: timer", () => {
  test("the timer runs a pass each interval and stops when stopped", async () => {
    vi.useFakeTimers();
    const warn = spyOn(console, "log").mockImplementation(() => {});
    try {
      const kv = fakeKv(mirrorEntries([OWNER, JOB_ID, EXPIRED_AT]));
      const { ports } = fakePorts();
      const timer = startExoRetentionSweepTimer({ kv, ports, now: () => NOW, intervalMs: 1000 });

      vi.advanceTimersByTime(1000);
      await timer.stop();
      expect(kv.deleted).toEqual([mirrorJobKey(OWNER, JOB_ID)]);

      kv.entries.set(mirrorJobKey(OWNER, OTHER_JOB_ID), jobRecord(OTHER_JOB_ID, EXPIRED_AT));
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(kv.deleted).toEqual([mirrorJobKey(OWNER, JOB_ID)]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a failed pass is logged and does not reject the tick", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "log").mockImplementation(() => {});
    try {
      const kv = fakeKv();
      kv.failList();
      const { ports } = fakePorts();
      const timer = startExoRetentionSweepTimer({ kv, ports, now: () => NOW, intervalMs: 60_000 });

      await expect(timer.tick()).resolves.toBeUndefined();
      expect(warn.mock.calls[0]?.[0]).toBe("[exo] retention sweep pass failed:");
      await timer.stop();
    } finally {
      warn.mockRestore();
      vi.restoreAllMocks();
    }
  });
});
