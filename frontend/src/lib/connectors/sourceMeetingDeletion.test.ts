import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  CONNECTORS_KV_PREFIX, clearDeletedMeetings, deleteSourceMeeting, deletedMeetingKvKey,
  isMeetingDeleted, meetingKvKey, transcriptKvKey, upsertMeeting,
} from "./connectorStore";

function fixture() {
  const entries = new Map<string, string>();
  const rows = new Map<string, string>();
  const calls: string[] = [];
  let markerError = false;
  let lateMarker = false;
  let cascadeError = false;
  let unknownCombined = false;
  const tcw = {
    kv: {
      async get(key: string) {
        calls.push(`get:${key}`);
        if (markerError) return { ok: false, error: { code: "KV_ERROR", message: "offline" } };
        return entries.has(key) ? { ok: true, data: { data: entries.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
      },
      async put(key: string, value: unknown) { calls.push(`put:${key}`); entries.set(key, String(value)); return { ok: true, data: undefined }; },
      async delete(key: string) { calls.push(`delete:${key}`); entries.delete(key); return { ok: true, data: undefined }; },
      async list({ path }: { path: string }) { return { ok: true, data: { keys: [...entries.keys()].filter((key) => key.startsWith(path)) } }; },
    },
    sql: { db: () => ({
      async query(sql: string) {
        calls.push(`query:${sql}`);
        if (sql.includes("sqlite_master")) return { ok: true, data: { rows: [["connector_meeting"], ["connector_state"]] } };
        if (sql.includes("exo-merged")) return cascadeError
          ? { ok: false, error: { code: "SQL_ERROR", message: "cascade failed" } }
          : { ok: true, data: { rows: unknownCombined ? [["combined-row", "combo-1", "{}"]] : [] } };
        return { ok: true, data: { rows: [] } };
      },
      async execute(sql: string, params: unknown[] = []) {
        calls.push(`execute:${sql}`);
        if (sql.startsWith("INSERT INTO connector_meeting")) {
          rows.set(String(params[1]) + "/" + String(params[2]), String(params[0]));
          if (lateMarker) entries.set(await deletedMeetingKvKey("google-meet", "record-1"), JSON.stringify({ v: 1, deleted_at: new Date().toISOString() }));
        }
        if (sql.startsWith("DELETE FROM connector_meeting")) rows.delete(String(params[0]) + "/" + String(params[1]));
        return { ok: true, data: { rows: [] } };
      },
    }) },
  } as unknown as TinyCloudWeb;
  return { tcw, entries, rows, calls, setMarkerError: () => { markerError = true; }, setLateMarker: () => { lateMarker = true; }, setCascadeError: () => { cascadeError = true; }, setUnknownCombined: () => { unknownCombined = true; } };
}

const meeting = { id: "row-1", source: "google-meet", sourceId: "record-1", title: "Meet", startedAt: null, durationSecs: null, organizerEmail: null, participants: [], summaryOverview: null, summaryActionItems: null, keywords: null, meetingType: null, metadata: {} };

describe("source-scoped deleted meetings", () => {
  test("hashes source ids, stores only version and deletion timestamp, and clears only that source", async () => {
    const f = fixture();
    const fireflies = await deletedMeetingKvKey("fireflies", "sensitive-id");
    expect(fireflies).toMatch(new RegExp(`^${CONNECTORS_KV_PREFIX}/fireflies/deleted/[a-f0-9]{64}$`));
    expect(fireflies).not.toContain("sensitive-id");
    f.rows.set("fireflies/sensitive-id", "row-2");
    f.entries.set(meetingKvKey("fireflies", "sensitive-id"), "{}");
    f.entries.set(transcriptKvKey("fireflies", "sensitive-id"), "[]");
    expect((await deleteSourceMeeting(f.tcw, "fireflies", "sensitive-id")).ok).toBe(true);
    expect(f.rows.has("fireflies/sensitive-id")).toBe(false);
    expect(f.entries.has(meetingKvKey("fireflies", "sensitive-id"))).toBe(false);
    expect(f.entries.has(transcriptKvKey("fireflies", "sensitive-id"))).toBe(false);
    expect(JSON.parse(f.entries.get(fireflies)!)).toEqual({ v: 1, deleted_at: expect.any(String) });
    expect(await isMeetingDeleted(f.tcw, "fireflies", "sensitive-id")).toEqual({ ok: true, data: true });
    const granola = await deletedMeetingKvKey("granola", "other-id");
    f.entries.set(granola, "{}");
    expect((await clearDeletedMeetings(f.tcw, "fireflies")).ok).toBe(true);
    expect(f.entries.has(fireflies)).toBe(false);
    expect(f.entries.has(granola)).toBe(true);
  });

  test("fails closed when marker read or combined cascade fails", async () => {
    const marker = fixture();
    marker.setMarkerError();
    expect((await deleteSourceMeeting(marker.tcw, "fireflies", "record-1")).ok).toBe(false);
    expect(marker.calls.some((call) => call.startsWith("put:"))).toBe(false);
    const cascade = fixture();
    cascade.rows.set("google-meet/record-1", "row-1");
    cascade.setCascadeError();
    expect((await deleteSourceMeeting(cascade.tcw, "google-meet", "record-1")).ok).toBe(false);
    expect(cascade.rows.has("google-meet/record-1")).toBe(true);
    const unknown = fixture();
    unknown.rows.set("fireflies/record-1", "row-2");
    unknown.setUnknownCombined();
    const result = await deleteSourceMeeting(unknown.tcw, "fireflies", "record-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("COMBINED_MEMBERS_UNKNOWN");
    expect(unknown.rows.has("fireflies/record-1")).toBe(true);
    expect(unknown.entries.has(await deletedMeetingKvKey("fireflies", "record-1"))).toBe(false);
  });

  test("marked Meet upsert writes no body or row and a late marker removes both", async () => {
    const marked = fixture();
    marked.entries.set(await deletedMeetingKvKey("google-meet", "record-1"), "{}");
    expect((await upsertMeeting(marked.tcw, meeting, [])).ok).toBe(false);
    expect(marked.calls.some((call) => call.startsWith("execute:INSERT") || call.startsWith("put:"))).toBe(false);
    const late = fixture();
    late.setLateMarker();
    const result = await upsertMeeting(late.tcw, meeting, []);
    expect(result.ok).toBe(false);
    expect(late.rows.has("google-meet/record-1")).toBe(false);
    expect(late.entries.has(transcriptKvKey("google-meet", "record-1"))).toBe(false);
  });
});
