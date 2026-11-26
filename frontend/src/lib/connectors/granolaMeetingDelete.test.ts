import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_KV_PREFIX, clearGranolaDeletedMeetings, deleteGranolaMeeting, granolaDeletedKvKey, isGranolaMeetingDeleted, meetingKvKey, purgeConnector, transcriptKvKey, upsertMeeting } from "./connectorStore";

function fixture() {
  const entries = new Map<string, string>();
  const rows = new Map<string, { source: string; sourceId: string }>();
  const calls: string[] = [];
  const combined = new Map<string, { sourceId: string; metadata: string }>();
  let getError = false;
  let queryError = false;
  const kv = {
    async get(key: string) {
      calls.push(`get:${key}`);
      if (getError) return { ok: false as const, error: { code: "KV_ERROR", message: "read failed" } };
      return entries.has(key) ? { ok: true as const, data: { data: entries.get(key) } } : { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async put(key: string, value: unknown) { calls.push(`put:${key}`); entries.set(key, String(value)); return { ok: true as const, data: undefined }; },
    async delete(key: string) { calls.push(`delete:${key}`); if (!entries.delete(key)) return { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } }; return { ok: true as const, data: undefined }; },
    async list({ path, cursor }: { path: string; cursor?: string }) {
      const keys = [...entries.keys()].filter((key) => key.startsWith(path)).sort();
      const start = Number(cursor ?? 0);
      return { ok: true as const, data: { keys: keys.slice(start, start + 1), ...(start + 1 < keys.length ? { nextCursor: String(start + 1), truncated: true } : {}) } };
    },
  };
  const db = {
    async query(sql: string) {
      calls.push(`query:${sql}`);
      if (queryError && sql.includes("exo-merged")) return { ok: false as const, error: { code: "SQL_ERROR", message: "read failed" } };
      if (sql.includes("sqlite_master")) return { ok: true as const, data: { rows: [["connector_meeting"], ["connector_state"]] } };
      if (sql.includes("exo-merged")) return { ok: true as const, data: { rows: [...combined].map(([id, row]) => [id, row.sourceId, row.metadata]) } };
      return { ok: true as const, data: { rows: [] } };
    },
    async execute(sql: string, params: unknown[] = []) {
      calls.push(`execute:${sql}`);
      if (sql.includes("source = 'exo-merged'")) combined.delete(String(params[0]));
      else if (sql.startsWith("DELETE FROM connector_meeting")) for (const [id, row] of rows) if (row.source === params[0] && row.sourceId === params[1]) rows.delete(id);
      return { ok: true as const, data: { rows: [] } };
    },
    async batch() { return { ok: true as const, data: { rows: [] } }; },
  };
  const tcw = { kv, sql: { db: () => db } } as unknown as TinyCloudWeb;
  return { tcw, entries, rows, combined, calls, setGetError: (v: boolean) => { getError = v; }, setQueryError: (v: boolean) => { queryError = v; } };
}

const meeting = { id: "row-1", source: "granola", sourceId: "m1", title: "Meeting", startedAt: null, durationSecs: null, organizerEmail: null, participants: [], summaryOverview: null, summaryActionItems: null, keywords: null, meetingType: null, metadata: {} };

describe("Granola meeting deletion", () => {
  test("marks first, deletes only the matching source and id, and tolerates missing KV on retry", async () => {
    const f = fixture();
    f.rows.set("g", { source: "granola", sourceId: "m1" });
    f.rows.set("other", { source: "fireflies", sourceId: "m1" });
    f.rows.set("second", { source: "granola", sourceId: "m2" });
    f.entries.set(meetingKvKey("granola", "m1"), "{}");
    f.entries.set(transcriptKvKey("granola", "m1"), "[]");
    expect((await deleteGranolaMeeting(f.tcw, "granola", "m1")).ok).toBe(true);
    expect(f.calls.findIndex((call) => call.startsWith("put:"))).toBeLessThan(f.calls.findIndex((call) => call.startsWith("delete:")));
    expect(f.rows.has("g")).toBe(false);
    expect(f.rows.has("other")).toBe(true);
    expect(f.rows.has("second")).toBe(true);
    expect((await isGranolaMeetingDeleted(f.tcw, "m1"))).toEqual({ ok: true, data: true });
    expect((await deleteGranolaMeeting(f.tcw, "granola", "m1")).ok).toBe(true);
  });

  test("cascade read failure leaves the member data intact", async () => {
    const f = fixture();
    f.rows.set("g", { source: "granola", sourceId: "m1" });
    f.setQueryError(true);
    expect((await deleteGranolaMeeting(f.tcw, "granola", "m1")).ok).toBe(false);
    expect(f.rows.has("g")).toBe(true);
    expect(f.calls.some((call) => call.startsWith("execute:DELETE"))).toBe(false);
  });

  test("marker read failure blocks upsert and invalid ids cannot escape the prefix", async () => {
    const f = fixture();
    f.setGetError(true);
    expect((await upsertMeeting(f.tcw, meeting, [])).ok).toBe(false);
    expect(f.calls.some((call) => call.startsWith("put:"))).toBe(false);
    expect((await deleteGranolaMeeting(f.tcw, "granola", "../m1")).ok).toBe(false);
    f.calls.length = 0;
    expect((await deleteGranolaMeeting(f.tcw, "fireflies", "m1")).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test("marked meetings reject upsert without writing their body", async () => {
    const f = fixture();
    f.entries.set(granolaDeletedKvKey("m1"), JSON.stringify({ v: 1, deleted_at: new Date().toISOString() }));
    const result = await upsertMeeting(f.tcw, meeting, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("GRANOLA_MEETING_DELETED");
    expect(f.calls.some((call) => call.startsWith("put:"))).toBe(false);
  });

  test("purge retains markers and clear removes paginated markers", async () => {
    const f = fixture();
    f.entries.set(granolaDeletedKvKey("m1"), "{}");
    f.entries.set(granolaDeletedKvKey("m2"), "{}");
    expect((await purgeConnector(f.tcw, "granola")).ok).toBe(true);
    expect(f.entries.has(granolaDeletedKvKey("m1"))).toBe(true);
    expect((await clearGranolaDeletedMeetings(f.tcw)).ok).toBe(true);
    expect([...f.entries.keys()].filter((key) => key.startsWith(`${CONNECTORS_KV_PREFIX}/granola/deleted/`))).toEqual([]);
  });
  test("removes a combined meeting listing the deleted member", async () => {
    const f = fixture();
    f.combined.set("combo", { sourceId: "c1", metadata: JSON.stringify({ merge: { members: [{ source: "granola", source_id: "m1" }] } }) });
    f.rows.set("g", { source: "granola", sourceId: "m1" });
    expect((await deleteGranolaMeeting(f.tcw, "granola", "m1")).ok).toBe(true);
    expect(f.combined.has("combo")).toBe(false);
    expect(f.rows.has("g")).toBe(false);
  });

  test("unknown combined members block deletion and preserve the member", async () => {
    const f = fixture();
    f.combined.set("combo", { sourceId: "c1", metadata: "{}" });
    f.rows.set("g", { source: "granola", sourceId: "m1" });
    const result = await deleteGranolaMeeting(f.tcw, "granola", "m1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("COMBINED_MEMBERS_UNKNOWN");
    expect(f.rows.has("g")).toBe(true);
  });
});
