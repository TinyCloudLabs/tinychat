import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { FirefliesTranscript } from "./firefliesClient";
import { syncFireflies, type SyncStore } from "./firefliesSync";
import type { StoreResult } from "./connectorStore";
import { syncGoogleMeet, type GmeetSyncStore } from "./gmeetSync";

const tcw = {} as TinyCloudWeb;
const ok = <T>(data: T) => ({ ok: true as const, data });
const offline = { ok: false as const, error: { code: "KV_ERROR", message: "marker read offline" } };
const transcript: FirefliesTranscript = {
  id: "meeting-1", title: "Weekly", date: "2026-08-16T09:00:00.000Z", duration: 30,
  organizer_email: null, speakers: [], meeting_attendees: [], sentences: [], summary: null,
};

function firefliesFixture(marker: (reads: number) => StoreResult<boolean>) {
  let reads = 0;
  const calls: string[] = [];
  const store = {
    async ensureSchema() { return ok(undefined); },
    async getConnection() { return ok({ status: "connected" as const, lastSyncedAt: null }); },
    async listKnownSourceIds() { return ok([]); },
    async listTranscriptBodyIds() { return ok(new Set<string>()); },
    async isMeetingDeleted() { calls.push("marker"); return marker(++reads); },
    async insertMeeting() { calls.push("insert"); return ok(true); },
    async putTranscriptBody() { calls.push("body"); return ok(undefined); },
    async deleteSourceMeeting() { calls.push("remove"); return ok(undefined); },
    async countMeetings() { return ok(0); },
    async updateSyncState() { return ok(undefined); },
  } as SyncStore;
  const client = {
    delayMs: 0,
    async listNewTranscriptIds() { return ok({ ids: ["meeting-1"], complete: true, nextSkip: 1, nextAnchor: "meeting-1", nextAnchorDate: null, nextPreviousNeighbor: null }); },
    async getTranscript() { return ok(transcript); },
  };
  return { calls, run: () => syncFireflies({ tcw, store, client }) };
}

function meetFixture(marker: (reads: number) => StoreResult<boolean>) {
  let reads = 0;
  const calls: string[] = [];
  const store = {
    async getConnection() { return ok(null); },
    async isMeetingDeleted() { calls.push("marker"); return marker(++reads); },
    async putTranscriptBody() { calls.push("body"); return ok(undefined); },
    async upsertMeeting() { calls.push("upsert"); return ok({ id: "row-1", inserted: true, createdAt: "now" }); },
    async deleteSourceMeeting() { calls.push("remove"); return ok(undefined); },
    async countMeetings() { return ok(0); },
    async updateSyncState() { return ok(undefined); },
  } as GmeetSyncStore;
  const recordName = "conferenceRecords/meeting-1";
  const transcriptName = `${recordName}/transcripts/t1`;
  const client = {
    delayMs: 0,
    async pace() {},
    async listConferenceRecords() { return ok([{ name: recordName, startTime: "2026-08-16T09:00:00.000Z", endTime: "2026-08-16T09:30:00.000Z", space: "spaces/room" }]); },
    async listParticipants() { calls.push("participants"); return ok([]); },
    async listTranscripts() { calls.push("transcripts"); return ok([{ name: transcriptName, state: "ENDED" }]); },
    async listTranscriptEntries() { calls.push("entries"); return ok([{ name: `${transcriptName}/entries/1`, participant: "", text: "Hello", languageCode: "en", startTime: "2026-08-16T09:01:00.000Z", endTime: "2026-08-16T09:02:00.000Z" }]); },
  };
  return { calls, run: () => syncGoogleMeet({ tcw, store, client, now: () => Date.parse("2026-08-17T12:00:00.000Z") }) };
}

describe("source deletion sync guards", () => {
  test("Fireflies counts a marked meeting as skipped without inserting SQL or KV", async () => {
    const f = firefliesFixture(() => ok(true));
    const result = await f.run();
    expect(result.ok && result.data.skipped).toBe(1);
    expect(f.calls).toEqual(["marker"]);
  });
  test("Fireflies marker read error fails closed before any insert or body write", async () => {
    const f = firefliesFixture(() => offline);
    const result = await f.run();
    expect(result.ok).toBe(false);
    expect(f.calls).toEqual(["marker"]);
  });
  test("Fireflies late marker removes row and body and counts skipped", async () => {
    const f = firefliesFixture((reads) => ok(reads === 3));
    const result = await f.run();
    expect(result.ok && result.data.skipped).toBe(1);
    expect(f.calls).toEqual(["marker", "insert", "marker", "body", "marker", "remove"]);
  });
  test("Meet marked conference skips without fetching or writing, and read errors fail closed", async () => {
    const marked = meetFixture(() => ok(true));
    const skipped = await marked.run();
    expect(skipped.ok && skipped.data?.skipped).toBe(1);
    expect(marked.calls).toEqual(["marker"]);
    const failed = meetFixture(() => offline);
    const failure = await failed.run();
    expect(failure.ok && failure.data?.failed).toBe(1);
    expect(failed.calls).toEqual(["marker"]);
  });
  test("Meet conference late marker removes row and body instead of counting created", async () => {
    const f = meetFixture((reads) => ok(reads === 3));
    const result = await f.run();
    expect(result.ok && result.data?.skipped).toBe(1);
    expect(f.calls).toEqual(["marker", "participants", "transcripts", "entries", "marker", "body", "upsert", "marker", "remove"]);
  });
});
