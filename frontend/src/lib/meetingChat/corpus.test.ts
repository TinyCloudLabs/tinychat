import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  SQL_DISCOVERY_MAX_MEETINGS,
  SQL_COMBINED_MEMBER_KEYS_QUERY,
  SQL_MEETING_METADATA_QUERY,
  SQL_MEETING_METADATA_LEGACY_QUERY,
  SUPPORTED_MEETING_SOURCES,
  TRANSCRIBED_ONLY_SOURCES,
  discoverKvMeetings,
  discoverMeetingCorpus,
  discoverSqlMeetings,
  mergeMeetingCorpus,
} from "./corpus";
import { CONNECTORS_KV_PREFIX } from "../connectors/connectorStore";
import { LOCAL_MEETING_SOURCE } from "../localTranscriber";
import { VOICE_NOTE_SOURCE } from "../voiceNotes/voiceNoteStore";
import { detectMeetingIntent, selectMeeting } from "./retriever";
import type { MeetingCandidate } from "./types";

type QueryResult =
  | { ok: true; data: { rows: unknown } }
  | { ok: false; error: { code: string; message: string } };

function fakeTcw(query: (sql: string) => Promise<QueryResult>): TinyCloudWeb {
  return {
    sql: {
      db: () => ({ query: (sql: string) => sql.includes("sqlite_schema")
        ? Promise.resolve({ ok: true, data: { rows: [] } }) : query(sql) }),
    },
  } as unknown as TinyCloudWeb;
}

const validRow = [
  "row-1",
  "fireflies",
  "meeting-1",
  "Planning",
  "2026-08-24T09:00:00.000Z",
  "owner@example.test",
  JSON.stringify([
    { name: "Avery", email: "avery@example.test" },
    { name: "Sam", email: null },
  ]),
  1,
  "2026-08-24T08:00:00.000Z",
  "2026-08-24T09:30:00.000Z",
];

interface KvListReply {
  ok: true;
  data: { keys: unknown; cursor?: unknown };
}

class DiscoveryKv {
  calls: Array<{ path: string; cursor?: string; active: number }> = [];
  getCalls = 0;
  active = 0;

  constructor(
    private readonly listImpl: (options: { path: string; cursor?: string }) => Promise<
      KvListReply | { ok: false; error: { code: string; message: string } }
    >,
  ) {}

  async list(options: { path: string; cursor?: string }) {
    this.active += 1;
    this.calls.push({ ...options, active: this.active });
    try {
      return await this.listImpl(options);
    } finally {
      this.active -= 1;
    }
  }

  async get() {
    this.getCalls += 1;
    throw new Error("KV discovery must never read bodies");
  }
}

function fakeKvTcw(kv: DiscoveryKv): TinyCloudWeb {
  return { kv } as unknown as TinyCloudWeb;
}

describe("SQL meeting metadata discovery", () => {
  test("runs one strict read-only metadata query and produces content-free candidates", async () => {
    const queries: string[] = [];
    const result = await discoverSqlMeetings(fakeTcw(async (sql) => {
      queries.push(sql);
      return { ok: true, data: { rows: [validRow] } };
    }));

    expect(queries).toEqual([SQL_MEETING_METADATA_LEGACY_QUERY]);
    expect(SQL_MEETING_METADATA_QUERY).toMatch(/^SELECT\b/i);
    // Provider metadata is never selected; JSON fields only participate in filtered admission predicates.
    const [selectList, predicate] = SQL_MEETING_METADATA_QUERY.split(/\bFROM connector_meeting m\b/);
    expect(selectList).not.toMatch(/\bmetadata\b/i);
    expect(predicate).toContain("voice_note_transcript");
    expect(predicate).toContain("json_valid(g.metadata)");
    expect(predicate).toContain("json_extract(g.metadata, '$.transcription_outcome')");
    expect(SQL_MEETING_METADATA_QUERY).not.toMatch(/\bsummary_overview\s*,|\bsummary_action_items\s*,/i);
    expect(result.lane).toEqual({ state: "healthy" });
    expect(result.candidates).toEqual([{
      source: "fireflies",
      sourceId: "meeting-1",
      title: "Planning",
      startedAt: "2026-08-24T09:00:00.000Z",
      participantNames: ["Avery", "Sam"],
      participantEmails: ["avery@example.test"],
      organizerEmail: "owner@example.test",
      hasSqlSummary: true,
      hasLocalRecord: false,
      hasLocalTranscript: false,
      localRowId: "row-1",
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T09:30:00.000Z",
    }]);
    const candidateKeys = Object.keys(result.candidates[0] ?? {});
    for (const forbidden of ["summary", "transcript", "metadata", "providerMetadata"]) {
      expect(candidateKeys).not.toContain(forbidden);
    }
  });

  test("a newer no-speech winner blocks an older transcribed duplicate", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE connector_meeting (
          id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT,
          organizer_email TEXT, participants TEXT, summary_overview TEXT,
          summary_action_items TEXT, created_at TEXT, updated_at TEXT, metadata TEXT
        );
        CREATE TABLE voice_note_transcript (
          source_id TEXT, outcome TEXT, participants TEXT
        );
      `);
      const insert = sqlite.prepare(
        "INSERT INTO connector_meeting (id, source, source_id, title, started_at, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run("canonical", "exo-voice-note", "rec", "Note", "2026-02-01", "2026-02-01", "2026-02-01",
        JSON.stringify({ transcription_outcome: "no_speech", transcribed_at: "2026-02-01T00:00:00.000Z" }));
      insert.run("duplicate", "exo-voice-note-dup", "rec", "Note", "2026-01-01", "2026-01-01", "2026-01-01",
        JSON.stringify({ transcription_outcome: "transcribed", transcript_text: "Old transcript", transcribed_at: "2026-01-01T00:00:00.000Z" }));

      expect(sqlite.prepare(SQL_MEETING_METADATA_QUERY).all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  test("classifies a missing table as an unused lane", async () => {
    const result = await discoverSqlMeetings(fakeTcw(async () => ({
      ok: false,
      error: { code: "SQL_ERROR", message: "no such table: connector_meeting" },
    })));

    expect(result).toEqual({
      candidates: [],
      lane: { state: "unused", reason: "missing-table" },
    });
  });

  test("keeps storage and transport errors distinct from an empty lane", async () => {
    const storage = await discoverSqlMeetings(fakeTcw(async () => ({
      ok: false,
      error: { code: "AUTH_UNAUTHORIZED", message: "permission denied" },
    })));
    const transport = await discoverSqlMeetings(fakeTcw(async () => {
      throw new Error("network dropped");
    }));

    expect(storage).toEqual({ candidates: [], lane: { state: "failed", reason: "storage" } });
    expect(transport).toEqual({ candidates: [], lane: { state: "failed", reason: "transport" } });
  });

  test("skips malformed rows and marks the lane partial without leaking their content", async () => {
    const malformed = [...validRow];
    malformed[6] = '{"unexpected":"provider payload"}';
    const result = await discoverSqlMeetings(fakeTcw(async () => ({
      ok: true,
      data: { rows: [validRow, malformed, ["missing", "columns"]] },
    })));

    expect(result.lane).toEqual({ state: "partial", malformedRows: 2 });
    expect(result.candidates).toHaveLength(1);
    expect(JSON.stringify(result.candidates)).not.toContain("provider payload");
  });

  test("uses one SQL overflow sentinel and marks omitted rows partial", async () => {
    const rows = Array.from({ length: SQL_DISCOVERY_MAX_MEETINGS + 1 }, (_, index) => [
      ...validRow.slice(0, 2), `meeting-${index}`, ...validRow.slice(3),
    ]);
    const result = await discoverSqlMeetings(fakeTcw(async () => ({ ok: true, data: { rows } })));
    expect(SQL_MEETING_METADATA_QUERY).toContain(`LIMIT ${SQL_DISCOVERY_MAX_MEETINGS + 1}`);
    expect(result.candidates).toHaveLength(SQL_DISCOVERY_MAX_MEETINGS);
    expect(result.lane).toEqual({ state: "partial", malformedRows: 0, truncated: true });
  });

  test("rejects unsupported SQL sources before they become candidates", async () => {
    const unsupported = [...validRow];
    unsupported[1] = "granola";
    const result = await discoverSqlMeetings(fakeTcw(async () => ({ ok: true, data: { rows: [unsupported] } })));
    expect(SQL_MEETING_METADATA_QUERY).toContain(
      "source IN ('fireflies', 'google-meet', 'tinycloud-transcriber', 'exo-local', 'exo-voice-note', 'exo-upload', 'exo-merged')",
    );
    // The browser-local capture sources are named by their writers' own constants.
    expect(SUPPORTED_MEETING_SOURCES).toEqual(expect.arrayContaining([LOCAL_MEETING_SOURCE, VOICE_NOTE_SOURCE]));
    // The SQL filter and the row/KV allowlist are one definition: none can drift.
    for (const source of SUPPORTED_MEETING_SOURCES) {
      expect(SQL_MEETING_METADATA_QUERY).toContain(`'${source}'`);
    }
    expect(result).toEqual({ candidates: [], lane: { state: "partial", malformedRows: 1 } });
  });

  test("a voice note row the SQL predicate admitted (transcribed) is a candidate", async () => {
    const voiceNote = [...validRow];
    voiceNote[1] = VOICE_NOTE_SOURCE;
    const result = await discoverSqlMeetings(fakeTcw(async () => ({ ok: true, data: { rows: [voiceNote] } })));
    expect(result.lane).toEqual({ state: "healthy" });
    expect(result.candidates).toEqual([expect.objectContaining({ source: VOICE_NOTE_SOURCE, sourceId: "meeting-1" })]);
    expect(TRANSCRIBED_ONLY_SOURCES).toEqual([VOICE_NOTE_SOURCE]);
  });

  test("a voice note known only by its KV transcript key (written empty at save) is never a candidate", () => {
    const kvOnly = (source: string, sourceId: string) => ({
      source,
      sourceId,
      title: null,
      startedAt: null,
      participantNames: [],
      participantEmails: [],
      organizerEmail: null,
      hasSqlSummary: false,
      hasLocalRecord: false,
      hasLocalTranscript: true,
      localRowId: null,
      createdAt: null,
      updatedAt: null,
    });
    const admitted = { ...kvOnly(VOICE_NOTE_SOURCE, "rec-transcribed"), title: "Voice note", startedAt: "2026-10-03T09:00:00.000Z", localRowId: "row-v", hasLocalTranscript: false };
    const corpus = mergeMeetingCorpus({
      sql: { candidates: [admitted], lane: { state: "healthy" } },
      kv: {
        candidates: [kvOnly(VOICE_NOTE_SOURCE, "rec-transcribed"), kvOnly(VOICE_NOTE_SOURCE, "rec-untranscribed"), kvOnly("exo-local", "local:s1")],
        lane: { state: "healthy" },
      },
    });
    expect(corpus.candidates.map((c) => `${c.source}/${c.sourceId}`)).toEqual([
      "exo-local/local:s1",
      "exo-voice-note/rec-transcribed",
    ]);
    expect(corpus.candidates.find((c) => c.sourceId === "rec-transcribed")).toEqual(
      expect.objectContaining({ hasLocalTranscript: true, localRowId: "row-v" }),
    );
  });
  test("a versioned transcript body key never becomes a meeting candidate", async () => {
    const source = VOICE_NOTE_SOURCE;
    const kv = new DiscoveryKv(async ({ path }) => ({ ok: true, data: {
      keys: path.endsWith("/transcript/")
        ? [`${path}real-note`, `${CONNECTORS_KV_PREFIX}/${source}/transcript-rev/ghost/hash`]
        : [],
    } }));
    const result = await discoverKvMeetings(fakeKvTcw(kv), source);
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(["real-note"]);
    expect(result.candidates.some((candidate) => candidate.sourceId.includes("transcript-rev"))).toBe(false);
  });
});

describe("reconciled KV prefix discovery", () => {
  const source = "fireflies";
  const meetingPrefix = `${CONNECTORS_KV_PREFIX}/${source}/meeting/`;
  const transcriptPrefix = `${CONNECTORS_KV_PREFIX}/${source}/transcript/`;

  test("pages both SDK-defined complete prefixes sequentially without reading values", async () => {
    const kv = new DiscoveryKv(async (options) => {
      if (options.path === meetingPrefix && options.cursor === undefined) {
        return { ok: true, data: { keys: [`${meetingPrefix}same`], cursor: "meeting-page-2" } };
      }
      if (options.path === meetingPrefix && options.cursor === "meeting-page-2") {
        return { ok: true, data: { keys: [`${meetingPrefix}record-only`] } };
      }
      if (options.path === transcriptPrefix && options.cursor === undefined) {
        return { ok: true, data: { keys: [`${transcriptPrefix}same`], cursor: "transcript-page-2" } };
      }
      if (options.path === transcriptPrefix && options.cursor === "transcript-page-2") {
        return { ok: true, data: { keys: [`${transcriptPrefix}transcript-only`] } };
      }
      throw new Error(`unexpected list ${JSON.stringify(options)}`);
    });

    const result = await discoverKvMeetings(fakeKvTcw(kv), source);

    expect(kv.calls).toEqual([
      { path: meetingPrefix, signal: undefined, active: 1 },
      { path: meetingPrefix, cursor: "meeting-page-2", signal: undefined, active: 1 },
      { path: transcriptPrefix, signal: undefined, active: 1 },
      { path: transcriptPrefix, cursor: "transcript-page-2", signal: undefined, active: 1 },
    ]);
    expect(kv.getCalls).toBe(0);
    expect(result.lane).toEqual({ state: "healthy" });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        source,
        sourceId: "record-only",
        hasLocalRecord: true,
        hasLocalTranscript: false,
        title: null,
        startedAt: null,
        participantNames: [],
        participantEmails: [],
        organizerEmail: null,
        hasSqlSummary: false,
        localRowId: null,
      }),
      expect.objectContaining({ sourceId: "same", hasLocalRecord: true, hasLocalTranscript: true }),
      expect.objectContaining({ sourceId: "transcript-only", hasLocalRecord: false, hasLocalTranscript: true }),
    ]);
  });

  test("distinguishes an empty prefix from list failures", async () => {
    const empty = await discoverKvMeetings(fakeKvTcw(new DiscoveryKv(async () => (
      { ok: true, data: { keys: [] } }
    ))), source);
    expect(empty).toEqual({ candidates: [], lane: { state: "healthy" } });

    const storage = await discoverKvMeetings(fakeKvTcw(new DiscoveryKv(async () => (
      { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "no access" } }
    ))), source);
    expect(storage).toEqual({ candidates: [], lane: { state: "failed", reason: "storage" } });

    const transport = await discoverKvMeetings(fakeKvTcw(new DiscoveryKv(async () => {
      throw new Error("offline");
    })), source);
    expect(transport).toEqual({ candidates: [], lane: { state: "failed", reason: "transport" } });
  });

  test("marks malformed listed keys partial while retaining valid opaque identities", async () => {
    const kv = new DiscoveryKv(async (options) => {
      if (options.path === meetingPrefix) {
        return {
          ok: true,
          data: { keys: [`${meetingPrefix}valid`, `${meetingPrefix}`, 42, `${transcriptPrefix}wrong-prefix`] },
        };
      }
      return { ok: true, data: { keys: [] } };
    });

    const result = await discoverKvMeetings(fakeKvTcw(kv), source);

    expect(result.lane).toEqual({ state: "partial", malformedRows: 3 });
    expect(result.candidates).toEqual([
      expect.objectContaining({ source, sourceId: "valid", hasLocalRecord: true, hasLocalTranscript: false }),
    ]);
    expect(JSON.stringify(result.candidates)).not.toContain("wrong-prefix");
  });
});

function meetingCandidate(patch: Partial<MeetingCandidate> = {}): MeetingCandidate {
  return {
    source: "fireflies",
    sourceId: "meeting-1",
    title: "Planning",
    startedAt: "2026-08-24T09:00:00.000Z",
    participantNames: [],
    participantEmails: [],
    organizerEmail: null,
    hasSqlSummary: false,
    hasLocalRecord: false,
    hasLocalTranscript: false,
    localRowId: null,
    createdAt: null,
    updatedAt: null,
    ...patch,
  };
}

describe("exact-identity meeting corpus merge", () => {
  test("merges only an exact source and sourceId match", () => {
    const corpus = mergeMeetingCorpus({
      sql: {
        candidates: [meetingCandidate({
          sourceId: "sql-and-kv",
          title: "Project Falcon",
          hasSqlSummary: true,
          localRowId: "row-7",
        }), meetingCandidate({
          sourceId: "same-title-different-id",
          title: "Project Falcon",
        })],
        lane: { state: "healthy" },
      },
      kv: {
        candidates: [
          meetingCandidate({
            sourceId: "sql-and-kv",
            title: null,
            startedAt: null,
            hasLocalRecord: true,
          }),
          meetingCandidate({
            source: "other-source",
            sourceId: "sql-and-kv",
            title: null,
            startedAt: null,
            hasLocalTranscript: true,
          }),
        ],
        lane: { state: "healthy" },
      },
    });

    expect(corpus.candidates).toHaveLength(3);
    expect(corpus.candidates).toEqual([
      expect.objectContaining({
        source: "fireflies",
        sourceId: "same-title-different-id",
        title: "Project Falcon",
        hasLocalRecord: false,
      }),
      expect.objectContaining({
        source: "fireflies",
        sourceId: "sql-and-kv",
        title: "Project Falcon",
        hasSqlSummary: true,
        hasLocalRecord: true,
        localRowId: "row-7",
      }),
      expect.objectContaining({
        source: "other-source",
        sourceId: "sql-and-kv",
        title: null,
        hasLocalTranscript: true,
      }),
    ]);
  });

  test("discovers and merges transcript availability for Google Meet and Transcriber SQL identities", async () => {
    const rows = [
      [...validRow.slice(0, 1), "google-meet", "g-1", ...validRow.slice(3)],
      [...validRow.slice(0, 1), "tinycloud-transcriber", "t-1", ...validRow.slice(3)],
    ];
    const lists: string[] = [];
    const corpus = await discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => ({ ok: true, data: { rows } }) }) },
      kv: { list: async ({ path }: { path: string }) => {
        lists.push(path);
        return { ok: true, data: { keys: path.endsWith("google-meet/transcript/") ? [`${path}g-1`] : path.endsWith("tinycloud-transcriber/transcript/") ? [`${path}t-1`] : [] } };
      } },
    } as unknown as TinyCloudWeb);
    expect(corpus.candidates.find((candidate) => candidate.sourceId === "g-1")?.hasLocalTranscript).toBe(true);
    expect(corpus.candidates.find((candidate) => candidate.sourceId === "t-1")?.hasLocalTranscript).toBe(true);
    expect(lists).toEqual(expect.arrayContaining([
      `${CONNECTORS_KV_PREFIX}/google-meet/transcript/`,
      `${CONNECTORS_KV_PREFIX}/tinycloud-transcriber/transcript/`,
    ]));
  });

  test("does not enumerate KV prefixes for an unsupported SQL source", async () => {
    const rows = [[...validRow.slice(0, 1), "granola", "g-1", ...validRow.slice(3)]];
    const lists: string[] = [];
    const result = await discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => ({ ok: true, data: { rows } }) }) },
      kv: { list: async ({ path }: { path: string }) => {
        lists.push(path);
        return { ok: true, data: { keys: [] } };
      } },
    } as unknown as TinyCloudWeb);
    expect(result.candidates).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: "granola" })]));
    expect(lists.some((path) => path.includes("/granola/"))).toBe(false);
  });

  test("includes an already-selected supported source when SQL discovery fails", async () => {
    const lists: string[] = [];
    await discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED" } }) }) },
      kv: { list: async ({ path }: { path: string }) => {
        lists.push(path);
        return { ok: true, data: { keys: [] } };
      } },
    } as unknown as TinyCloudWeb, undefined, undefined, { source: "google-meet", sourceId: "g-opaque" });
    expect(lists).toEqual([
      `${CONNECTORS_KV_PREFIX}/fireflies/meeting/`,
      `${CONNECTORS_KV_PREFIX}/fireflies/transcript/`,
      `${CONNECTORS_KV_PREFIX}/google-meet/meeting/`,
      `${CONNECTORS_KV_PREFIX}/google-meet/transcript/`,
    ]);
  });

  test("threads cancellation through discovery and does not begin a later lane", async () => {
    const controller = new AbortController();
    let kvCalls = 0;
    await expect(discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => {
        controller.abort();
        return { ok: true, data: { rows: [] } };
      } }) },
      kv: { list: async () => {
        kvCalls += 1;
        return { ok: true, data: { keys: [] } };
      } },
    } as unknown as TinyCloudWeb, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(kvCalls).toBe(0);
  });

  test("reconciles exact-match availability and metadata deterministically", () => {
    const duplicateA = meetingCandidate({
      title: "Zulu planning",
      participantNames: ["Zoe"],
      participantEmails: ["zoe@example.test"],
      hasSqlSummary: true,
      localRowId: "row-z",
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    });
    const duplicateB = meetingCandidate({
      title: "Alpha planning",
      participantNames: ["Avery"],
      participantEmails: ["avery@example.test"],
      organizerEmail: "owner@example.test",
      localRowId: "row-a",
      createdAt: "2026-08-23T08:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
    });
    const kv = meetingCandidate({
      title: null,
      participantNames: ["Sam"],
      startedAt: null,
      hasLocalRecord: true,
      hasLocalTranscript: true,
    });
    const build = (sqlCandidates: readonly MeetingCandidate[]) => mergeMeetingCorpus({
      sql: { candidates: sqlCandidates, lane: { state: "healthy" } },
      kv: { candidates: [kv], lane: { state: "healthy" } },
    });

    const forward = build([duplicateA, duplicateB]);
    const reversed = build([duplicateB, duplicateA]);

    expect(forward).toEqual(reversed);
    expect(forward.candidates).toEqual([expect.objectContaining({
      title: "Zulu planning",
      participantNames: ["Sam", "Zoe"],
      participantEmails: ["zoe@example.test"],
      organizerEmail: null,
      hasSqlSummary: true,
      hasLocalRecord: true,
      hasLocalTranscript: true,
      localRowId: "row-z",
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    })]);
    expect(JSON.stringify(forward.candidates)).not.toContain("summary_overview");
    expect(JSON.stringify(forward.candidates)).not.toContain("providerMetadata");
  });

  test("unions duplicate exact-match availability without letting input order hide evidence", () => {
    const recordOnly = meetingCandidate({ hasLocalRecord: true });
    const transcriptOnly = meetingCandidate({ hasLocalTranscript: true });
    const build = (kvCandidates: readonly MeetingCandidate[]) => (
      mergeMeetingCorpus({
        sql: { candidates: [], lane: { state: "healthy" } },
        kv: { candidates: kvCandidates, lane: { state: "healthy" } },
      })
    );

    const forward = build([recordOnly, transcriptOnly]);
    const reversed = build([transcriptOnly, recordOnly]);

    expect(forward).toEqual(reversed);
    expect(forward.candidates).toEqual([expect.objectContaining({
      hasLocalRecord: true,
      hasLocalTranscript: true,
    })]);
  });

  test("preserves each lane health and marks incomplete corpus discovery partial", () => {
    const incomplete = mergeMeetingCorpus({
      sql: { candidates: [], lane: { state: "unused", reason: "missing-table" } },
      kv: { candidates: [], lane: { state: "failed", reason: "storage" } },
    });
    const complete = mergeMeetingCorpus({
      sql: { candidates: [], lane: { state: "unused", reason: "missing-table" } },
      kv: { candidates: [], lane: { state: "healthy" } },
    });

    expect(incomplete).toEqual({
      candidates: [],
      lanes: {
        sql: { state: "unused", reason: "missing-table" },
        kv: { state: "failed", reason: "storage" },
      },
      partial: true,
    });
    expect(complete.partial).toBe(false);
  });
});

describe("combined meetings in the corpus (TC-1152)", () => {
  const MERGED_ID = "merged-1";

  function combinedMetadata(members: unknown): string {
    return JSON.stringify({ merge: { v: 1, members } });
  }

  function seedDb(withCommitTable: boolean, rows: Array<{
    id: string; source: string; sourceId: string; metadata?: string | null; startedAt?: string;
  }>): Database {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE connector_meeting (
      id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT,
      participants TEXT, summary_overview TEXT, summary_action_items TEXT, created_at TEXT, updated_at TEXT, metadata TEXT
    )`);
    if (withCommitTable) db.exec("CREATE TABLE voice_note_transcript (source_id TEXT, outcome TEXT, participants TEXT)");
    const insert = db.prepare(
      "INSERT INTO connector_meeting (id, source, source_id, title, started_at, participants, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.id, row.source, row.sourceId, `Title ${row.id}`, row.startedAt ?? "2026-08-24T09:00:00.000Z",
        "2026-08-24T08:00:00.000Z", "2026-08-24T09:30:00.000Z", row.metadata ?? null);
    }
    return db;
  }

  function sqliteTcw(db: Database, queries: string[] = [], extra: Record<string, unknown> = {}): TinyCloudWeb {
    return {
      sql: { db: () => ({ query: async (sql: string) => {
        queries.push(sql);
        try {
          return { ok: true, data: { rows: db.prepare(sql).values() } };
        } catch (error) {
          return { ok: false, error: { code: "SQL_ERROR", message: String(error) } };
        }
      } }) },
      ...extra,
    } as unknown as TinyCloudWeb;
  }

  const MEMBERS = [
    { source: "fireflies", source_id: "ff-1" },
    { source: "google-meet", source_id: "gm-1" },
  ];
  const baseRows = [
    { id: "r-ff", source: "fireflies", sourceId: "ff-1" },
    { id: "r-gm", source: "google-meet", sourceId: "gm-1" },
    { id: "r-other", source: "fireflies", sourceId: "ff-other" },
    { id: "r-local", source: "exo-local", sourceId: "local-1" },
  ];
  const combinedRow = { id: "r-merged", source: "exo-merged", sourceId: MERGED_ID, metadata: combinedMetadata(MEMBERS) };

  const ids = async (db: Database) => {
    const result = await discoverSqlMeetings(sqliteTcw(db));
    return { ids: result.candidates.map((c) => c.sourceId).sort(), lane: result.lane };
  };

  for (const withCommitTable of [false, true]) {
    const label = withCommitTable ? "commit-table query" : "legacy query";

    describe(label, () => {
      test("lists the combined meeting and neither of its members; other meetings are unaffected", async () => {
        const db = seedDb(withCommitTable, [...baseRows, combinedRow]);
        try {
          expect(await ids(db)).toEqual({ ids: [MERGED_ID, "ff-other", "local-1"].sort(), lane: { state: "healthy" } });
        } finally { db.close(); }
      });

      test("with no combined rows the result is exactly the pre-combined list", async () => {
        const db = seedDb(withCommitTable, baseRows);
        try {
          expect((await ids(db)).ids).toEqual(["ff-1", "ff-other", "gm-1", "local-1"]);
        } finally { db.close(); }
      });

      test("membership is by source AND source_id: a same-id row of another source is not a member", async () => {
        const db = seedDb(withCommitTable, [
          { id: "r-a", source: "fireflies", sourceId: "shared" },
          { id: "r-b", source: "google-meet", sourceId: "shared" },
          { id: "r-merged", source: "exo-merged", sourceId: MERGED_ID, metadata: combinedMetadata([{ source: "fireflies", source_id: "shared" }]) },
        ]);
        try {
          const result = await discoverSqlMeetings(sqliteTcw(db));
          expect(result.candidates.map((c) => `${c.source}/${c.sourceId}`).sort()).toEqual([
            "exo-merged/merged-1", "google-meet/shared",
          ]);
        } finally { db.close(); }
      });

      const unreadable: Array<[string, string | null]> = [
        ["metadata is not JSON", "{not json"],
        ["metadata is NULL", null],
        ["metadata is a JSON array", "[1,2]"],
        ["metadata has no merge record", JSON.stringify({ transcript_text: "x" })],
        ["merge.members is empty", combinedMetadata([])],
        ["merge.members is not an array", JSON.stringify({ merge: { members: "ff-1" } })],
        ["a member lacks source_id", combinedMetadata([MEMBERS[0], { source: "google-meet" }])],
        ["a member has an empty source", combinedMetadata([{ source: "", source_id: "x" }, MEMBERS[1]])],
        ["a member is not an object", combinedMetadata([MEMBERS[0], 5])],
        ["a member is a bare string", combinedMetadata([MEMBERS[0], "gm-1"])],
      ];
      for (const [name, metadata] of unreadable) {
        test(`FAIL CLOSED: a combined row whose ${name} is itself excluded and hides nothing`, async () => {
          const db = seedDb(withCommitTable, [...baseRows, { ...combinedRow, metadata }]);
          try {
            expect(await ids(db)).toEqual({ ids: ["ff-1", "ff-other", "gm-1", "local-1"], lane: { state: "healthy" } });
          } finally { db.close(); }
        });
      }

      test("an unreadable combined row does not disturb a readable one next to it", async () => {
        const db = seedDb(withCommitTable, [
          ...baseRows,
          combinedRow,
          { id: "r-bad", source: "exo-merged", sourceId: "bad-1", metadata: "{oops" },
          { id: "r-bad2", source: "exo-merged", sourceId: "bad-2", metadata: combinedMetadata([{ source: "fireflies", source_id: "ff-other" }, 7]) },
        ]);
        try {
          // ff-other is named only by the unreadable bad-2 row: still listed.
          expect((await ids(db)).ids).toEqual([MERGED_ID, "ff-other", "local-1"].sort());
        } finally { db.close(); }
      });
    });
  }

  describe("discoverMeetingCorpus", () => {
    const keysUnder = (store: Record<string, string[]>) => ({
      list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: (store[path] ?? []).map((id) => `${path}${id}`) } }),
    });
    const prefix = (source: string, kind: "meeting" | "transcript") => `${CONNECTORS_KV_PREFIX}/${source}/${kind}/`;
    const kvStore = {
      [prefix("fireflies", "transcript")]: ["ff-1", "ff-other"],
      [prefix("google-meet", "transcript")]: ["gm-1"],
      [prefix("exo-merged", "transcript")]: [MERGED_ID],
    };

    test("one combined meeting; members vanish from the SQL and KV lanes; the combined body is read from its own KV key", async () => {
      const db = seedDb(true, [...baseRows, combinedRow]);
      try {
        const corpus = await discoverMeetingCorpus(
          sqliteTcw(db, [], { kv: keysUnder(kvStore) }),
        );
        const refs = corpus.candidates.map((c) => `${c.source}/${c.sourceId}`);
        expect(refs).toEqual(["exo-local/local-1", "exo-merged/merged-1", "fireflies/ff-other"]);
        const merged = corpus.candidates.find((c) => c.source === "exo-merged")!;
        expect(merged.hasLocalTranscript).toBe(true);
        expect(merged.localRowId).toBe("r-merged");
        // The default KV key of a body is the one a combined body is written under.
        expect(`${CONNECTORS_KV_PREFIX}/exo-merged/transcript/${MERGED_ID}`).toBe(`${prefix("exo-merged", "transcript")}${MERGED_ID}`);
      } finally { db.close(); }
    });

    test("a member's id can no longer be selected, not even as an already-selected thread meeting", async () => {
      const db = seedDb(true, [...baseRows, combinedRow]);
      try {
        const selected = { source: "fireflies", sourceId: "ff-1" };
        const corpus = await discoverMeetingCorpus(
          sqliteTcw(db, [], { kv: keysUnder(kvStore) }), undefined, undefined, selected,
        );
        expect(corpus.candidates.some((c) => c.sourceId === "ff-1" || c.sourceId === "gm-1")).toBe(false);
        const followUp = detectMeetingIntent("what did we decide in this meeting?", { now: new Date("2026-08-25T00:00:00.000Z") });
        expect(followUp).not.toBeNull();
        const selection = selectMeeting(followUp!, corpus, { selected });
        expect(selection.status === "selected" && selection.meeting.sourceId === "ff-1").toBe(false);
        // A fresh title search resolves to the combined meeting, never the member row.
        const byTitle = detectMeetingIntent("meeting called Title r-merged", { now: new Date("2026-08-25T00:00:00.000Z") });
        const found = selectMeeting(byTitle!, corpus);
        expect(found).toEqual(expect.objectContaining({ status: "selected", meeting: expect.objectContaining({ source: "exo-merged", sourceId: MERGED_ID }) }));
      } finally { db.close(); }
    });

    test("with no combined meeting no member lookup runs and nothing is hidden", async () => {
      const db = seedDb(true, baseRows);
      const queries: string[] = [];
      try {
        const corpus = await discoverMeetingCorpus(sqliteTcw(db, queries, { kv: keysUnder(kvStore) }));
        expect(queries).not.toContain(SQL_COMBINED_MEMBER_KEYS_QUERY);
        expect(corpus.candidates.map((c) => c.sourceId).sort()).toEqual(["ff-1", "ff-other", "gm-1", "local-1"]);
      } finally { db.close(); }
    });

    test("an unreadable combined row is not a candidate even if its body key exists, and hides no member", async () => {
      const db = seedDb(true, [...baseRows, { ...combinedRow, metadata: "{oops" }]);
      try {
        const corpus = await discoverMeetingCorpus(sqliteTcw(db, [], { kv: keysUnder(kvStore) }));
        const refs = corpus.candidates.map((c) => `${c.source}/${c.sourceId}`);
        expect(refs).toEqual(expect.arrayContaining(["fireflies/ff-1", "google-meet/gm-1"]));
        // Orphan body key only: opaque, so selection (which drops opaque KV-only identities) can never pick it.
        const orphan = corpus.candidates.find((c) => c.source === "exo-merged");
        expect(orphan === undefined || (orphan.localRowId === null && orphan.title === null)).toBe(true);
      } finally { db.close(); }
    });

    test("if the member lookup fails the members stay visible: never hide a meeting on an error", async () => {
      const db = seedDb(true, [...baseRows, combinedRow]);
      try {
        const real = sqliteTcw(db, [], { kv: keysUnder(kvStore) });
        const flaky = {
          ...real,
          sql: { db: () => ({ query: async (sql: string, ...rest: unknown[]) => (
            sql === SQL_COMBINED_MEMBER_KEYS_QUERY
              ? { ok: false, error: { code: "SQL_ERROR" } }
              : (real.sql.db("x") as unknown as { query: (s: string, ...r: unknown[]) => Promise<unknown> }).query(sql, ...rest)
          ) }) },
        } as unknown as TinyCloudWeb;
        const corpus = await discoverMeetingCorpus(flaky);
        expect(corpus.candidates.find((c) => c.sourceId === "ff-1")).toBeDefined();
      } finally { db.close(); }
    });
  });
});
