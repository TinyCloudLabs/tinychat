import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "@/capture/captureEvents";
import { CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "@/lib/connectors/connectorStore";
import { listMeetingsRead, readTranscript } from "@/lib/connectors/meetingExplorer";
import { readTranscriptCommit } from "@/lib/voiceNotes/voiceNoteCommits";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { SQL_MEETING_METADATA_QUERY } from "@/lib/meetingChat/corpus";
import { libraryRowMeta, libraryRowTitle } from "@/capture/library/LibraryRow";
import { parsePastedTranscript, pastedTranscriptProblem, PASTED_TRANSCRIPT_MAX_BYTES, savePastedTranscript } from "./pastedTranscript";

test("plain text retains its line breaks", () => {
  expect(parsePastedTranscript("First line\n\nSecond line")).toEqual([
    { index: 0, speaker_name: null, text: "First line\n\nSecond line", start_time: 0, end_time: 0 },
  ]);
});

test("speaker and timestamp lines become attributed, timed segments", () => {
  expect(parsePastedTranscript("[01:02] Alice: Hello\n[01:04] Bob: Hi")).toEqual([
    { index: 0, speaker_name: "Alice", text: "Hello", start_time: 62, end_time: 62 },
    { index: 1, speaker_name: "Bob", text: "Hi", start_time: 64, end_time: 64 },
  ]);
  expect(parsePastedTranscript("Alice: Hello\nBob: Hi").map((line) => line.speaker_name)).toEqual(["Alice", "Bob"]);
});

test("empty and oversized transcripts are rejected", () => {
  expect(pastedTranscriptProblem(" \n ")).not.toBeNull();
  expect(pastedTranscriptProblem("é".repeat(PASTED_TRANSCRIPT_MAX_BYTES / 2 + 1))).toContain("too large");
  expect(pastedTranscriptProblem("Hello")).toBeNull();
});

test("submit commits a transcript-only voice note and notifies the Library once", async () => {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const sql = { db(name: string) {
    expect(name).toBe(CONNECTORS_SQL_DB_NAME);
    return {
      async query(statement: string, params: unknown[] = []) {
        try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((row) => Object.values(row as object)) } }; }
        catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
      },
      async execute(statement: string, params: unknown[] = []) {
        try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
        catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
      },
    };
  } };
  const kv = {
    async put(key: string, value: string) { values.set(key, value); return { ok: true, data: {} }; },
    async get(key: string) { return values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND" } }; },
    async list({ path }: { path: string }) { return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } }; },
  };
  const tcw = { did: "did:test:pasted", spaceId: "pasted", sql, kv } as unknown as TinyCloudWeb;
  const events: unknown[] = [];
  const off = captureEvents.on("library-changed", (detail) => events.push(detail));
  try {
    const id = await savePastedTranscript(tcw, { text: "Alice: Hello\nBob: Hi", title: "Interview", date: "2026-10-13" });
    const row = sqlite.query("SELECT id, source, source_id, title, duration_secs, metadata FROM connector_meeting").get() as Record<string, unknown>;
    expect(row.id).toBe(`vn-${id}`);
    expect(row.source).toBe(VOICE_NOTE_SOURCE);
    expect(row.source_id).toBe(id);
    expect(row.title).toBe("Interview");
    expect(row.duration_secs).toBeNull();
    expect(JSON.parse(row.metadata as string)).toMatchObject({ source: "pasted", capture: "pasted", transcription_outcome: "transcribed" });
    expect([...values.keys()].some((key) => key.includes("/audio/"))).toBe(false);
    const commit = await readTranscriptCommit(tcw, id);
    expect(commit?.outcome).toBe("transcribed");
    expect(commit?.bodyKey).toContain(id);
    expect(values.get(transcriptKvKey(VOICE_NOTE_SOURCE, id))).toEqual(values.get(commit!.bodyKey));
    expect((await readTranscript(tcw, VOICE_NOTE_SOURCE, id, commit!.bodyKey)).sentences).toHaveLength(2);
    const library = await listMeetingsRead(tcw);
    expect(library.status).toBe("ok");
    if (library.status === "ok") {
      expect(library.meetings[0]).toMatchObject({ sourceId: id, metadata: { capture: "pasted" } });
      expect(libraryRowTitle(library.meetings[0]!)).toBe("Interview");
      expect(libraryRowMeta(library.meetings[0]!, new Date(), false)).toContain("Pasted transcript");
    }
    expect((sqlite.query(SQL_MEETING_METADATA_QUERY).get() as { source_id: string }).source_id).toBe(id);
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: id }]);
  } finally { off(); sqlite.close(); }
});
