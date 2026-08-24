// RED-first contract for W6 — the BROWSER RECONCILE (backend-ingest plan §8.1 W6, §8.2 delta 6's
// user-space half). The server half of the same delta item is pinned in
// `backend/src/__tests__/connector-reconcile.test.ts` (tagged `[delta-06]`, which is what the
// build gate counts); this suite owns the half that actually touches the user's space.
//
// The rules under test are the plan's, stated literally:
//
//   1. KV ONLY. "Any user-space connector write is `tcw.kv` — KV, never SQL/DuckDB" (§7's
//      standing rule). The fake handle here THROWS from `sql`, so a reconcile that reaches for a
//      table fails the suite instead of shipping.
//   2. STORAGE BEFORE ACK. `reconciledAt` is stamped only after the user-space write RESOLVED
//      ok — the invariant carried from `targetedSync`. A failed write acks nothing, so the row
//      stays in the server's discovery filter and the next run retries it.
//   3. UNLOCKED VAULT ONLY, and never a prompt: a locked vault is a reported no-op that touches
//      neither the API nor the space.
//   4. FAIL CLOSED. Every call resolves; a resolved non-`ok` is a FAILURE. A list that could not
//      be read is never "there was nothing to reconcile".
//   5. SEQUENTIAL. TinyCloud drops concurrent responses on one space, so no two storage calls
//      may ever overlap — asserted by an overlap tracker, not by reading the code.
//   6. IDEMPOTENT RE-RUNS, and the server copy is RETAINED (D2a): reconcile is a copy, never a
//      move, so nothing here deletes or shortens anything server-side.

import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  RECONCILE_MAX_PER_RUN,
  reconcileBackendMeetings,
  type BackendReconcileMeetingsClient,
  type ReconciledMeetingKvRecordV1,
} from "./backendReconcile";
import { meetingKvKey, transcriptKvKey } from "./connectorStore";
import type {
  ConnectorMeetingContent,
  ConnectorMeetingList,
  ConnectorMeetingMeta,
  ConnectorMeetingReconciled,
  ConnectorMeetingsResult,
} from "./meetingsApi";

const SOURCE = "fireflies";

function meta(over: Partial<ConnectorMeetingMeta> & { sourceId: string }): ConnectorMeetingMeta {
  return {
    sizeBytes: 128,
    storedAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    hasTranscript: true,
    hasSummary: false,
    ...over,
  };
}

function transcriptPayload(text: string) {
  return {
    id: "ff-1",
    title: "Q3 planning sync",
    sentences: [
      { index: 0, speaker_name: "Dana", text, start_time: 0, end_time: 2 },
    ],
  };
}

/** Records the order of every storage op and screams if two ever overlap. */
class OpTracker {
  order: string[] = [];
  private inFlight = 0;

  async run<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.inFlight > 0) {
      throw new Error(`concurrent storage op: ${label} overlapped another call`);
    }
    this.inFlight += 1;
    this.order.push(label);
    try {
      // A real turn of the event loop, so an accidental Promise.all overlaps here.
      await Promise.resolve();
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}

interface KvErr {
  code: string;
  message: string;
}

class FakeKv {
  entries = new Map<string, string>();
  putKeys: string[] = [];
  /** Keys whose put fails, every time — the user-space write failure the invariant is about. */
  failKeys = new Set<string>();
  constructor(readonly tracker: OpTracker) {}

  async put(key: string, value: unknown) {
    return this.tracker.run(`kv.put:${key}`, () => {
      if (this.failKeys.has(key)) {
        return { ok: false as const, error: { code: "KV_ERROR", message: "boom-kv" } as KvErr };
      }
      this.entries.set(key, typeof value === "string" ? value : JSON.stringify(value));
      this.putKeys.push(key);
      return { ok: true as const, data: { data: undefined, headers: {} } };
    });
  }
}

function makeTcw(tracker: OpTracker): { tcw: TinyCloudWeb; kv: FakeKv } {
  const kv = new FakeKv(tracker);
  const tcw = {
    kv,
    // KV-ONLY: any SQL reach is a defect, not a fallback.
    sql: {
      db: () => {
        throw new Error("W6 must never touch SQL — the user-space write is tcw.kv only");
      },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, kv };
}

interface ClientScript {
  lists?: ConnectorMeetingsResult<ConnectorMeetingList>[];
  reads?: Record<string, ConnectorMeetingsResult<ConnectorMeetingContent>>;
  acks?: Record<string, ConnectorMeetingsResult<ConnectorMeetingReconciled>>;
}

interface RecordingClient extends BackendReconcileMeetingsClient {
  calls: string[];
  listArgs: unknown[];
}

function client(script: ClientScript, tracker?: OpTracker): RecordingClient {
  const calls: string[] = [];
  const listArgs: unknown[] = [];
  let listIndex = 0;
  const run = async <T>(label: string, value: T): Promise<T> => {
    calls.push(label);
    if (tracker) return tracker.run(label, () => value);
    return value;
  };
  return {
    calls,
    listArgs,
    async list(options) {
      listArgs.push(options);
      const next =
        script.lists?.[Math.min(listIndex, (script.lists?.length ?? 1) - 1)] ??
        ({ status: "ok", value: { source: SOURCE, meetings: [], nextCursor: null, hasMore: false } } as const);
      listIndex += 1;
      return run("list", next);
    },
    async read(source, sourceId) {
      return run(
        `read:${sourceId}`,
        script.reads?.[sourceId] ?? {
          status: "ok",
          value: {
            source,
            sourceId,
            meta: meta({ sourceId }),
            content: { transcript: transcriptPayload("hello") },
          },
        },
      );
    },
    async markReconciled(source, sourceId) {
      return run(
        `ack:${sourceId}`,
        script.acks?.[sourceId] ?? {
          status: "ok",
          value: { reconciled: true, source, sourceId },
        },
      );
    },
  };
}

function unlocked() {
  return { isUnlocked: () => true };
}

const okList = (meetings: ConnectorMeetingMeta[]): ConnectorMeetingsResult<ConnectorMeetingList> => ({
  status: "ok",
  value: { source: SOURCE, meetings, nextCursor: null, hasMore: false },
});

let tracker: OpTracker;

beforeEach(() => {
  tracker = new OpTracker();
});

describe("reconcileBackendMeetings — the user-space copy", () => {
  test("[delta-06] writes the user's OWN space via tcw.kv, THEN acks", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client(
      { lists: [okList([meta({ sourceId: "mtg-a", title: "Q3 planning sync" })])] },
      tracker,
    );

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.written).toBe(1);
    expect(res.data.reconciled).toBe(1);
    expect(res.data.blocked).toBe(null);

    // KV only, under the granted `${APP_ID}/connectors/` prefix, both halves present.
    expect(kv.entries.has(meetingKvKey(SOURCE, "mtg-a"))).toBe(true);
    expect(kv.entries.has(transcriptKvKey(SOURCE, "mtg-a"))).toBe(true);
    const record = JSON.parse(
      kv.entries.get(meetingKvKey(SOURCE, "mtg-a")) ?? "{}",
    ) as ReconciledMeetingKvRecordV1;
    expect(record).toEqual({
      v: 1,
      source: SOURCE,
      sourceId: "mtg-a",
      title: "Q3 planning sync",
      startedAt: null,
      hasTranscript: true,
      hasSummary: false,
      storedAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
      copiedAt: expect.any(String),
      origin: "backend-ingest",
    });
    // The transcript body keeps Option C's shape, so the user's space stays one archive.
    expect(JSON.parse(kv.entries.get(transcriptKvKey(SOURCE, "mtg-a")) ?? "[]")).toHaveLength(1);

    // STORAGE BEFORE ACK — the stamp trails the write, never leads it.
    const putAt = tracker.order.findIndex((op) => op === `kv.put:${meetingKvKey(SOURCE, "mtg-a")}`);
    const ackAt = tracker.order.indexOf("ack:mtg-a");
    expect(putAt).toBeGreaterThanOrEqual(0);
    expect(ackAt).toBeGreaterThan(putAt);

    // The row it hands back to the meetings view (`applyLocalMeetings`).
    expect(res.data.local).toEqual([
      { source: SOURCE, sourceId: "mtg-a", title: "Q3 planning sync", startedAt: null },
    ]);
  });

  test("[delta-06] pulls ONLY unreconciled rows — the read-API discovery filter", async () => {
    const { tcw } = makeTcw(tracker);
    const api = client({ lists: [okList([])] }, tracker);

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    expect(api.listArgs[0]).toMatchObject({ source: SOURCE, reconciled: false });
  });

  test("[delta-06] a FAILED user-space write acks NOTHING and the run continues", async () => {
    const { tcw, kv } = makeTcw(tracker);
    kv.failKeys.add(meetingKvKey(SOURCE, "mtg-bad"));
    const api = client(
      { lists: [okList([meta({ sourceId: "mtg-bad" }), meta({ sourceId: "mtg-good" })])] },
      tracker,
    );

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The failed one is NOT acked — the server keeps it in the discovery filter.
    expect(api.calls).not.toContain("ack:mtg-bad");
    expect(res.data.failures).toEqual([
      { sourceId: "mtg-bad", stage: "storage", detail: expect.stringContaining("boom-kv") },
    ]);
    // …and one bad meeting never fails the batch.
    expect(api.calls).toContain("ack:mtg-good");
    expect(res.data.written).toBe(1);
    expect(res.data.reconciled).toBe(1);
  });

  test("[delta-06] a stored-but-unacked meeting is reported, never counted as reconciled", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client(
      {
        lists: [okList([meta({ sourceId: "mtg-a" })])],
        acks: { "mtg-a": { status: "retryable", httpStatus: 503, code: "unavailable" } },
      },
      tracker,
    );

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.written).toBe(1);
    expect(res.data.reconciled).toBe(0);
    expect(res.data.unacknowledged).toEqual(["mtg-a"]);
    // The meeting is SAFE in the user's space; only the stamp is missing, and the next run
    // re-writes the same keys and re-acks. That is the failure direction this design accepts.
    expect(kv.entries.has(meetingKvKey(SOURCE, "mtg-a"))).toBe(true);
  });

  test("[delta-06] a locked vault is a no-op: no API call, no write, no prompt", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client({ lists: [okList([meta({ sourceId: "mtg-a" })])] }, tracker);

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: { isUnlocked: () => false },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe("vault-locked");
    expect(res.data.written).toBe(0);
    expect(api.calls).toEqual([]);
    expect(kv.putKeys).toEqual([]);
  });

  test("[delta-06] a dark/non-cohort surface is a stated no-op, not an error", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client({ lists: [{ status: "feature-dark" }] }, tracker);

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe("feature-dark");
    expect(kv.putKeys).toEqual([]);
  });

  test("[delta-06] an unreadable list FAILS — it is never 'nothing to reconcile'", async () => {
    const { tcw } = makeTcw(tracker);
    for (const failure of [
      { status: "retryable", httpStatus: 503, code: "unavailable" },
      { status: "offline" },
      { status: "rejected", httpStatus: 400, code: "invalid_reconciled" },
    ] as ConnectorMeetingsResult<ConnectorMeetingList>[]) {
      const api = client({ lists: [failure] }, tracker);
      const res = await reconcileBackendMeetings({
        tcw,
        source: SOURCE,
        meetings: api,
        secrets: unlocked(),
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe("api");
    }
  });

  test("[delta-06] a signed-out session stops the run as a stated state", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client({ lists: [{ status: "unauthenticated" }] }, tracker);
    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe("signed-out");
    expect(kv.putKeys).toEqual([]);
  });

  test("[delta-06] a meeting swept between list and read is skipped, not acked", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client(
      {
        lists: [okList([meta({ sourceId: "mtg-gone" }), meta({ sourceId: "mtg-here" })])],
        reads: { "mtg-gone": { status: "not-found" } },
      },
      tracker,
    );

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.vanished).toBe(1);
    expect(api.calls).not.toContain("ack:mtg-gone");
    expect(kv.entries.has(meetingKvKey(SOURCE, "mtg-gone"))).toBe(false);
    // The run keeps going: one missing row is not a reason to abandon the rest.
    expect(res.data.reconciled).toBe(1);
  });

  test("[delta-06] a summary-only PARTIAL row reconciles without throwing", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client(
      {
        lists: [
          okList([
            meta({ sourceId: "mtg-partial", hasTranscript: false, hasSummary: true }),
          ]),
        ],
        reads: {
          "mtg-partial": {
            status: "ok",
            value: {
              source: SOURCE,
              sourceId: "mtg-partial",
              meta: meta({ sourceId: "mtg-partial", hasTranscript: false, hasSummary: true }),
              content: { summary: { overview: "Legal review blocks the Q3 plan" } },
            },
          },
        },
      },
      tracker,
    );

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.reconciled).toBe(1);
    // No transcript half arrived, so no transcript key is written — an empty body would
    // overwrite a richer Option-C copy with nothing.
    expect(kv.entries.has(transcriptKvKey(SOURCE, "mtg-partial"))).toBe(false);
    const record = JSON.parse(kv.entries.get(meetingKvKey(SOURCE, "mtg-partial")) ?? "{}");
    expect(record.hasSummary).toBe(true);
    expect(record.hasTranscript).toBe(false);
    expect(record.summary).toEqual({ overview: "Legal review blocks the Q3 plan" });
  });

  test("[delta-06] re-running over a reconciled archive writes nothing and acks nothing", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client({ lists: [okList([])] }, tracker);

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scanned).toBe(0);
    expect(res.data.written).toBe(0);
    expect(kv.putKeys).toEqual([]);
    expect(api.calls).toEqual(["list"]);
  });

  test("[delta-06] every call is SEQUENTIAL — one space, never a Promise.all", async () => {
    const { tcw } = makeTcw(tracker);
    const ids = ["m1", "m2", "m3", "m4"];
    const api = client({ lists: [okList(ids.map((sourceId) => meta({ sourceId })))] }, tracker);

    // The tracker throws on ANY overlap, so a parallel implementation cannot pass this.
    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.reconciled).toBe(4);
    // Per meeting: read → put(s) → ack, in that order, before the next meeting starts.
    expect(tracker.order.indexOf("read:m2")).toBeGreaterThan(tracker.order.indexOf("ack:m1"));
  });

  test("[delta-06] pages the discovery filter with the cursor the server gave", async () => {
    const { tcw, kv } = makeTcw(tracker);
    const api = client(
      {
        lists: [
          {
            status: "ok",
            value: {
              source: SOURCE,
              meetings: [meta({ sourceId: "p1" })],
              nextCursor: "p1",
              hasMore: true,
            },
          },
          okList([meta({ sourceId: "p2" })]),
        ],
      },
      tracker,
    );

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.reconciled).toBe(2);
    expect(api.listArgs[1]).toMatchObject({ reconciled: false, cursor: "p1" });
    expect(kv.entries.has(meetingKvKey(SOURCE, "p2"))).toBe(true);
  });

  test("[delta-06] a bounded run says so — no silent cap", async () => {
    const { tcw } = makeTcw(tracker);
    const many = Array.from({ length: 3 }, (_, i) => meta({ sourceId: `m${i}` }));
    const api = client({ lists: [okList(many)] }, tracker);

    const res = await reconcileBackendMeetings({
      tcw,
      source: SOURCE,
      meetings: api,
      secrets: unlocked(),
      maxMeetings: 2,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.written).toBe(2);
    // The caller is TOLD the run stopped early, so "0 unreconciled left" is never implied.
    expect(res.data.truncated).toBe(true);
    expect(RECONCILE_MAX_PER_RUN).toBeGreaterThan(0);
  });

  test("[delta-06] nothing is logged — no meeting id or content reaches the console", async () => {
    const { tcw, kv } = makeTcw(tracker);
    kv.failKeys.add(meetingKvKey(SOURCE, "mtg-secret"));
    const api = client({ lists: [okList([meta({ sourceId: "mtg-secret" })])] }, tracker);

    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
      await reconcileBackendMeetings({
        tcw,
        source: SOURCE,
        meetings: api,
        secrets: unlocked(),
      });
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }
    expect(lines).toEqual([]);
  });
});
