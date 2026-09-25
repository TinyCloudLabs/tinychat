// Saving a transcriber meeting into the user's space: the mapping onto the shared connector
// store shape (connector_meeting row + sentence body), and the explorer registration.
import { describe, expect, test } from "bun:test";

import {
  TRANSCRIBER_MEETING_SOURCE,
  normalizeTranscriberTranscript,
  transcriberMeetingTitle,
} from "./transcriberSave";
import { EXPLORER_MEETING_SOURCES, meetingSourceLabel } from "./connectors/meetingExplorer";
import type { TranscriberMeeting, TranscriberTranscript } from "./transcriberApi";

const meeting: TranscriberMeeting = {
  id: "mtg_01ABC",
  status: "completed",
  platform: "jitsi",
  meeting_url: "https://meet.ffmuc.net/TinyCloudZcash",
  bot: { name: "TinyCloud Private Notetaker", joined_at: "2026-08-19T09:37:56.729Z" },
  created_at: "2026-08-19T09:37:35.245Z",
  started_at: "2026-08-19T09:37:56.729Z",
  ended_at: "2026-08-19T09:39:40.000Z",
};

const transcript: TranscriberTranscript = {
  meeting_id: "mtg_01ABC",
  status: "completed",
  language: "en",
  duration_seconds: 102.54,
  speakers: [
    { id: "speaker_0", name: "Alice" },
    { id: "speaker_1", name: "Alice" },
    { id: "speaker_2", name: " " },
  ],
  segments: [
    { id: "seg_001", speaker_id: "speaker_0", speaker_name: "Alice", start: 32.967, end: 33.967, text: "QUICK BROWN" },
    { id: "seg_002", speaker_id: "speaker_0", speaker_name: "Alice", start: 48.658, end: 50.39, text: "Hello from Alice." },
  ],
  text: "Alice: QUICK BROWN\nAlice: Hello from Alice.",
};

describe("normalizeTranscriberTranscript", () => {
  test("maps onto the connector store shape, keyed by (source, meeting id)", () => {
    const { meeting: row, sentences } = normalizeTranscriberTranscript(meeting, transcript);
    expect(row.source).toBe(TRANSCRIBER_MEETING_SOURCE);
    expect(row.sourceId).toBe("mtg_01ABC");
    expect(row.title).toBe("TinyCloudZcash (meet.ffmuc.net)");
    expect(row.startedAt).toBe("2026-08-19T09:37:56.729Z");
    expect(row.durationSecs).toBe(103);
    expect(row.participants).toEqual([{ name: "Alice", email: null }]);
    expect(row.metadata).toMatchObject({ meeting_url: meeting.meeting_url, platform: "jitsi", language: "en" });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sentences).toEqual([
      { index: 0, speaker_name: "Alice", text: "QUICK BROWN", start_time: 32.967, end_time: 33.967 },
      { index: 1, speaker_name: "Alice", text: "Hello from Alice.", start_time: 48.658, end_time: 50.39 },
    ]);
  });

  test("falls back to the last segment end for duration and to created_at for start", () => {
    const { meeting: row } = normalizeTranscriberTranscript(
      { ...meeting, started_at: null },
      { ...transcript, duration_seconds: undefined },
    );
    expect(row.durationSecs).toBe(50);
    expect(row.startedAt).toBe("2026-08-19T09:37:35.245Z");
  });

  test("an empty transcript still yields a row", () => {
    const { meeting: row, sentences } = normalizeTranscriberTranscript(meeting, {
      meeting_id: "mtg_01ABC",
      status: "completed",
    });
    expect(sentences).toEqual([]);
    expect(row.durationSecs).toBeNull();
    expect(row.participants).toEqual([]);
  });

  test("title degrades to the raw url", () => {
    expect(transcriberMeetingTitle({ meeting_url: "garbage" })).toBe("garbage");
  });
});

describe("explorer registration", () => {
  test("the transcriber source is listed and labelled", () => {
    expect(EXPLORER_MEETING_SOURCES).toContain(TRANSCRIBER_MEETING_SOURCE);
    expect(meetingSourceLabel(TRANSCRIBER_MEETING_SOURCE)).toBe("TinyCloud Transcriber");
  });
});


test("saving a transcript retains capture evidence and transcription provenance", () => {
  const capture = { completion_reason: "evicted", provider_status: "completed", exit_code: 0 };
  const { meeting: row } = normalizeTranscriberTranscript(meeting, {
    ...transcript, capture, provider: "vexa", fallback_from: "tinfoil", fallback_reason: "no_usable_recording",
  });
  expect(row.metadata).toMatchObject({ capture, transcript_provider: "vexa", fallback_from: "tinfoil", fallback_reason: "no_usable_recording" });
});

import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { saveTranscriberMeeting, listSavedTranscriberMeetingIds } from "./transcriberSave";
import { transcriptKvKey } from "./connectors/connectorStore";
import { syncTranscriberLibrary } from "../chat/useTranscriberLibrarySync";
import type { TranscriberClient } from "./transcriberApi";

function libraryFixture() {
  const sql = new Database(":memory:");
  const bodies = new Map<string, string>();
  let failWrite = true;
  let writes = 0;
  const wrap = <T,>(fn: () => T) => {
    try { return { ok: true, data: fn() }; }
    catch { return { ok: false, error: { code: "SQL_ERROR", message: "sql failed" } }; }
  };
  const tcw = {
    did: `did:test:${crypto.randomUUID()}`,
    sql: { db: () => ({
      execute: async (query: string, params: unknown[] = []) => wrap(() => sql.query(query).run(...params as never[])),
      query: async (query: string, params: unknown[] = []) => wrap(() => ({ rows: sql.query(query).values(...params as never[]) })),
    }) },
    kv: {
      get: async (key: string) => bodies.has(key) ? { ok: true, data: { data: bodies.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } },
      put: async (key: string, value: string) => {
        writes++;
        if (failWrite) { failWrite = false; return { ok: false, error: { code: "KV_WRITE_FAILED", message: "temporary" } }; }
        bodies.set(key, value); return { ok: true };
      },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, sql, bodies, writes: () => writes, allowWrites: () => { failWrite = false; } };
}

for (const empty of [false, true]) {
  test(`SQL success then KV failure is repaired after reload (${empty ? "empty" : "nonempty"} transcript)`, async () => {
    const f = libraryFixture();
    const body = { ...transcript, segments: empty ? [] : transcript.segments };
    expect((await saveTranscriberMeeting(f.tcw, meeting, body)).ok).toBe(false);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM connector_meeting").get()).toEqual({ n: 1 });
    expect(await listSavedTranscriberMeetingIds(f.tcw)).toEqual({ ok: true, data: [] });
    // A new mount has no in-memory knowledge of the failed import. A complete
    // SQL row alone must not suppress this retry.
    const saved: Record<string, string> = {};
    let fetches = 0;
    const client = {
      list: async () => ({ status: "ok", value: { meetings: [meeting] } }),
      transcript: async () => { fetches++; return { status: "ok", value: { status: "ready", transcript: body } }; },
    } as unknown as TranscriberClient;
    await syncTranscriberLibrary({ tcw: f.tcw, client, onState: (id, state) => { saved[id] = state; } });
    expect(saved[meeting.id]).toBe("saved");
    expect(f.sql.query("SELECT COUNT(*) AS n FROM connector_meeting").get()).toEqual({ n: 1 });
    const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
    expect(JSON.parse(f.bodies.get(key)!)).toHaveLength(empty ? 0 : 2);
    expect(await listSavedTranscriberMeetingIds(f.tcw)).toEqual({ ok: true, data: [meeting.id] });
    // Another return reads completeness, avoiding both fetches and body rewrites.
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(fetches).toBe(1);
    expect(f.writes()).toBe(2);
    f.sql.close();
  });
}

test("repair preserves a manually edited title and existing transcript bodies", async () => {
  const f = libraryFixture(); f.allowWrites();
  expect((await saveTranscriberMeeting(f.tcw, meeting, transcript)).ok).toBe(true);
  f.sql.query("UPDATE connector_meeting SET title = ?").run("My custom title");
  const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const existing = f.bodies.get(key);
  expect((await saveTranscriberMeeting(f.tcw, { ...meeting, metadata: {
    source: "google-calendar-autojoin", calendar_title: "Changed calendar title", scheduled_start: "2026-08-19T09:30:00Z",
  } }, { ...transcript, segments: [] })).ok).toBe(true);
  expect(f.sql.query("SELECT title FROM connector_meeting").get()).toEqual({ title: "My custom title" });
  expect(f.bodies.get(key)).toBe(existing);
  expect(f.writes()).toBe(1);
  f.sql.close();
});

test("autojoin uses Calendar title and scheduled start; manual recordings keep their URL title", () => {
  const row = normalizeTranscriberTranscript({ ...meeting, metadata: {
    source: "google-calendar-autojoin", calendar_title: "Weekly planning", scheduled_start: "2026-08-19T09:30:00Z",
  } }, transcript).meeting;
  expect(row.title).toBe("Weekly planning");
  expect(row.startedAt).toBe("2026-08-19T09:30:00Z");
  expect(normalizeTranscriberTranscript({ ...meeting, metadata: { calendar_title: "Ignore me" } }, transcript).meeting.title)
    .toBe("TinyCloudZcash (meet.ffmuc.net)");
});

test("per-recording failures are isolated, and a locked/unmounted session performs no work", async () => {
  const f = libraryFixture(); f.allowWrites();
  let lists = 0;
  const states: Record<string, string> = {};
  const client = {
    list: async () => { lists++; return { status: "ok", value: { meetings: [{ ...meeting, id: "broken" }, meeting] } }; },
    transcript: async (id: string) => {
      if (id === "broken") throw new Error("recording unavailable");
      return { status: "ok", value: { status: "ready", transcript } };
    },
  } as unknown as TranscriberClient;
  await syncTranscriberLibrary({ tcw: f.tcw, client, isCurrent: () => false });
  expect(lists).toBe(0);
  await syncTranscriberLibrary({ tcw: f.tcw, client, onState: (id, state) => { states[id] = state; } });
  expect(states).toEqual({ broken: "error", [meeting.id]: "saved" });
  f.sql.close();
});

test("a failed completeness read is isolated and never overwrites the unreadable body", async () => {
  const f = libraryFixture(); f.allowWrites();
  expect((await saveTranscriberMeeting(f.tcw, meeting, transcript)).ok).toBe(true);
  const brokenKey = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const get = f.tcw.kv.get.bind(f.tcw.kv);
  f.tcw.kv.get = (async (key: string) => key === brokenKey
    ? { ok: false, error: { code: "TRANSPORT_ERROR", message: "not available" } }
    : get(key)) as typeof f.tcw.kv.get;
  const second = { ...meeting, id: "recording-2" };
  const states: Record<string, string> = {};
  const client = {
    list: async () => ({ status: "ok", value: { meetings: [meeting, second] } }),
    transcript: async () => ({ status: "ok", value: { status: "ready", transcript } }),
  } as unknown as TranscriberClient;
  await syncTranscriberLibrary({ tcw: f.tcw, client, onState: (id, state) => { states[id] = state; } });
  expect(states).toEqual({ [meeting.id]: "error", [second.id]: "saved" });
  expect(f.writes()).toBe(2);
  f.sql.close();
});
