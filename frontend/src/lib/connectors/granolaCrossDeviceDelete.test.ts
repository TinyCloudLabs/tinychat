import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { granolaDeletedKvKey, meetingKvKey, transcriptKvKey, upsertMeeting } from "./connectorStore";

const meeting = { id: "row-1", source: "granola", sourceId: "m1", title: "Meeting", startedAt: null, durationSecs: null, organizerEmail: null, participants: [], summaryOverview: null, summaryActionItems: null, keywords: null, meetingType: null, metadata: {} };

// A second device deletes the meeting between this device's marker read and its write: the marker is
// absent on the first read and present on the next.
function raceSpace(markerAppearsOnRead: number) {
  const entries = new Map<string, string>();
  const calls: string[] = [];
  const executed: string[] = [];
  let markerReads = 0;
  let markerKey = "";
  const kv = {
    async get(key: string) {
      if (key === markerKey) {
        markerReads++;
        if (markerReads >= markerAppearsOnRead) return { ok: true as const, data: { data: "{}" } };
        return { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } };
      }
      return entries.has(key) ? { ok: true as const, data: { data: entries.get(key) } } : { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async put(key: string, value: unknown) { calls.push(`put:${key}`); entries.set(key, String(value)); return { ok: true as const, data: undefined }; },
    async delete(key: string) { calls.push(`delete:${key}`); entries.delete(key); return { ok: true as const, data: undefined }; },
    async list() { return { ok: true as const, data: { keys: [] } }; },
  };
  const db = {
    async query(sql: string) {
      if (sql.includes("sqlite_master")) return { ok: true as const, data: { rows: [["connector_meeting"], ["connector_state"]] } };
      return { ok: true as const, data: { rows: [] } };
    },
    async execute(sql: string) { executed.push(sql); return { ok: true as const, data: { rows: [] } }; },
    async batch() { return { ok: true as const, data: { rows: [] } }; },
  };
  const tcw = { kv, sql: { db: () => db } } as unknown as TinyCloudWeb;
  return { tcw, calls, executed, setMarkerKey: (key: string) => { markerKey = key; } };
}

describe("Granola write racing a delete on another device", () => {
  test("a marker that appears after the write removes what was written", async () => {
    const f = raceSpace(2);
    f.setMarkerKey(await granolaDeletedKvKey("m1"));
    const result = await upsertMeeting(f.tcw, meeting, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("GRANOLA_MEETING_DELETED");
    expect(f.calls).toContain(`delete:${meetingKvKey("granola", "m1")}`);
    expect(f.calls).toContain(`delete:${transcriptKvKey("granola", "m1")}`);
    expect(f.executed.some((sql) => sql.startsWith("DELETE FROM connector_meeting"))).toBe(true);
  });

  test("with no marker on either read the write stands and nothing is removed", async () => {
    const f = raceSpace(99);
    f.setMarkerKey(await granolaDeletedKvKey("m1"));
    const result = await upsertMeeting(f.tcw, meeting, []);
    expect(result.ok).toBe(true);
    expect(f.calls.some((call) => call.startsWith("delete:"))).toBe(false);
    expect(f.executed.some((sql) => sql.startsWith("DELETE FROM connector_meeting"))).toBe(false);
  });
});
