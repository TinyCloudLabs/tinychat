import { describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

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
    expect(sqlCalls[0].sql).toContain("FROM connector_meeting");
    expect(sqlCalls[0].sql).toContain("source IN (?, ?)");
    expect(sqlCalls[0].sql).toContain("ORDER BY started_at DESC");
  });

  it("defaults to fireflies, google-meet, the transcriber, exo local AND exo voice notes", async () => {
    const { tcw, sqlCalls } = fakeTcw({ sql: { ok: true, data: { rows: [] } } });
    await listMeetings(tcw);
    expect(sqlCalls[0].params).toEqual(["fireflies", "google-meet", "tinycloud-transcriber", "exo-local", "exo-voice-note", "exo-upload"]);
    expect(EXPLORER_MEETING_SOURCES).toEqual(["fireflies", "google-meet", "tinycloud-transcriber", "exo-local", "exo-voice-note", "exo-upload"]);
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
    expect(read.status === "ok" && read.meetings.map((m) => m.durationSecs)).toEqual([42, null]);
    expect(sqlCalls[0].sql).toContain("duration_secs");
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
