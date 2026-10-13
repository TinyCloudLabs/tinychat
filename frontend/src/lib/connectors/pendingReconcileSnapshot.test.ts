import { describe, expect, test } from "bun:test";
import type { ConnectorMeetingMeta } from "./meetingsApi";
import type { TranscriberListRow } from "../transcriberApi";
import {
  PENDING_RECONCILE_SNAPSHOT_KEY,
  backendPendingRows,
  transcriberPendingRows,
  writePendingReconcileSnapshot,
  type PendingReconcileMeeting,
} from "./pendingReconcileSnapshot";

const backendRow = (over: Partial<ConnectorMeetingMeta> & { sourceId: string }): ConnectorMeetingMeta => ({
  sizeBytes: 123,
  storedAt: "2026-10-13T08:00:00.000Z",
  updatedAt: "2026-10-13T08:01:00.000Z",
  hasTranscript: true,
  hasSummary: false,
  ...over,
});

function kvFixture() {
  const entries = new Map<string, string>();
  const etags = new Map<string, string>();
  const writes: Array<{ key: string; value: string; options?: { ifMatch?: string; ifNoneMatch?: "*" } }> = [];
  let revision = 0;
  const kv = {
    async get(key: string) {
      const value = entries.get(key);
      return value === undefined
        ? { ok: false as const, error: { code: "KV_NOT_FOUND" } }
        : { ok: true as const, data: { data: value, headers: { etag: etags.get(key) } } };
    },
    async put(key: string, value: string, options?: { ifMatch?: string; ifNoneMatch?: "*" }) {
      writes.push({ key, value, options });
      if (options?.ifNoneMatch === "*" && entries.has(key)) {
        return { ok: false as const, error: { code: "KV_PRECONDITION_FAILED" } };
      }
      if (options?.ifMatch !== undefined && etags.get(key) !== options.ifMatch) {
        return { ok: false as const, error: { code: "KV_PRECONDITION_FAILED" } };
      }
      if (entries.has(key) && options?.ifMatch === undefined) {
        return { ok: false as const, error: { code: "KV_PRECONDITION_FAILED" } };
      }
      entries.set(key, value);
      etags.set(key, `etag-${++revision}`);
      return { ok: true as const };
    },
  };
  return {
    entries,
    writes,
    kv,
    seed: (key: string, value: string) => { entries.set(key, value); etags.set(key, `etag-${++revision}`); },
  };
}

describe("backend-only metadata snapshot", () => {
  test("projects unreconciled connector rows without content or identifying extras", () => {
    const projected = backendPendingRows("fireflies", [backendRow({
      sourceId: "ff-1",
      ts: "2026-10-12T12:00:00Z",
      title: "PRIVATE_TITLE",
      participantNames: ["PRIVATE_PERSON"],
      organizerEmail: "private@example.test",
    })]);
    expect(projected).toEqual([{
      id: "ff-1",
      source: "fireflies",
      ts: "2026-10-12T12:00:00Z",
      storedAt: "2026-10-13T08:00:00.000Z",
      updatedAt: "2026-10-13T08:01:00.000Z",
      status: "unreconciled",
      reconciled: false,
    }]);
  });

  test("lists only completed, unsaved transcriber rows", () => {
    const rows = [
      { id: "saved", status: "completed", created_at: "2026-10-01T00:00:00Z", meeting_url: "PRIVATE_URL" },
      { id: "not-complete", status: "processing", created_at: "2026-10-02T00:00:00Z" },
      { id: "ptx-1", status: "completed", created_at: "2026-10-03T00:00:00Z", completed_at: "2026-10-03T01:00:00Z", transcript: { text: "PRIVATE_CONTENT" }, error: { message: "PRIVATE_ERROR" } },
      { id: "unavailable", unavailable: true },
    ] as unknown as TranscriberListRow[];
    expect(transcriberPendingRows(rows, ["saved"], [])).toEqual([{
      id: "ptx-1",
      source: "transcriber",
      createdAt: "2026-10-03T00:00:00Z",
      completedAt: "2026-10-03T01:00:00Z",
      status: "completed",
      reconciled: false,
    }, {
      id: "unavailable",
      source: "transcriber",
      status: "unknown",
      reconciled: false,
    }]);
  });
  test("projects unreadable saved-body ids as unknown without other metadata", () => {
    expect(transcriberPendingRows([], [], ["body-failed", "body-threw"])).toEqual([
      { id: "body-failed", source: "transcriber", status: "unknown", reconciled: false },
      { id: "body-threw", source: "transcriber", status: "unknown", reconciled: false },
    ]);
  });

  test("serializes only allowlisted metadata and persists every newer backend observation", async () => {
    const f = kvFixture();
    const rows = backendPendingRows("fireflies", [backendRow({ sourceId: "ff-1", title: "PRIVATE_TITLE" })]);
    const observedAt = "2026-10-13T09:00:00.000Z";
    const first = await writePendingReconcileSnapshot(f.kv, "backend-ingest", rows, observedAt);
    expect(first).toEqual({ ok: true, changed: true });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.key).toBe(`${PENDING_RECONCILE_SNAPSHOT_KEY}/backend-ingest`);
    const serialized = f.writes[0]?.value ?? "";
    expect(serialized).not.toMatch(/title|participant|email|url|content|transcript|summary|error|PRIVATE_/i);
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      changed_at: observedAt,
      checked_at: observedAt,
      count: 1,
      meetings: rows,
    });

    const unchanged = await writePendingReconcileSnapshot(f.kv, "backend-ingest", rows, "2026-10-13T09:00:30.000Z");
    expect(unchanged).toEqual({ ok: true, changed: true });
    expect(f.writes).toHaveLength(2);
    const refreshed = JSON.parse(f.writes[1]?.value ?? "{}");
    expect(refreshed.changed_at).toBe(observedAt);
    expect(refreshed.checked_at).toBe("2026-10-13T09:00:30.000Z");
  });
  test("refreshes the transcriber checked_at every 50 minutes without changing changed_at", async () => {
    const f = kvFixture();
    const rows = transcriberPendingRows([
      { id: "ptx-1", status: "completed", created_at: "2026-10-03T00:00:00Z" },
    ] as TranscriberListRow[], []);
    await writePendingReconcileSnapshot(f.kv, "transcriber", rows, "2026-10-13T09:00:00.000Z");
    const beforeHeartbeat = await writePendingReconcileSnapshot(f.kv, "transcriber", rows, "2026-10-13T09:49:59.999Z");
    expect(beforeHeartbeat).toEqual({ ok: true, changed: false });
    expect(f.writes).toHaveLength(1);
    const afterHeartbeat = await writePendingReconcileSnapshot(f.kv, "transcriber", rows, "2026-10-13T09:50:00.001Z");
    expect(afterHeartbeat).toEqual({ ok: true, changed: true });
    expect(f.writes).toHaveLength(2);
    const source = JSON.parse(f.writes[1]?.value ?? "{}");
    expect(source.changed_at).toBe("2026-10-13T09:00:00.000Z");
    expect(source.checked_at).toBe("2026-10-13T09:50:00.001Z");
  });
  test("keeps transcriber checked_at within pack freshness during maximum-duration sync passes", async () => {
    const f = kvFixture();
    const empty: PendingReconcileMeeting[] = [];
    const origin = Date.parse("2026-10-13T09:00:00.000Z");
    const intervalMs = 30_000;
    const passDurationMs = 60_000;
    const packStaleAfterMs = 3_630_000;
    let nowMs = origin;
    const realNow = Date.now;
    Date.now = () => nowMs;
    try {
      nowMs = origin + passDurationMs;
      await writePendingReconcileSnapshot(f.kv, "transcriber", empty, new Date(origin).toISOString());
      for (let passStart = origin + 15_000; passStart <= origin + 2 * 60 * 60 * 1000; passStart += intervalMs) {
        nowMs = passStart + passDurationMs;
        await writePendingReconcileSnapshot(f.kv, "transcriber", empty, new Date(passStart).toISOString());
        const snapshot = JSON.parse(f.entries.get(`${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`) ?? "{}");
        expect(nowMs - Date.parse(snapshot.checked_at)).toBeLessThanOrEqual(packStaleAfterMs);
      }
    } finally {
      Date.now = realNow;
    }
  });
  test("backend-ingest persists an unchanged 08:30 observation to fence an older 08:15 pass", async () => {
    const f = kvFixture();
    const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/backend-ingest`;
    const empty: PendingReconcileMeeting[] = [];
    f.seed(key, JSON.stringify({
      version: 1,
      changed_at: "2026-10-13T08:00:00.000Z",
      checked_at: "2026-10-13T08:00:00.000Z",
      count: 0,
      meetings: empty,
    }));
    let reads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
    let releaseOlder!: () => void;
    const olderPut = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const kv = {
      async get(readKey: string) {
        const result = await f.kv.get(readKey);
        if (++reads === 2) releaseReads();
        await bothRead;
        return result;
      },
      async put(writeKey: string, value: string, options?: { ifMatch?: string; ifNoneMatch?: "*" }) {
        if (value.includes("ff-slow-0815")) await olderPut;
        return f.kv.put(writeKey, value, options);
      },
    };
    const slow = writePendingReconcileSnapshot(kv, "backend-ingest", backendPendingRows("fireflies", [
      backendRow({ sourceId: "ff-slow-0815" }),
    ]), "2026-10-13T08:15:00.000Z");
    const newer = writePendingReconcileSnapshot(kv, "backend-ingest", empty, "2026-10-13T08:30:00.000Z");
    await newer;
    releaseOlder();
    await slow;
    const stored = JSON.parse(f.entries.get(key) ?? "{}");
    expect(stored.checked_at).toBe("2026-10-13T08:30:00.000Z");
    expect(stored.meetings).toEqual([]);
  });

  test("the next transcriber pass repairs a stale projection from a slower pass", async () => {
    const f = kvFixture();
    const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`;
    const empty: PendingReconcileMeeting[] = [];
    const pending = transcriberPendingRows([
      { id: "ptx-slow-0815", status: "completed", created_at: "2026-10-13T08:15:00.000Z" },
    ] as TranscriberListRow[], []);
    await writePendingReconcileSnapshot(f.kv, "transcriber", empty, "2026-10-13T08:00:00.000Z");
    expect(await writePendingReconcileSnapshot(f.kv, "transcriber", empty, "2026-10-13T08:30:00.000Z"))
      .toEqual({ ok: true, changed: false });
    await writePendingReconcileSnapshot(f.kv, "transcriber", pending, "2026-10-13T08:15:00.000Z");
    const repaired = await writePendingReconcileSnapshot(f.kv, "transcriber", empty, "2026-10-13T08:30:30.000Z");
    expect(repaired).toEqual({ ok: true, changed: true });
    const stored = JSON.parse(f.entries.get(key) ?? "{}");
    expect(stored.checked_at).toBe("2026-10-13T08:30:30.000Z");
    expect(stored.meetings).toEqual([]);
  });

  test("an invalid or future changed_at is reset to the current observation", async () => {
    const observedAt = new Date().toISOString();
    const checkedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    for (const changedAt of ["not-a-timestamp", new Date(Date.now() + 60 * 60 * 1000).toISOString()]) {
      const f = kvFixture();
      const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`;
      f.seed(key, JSON.stringify({
        version: 1,
        changed_at: changedAt,
        checked_at: checkedAt,
        count: 0,
        meetings: [],
      }));
      await writePendingReconcileSnapshot(f.kv, "transcriber", [], observedAt);
      expect(JSON.parse(f.entries.get(key) ?? "{}").changed_at).toBe(observedAt);
    }
  });
  test("concurrent source writes keep independent state under separate keys", async () => {
    const entries = new Map<string, { value: string; etag: string }>();
    let getCount = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
    let revision = 0;
    const kv = {
      async get(key: string) {
        const stored = entries.get(key);
        getCount++;
        if (getCount === 2) releaseReads();
        await bothRead;
        return stored
          ? { ok: true as const, data: { data: stored.value, headers: { etag: stored.etag } } }
          : { ok: false as const, error: { code: "KV_NOT_FOUND" } };
      },
      async put(key: string, value: string, options?: { ifMatch?: string; ifNoneMatch?: "*" }) {
        const current = entries.get(key);
        if (options?.ifNoneMatch === "*" && current) return { ok: false as const, error: { code: "KV_PRECONDITION_FAILED" } };
        if (options?.ifMatch !== undefined && options.ifMatch !== current?.etag) return { ok: false as const, error: { code: "KV_PRECONDITION_FAILED" } };
        entries.set(key, { value, etag: `etag-${++revision}` });
        return { ok: true as const };
      },
    };
    const backendKey = `${PENDING_RECONCILE_SNAPSHOT_KEY}/backend-ingest`;
    const transcriberKey = `${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`;
    await Promise.all([
      writePendingReconcileSnapshot(kv, "backend-ingest", backendPendingRows("fireflies", [backendRow({ sourceId: "ff-1" })]), "2026-10-13T09:00:00.000Z"),
      writePendingReconcileSnapshot(kv, "transcriber", transcriberPendingRows([
        { id: "ptx-1", status: "completed", created_at: "2026-10-03T00:00:00Z" },
      ] as TranscriberListRow[], []), "2026-10-13T09:00:01.000Z"),
    ]);
    expect(JSON.parse(entries.get(backendKey)?.value ?? "{}").meetings.map((row: { id: string }) => row.id)).toEqual(["ff-1"]);
    expect(JSON.parse(entries.get(transcriberKey)?.value ?? "{}").meetings.map((row: { id: string }) => row.id)).toEqual(["ptx-1"]);
  });

  test("a slower same-source pass cannot overwrite a newer observedAt after both read", async () => {
    const f = kvFixture();
    const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/backend-ingest`;
    f.seed(key, JSON.stringify({
      version: 1,
      changed_at: "2026-10-13T08:00:00.000Z",
      checked_at: "2026-10-13T08:00:00.000Z",
      count: 1,
      meetings: backendPendingRows("fireflies", [backendRow({ sourceId: "ff-initial" })]),
    }));
    let reads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
    let releaseOlder!: () => void;
    const olderPut = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const kv = {
      async get(readKey: string) {
        const result = await f.kv.get(readKey);
        reads++;
        if (reads === 2) releaseReads();
        await bothRead;
        return result;
      },
      async put(writeKey: string, value: string, options?: { ifMatch?: string; ifNoneMatch?: "*" }) {
        if (value.includes("ff-older")) await olderPut;
        return f.kv.put(writeKey, value, options);
      },
    };
    const older = writePendingReconcileSnapshot(kv, "backend-ingest", backendPendingRows("fireflies", [backendRow({ sourceId: "ff-older" })]), "2026-10-13T09:00:00.000Z");
    const newer = writePendingReconcileSnapshot(kv, "backend-ingest", backendPendingRows("fireflies", [backendRow({ sourceId: "ff-newer" })]), "2026-10-13T09:01:00.000Z");
    await newer;
    releaseOlder();
    await older;
    const stored = JSON.parse(f.entries.get(key) ?? "{}");
    expect(stored.checked_at).toBe("2026-10-13T09:01:00.000Z");
    expect(stored.meetings.map((row: { id: string }) => row.id)).toEqual(["ff-newer"]);
  });
  test("a completed newer observation makes a later-arriving older pass a no-op", async () => {
    const f = kvFixture();
    const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/backend-ingest`;
    await writePendingReconcileSnapshot(
      f.kv,
      "backend-ingest",
      backendPendingRows("fireflies", [backendRow({ sourceId: "ff-newer" })]),
      "2026-10-13T09:01:00.000Z",
    );
    const stale = await writePendingReconcileSnapshot(
      f.kv,
      "backend-ingest",
      backendPendingRows("fireflies", [backendRow({ sourceId: "ff-older" })]),
      "2026-10-13T09:00:00.000Z",
    );
    expect(stale).toEqual({ ok: true, changed: false });
    expect(f.writes).toHaveLength(1);
    const stored = JSON.parse(f.entries.get(key) ?? "{}");
    expect(stored.checked_at).toBe("2026-10-13T09:01:00.000Z");
    expect(stored.meetings.map((row: { id: string }) => row.id)).toEqual(["ff-newer"]);
  });

  test("a future checked_at is repaired from the current source observation", async () => {
    const f = kvFixture();
    const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`;
    const current = new Date().toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rows: PendingReconcileMeeting[] = [];
    f.seed(key, JSON.stringify({ version: 1, changed_at: future, checked_at: future, count: 0, meetings: [] }));
    const result = await writePendingReconcileSnapshot(f.kv, "transcriber", rows, current);
    expect(result).toEqual({ ok: true, changed: true });
    expect(JSON.parse(f.entries.get(key) ?? "{}").checked_at).toBe(current);
  });

  test("a corrupt v1 snapshot is replaced but another version is preserved", async () => {
    const f = kvFixture();
    const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/backend-ingest`;
    const rows = backendPendingRows("fireflies", [backendRow({ sourceId: "ff-repair" })]);
    f.seed(key, "{corrupted");
    const repaired = await writePendingReconcileSnapshot(f.kv, "backend-ingest", rows, "2026-10-13T09:00:00.000Z");
    expect(repaired).toEqual({ ok: true, changed: true });
    expect(JSON.parse(f.entries.get(key) ?? "{}").version).toBe(1);
    f.seed(key, JSON.stringify({ version: 2, payload: "newer format" }));
    const before = f.writes.length;
    const unsupported = await writePendingReconcileSnapshot(f.kv, "backend-ingest", rows, "2026-10-13T10:00:00.000Z");
    expect(unsupported).toEqual({ ok: false });
    expect(f.writes).toHaveLength(before);
    expect(JSON.parse(f.entries.get(key) ?? "{}").version).toBe(2);
  });


  test("does not write a listing after the active account changes during the read", async () => {
    let current = true;
    let writes = 0;
    const kv = {
      async get() {
        current = false;
        return { ok: false as const, error: { code: "KV_NOT_FOUND" } };
      },
      async put() {
        writes++;
        return { ok: true as const };
      },
    };
    const result = await writePendingReconcileSnapshot(
      kv,
      "backend-ingest",
      backendPendingRows("fireflies", [backendRow({ sourceId: "other-account" })]),
      "2026-10-13T09:00:00.000Z",
      () => current,
    );
    expect(result).toEqual({ ok: false });
    expect(writes).toBe(0);
  });


  test("stores sequential source projections independently", async () => {
    const f = kvFixture();
    await writePendingReconcileSnapshot(f.kv, "backend-ingest", backendPendingRows("fireflies", [backendRow({ sourceId: "ff-1" })]), "2026-10-13T09:00:00.000Z");
    await writePendingReconcileSnapshot(f.kv, "transcriber", transcriberPendingRows([
      { id: "ptx-1", status: "completed", created_at: "2026-10-03T00:00:00Z" },
    ] as TranscriberListRow[], []), "2026-10-13T09:00:30.000Z");
    const backend = JSON.parse(f.entries.get(`${PENDING_RECONCILE_SNAPSHOT_KEY}/backend-ingest`) ?? "{}");
    const transcriber = JSON.parse(f.entries.get(`${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`) ?? "{}");
    expect(backend.meetings.map((row: { id: string }) => row.id)).toEqual(["ff-1"]);
    expect(transcriber.meetings.map((row: { id: string }) => row.id)).toEqual(["ptx-1"]);
    expect(transcriber.count).toBe(1);
  });
});
