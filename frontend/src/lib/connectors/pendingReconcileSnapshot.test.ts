import { describe, expect, test } from "bun:test";
import type { ConnectorMeetingMeta } from "./meetingsApi";
import type { TranscriberListRow } from "../transcriberApi";
import {
  PENDING_RECONCILE_SNAPSHOT_KEY,
  backendPendingRows,
  transcriberPendingRows,
  writePendingReconcileSnapshot,
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
  const writes: Array<{ key: string; value: string }> = [];
  const kv = {
    async get(key: string) {
      const value = entries.get(key);
      return value === undefined
        ? { ok: false as const, error: { code: "KV_NOT_FOUND" } }
        : { ok: true as const, data: { data: value } };
    },
    async put(key: string, value: string) {
      entries.set(key, value);
      writes.push({ key, value });
      return { ok: true as const };
    },
  };
  return { entries, writes, kv };
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
    expect(transcriberPendingRows(rows, ["saved"])).toEqual([{
      id: "ptx-1",
      source: "transcriber",
      createdAt: "2026-10-03T00:00:00Z",
      completedAt: "2026-10-03T01:00:00Z",
      status: "completed",
      reconciled: false,
    }]);
  });

  test("serializes only the allowlisted metadata and writes only when a source projection changes", async () => {
    const f = kvFixture();
    const rows = backendPendingRows("fireflies", [backendRow({ sourceId: "ff-1", title: "PRIVATE_TITLE" })]);
    const first = await writePendingReconcileSnapshot(f.kv, "backend-ingest", rows, () => "2026-10-13T09:00:00.000Z");
    expect(first).toEqual({ ok: true, changed: true });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.key).toBe(PENDING_RECONCILE_SNAPSHOT_KEY);
    const serialized = f.writes[0]?.value ?? "";
    expect(serialized).not.toMatch(/title|participant|email|url|content|transcript|summary|error|PRIVATE_/i);
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      as_of: "2026-10-13T09:00:00.000Z",
      sources: {
        "backend-ingest": {
          as_of: "2026-10-13T09:00:00.000Z",
          count: 1,
          meetings: rows,
        },
      },
    });

    const unchanged = await writePendingReconcileSnapshot(f.kv, "backend-ingest", rows, () => "2026-10-13T09:00:30.000Z");
    expect(unchanged).toEqual({ ok: true, changed: false });
    expect(f.writes).toHaveLength(1);
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
      () => "2026-10-13T09:00:00.000Z",
      () => current,
    );
    expect(result).toEqual({ ok: false });
    expect(writes).toBe(0);
  });


  test("merges independent existing sync projections without dropping the other source", async () => {
    const f = kvFixture();
    await writePendingReconcileSnapshot(f.kv, "backend-ingest", backendPendingRows("fireflies", [backendRow({ sourceId: "ff-1" })]), () => "2026-10-13T09:00:00.000Z");
    await writePendingReconcileSnapshot(f.kv, "transcriber", transcriberPendingRows([
      { id: "ptx-1", status: "completed", created_at: "2026-10-03T00:00:00Z" },
    ] as TranscriberListRow[], []), () => "2026-10-13T09:00:30.000Z");
    const snapshot = JSON.parse(f.entries.get(PENDING_RECONCILE_SNAPSHOT_KEY) ?? "{}");
    expect(snapshot.sources["backend-ingest"].meetings.map((row: { id: string }) => row.id)).toEqual(["ff-1"]);
    expect(snapshot.sources.transcriber.meetings.map((row: { id: string }) => row.id)).toEqual(["ptx-1"]);
    expect(snapshot.sources.transcriber.count).toBe(1);
  });
});
