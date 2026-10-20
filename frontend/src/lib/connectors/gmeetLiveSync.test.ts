// What a reload must not lose while a Notes sync runs: the live count of saved meetings, the run's
// log, and the checkpoint the next page load reads back as "interrupted". All on fakes; two accounts.
import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { GmeetDriveProgress, NormalizedMeeting, StoreResult } from "./connectorStore";
import { describeGmeetInterrupted, readGmeetInterrupted } from "./gmeetInterrupted";
import { getGmeetMeetingCount, resetGmeetMeetingCountsForTests } from "./gmeetLiveCount";
import { _resetGmeetSyncSingleFlightForTests, getGmeetRunLog, isGmeetSyncInFlight, syncGoogleMeet, type GmeetSyncClient, type GmeetSyncStore } from "./gmeetSync";
import { readStoredGmeetSyncLog, startPersistingGmeetRunLog } from "./gmeetSyncLogStore";

const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });
const ALICE = { did: "did:pkh:eip155:1:0xalice" } as unknown as TinyCloudWeb;
const BOB = { did: "did:pkh:eip155:1:0xbob" } as unknown as TinyCloudWeb;
const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const DOC_MIME = "application/vnd.google-apps.document";

class MemoryStorage {
  items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
}
const asStorage = (storage: MemoryStorage) => storage as unknown as Storage;

/** One account's space: its meeting rows and its single checkpoint. */
function space(notes: number) {
  const rows = new Set<string>();
  let checkpoint: GmeetDriveProgress | null = null;
  const store = {
    async getConnection() { return ok({ connectorId: "google-meet" as const, status: "connected" as const, lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null, itemCount: 0 }); },
    async putTranscriptBody() { return ok(undefined); },
    async upsertMeeting(_: TinyCloudWeb, meeting: NormalizedMeeting) {
      const inserted = !rows.has(meeting.sourceId);
      rows.add(meeting.sourceId);
      return ok({ id: meeting.id, inserted, createdAt: "created-at" });
    },
    async updateSyncState() { return ok(undefined); },
    async countMeetings() { return ok(rows.size); },
    async getDriveCursor() { return ok("old-cursor"); },
    async putDriveCursor() { return ok(undefined); },
    async findGmeetNotesAssociation() { return ok(null); },
    async attachGmeetNotes() { return ok(undefined); },
    async removeGmeetNotes() { return ok(undefined); },
    async loadGmeetNotesIndex() { return ok({ size: 0, find: () => null }); },
    async getDriveProgress() { return ok(checkpoint); },
    async putDriveProgress(_: TinyCloudWeb, _source: string, progress: GmeetDriveProgress | null) { checkpoint = progress; return ok(undefined); },
  } as unknown as GmeetSyncStore;
  const gate = Promise.withResolvers<void>();
  const client = {
    delayMs: 0,
    async pace() {},
    async listConferenceRecords() { return ok([]); },
    async listParticipants() { return ok([]); },
    async listTranscripts() { return ok([]); },
    async listTranscriptEntries() { return ok([]); },
    async getDriveStartPageToken() { return ok("next-cursor"); },
    async listDriveFiles() {
      return ok(Array.from({ length: notes }, (_, i) => ({ id: `notes-${i}`, name: "Notes by Gemini", mimeType: DOC_MIME, modifiedTime: "2026-10-01T00:00:00.000Z" })));
    },
    async listDriveChangesPage() { return ok({ changes: [], nextPageToken: null, newStartPageToken: "next-cursor" }); },
    async getDriveDocument(id: string) {
      // The run stays here, as a page reload would leave it: 12 Notes read, 10 of them checkpointed.
      if (id === "notes-12") await gate.promise;
      return ok({ title: "Notes by Gemini", tabs: [{ tabProperties: { title: "Meeting notes" }, documentTab: { body: { content: [
        { paragraph: { paragraphStyle: { namedStyleType: "HEADING_3" }, elements: [{ textRun: { content: "Summary\n" } }] } },
        { paragraph: { elements: [{ textRun: { content: "Saved synthetic Notes.\n" } }] } },
      ] } } }] });
    },
  } as unknown as GmeetSyncClient;
  return { store, client, gate, rows: () => rows.size, checkpoint: () => checkpoint };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 20_000 && !condition(); i++) await Promise.resolve();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  _resetGmeetSyncSingleFlightForTests();
  resetGmeetMeetingCountsForTests();
});

describe("a Notes sync that has not settled", () => {
  test("the saved-meeting count follows every saved Note, without waiting for a checkpoint or for the run to settle", async () => {
    const a = space(25);
    const foreground = syncGoogleMeet({ client: a.client, store: a.store, tcw: ALICE, driveMode: "snapshot", deferNotes: true, now: () => NOW_MS });
    await until(() => (getGmeetMeetingCount(ALICE) ?? 0) >= 12);
    expect(getGmeetMeetingCount(ALICE)).toBe(12); // 12 Notes are saved (10 of them checkpointed); the run has not settled.
    a.gate.resolve();
    await foreground;
    await until(() => !isGmeetSyncInFlight());
    expect(getGmeetMeetingCount(ALICE)).toBe(25);
  });

  test("a run a reload kills leaves its log and an interrupted checkpoint", async () => {
    const storage = new MemoryStorage();
    const stop = startPersistingGmeetRunLog(ALICE, { storage: asStorage(storage) });
    const a = space(25);
    void syncGoogleMeet({ client: a.client, store: a.store, tcw: ALICE, driveMode: "snapshot", deferNotes: true, now: () => NOW_MS });
    await until(() => a.rows() >= 12);
    // No timer ran and the run never ended: this is exactly what a reload at 12 Notes leaves behind.
    const log = readStoredGmeetSyncLog(ALICE.did, asStorage(storage));
    expect(log?.notesOutcome).toBeNull(); // The Notes reconcile has not settled.
    expect(log?.timeline.some((entry) => entry.stage === "notes" && (entry.notesDone ?? 0) >= 10)).toBe(true);
    expect(log?.diagnostics).toMatchObject({ drive_checkpoint_writes: 1 });
    const interrupted = await readGmeetInterrupted(ALICE, a.store.getDriveProgress!, () => NOW_MS);
    expect(interrupted).toEqual({ done: 10, total: 25 });
    expect(describeGmeetInterrupted(interrupted!)).toBe("A Notes sync was interrupted at 10/25. Sync now resumes it.");
    stop();
    a.gate.resolve();
  });

  test("a checkpoint older than a day, or none, is not reported as interrupted", async () => {
    const a = space(25);
    void syncGoogleMeet({ client: a.client, store: a.store, tcw: ALICE, driveMode: "snapshot", deferNotes: true, now: () => NOW_MS });
    await until(() => a.rows() >= 12);
    expect(await readGmeetInterrupted(ALICE, a.store.getDriveProgress!, () => NOW_MS + 25 * 3_600_000)).toBeNull();
    expect(await readGmeetInterrupted(BOB, space(0).store.getDriveProgress!, () => NOW_MS)).toBeNull();
    a.gate.resolve();
  });
});

describe("one account's run is nothing to another account (TC-1376)", () => {
  test("count, log and interrupted checkpoint stay with the account that ran", async () => {
    const storage = new MemoryStorage();
    const stopAlice = startPersistingGmeetRunLog(ALICE, { storage: asStorage(storage) });
    const stopBob = startPersistingGmeetRunLog(BOB, { storage: asStorage(storage) });
    const a = space(25);
    const b = space(0);
    void syncGoogleMeet({ client: a.client, store: a.store, tcw: ALICE, driveMode: "snapshot", deferNotes: true, now: () => NOW_MS });
    await until(() => (getGmeetMeetingCount(ALICE) ?? 0) >= 12);

    expect(getGmeetMeetingCount(ALICE)).toBe(12);
    expect(getGmeetMeetingCount(BOB)).toBeNull();
    expect(readStoredGmeetSyncLog(ALICE.did, asStorage(storage))).not.toBeNull();
    expect(readStoredGmeetSyncLog(BOB.did, asStorage(storage))).toBeNull();
    expect(getGmeetRunLog(BOB)).toBeNull();
    // Each account reads its own space's checkpoint: Bob's space has none.
    expect(await readGmeetInterrupted(ALICE, a.store.getDriveProgress!, () => NOW_MS)).not.toBeNull();
    expect(await readGmeetInterrupted(BOB, b.store.getDriveProgress!, () => NOW_MS)).toBeNull();
    stopAlice();
    stopBob();
    a.gate.resolve();
  });
});
