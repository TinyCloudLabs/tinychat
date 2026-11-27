import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { NormalizedMeeting, StoreResult, UpsertMeetingOutcome } from "./connectorStore";
import type { GranolaNote, GranolaNotePage } from "./granolaClient";
import { importGranolaCsv, type GranolaCsvImportStore } from "./granolaCsvImport";
import { syncGranola, type GranolaSyncClient, type GranolaSyncStore } from "./granolaSync";

const tcw = {} as TinyCloudWeb;
const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });
const deleted = { ok: false as const, error: { code: "GRANOLA_MEETING_DELETED", message: "deleted meeting" } };

function csvStore(failId: string, failure: StoreResult<UpsertMeetingOutcome> = deleted) {
  const written: string[] = [];
  const store: GranolaCsvImportStore = {
    async ensureSchema() { return ok(undefined); },
    async upsertMeeting(_tcw, meeting) {
      if (meeting.sourceId === failId) return failure;
      written.push(meeting.sourceId);
      return ok({ id: meeting.id, inserted: true, createdAt: "2026-11-10T00:00:00Z" });
    },
  };
  return { store, written };
}

test("CSV import skips a marked meeting and imports the other row", async () => {
  const { store, written } = csvStore("not_removed");
  const result = await importGranolaCsv({
    tcw, store, checkPurge: async () => false,
    text: "Note ID,Title,Created,Summary\nnot_removed,Removed,2026-11-10,Text\nnot_kept,Kept,2026-11-11,Text",
  });
  expect(result).toMatchObject({ ok: true, data: { added: 1, skippedDeleted: 1, failed: 0 } });
  expect(written).toEqual(["not_kept"]);
});

test("CSV import treats a marker read failure as a storage failure", async () => {
  const { store, written } = csvStore("not_removed", { ok: false, error: { code: "KV_UNAVAILABLE", message: "read failed" } });
  const result = await importGranolaCsv({
    tcw, store, checkPurge: async () => false,
    text: "Note ID,Title,Created,Summary\nnot_removed,Removed,2026-11-10,Text\nnot_kept,Kept,2026-11-11,Text",
  });
  expect(result).toMatchObject({ ok: false, error: { kind: "storage" }, partial: { added: 0, failed: 1 } });
  expect(written).toEqual([]);
});

function syncSetup(failure: StoreResult<UpsertMeetingOutcome>) {
  const id = "not_removed";
  const note = {
    id, title: "Meeting", owner: null,
    created_at: "2026-11-10T14:00:00Z", updated_at: "2026-11-10T15:00:00Z", deleted_at: null,
    web_url: "https://example.invalid/note", calendar_event: null, attendees: [],
    folder_membership: [], space_membership: [], summary_text: "Summary", summary_markdown: null,
    attachment_count: 0,
  } as GranolaNote;
  const page: GranolaNotePage = { notes: [note], hasMore: false, cursor: null };
  const client: GranolaSyncClient = {
    delayMs: 0,
    async listNotes() { return { ok: true, data: page }; },
    async getNote() { return { ok: true, data: note }; },
    async getTranscript() { return { ok: true, data: { items: [], truncated: false } }; },
  };
  const written: string[] = [];
  const store: GranolaSyncStore = {
    async ensureSchema() { return ok(undefined); },
    async listMeetingMetadataValues() { return ok({}); },
    async getConnection() { return ok({ status: "connected" as const, lastSyncedAt: null }); },
    async upsertMeeting(_tcw, meeting: NormalizedMeeting) { written.push(meeting.sourceId); return failure; },
    async countMeetings() { return ok(0); },
    async updateSyncState() { return ok(undefined); },
  };
  return { client, store, written };
}

test("Granola API sync counts a marked meeting as skipped", async () => {
  const { client, store, written } = syncSetup(deleted);
  const result = await syncGranola({ client, store, tcw, checkPurge: async () => false });
  expect(result).toMatchObject({ ok: true, data: { added: 0, skipped: 1, errors: [] } });
  expect(written).toEqual(["not_removed"]);
});

test("Granola API sync reports a marker read failure and does not add the meeting", async () => {
  const { client, store } = syncSetup({ ok: false, error: { code: "KV_UNAVAILABLE", message: "read failed" } });
  const result = await syncGranola({ client, store, tcw, checkPurge: async () => false });
  expect(result).toMatchObject({ ok: true, data: { added: 0, skipped: 0, errors: ["not_removed: read failed"] } });
});
