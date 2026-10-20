// The Meeting sources window after a manual Sync now (TC-1481 stage 5), rendered from the real
// MeetingSourcesDialog over a fake Google and a fake store (no account, no node). The press is the
// function the Sync now button calls (`runGmeetSyncNow`), driven here without the vault: the real
// engine runs it, hands the 26 Notes to the background, and the window shows what the engine says.
//
//   gmeet-sync-now-running   the press has returned; 12 of 26 Notes are saved, the rest are still running
//   gmeet-sync-now-finished  the background run has ended: 27 meetings, the earlier failure gone
//   gmeet-sync-now-before    the window as the earlier timed-out runs left it, before the press
import { useEffect, useRef, useState } from "react";

import { MeetingSourcesDialog } from "@/capture/meetingSources/MeetingSourcesDialog";
import { runGmeetSyncNow } from "@/chat/ConnectorsCard";
import { getGmeetLiveStatus, onGmeetNotesSettled, type GmeetSyncClient, type GmeetSyncStore } from "@/lib/connectors/gmeetSync";
import { publishGmeetMeetingCount } from "@/lib/connectors/gmeetLiveCount";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { HarnessScreen } from "../screen";
import { harnessSessionStore, harnessTcw, HARNESS_DID } from "../stubs";

const DOC_MIME = "application/vnd.google-apps.document";
const NOTES = 26;
const HOLD_AT = 12;

interface FakeConnection {
  status: "connected";
  lastSyncedAt: string;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  itemCount: number;
}

interface FakeSpace {
  connection: FakeConnection;
  meetings: Set<string>;
  cursor: string | null;
  checkpoint: { startToken: string; doneIds: string[]; savedAt: string } | null;
}

const ok = <T,>(data: T) => ({ ok: true as const, data });

function notesDocument() {
  return { title: "Notes by Gemini", tabs: [
    { tabProperties: { title: "Meeting notes" }, documentTab: { body: { content: [
      { paragraph: { paragraphStyle: { namedStyleType: "HEADING_3" }, elements: [{ textRun: { content: "Summary\n" } }] } },
      { paragraph: { elements: [{ textRun: { content: "Saved synthetic Notes.\n" } }] } },
    ] } } },
  ] };
}

function fakeSpace(): FakeSpace {
  return {
    // What two timed-out foreground runs left behind: the watermark from connecting, 14 minutes ago.
    connection: {
      status: "connected",
      lastSyncedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
      lastSyncStatus: "error",
      lastSyncError: "Syncing Google Meet notes from Drive timed out. Saved meetings are kept. Retry to finish syncing.",
      itemCount: 0,
    },
    meetings: new Set(),
    cursor: null,
    checkpoint: null,
  };
}

/** The window's own reads (connection row, meeting count) answered from the fake space. */
function fakeTcw(space: FakeSpace): TinyCloudWeb {
  // The harness stub answers any SDK member; Reflect.get reads it untyped.
  const stubSql: { db: (name: string) => object } = Reflect.get(harnessTcw, "sql");
  const stubDb = stubSql.db("connectors");
  const db = new Proxy(stubDb, {
    get(target, key) {
      if (key !== "query") return Reflect.get(target, key);
      return async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM connector_state")) {
          if (params[0] !== "google-meet") return ok({ rows: [] });
          const c = space.connection;
          return ok({ rows: [["google-meet", c.status, c.lastSyncedAt, c.lastSyncStatus, c.lastSyncError, c.itemCount]] });
        }
        if (sql.includes("COUNT(*) FROM connector_meeting")) return ok({ rows: [[space.meetings.size]] });
        return ok({ rows: [] });
      };
    },
  });
  return new Proxy(harnessTcw as object, {
    get(target, key) {
      if (key === "sql") return { db: () => db };
      return Reflect.get(target, key);
    },
  }) as unknown as TinyCloudWeb;
}

function fakeStore(space: FakeSpace): GmeetSyncStore {
  return {
    async getConnection() { return ok({ connectorId: "google-meet" as const, ...space.connection }); },
    async putTranscriptBody() { return ok(undefined); },
    async upsertMeeting(_tcw: TinyCloudWeb, meeting: { id: string; sourceId: string }) {
      const inserted = !space.meetings.has(meeting.sourceId);
      space.meetings.add(meeting.sourceId);
      return ok({ id: meeting.id, inserted, createdAt: "created-at" });
    },
    async updateSyncState(_tcw: TinyCloudWeb, input: { lastSyncedAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null; itemCount: number }) {
      space.connection = {
        status: "connected",
        lastSyncedAt: input.lastSyncedAt ?? space.connection.lastSyncedAt,
        lastSyncStatus: input.lastSyncStatus,
        lastSyncError: input.lastSyncError,
        itemCount: input.itemCount,
      };
      return ok(undefined);
    },
    async countMeetings() { return ok(space.meetings.size); },
    async getDriveCursor() { return ok(space.cursor); },
    async putDriveCursor(_tcw: TinyCloudWeb, _source: string, cursor: string) { space.cursor = cursor; return ok(undefined); },
    async findGmeetNotesAssociation() { return ok(null); },
    async attachGmeetNotes() { return ok(undefined); },
    async removeGmeetNotes() { return ok(undefined); },
    async loadGmeetNotesIndex() { return ok({ size: 0, find: () => null }); },
    async getDriveProgress() { return ok(space.checkpoint); },
    async putDriveProgress(_tcw: TinyCloudWeb, _source: string, progress: FakeSpace["checkpoint"]) { space.checkpoint = progress; return ok(undefined); },
  } as unknown as GmeetSyncStore;
}

/** A Google with one Meet record and 26 Notes; reads past `holdAt` never answer (the run stays in flight). */
function fakeGoogle(holdAt: number | null): GmeetSyncClient {
  const recordName = "conferenceRecords/rec-0";
  const transcriptName = `${recordName}/transcripts/t1`;
  const speaker = `${recordName}/participants/p1`;
  const never = new Promise<never>(() => {});
  return {
    delayMs: 0,
    async pace() {},
    async listConferenceRecords() {
      return ok([{ name: recordName, startTime: "2026-10-05T09:00:00.000Z", endTime: "2026-10-05T09:30:00.000Z", space: "spaces/standing-room" }]);
    },
    async listParticipants() { return ok([{ name: speaker, signedinUser: { user: "people/1", displayName: "Alice" } }]); },
    async listTranscripts() { return ok([{ name: transcriptName, state: "ENDED" }]); },
    async listTranscriptEntries() {
      return ok([{ name: `${transcriptName}/entries/0`, participant: speaker, text: "Saved synthetic transcript", languageCode: "en-US", startTime: "2026-10-05T09:00:00.000Z", endTime: "2026-10-05T09:00:05.000Z" }]);
    },
    async getDriveStartPageToken() { return ok("next-cursor"); },
    async listDriveFiles() {
      return ok(Array.from({ length: NOTES }, (_, i) => ({ id: `notes-${i}`, name: "Notes by Gemini", mimeType: DOC_MIME, modifiedTime: "2026-10-01T00:00:00.000Z" })));
    },
    async listDriveChangesPage() { return ok({ changes: [], nextPageToken: null, newStartPageToken: "next-cursor" }); },
    async getDriveDocument(id: string) {
      if (holdAt !== null && Number(id.slice("notes-".length)) >= holdAt) await never;
      return ok(notesDocument());
    },
  } as unknown as GmeetSyncClient;
}

const mintFetch = (async () => new Response(JSON.stringify({ access_token: "harness-access" }), { status: 200 })) as unknown as typeof fetch;

type Phase = "before" | "running" | "finished";

function GmeetSyncNowFixture({ phase }: { phase: Phase }) {
  const [space] = useState(fakeSpace);
  const [tcw] = useState(() => fakeTcw(space));
  const [ready, setReady] = useState(phase === "before");
  const started = useRef(false);

  useEffect(() => {
    if (phase === "before" || started.current) return;
    started.current = true;
    let cancelled = false;
    const markReady = () => { window.setTimeout(() => { if (!cancelled) setReady(true); }, 500); };
    const off = onGmeetNotesSettled(markReady);
    // The count the window reads on open: the rows saved so far.
    publishGmeetMeetingCount(tcw, space.meetings.size);
    void runGmeetSyncNow({
      tcw, backendUrl: window.location.origin, sessionStore: harnessSessionStore, refreshToken: "harness-refresh",
      driveMode: "auto", signal: new AbortController().signal, onProgress: () => {},
      deps: { store: fakeStore(space), fetchImpl: mintFetch, createClient: () => fakeGoogle(phase === "running" ? HOLD_AT : null), mintRetryDelayMs: 0 },
    });
    if (phase === "running") {
      const poll = window.setInterval(() => {
        if (getGmeetLiveStatus(tcw).progress?.notesDone === HOLD_AT) { window.clearInterval(poll); markReady(); }
      }, 50);
      return () => { cancelled = true; off(); window.clearInterval(poll); };
    }
    return () => { cancelled = true; off(); };
  }, [phase, space, tcw]);

  return (
    <div data-gmeet-harness={ready ? "ready" : "pending"} data-did={HARNESS_DID}>
      <MeetingSourcesDialog open onOpenChange={() => {}} tcw={tcw} backendUrl={window.location.origin} sessionStore={harnessSessionStore} />
    </div>
  );
}

function screen(name: Phase): HarnessScreen {
  return {
    id: `meeting-sources-gmeet-sync-now-${name}`,
    group: "meetingSources",
    layout: "pane",
    path: "/chat/connectors",
    platform: "web",
    readyWhen: `[data-gmeet-harness="ready"] [data-source="google-meet"] .ms-status`,
    render: () => <GmeetSyncNowFixture phase={name} />,
  };
}

export const meetingSourcesGmeetScreens: HarnessScreen[] = [screen("before"), screen("running"), screen("finished")];
