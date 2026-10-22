import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DEFAULT_PRIVACY_LEVEL,
  DETAILS_SCHEMA,
  MEETING_DB_DETAILS,
  MEETING_DB_SUMMARIES,
  MEETING_DB_TRANSCRIPTS,
  SUMMARIES_SCHEMA,
  TRANSCRIPTS_SCHEMA,
  assertExactMeetingDbPath,
  databasesForLevel,
  parseConnectorStateRow,
  parseDetailsRow,
  parseKeywordRow,
  parseParticipantRow,
  parseSourceRefRow,
} from "../src/index";

const SCHEMAS: Record<string, readonly string[]> = {
  details: DETAILS_SCHEMA,
  summaries: SUMMARIES_SCHEMA,
  transcripts: TRANSCRIPTS_SCHEMA,
};

function openWithSchema(statements: readonly string[]): Database {
  const db = new Database(":memory:");
  for (const sql of statements) db.exec(sql);
  return db;
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => row.name);
}

const VALID_MEETING = {
  id: "m-1",
  source: "transcriber",
  source_id: "src-1",
  title: "Weekly sync",
  started_at: "2025-01-02T10:00:00Z",
  duration_secs: 1800,
  meeting_type: "standup",
  content_kind: "transcript",
  has_summary: 1,
  has_transcript: 1,
  transcript_start_secs: 0,
  transcript_end_secs: 1800,
  coverage_status: "full",
  parent_meeting_id: null,
  created_at: "2025-01-02T10:30:00Z",
  updated_at: "2025-01-02T10:30:00Z",
  schema_version: 1,
};

describe("database paths", () => {
  test("are the exact app-scoped paths", () => {
    expect(MEETING_DB_DETAILS).toBe("xyz.tinycloud.tinychat/details");
    expect(MEETING_DB_SUMMARIES).toBe("xyz.tinycloud.tinychat/summaries");
    expect(MEETING_DB_TRANSCRIPTS).toBe("xyz.tinycloud.tinychat/transcripts");
  });
});

describe("schema DDL", () => {
  for (const [name, statements] of Object.entries(SCHEMAS)) {
    test(`${name} runs on an empty database and is idempotent`, () => {
      const db = openWithSchema(statements);
      const first = tableNames(db);
      for (const sql of statements) db.exec(sql);
      expect(tableNames(db)).toEqual(first);
      db.close();
    });
  }

  test("creates exactly the declared tables in each database", () => {
    expect(tableNames(openWithSchema(DETAILS_SCHEMA))).toEqual([
      "connector_state",
      "meeting",
      "meeting_keyword",
      "meeting_participant",
      "meeting_source_ref",
    ]);
    expect(tableNames(openWithSchema(SUMMARIES_SCHEMA))).toEqual(["meeting_action_item", "meeting_summary"]);
    expect(tableNames(openWithSchema(TRANSCRIPTS_SCHEMA))).toEqual(["meeting_transcript", "transcript_segment"]);
  });

  test("primary keys reject duplicate rows", () => {
    const details = openWithSchema(DETAILS_SCHEMA);
    details.run(
      "INSERT INTO meeting (id, source, created_at, updated_at, schema_version) VALUES ('m-1', 's', 't', 't', 1)",
    );
    expect(() =>
      details.run(
        "INSERT INTO meeting (id, source, created_at, updated_at, schema_version) VALUES ('m-1', 's', 't', 't', 1)",
      ),
    ).toThrow(/UNIQUE constraint failed/);

    details.run("INSERT INTO meeting_keyword (meeting_id, keyword) VALUES ('m-1', 'budget')");
    expect(() => details.run("INSERT INTO meeting_keyword (meeting_id, keyword) VALUES ('m-1', 'budget')")).toThrow(
      /UNIQUE constraint failed/,
    );

    const summaries = openWithSchema(SUMMARIES_SCHEMA);
    summaries.run("INSERT INTO meeting_action_item (meeting_id, ordinal, text) VALUES ('m-1', 0, 'follow up')");
    expect(() =>
      summaries.run("INSERT INTO meeting_action_item (meeting_id, ordinal, text) VALUES ('m-1', 0, 'again')"),
    ).toThrow(/UNIQUE constraint failed/);

    const transcripts = openWithSchema(TRANSCRIPTS_SCHEMA);
    transcripts.run("INSERT INTO transcript_segment (meeting_id, ordinal, text) VALUES ('m-1', 0, 'hi')");
    expect(() =>
      transcripts.run("INSERT INTO transcript_segment (meeting_id, ordinal, text) VALUES ('m-1', 0, 'hi')"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  test("required columns reject NULL", () => {
    const db = openWithSchema(DETAILS_SCHEMA);
    expect(() =>
      db.run("INSERT INTO meeting (id, source, created_at, updated_at, schema_version) VALUES ('m-2', NULL, 't', 't', 1)"),
    ).toThrow(/NOT NULL constraint failed/);
  });

  // Allowlists: a new column in any table fails here until the design is
  // changed on purpose. Column order follows the DDL declaration order.
  test("details database columns match the allowlist exactly", () => {
    const db = openWithSchema(DETAILS_SCHEMA);
    expect(Object.fromEntries(tableNames(db).map((t) => [t, columnNames(db, t)]))).toEqual({
      connector_state: ["connector_id", "last_synced_at", "status"],
      meeting: [
        "id",
        "source",
        "source_id",
        "title",
        "started_at",
        "duration_secs",
        "meeting_type",
        "content_kind",
        "has_summary",
        "has_transcript",
        "transcript_start_secs",
        "transcript_end_secs",
        "coverage_status",
        "parent_meeting_id",
        "created_at",
        "updated_at",
        "schema_version",
      ],
      meeting_keyword: ["meeting_id", "keyword"],
      meeting_participant: ["meeting_id", "ordinal", "display_name", "email", "role"],
      meeting_source_ref: ["meeting_id", "source", "source_id"],
    });
    db.close();
  });

  test("summaries database columns match the allowlist exactly", () => {
    const db = openWithSchema(SUMMARIES_SCHEMA);
    expect(Object.fromEntries(tableNames(db).map((t) => [t, columnNames(db, t)]))).toEqual({
      meeting_action_item: ["meeting_id", "ordinal", "text", "assignee", "due_at", "status"],
      meeting_summary: ["meeting_id", "summary", "updated_at", "revision"],
    });
    db.close();
  });

  test("transcripts database columns match the allowlist exactly", () => {
    const db = openWithSchema(TRANSCRIPTS_SCHEMA);
    expect(Object.fromEntries(tableNames(db).map((t) => [t, columnNames(db, t)]))).toEqual({
      meeting_transcript: ["meeting_id", "format", "language", "revision", "updated_at"],
      transcript_segment: ["meeting_id", "ordinal", "speaker", "start_secs", "end_secs", "text"],
    });
    db.close();
  });
});

describe("details row validation", () => {
  test("accepts a valid meeting row and returns only declared fields", () => {
    expect(parseDetailsRow(VALID_MEETING)).toEqual(VALID_MEETING);
  });

  test("fills omitted nullable fields with null", () => {
    const { title: _title, ...partial } = VALID_MEETING;
    expect(parseDetailsRow(partial).title).toBeNull();
  });

  for (const key of ["transcript", "summary", "body", "payload", "metadata"]) {
    test(`rejects a meeting row carrying "${key}"`, () => {
      expect(() => parseDetailsRow({ ...VALID_MEETING, [key]: "content" })).toThrow(/unknown field/);
    });
  }

  test("rejects object and array values", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, title: { text: "x" } })).toThrow(/must be a string/);
    expect(() => parseDetailsRow({ ...VALID_MEETING, title: ["x"] })).toThrow(/must be a string/);
  });

  test("rejects a 100 KB title and accepts one at the 500 character limit", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, title: "x".repeat(100_000) })).toThrow(/exceeds 500/);
    expect(parseDetailsRow({ ...VALID_MEETING, title: "x".repeat(500) }).title).toHaveLength(500);
  });

  test("rejects a missing id and non-flag has_summary values", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, id: null })).toThrow(/"id" is required/);
    expect(() => parseDetailsRow({ ...VALID_MEETING, has_summary: 2 })).toThrow(/must be 0 or 1/);
  });

  test("keyword limit is 100 characters", () => {
    expect(() => parseKeywordRow({ meeting_id: "m-1", keyword: "k".repeat(101) })).toThrow(/exceeds 100/);
    expect(parseKeywordRow({ meeting_id: "m-1", keyword: "k".repeat(100) }).keyword).toHaveLength(100);
  });

  test("participant, source-ref and connector-state rows reject unknown fields", () => {
    expect(() => parseParticipantRow({ meeting_id: "m-1", ordinal: 0, transcript: "x" })).toThrow(/unknown field/);
    expect(() => parseSourceRefRow({ meeting_id: "m-1", source: "s", source_id: "x", body: "y" })).toThrow(
      /unknown field/,
    );
    expect(() => parseConnectorStateRow({ connector_id: "c", status: "ok", payload: {} })).toThrow(/unknown field/);
  });

  test("non-object input is rejected", () => {
    expect(() => parseDetailsRow(null)).toThrow(/expected a plain object/);
    expect(() => parseDetailsRow([VALID_MEETING])).toThrow(/expected a plain object/);
  });

  test("rejects a negative duration", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, duration_secs: -1 })).toThrow(/non-negative integer/);
  });

  test("rejects negative transcript bounds", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, transcript_start_secs: -0.5, transcript_end_secs: 10 })).toThrow(
      /finite, non-negative/,
    );
    expect(() => parseDetailsRow({ ...VALID_MEETING, transcript_start_secs: 0, transcript_end_secs: -1 })).toThrow(
      /finite, non-negative/,
    );
  });

  test("rejects non-finite transcript bounds", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, transcript_end_secs: Infinity })).toThrow(/finite, non-negative/);
    expect(() => parseDetailsRow({ ...VALID_MEETING, transcript_end_secs: Number.NaN })).toThrow(/finite, non-negative/);
  });

  test("rejects a transcript end before its start", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, transcript_start_secs: 100, transcript_end_secs: 50 })).toThrow(
      /before transcript_start_secs/,
    );
  });

  test("accepts equal transcript bounds and a bound left null", () => {
    expect(parseDetailsRow({ ...VALID_MEETING, transcript_start_secs: 5, transcript_end_secs: 5 }).transcript_end_secs).toBe(5);
    expect(parseDetailsRow({ ...VALID_MEETING, transcript_start_secs: 5, transcript_end_secs: null }).transcript_end_secs).toBeNull();
  });

  test("rejects an empty or whitespace-only id", () => {
    expect(() => parseDetailsRow({ ...VALID_MEETING, id: "" })).toThrow(/"id" must not be blank/);
    expect(() => parseDetailsRow({ ...VALID_MEETING, id: "   " })).toThrow(/"id" must not be blank/);
  });

  test("rejects a negative participant ordinal and a blank meeting id", () => {
    expect(() => parseParticipantRow({ meeting_id: "m-1", ordinal: -1 })).toThrow(/non-negative integer/);
    expect(() => parseParticipantRow({ meeting_id: " ", ordinal: 0 })).toThrow(/must not be blank/);
  });
});

describe("privacy levels", () => {
  test("level 1 grants details only", () => {
    expect(databasesForLevel(1)).toEqual([MEETING_DB_DETAILS]);
  });

  test("level 2 grants details and summaries", () => {
    expect(databasesForLevel(2)).toEqual([MEETING_DB_DETAILS, MEETING_DB_SUMMARIES]);
  });

  test("level 3 grants all three databases", () => {
    expect(databasesForLevel(3)).toEqual([MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS]);
  });

  test("default level is 2", () => {
    expect(DEFAULT_PRIVACY_LEVEL).toBe(2);
  });

  test("unknown levels throw", () => {
    expect(() => databasesForLevel(4 as never)).toThrow(RangeError);
    expect(() => databasesForLevel("2" as never)).toThrow(RangeError);
  });

  test("every granted path passes the exact-path assertion", () => {
    for (const level of [1, 2, 3] as const) {
      for (const path of databasesForLevel(level)) {
        expect(() => assertExactMeetingDbPath(path)).not.toThrow();
      }
    }
  });
});

describe("exact path assertion", () => {
  test("accepts the three exact paths", () => {
    for (const path of [MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS]) {
      expect(() => assertExactMeetingDbPath(path)).not.toThrow();
    }
  });

  test("rejects a trailing slash", () => {
    expect(() => assertExactMeetingDbPath(`${MEETING_DB_DETAILS}/`)).toThrow(/not an exact meeting database path/);
  });

  test("rejects the bare app prefix, with or without a slash", () => {
    expect(() => assertExactMeetingDbPath("xyz.tinycloud.tinychat")).toThrow(/not an exact/);
    expect(() => assertExactMeetingDbPath("xyz.tinycloud.tinychat/")).toThrow(/not an exact/);
  });

  test("rejects any other path", () => {
    expect(() => assertExactMeetingDbPath("xyz.tinycloud.tinychat/threads")).toThrow(/not an exact/);
    expect(() => assertExactMeetingDbPath("xyz.tinycloud.tinychat/details ")).toThrow(/not an exact/);
    expect(() => assertExactMeetingDbPath("xyz.tinycloud.tinychat/Details")).toThrow(/not an exact/);
  });
});
