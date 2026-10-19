import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { CONNECTOR_SCHEMA } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PipelineTrackSummary } from "@/capture/pipeline/PipelineTrackSummary";
import { buildNotePipelineInput, type NotePipelineFacts } from "../voiceNotes/useNotePipeline";
import { spaceLaneSnapshot } from "../spaceWriteLane";

import { CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "./connectorStore.js";
import type { FirefliesSentence } from "./firefliesClient.js";
import {
  EXPLORER_MEETING_SOURCES,
  findMeetingId,
  listMeetings,
  listMeetingsRead,
  meetingSourceLabel,
  readMeetingAudio,
  readMeetingMetadata,
  readTranscript,
  transcriptCopyText,
  type MeetingAudioRead,
} from "./meetingExplorer.js";
import { notePipeline } from "../voiceNotes/notePipeline";
import { TRANSCRIPT_TABLE_DDL, VOICE_NOTE_INDEX_DDL } from "../voiceNotes/voiceNoteRows";

type SqlResult =
  | { ok: true; data: { rows: unknown[][] } }
  | { ok: true; data: Record<string, never> }
  | { ok: false; error: { code: string; message: string } };

type KvResult =
  | { ok: true; data: { data: unknown; headers: Record<string, string> } }
  | { ok: false; error: { code: string; message: string } };

interface SqlCall {
  db: string;
  sql: string;
  params: unknown[];
}

/** Minimal tcw stand-in: records what the explorer asked for, returns canned results. */
function fakeTcw(opts: { sql?: SqlResult; kv?: KvResult }) {
  const sqlCalls: SqlCall[] = [];
  const kvKeys: string[] = [];
  const tcw = {
    sql: {
      db(name: string) {
        return {
          async query(sql: string, params: unknown[] = []): Promise<SqlResult> {
            sqlCalls.push({ db: name, sql, params });
            return (
              opts.sql ?? { ok: true as const, data: { rows: [] as unknown[][] } }
            );
          },
        };
      },
    },
    kv: {
      async get(key: string): Promise<KvResult> {
        kvKeys.push(key);
        return (
          opts.kv ?? { ok: false as const, error: { code: "KV_NOT_FOUND", message: "no key" } }
        );
      },
    },
  };
  return { tcw: tcw as unknown as TinyCloudWeb, sqlCalls, kvKeys };
}

function realListingSpace() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE connector_meeting (
    id TEXT PRIMARY KEY, source TEXT, source_id TEXT, title TEXT, started_at TEXT,
    duration_secs REAL, metadata TEXT
  );
  CREATE TABLE voice_note_transcript (source_id TEXT PRIMARY KEY, outcome TEXT);`);
  const tcw = {
    sql: {
      db() {
        return {
          async query(sql: string, params: unknown[] = []) {
            try {
              return { ok: true as const, data: { rows: sqlite.query(sql).values(...(params as never[])) } };
            } catch (error) {
              return { ok: false as const, error: { code: "SQL_ERROR", message: String(error) } };
            }
          },
        };
      },
    },
  } as unknown as TinyCloudWeb;
  return { sqlite, tcw };
}

function pipelineFacts(id: string, rowMetadata: Record<string, unknown> | null): NotePipelineFacts {
  return {
    id,
    device: "web",
    online: true,
    saved: true,
    rowMetadata,
    localNote: null,
    native: null,
    capture: { finalizing: false, issue: null },
    pending: null,
    lane: spaceLaneSnapshot(),
    onDeviceStatus: null,
    transcriptSync: null,
    cloudJob: null,
    noteSync: { syncing: false, failed: false, skip: null, syncedAt: null, attempting: false },
  };
}

/**
 * A tcw whose storage surface throws instead of returning a Result — the
 * transport failing under the Result layer (SDK rejection, torn-down session).
 * `sync` throws from `sql.db()` itself, before any promise exists.
 */
function throwingTcw(mode: "async" | "sync" = "async") {
  const boom = () => {
    throw new Error("transport down");
  };
  return {
    sql: {
      db(_name: string) {
        if (mode === "sync") boom();
        return {
          query: async (): Promise<SqlResult> => boom(),
        };
      },
    },
    kv: {
      get: async (): Promise<KvResult> => boom(),
    },
  } as unknown as TinyCloudWeb;
}

function sentence(over: Partial<FirefliesSentence>): FirefliesSentence {
  return {
    index: 0,
    speaker_name: null,
    text: "hello",
    start_time: 0,
    end_time: 1,
    ...over,
  };
}

describe("listMeetings", () => {
  it("maps positional rows to MeetingListItem", async () => {
    const { tcw } = fakeTcw({
      sql: {
        ok: true,
        data: {
          rows: [
            ["row-1", "fireflies", "src-1", "Standup", "2026-08-01T10:00:00.000Z"],
            ["row-2", "fireflies", "src-2", "Retro", "2026-07-30T10:00:00.000Z"],
          ],
        },
      },
    });
    expect(await listMeetings(tcw)).toEqual([
      {
        id: "row-1",
        source: "fireflies",
        sourceId: "src-1",
        title: "Standup",
        startedAt: "2026-08-01T10:00:00.000Z",
        durationSecs: null,
      },
      {
        id: "row-2",
        source: "fireflies",
        sourceId: "src-2",
        title: "Retro",
        startedAt: "2026-07-30T10:00:00.000Z",
        durationSecs: null,
      },
    ]);
  });

  it("lists both sources in one merged list, each row labelled with its source", async () => {
    const { tcw } = fakeTcw({
      sql: {
        ok: true,
        data: {
          // As the DB hands them back: newest-first ACROSS the union, so the
          // two connectors interleave rather than grouping.
          rows: [
            ["row-1", "google-meet", "conf-1", "Design sync", "2026-08-16T09:00:00.000Z"],
            ["row-2", "fireflies", "src-2", "Standup", "2026-08-15T09:00:00.000Z"],
            ["row-3", "google-meet", "conf-3", "Retro", "2026-08-14T09:00:00.000Z"],
          ],
        },
      },
    });
    const meetings = await listMeetings(tcw);
    expect(meetings.map((m) => [m.source, m.sourceId])).toEqual([
      ["google-meet", "conf-1"],
      ["fireflies", "src-2"],
      ["google-meet", "conf-3"],
    ]);
  });

  it("queries the fully-resolved connectors db across every requested source", async () => {
    const { tcw, sqlCalls } = fakeTcw({ sql: { ok: true, data: { rows: [] } } });
    await listMeetings(tcw, ["otter", "granola"]);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].db).toBe(CONNECTORS_SQL_DB_NAME);
    expect(sqlCalls[0].params).toEqual(["otter", "granola"]);
  });

  it("defaults to fireflies, google-meet, the transcriber, exo local AND exo voice notes", async () => {
    const { tcw, sqlCalls } = fakeTcw({ sql: { ok: true, data: { rows: [] } } });
    await listMeetings(tcw);
    expect(sqlCalls.at(-1)?.params).toEqual(["fireflies", "google-meet", "tinycloud-transcriber", "exo-local", "exo-voice-note", "exo-upload", "exo-merged"]);
    expect(EXPLORER_MEETING_SOURCES).toEqual(["fireflies", "google-meet", "tinycloud-transcriber", "exo-local", "exo-voice-note", "exo-upload", "exo-merged"]);
  });

  it("runs no query at all for an empty source list", async () => {
    const { tcw, sqlCalls } = fakeTcw({ sql: { ok: true, data: { rows: [] } } });
    expect(await listMeetings(tcw, [])).toEqual([]);
    expect(sqlCalls).toEqual([]);
  });

  it("returns [] when the query fails (not connected / missing table)", async () => {
    const { tcw } = fakeTcw({
      sql: { ok: false, error: { code: "STORE_ERROR", message: "no such table: connector_meeting" } },
    });
    expect(await listMeetings(tcw)).toEqual([]);
  });

  it("returns [] when rows is undefined", async () => {
    const { tcw } = fakeTcw({ sql: { ok: true, data: {} } });
    expect(await listMeetings(tcw)).toEqual([]);
  });

  it("maps non-string title / started_at cells to null", async () => {
    const { tcw } = fakeTcw({
      sql: { ok: true, data: { rows: [["row-1", "fireflies", "src-1", null, 1723600000]] } },
    });
    expect(await listMeetings(tcw)).toEqual([
      { id: "row-1", source: "fireflies", sourceId: "src-1", title: null, startedAt: null, durationSecs: null },
    ]);
  });

  it("skips rows with a falsy id, source or source_id", async () => {
    const { tcw } = fakeTcw({
      sql: {
        ok: true,
        data: {
          rows: [
            ["", "fireflies", "src-1", "No id", null],
            [null, "fireflies", "src-2", "Null id", null],
            ["row-3", "fireflies", "", "No source id", null],
            ["row-4", "fireflies", null, "Null source id", null],
            // No source: the transcript key is (source, source_id), so this row
            // could never be expanded.
            ["row-5", "", "src-5", "No source", null],
            ["row-6", null, "src-6", "Null source", null],
            ["row-7", "google-meet", "conf-7", "Keeper", null],
          ],
        },
      },
    });
    expect(await listMeetings(tcw)).toEqual([
      {
        id: "row-7",
        source: "google-meet",
        sourceId: "conf-7",
        title: "Keeper",
        startedAt: null,
        durationSecs: null,
      },
    ]);
  });

  it("never throws on a rejected-shaped error result", async () => {
    const { tcw } = fakeTcw({
      sql: { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "unauthorized" } },
    });
    await expect(listMeetings(tcw)).resolves.toEqual([]);
  });

  it("returns [] when the query rejects instead of returning a Result", async () => {
    await expect(listMeetings(throwingTcw())).resolves.toEqual([]);
  });

  it("returns [] when resolving the db throws synchronously", async () => {
    await expect(listMeetings(throwingTcw("sync"))).resolves.toEqual([]);
  });
});

describe("listMeetingsRead", () => {
  it("reads duration_secs, and only a number counts", async () => {
    const { tcw, sqlCalls } = fakeTcw({
      sql: {
        ok: true,
        data: {
          rows: [
            ["row-1", "exo-voice-note", "rec-1", "Voice note", "2026-10-06T09:28:00.000Z", 42],
            ["row-2", "fireflies", "src-2", "Standup", "2026-10-05T14:00:00.000Z", "1880"],
          ],
        },
      },
    });
    const read = await listMeetingsRead(tcw);
    expect(read.status).toBe("ok");
    expect(read.status === "ok" && read.meetings.map((m) => m.durationSecs)).toEqual([42.5, null]);
    expect(sqlCalls.at(-1)?.sql).toContain("duration_secs");
  });

  it("carries voice-note pipeline metadata from the listing only for voice notes", async () => {
    const projectedMetadata = JSON.stringify({
      transcription_outcome: "transcribed",
      note_kv_key: "recording-note.md",
      note_edited_at: "2026-10-11T10:00:00.000Z",
      audio_kv_key: "voice/audio",
      audio_stored: 1,
    });
    const { tcw } = fakeTcw({
      sql: { ok: true, data: { rows: [
        ["row-voice", "exo-voice-note", "rec-1", null, "2026-10-11T10:00:00.000Z", 42, projectedMetadata],
        ["row-meeting", "fireflies", "src-1", "Standup", "2026-10-10T10:00:00.000Z", 180, null],
        ["row-no-metadata", "exo-voice-note", "rec-2", null, "2026-10-09T10:00:00.000Z", 42, null],
        ["row-invalid-metadata", "exo-voice-note", "rec-3", null, "2026-10-08T10:00:00.000Z", 42, "invalid"],
      ] } },
    });

    const read = await listMeetingsRead(tcw);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.meetings[0]?.metadata).toEqual({
      transcription_outcome: "transcribed",
      note_kv_key: "recording-note.md",
      note_edited_at: "2026-10-11T10:00:00.000Z",
      audio_kv_key: "voice/audio",
      audio_stored: 1,
    });
    expect(read.meetings[0]?.metadata).not.toHaveProperty("transcript_text");
    expect(read.meetings[1]).toMatchObject({
      id: "row-meeting",
      source: "fireflies",
      sourceId: "src-1",
      title: "Standup",
      startedAt: "2026-10-10T10:00:00.000Z",
      durationSecs: 180,
    });
    expect(read.meetings[1]?.metadata).toBeUndefined();
    expect(read.meetings[2]?.metadata).toBeNull();
    expect(read.meetings[3]?.metadata).toBeUndefined();
  });
  it("resolves legacy transcript evidence and commit outcomes in the real listing SQL without loading bodies", async () => {
    const { sqlite, tcw } = realListingSpace();
    sqlite.query("INSERT INTO connector_meeting VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "legacy-row", "exo-voice-note", "legacy-note", null, "2026-10-12T00:00:00Z", 30,
      JSON.stringify({ transcript_text: "Legacy words", transcription_outcome: null }),
    );
    sqlite.query("INSERT INTO connector_meeting VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "stale-row", "exo-voice-note", "stale-note", null, "2026-10-11T00:00:00Z", 60,
      JSON.stringify({ transcription_outcome: "pending", transcription_error_code: "service_busy" }),
    );
    sqlite.query("INSERT INTO connector_meeting VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "failed-row", "exo-voice-note", "failed-note", null, "2026-10-10T00:00:00Z", 20,
      JSON.stringify({ transcription_outcome: "failed", transcription_error_code: "recording_too_large" }),
    );
    sqlite.query("INSERT INTO connector_meeting VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "null-metadata-row", "exo-voice-note", "null-metadata-note", null, "2026-10-09T00:00:00Z", 25, null,
    );
    sqlite.query("INSERT INTO voice_note_transcript VALUES (?, ?)").run("stale-note", "transcribed");
    sqlite.query("INSERT INTO voice_note_transcript VALUES (?, ?)").run("null-metadata-note", "no_speech");

    const read = await listMeetingsRead(tcw, ["exo-voice-note"]);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    const legacy = read.meetings.find((meeting) => meeting.sourceId === "legacy-note")!;
    const stale = read.meetings.find((meeting) => meeting.sourceId === "stale-note")!;
    const nullMetadata = read.meetings.find((meeting) => meeting.sourceId === "null-metadata-note")!;
    expect(buildNotePipelineInput(pipelineFacts("legacy-note", legacy.metadata ?? null)).transcript.inSpace).toBe("transcribed");
    expect(buildNotePipelineInput(pipelineFacts("stale-note", stale.metadata ?? null)).transcript.inSpace).toBe("transcribed");
    expect(buildNotePipelineInput(pipelineFacts("null-metadata-note", nullMetadata.metadata ?? null)).transcript.inSpace).toBe("no_speech");
    expect(legacy.metadata).not.toHaveProperty("transcript_text");
    expect(stale.metadata).not.toHaveProperty("transcript_text");
    expect(stale.metadata).toMatchObject({ transcript_commit_outcome: "transcribed" });
    const failed = read.meetings.find((meeting) => meeting.sourceId === "failed-note")!;
    const failedPipeline = buildNotePipelineInput(pipelineFacts("failed-note", failed.metadata ?? null));
    expect(failedPipeline.transcript).toMatchObject({ persistedState: "failed", errorCode: "recording_too_large" });
    const html = renderToStaticMarkup(createElement(PipelineTrackSummary, { pipeline: notePipeline(failedPipeline) }));
    expect(html).toContain("Private cloud couldn&#x27;t accept this recording&#x27;s length or size. Try again.");
    expect(failed.metadata).not.toHaveProperty("transcript_text");
    sqlite.close();
  });

  it("lists legacy transcript evidence when the commit table does not exist", async () => {
    const { sqlite, tcw } = realListingSpace();
    sqlite.exec("DROP TABLE voice_note_transcript");
    sqlite.query("INSERT INTO connector_meeting VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "legacy-no-commit-table", "exo-voice-note", "legacy-no-commit-table", null,
      "2026-10-12T00:00:00Z", 30, JSON.stringify({ transcript_text: "Legacy words" }),
    );
    const read = await listMeetingsRead(tcw, ["exo-voice-note"]);
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      const note = read.meetings.find((meeting) => meeting.sourceId === "legacy-no-commit-table")!;
      expect(buildNotePipelineInput(pipelineFacts(note.sourceId, note.metadata ?? null)).transcript.inSpace).toBe("transcribed");
      expect(note.metadata).not.toHaveProperty("transcript_text");
    }
    sqlite.close();
  });

  it("an ordinary empty space is ok and empty; a store error, a refused read or a throwing transport is failed", async () => {
    for (const error of [
      { code: "STORE_ERROR", message: "no such table: connector_meeting" },
      { code: "SQL_DB_NOT_FOUND", message: "no database" },
    ]) {
      expect(await listMeetingsRead(fakeTcw({ sql: { ok: false, error } }).tcw)).toEqual({ status: "ok", meetings: [] });
    }
    // An expired session: an error the Library shows (with Try again), never an empty Library.
    for (const error of [
      { code: "SQL_ERROR", message: "boom" },
      { code: "AUTH_UNAUTHORIZED", message: "unauthorized" },
    ]) {
      expect(await listMeetingsRead(fakeTcw({ sql: { ok: false, error } }).tcw)).toEqual({ status: "failed" });
    }
    expect(await listMeetingsRead(throwingTcw())).toEqual({ status: "failed" });
    expect(await listMeetingsRead(throwingTcw("sync"))).toEqual({ status: "failed" });
  });
});

/**
 * The listing SQL as shipped before TC-1274: a correlated legacy-winner subquery per voice-note row.
 * Frozen here so the set-based rewrite is held to identical rows, in the same order.
 */
const BASELINE_LIST_SQL = `SELECT id, source, source_id, title, started_at, duration_secs,
              CASE WHEN source = 'exo-voice-note' THEN
                CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN json_object(
                  'transcription_outcome', json_extract(metadata, '$.transcription_outcome'),
                  'transcription_error_code', json_extract(metadata, '$.transcription_error_code'),
                  'legacy_transcript_outcome',
                    (SELECT CASE WHEN json_extract(g.metadata, '$.transcription_outcome') IN ('transcribed','no_speech')
                                 THEN json_extract(g.metadata, '$.transcription_outcome') ELSE 'transcribed' END
                     FROM connector_meeting g
                     WHERE g.source_id = connector_meeting.source_id
                       AND g.source IN ('exo-voice-note','exo-voice-note-dup')
                       AND json_valid(g.metadata)
                       AND (json_extract(g.metadata, '$.transcription_outcome') IN ('transcribed','no_speech')
                         OR (json_extract(g.metadata, '$.transcription_outcome') IS NULL
                           AND typeof(json_extract(g.metadata, '$.transcript_text')) = 'text'
                           AND length(trim(json_extract(g.metadata, '$.transcript_text'))) > 0))
                     ORDER BY COALESCE(json_extract(g.metadata, '$.transcribed_at'), '') DESC, g.id ASC LIMIT 1),
                  'transcript_commit_outcome', __COMMIT_OUTCOME__,
                  'note_kv_key',           json_extract(metadata, '$.note_kv_key'),
                  'note_edited_at',        json_extract(metadata, '$.note_edited_at'),
                  'audio_kv_key',          json_extract(metadata, '$.audio_kv_key'),
                  'audio_stored',          json_extract(metadata, '$.audio.stored'),
                  'audio_device_platform', json_extract(metadata, '$.audio.device.platform'))
                ELSE 'invalid' END
              END AS pipeline_metadata,
              CASE WHEN source = 'exo-voice-note' AND json_valid(COALESCE(metadata, '{}'))
                THEN json_extract(metadata, '$.capture.duration_ms') END AS capture_duration_ms
       FROM connector_meeting
       WHERE source IN (__PLACEHOLDERS__) ORDER BY started_at DESC`;

const SEED_TRANSCRIBED_AT: readonly unknown[] = ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z", 7, null, undefined, { at: 1 }];
const SEED_STARTED_AT = ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z", null] as const;

/** Deterministic space covering every legacy-winner edge the baseline SQL distinguishes. */
function seedLegacyWinnerSpace(sqlite: Database, seed: number): void {
  let state = seed;
  const pick = <T,>(values: readonly T[]): T => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return values[Math.floor((state / 2147483648) * values.length)]!;
  };
  const insert = sqlite.query(`INSERT INTO connector_meeting (id, source, source_id, title, started_at, duration_secs,
    participants, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'c', 'u')`);
  const legacyMetadata = (): string | null => pick<() => string | null>([
    () => null,
    () => "{not json",
    () => "[1,2]",
    () => JSON.stringify({ transcription_outcome: pick(["transcribed", "no_speech", "pending", "failed", null, undefined]),
      transcript_text: pick(["words", "  ", "", 42, null, undefined]), transcribed_at: pick(SEED_TRANSCRIBED_AT),
      transcription_error_code: pick(["service_busy", undefined]), note_kv_key: pick(["k", undefined]),
      audio_kv_key: pick(["a", undefined]), audio: pick([{ stored: true, device: { platform: "web" } }, undefined]),
      capture: pick([{ duration_ms: 61_000 }, { duration_ms: "x" }, undefined]) }),
  ])();
  for (let n = 0; n < 400; n++) {
    const sourceId = `note-${n % 300}`; // some notes have only archived rows; some ids repeat across sources
    if (n < 300) insert.run(`vn-${n}`, "exo-voice-note", sourceId, `Note ${n}`, pick(SEED_STARTED_AT), pick([61, null, "x"]), legacyMetadata());
    for (let d = 0, dups = pick([0, 0, 1, 2, 3]); d < dups; d++) {
      insert.run(`dup-${n}-${d}-${pick(["a", "b", "c"])}`, "exo-voice-note-dup", sourceId, null, pick(SEED_STARTED_AT), null, legacyMetadata());
    }
    if (n % 7 === 0) insert.run(`ff-${n}`, pick(["fireflies", "google-meet", "tinycloud-transcriber", "exo-local", "exo-upload"]),
      pick([sourceId, `other-${n}`]), `Meeting ${n}`, pick(SEED_STARTED_AT), 1800, JSON.stringify({ transcript_text: "words" }));
  }
  const commit = sqlite.query(`INSERT OR IGNORE INTO voice_note_transcript (source_id, rev, hash, body_key, outcome, committed_at)
    VALUES (?, 1, 'h', 'b', ?, 'c')`);
  for (let n = 0; n < 300; n += 3) commit.run(`note-${n}`, pick(["transcribed", "no_speech"]));
}

describe("listMeetingsRead legacy-winner rewrite (TC-1274)", () => {
  // The baseline runs on the schema spaces have today. One variant adds a (source, source_id)
  // index afterwards, as a later provisioning step might: the Library order must not change.
  for (const variant of [
    { name: "app schema", addedIndexes: [], noCommitTable: false },
    { name: "after a source index is added",
      addedIndexes: ["CREATE INDEX idx_connector_meeting_source ON connector_meeting(source, source_id)"], noCommitTable: false },
    { name: "no commit table", addedIndexes: [], noCommitTable: true },
  ]) {
    it(`returns the baseline rows in the baseline order (${variant.name})`, async () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const sqlite = new Database(":memory:");
        for (const { sql } of CONNECTOR_SCHEMA) sqlite.exec(sql);
        sqlite.exec(TRANSCRIPT_TABLE_DDL);
        sqlite.exec(VOICE_NOTE_INDEX_DDL);
        seedLegacyWinnerSpace(sqlite, seed);
        if (variant.noCommitTable) sqlite.exec("DROP TABLE voice_note_transcript");
        // Every source, Google Meet alone (gmeet diagnostics), and every source but voice notes.
        const lists = [EXPLORER_MEETING_SOURCES, ["google-meet"], EXPLORER_MEETING_SOURCES.filter((source) => source !== "exo-voice-note")];
        const baselines = lists.map((sources) => sqlite.query(BASELINE_LIST_SQL
          .replace("__COMMIT_OUTCOME__", variant.noCommitTable ? "NULL"
            : "(SELECT t.outcome FROM voice_note_transcript t WHERE t.source_id = connector_meeting.source_id LIMIT 1)")
          .replace("__PLACEHOLDERS__", sources.map(() => "?").join(", ")))
          .values(...(sources as never[])));
        for (const ddl of variant.addedIndexes) sqlite.exec(ddl);
        let listed: unknown[][] | null = null;
        const tcw = { sql: { db: () => ({ async query(sql: string, params: unknown[] = []) {
          const rows = sqlite.query(sql).values(...(params as never[])) as unknown[][];
          if (!sql.includes("sqlite_schema")) listed = rows;
          return { ok: true as const, data: { rows } };
        } }) } } as unknown as TinyCloudWeb;
        const [baseline] = baselines;
        expect(baseline!.length).toBeGreaterThan(300);
        expect(baseline!.some((row) => String(row[6]).includes("\"legacy_transcript_outcome\":\"no_speech\""))).toBe(true);
        expect(baseline!.some((row) => String(row[6]).includes("\"legacy_transcript_outcome\":\"transcribed\""))).toBe(true);
        expect(baselines[1]!.length).toBeGreaterThan(0);
        for (const [index, sources] of lists.entries()) {
          expect((await listMeetingsRead(tcw, sources)).status).toBe("ok");
          expect(listed).toEqual(baselines[index]!);
        }
        sqlite.close();
      }
    });
  }
});

describe("findMeetingId", () => {
  it("finds a row's id by source and source id, in one read", async () => {
    const { tcw, sqlCalls } = fakeTcw({ sql: { ok: true, data: { rows: [["row-9"]] } } });
    expect(await findMeetingId(tcw, "exo-voice-note", "rec-1")).toEqual({ status: "ok", id: "row-9" });
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].params).toEqual(["exo-voice-note", "rec-1"]);
    expect(sqlCalls[0].sql).toContain("WHERE source = ? AND source_id = ?");
  });

  it("no row (or no table yet) is absent; a store error or a throwing transport is failed", async () => {
    expect(await findMeetingId(fakeTcw({ sql: { ok: true, data: { rows: [] } } }).tcw, "exo-voice-note", "rec-1")).toEqual({ status: "absent" });
    expect(
      await findMeetingId(fakeTcw({ sql: { ok: false, error: { code: "STORE_ERROR", message: "no such table: connector_meeting" } } }).tcw, "s", "x"),
    ).toEqual({ status: "absent" });
    expect(await findMeetingId(fakeTcw({ sql: { ok: false, error: { code: "SQL_ERROR", message: "boom" } } }).tcw, "s", "x")).toEqual({
      status: "failed",
    });
    expect(await findMeetingId(throwingTcw(), "s", "x")).toEqual({ status: "failed" });
  });
});

describe("readMeetingMetadata", () => {
  it("reads the row's metadata object; no row or a non-object is absent; a rejected query is failed", async () => {
    const meta = { capture: "upload", transcript_provider: "assemblyai", assemblyai_account: "own" };
    expect(await readMeetingMetadata(fakeTcw({ sql: { ok: true, data: { rows: [[JSON.stringify(meta)]] } } }).tcw, "m-1")).toEqual({
      status: "ok",
      metadata: meta,
    });
    expect(await readMeetingMetadata(fakeTcw({ sql: { ok: true, data: { rows: [] } } }).tcw, "m-1")).toEqual({ status: "absent" });
    expect(await readMeetingMetadata(fakeTcw({ sql: { ok: true, data: { rows: [["[1,2]"]] } } }).tcw, "m-1")).toEqual({
      status: "absent",
    });
    expect(
      await readMeetingMetadata(fakeTcw({ sql: { ok: false, error: { code: "SQL_ERROR", message: "boom" } } }).tcw, "m-1"),
    ).toEqual({ status: "failed" });
  });
});

describe("readTranscript", () => {
  const stored = [
    sentence({ index: 0, speaker_name: "Ada", text: "Morning." }),
    sentence({ index: 1, speaker_name: null, text: "Morning back." }),
  ];

  it("reads a committed body key instead of the fixed key", async () => {
    const { tcw, kvKeys } = fakeTcw({ kv: { ok: true, data: { data: JSON.stringify(stored), headers: {} } } });
    const key = "xyz.tinycloud.tinychat/connectors/exo-voice-note/transcript-rev/rec/hash";
    expect(await readTranscript(tcw, "exo-voice-note", "rec", key)).toEqual({ status: "ok", sentences: stored });
    expect(kvKeys).toEqual([key]);
  });

  it("shows the winning legacy row text when the fixed body is stale", async () => {
    const { tcw } = fakeTcw({ kv: { ok: true, data: { data: JSON.stringify(stored), headers: {} } } });
    expect(await readTranscript(tcw, "exo-voice-note", "rec", undefined, "Newer words")).toEqual({
      status: "ok", sentences: [{ index: 0, speaker_name: null, text: "Newer words", start_time: 0, end_time: 0 }],
    });
  });

  it("parses a JSON-stringified payload", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: true, data: { data: JSON.stringify(stored), headers: {} } },
    });
    expect(await readTranscript(tcw, "fireflies", "src-1")).toEqual({
      status: "ok",
      sentences: stored,
    });
  });

  it("accepts an already-parsed array payload", async () => {
    const { tcw } = fakeTcw({ kv: { ok: true, data: { data: stored, headers: {} } } });
    expect(await readTranscript(tcw, "fireflies", "src-1")).toEqual({
      status: "ok",
      sentences: stored,
    });
  });

  it("reads the fireflies-scoped key for a fireflies meeting", async () => {
    const { tcw, kvKeys } = fakeTcw({
      kv: { ok: true, data: { data: JSON.stringify([]), headers: {} } },
    });
    await readTranscript(tcw, "fireflies", "src-9");
    expect(kvKeys).toEqual([transcriptKvKey("fireflies", "src-9")]);
  });

  it("reads the google-meet-scoped key for a Meet meeting", async () => {
    const { tcw, kvKeys } = fakeTcw({
      kv: { ok: true, data: { data: JSON.stringify([]), headers: {} } },
    });
    await readTranscript(tcw, "google-meet", "conf-9");
    expect(kvKeys).toEqual([transcriptKvKey("google-meet", "conf-9")]);
    // The Fireflies key for the same id must not be what was read — that miss
    // would render as "not synced yet" forever.
    expect(kvKeys).not.toContain(transcriptKvKey("fireflies", "conf-9"));
  });

  it("reports an empty stored transcript as ok, not absent", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: true, data: { data: JSON.stringify([]), headers: {} } },
    });
    expect(await readTranscript(tcw, "google-meet", "conf-1")).toEqual({
      status: "ok",
      sentences: [],
    });
  });

  it("reports malformed JSON as absent (re-reading returns the same bytes)", async () => {
    const { tcw } = fakeTcw({ kv: { ok: true, data: { data: "{not json", headers: {} } } });
    expect(await readTranscript(tcw, "fireflies", "src-1")).toEqual({ status: "absent" });
  });

  it("reports a payload that is not an array as absent", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: true, data: { data: { sentences: [] }, headers: {} } },
    });
    expect(await readTranscript(tcw, "fireflies", "src-1")).toEqual({ status: "absent" });
  });

  it("reports a missing key as absent", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: false, error: { code: "KV_NOT_FOUND", message: "no key" } },
    });
    expect(await readTranscript(tcw, "fireflies", "src-1")).toEqual({ status: "absent" });
  });

  it("reports a non-missing store error as failed, so the caller can retry", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "unauthorized" } },
    });
    expect(await readTranscript(tcw, "fireflies", "src-1")).toEqual({ status: "failed" });
  });

  it("reports an unlabelled store error as failed", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: false, error: { code: "", message: "" } },
    });
    expect(await readTranscript(tcw, "google-meet", "conf-1")).toEqual({ status: "failed" });
  });

  it("reports a rejected read as failed and never throws", async () => {
    await expect(readTranscript(throwingTcw(), "fireflies", "src-1")).resolves.toEqual({
      status: "failed",
    });
  });

  it("filters out entries without a string text", async () => {
    const { tcw } = fakeTcw({
      kv: {
        ok: true,
        data: {
          data: JSON.stringify([
            { index: 0, speaker_name: "Ada", text: "kept" },
            { index: 1, speaker_name: "Ada" },
            { index: 2, speaker_name: "Ada", text: 42 },
            null,
            "not an object",
          ]),
          headers: {},
        },
      },
    });
    expect(await readTranscript(tcw, "fireflies", "src-1")).toEqual({
      status: "ok",
      sentences: [{ index: 0, speaker_name: "Ada", text: "kept" } as FirefliesSentence],
    });
  });
});

describe("meetingSourceLabel", () => {
  it("names each browsable source the way Settings does", () => {
    expect(meetingSourceLabel("fireflies")).toBe("Fireflies");
    expect(meetingSourceLabel("google-meet")).toBe("Google Meet");
    expect(meetingSourceLabel("exo-merged")).toBe("Combined meeting");
  });

  it("labels every source the explorer browses", () => {
    for (const source of EXPLORER_MEETING_SOURCES) {
      expect(meetingSourceLabel(source)).not.toBe(source);
    }
  });

  it("falls back to the raw source string rather than rendering blank", () => {
    expect(meetingSourceLabel("otter")).toBe("otter");
  });
});

describe("transcriptCopyText", () => {
  it("attributes each line to its speaker", () => {
    expect(
      transcriptCopyText([
        sentence({ speaker_name: "Ada", text: "Morning." }),
        sentence({ speaker_name: "Grace", text: "Morning back." }),
      ]),
    ).toBe("Ada: Morning.\nGrace: Morning back.");
  });

  it("emits a bare line when the speaker is unknown", () => {
    expect(transcriptCopyText([sentence({ speaker_name: null, text: "Anon line." })])).toBe(
      "Anon line.",
    );
  });

  it("joins lines with a single newline", () => {
    const out = transcriptCopyText([
      sentence({ speaker_name: null, text: "a" }),
      sentence({ speaker_name: null, text: "b" }),
      sentence({ speaker_name: "C", text: "c" }),
    ]);
    expect(out).toBe("a\nb\nC: c");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("returns an empty string for an empty transcript", () => {
    expect(transcriptCopyText([])).toBe("");
  });
});

describe("readMeetingAudio", () => {
  const BASE = "xyz.tinycloud.tinychat/connectors/exo-upload/audio/m-1";
  const row = (metadata: string | null): SqlResult => ({ ok: true, data: { rows: [[metadata]] } });
  const cases: [string, SqlResult, MeetingAudioRead][] = [
    ["stored audio with a base", row(JSON.stringify({ audio: { stored: true, base: BASE } })), { status: "stored", base: BASE }],
    ["audio that was not stored", row(JSON.stringify({ audio: { stored: false, base: BASE, reason: "quota" } })), { status: "absent" }],
    ["a pre-TC-517 voice note's audio_kv_key", row(JSON.stringify({ audio_kv_key: BASE })), { status: "absent" }],
    ["metadata that is not JSON", row("{not json"), { status: "absent" }],
    ["no row", { ok: true, data: { rows: [] } }, { status: "absent" }],
    ["a rejected query", { ok: false, error: { code: "SQL_ERROR", message: "boom" } }, { status: "failed" }],
  ];

  for (const [name, sql, expected] of cases) {
    it(`reads ${name} as ${expected.status}`, async () => {
      const { tcw, sqlCalls } = fakeTcw({ sql });
      expect(await readMeetingAudio(tcw, "row-1")).toEqual(expected);
      expect(sqlCalls.map((c) => [c.db, c.params])).toEqual([[CONNECTORS_SQL_DB_NAME, ["row-1"]]]);
    });
  }

  it("reads a transport that throws as failed", async () => {
    expect(await readMeetingAudio(throwingTcw(), "row-1")).toEqual({ status: "failed" });
  });
});
