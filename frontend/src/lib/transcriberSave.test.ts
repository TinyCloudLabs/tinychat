// Saving a transcriber meeting into the user's space: the mapping onto the shared connector
// store shape (connector_meeting row + sentence body), and the explorer registration.
import { describe, expect, spyOn, test } from "bun:test";
import type { DelegatedAccess } from "@tinyboilerplate/server";
import { archiveKvKey, ensureConnectorSchema, writeTranscriberMeeting } from "@tinyboilerplate/core";
import { delegatedConnectorPort } from "../../../backend/src/services/user-space-port";
import { webConnectorPort } from "./connectors/connectorPort";

import {
  TRANSCRIBER_MEETING_SOURCE,
  normalizeTranscriberTranscript,
  transcriberMeetingTitle,
} from "./transcriberSave";
import { EXPLORER_MEETING_SOURCES, meetingSourceLabel, transcriptCopyText } from "./connectors/meetingExplorer";
import { captureEvents } from "../capture/captureEvents";
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
  test("unattributed speakers become null and never become participants", async () => {
    const names = ["Unknown", "  Unknown  ", null, "", "  ", "Alice", "unknown", "Unknown Person"];
    const { meeting: row, sentences, body } = await normalizeTranscriberTranscript(meeting, {
      ...transcript,
      speakers: names.map((name, i) => ({ id: `speaker_${i}`, name })),
      segments: names.map((speaker_name, i) => ({
        id: `seg_${i}`, speaker_id: `speaker_${i}`, speaker_name, start: i, end: i + 1, text: `Line ${i}.`,
      })),
    });
    expect(sentences.map((s) => s.speaker_name)).toEqual([null, null, null, null, null, "Alice", "unknown", "Unknown Person"]);
    expect(row.participants).toEqual([
      { name: "Alice", email: null }, { name: "unknown", email: null }, { name: "Unknown Person", email: null },
    ]);
    expect(JSON.parse(body)).toEqual(sentences);
    expect(transcriptCopyText(sentences)).toBe("Line 0.\nLine 1.\nLine 2.\nLine 3.\nLine 4.\nAlice: Line 5.\nunknown: Line 6.\nUnknown Person: Line 7.");
  });

  test("maps onto the connector store shape, keyed by (source, meeting id)", async () => {
    const { meeting: row, sentences } = await normalizeTranscriberTranscript(meeting, transcript);
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

  test("falls back to the last segment end for duration and to created_at for start", async () => {
    const { meeting: row } = await normalizeTranscriberTranscript(
      { ...meeting, started_at: null },
      { ...transcript, duration_seconds: undefined },
    );
    expect(row.durationSecs).toBe(50);
    expect(row.startedAt).toBe("2026-08-19T09:37:35.245Z");
  });

  test("an empty transcript still yields a row", async () => {
    const { meeting: row, sentences } = await normalizeTranscriberTranscript(meeting, {
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


test("saving a transcript retains capture evidence and transcription provenance", async () => {
  const capture = { completion_reason: "evicted", provider_status: "completed", exit_code: 0 };
  const { meeting: row } = await normalizeTranscriberTranscript(meeting, {
    ...transcript, capture, provider: "vexa", fallback_from: "tinfoil", fallback_reason: "no_usable_recording",
  });
  expect(row.metadata).toMatchObject({ capture, transcript_provider: "vexa", fallback_from: "tinfoil", fallback_reason: "no_usable_recording" });
});

import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { saveTranscriberMeeting, listSavedTranscriberMeetingIds, listSavedTranscriberVersions, refreshTranscriberMeeting as refreshWithUpstream } from "./transcriberSave";
const refreshTranscriberMeeting = (
  tcw: TinyCloudWeb, row: TranscriberMeeting, body: TranscriberTranscript,
  fetchTranscript: () => Promise<TranscriberTranscript | null> = async () => null,
) => refreshWithUpstream(tcw, row, body, fetchTranscript);
import { transcriptKvKey } from "./connectors/connectorStore";
import { syncTranscriberLibrary } from "../chat/useTranscriberLibrarySync";
import type { TranscriberClient } from "./transcriberApi";
import { resetSpaceLaneForTests, runOnSpaceLane } from "./spaceWriteLane";
import { setVoiceNoteSaveDeadlineForTests } from "./voiceNotes/saveDeadline";
import { createTranscriberClient } from "./transcriberApi";
import { createTranscriptionApiClient, type TranscriptionTranscript } from "../../../backend/src/services/transcription-api";
import type { SessionStore } from "@tinyboilerplate/client";

function libraryFixture() {
  const sql = new Database(":memory:");
  const bodies = new Map<string, string>();
  let failWrite = true;
  let writes = 0;
  let updates = 0;
  let failUpdate = false;
  let failVersions = false;
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const wrap = <T,>(fn: () => T) => {
    try { return { ok: true, data: fn() }; }
    catch { return { ok: false, error: { code: "SQL_ERROR", message: "sql failed" } }; }
  };
  const tcw = {
    did: `did:test:${crypto.randomUUID()}`,
    sql: { db: () => ({
      execute: async (query: string, params: unknown[] = []) => wrap(() => {
        if (/^\s*UPDATE connector_meeting\b/i.test(query)) {
          updates++;
          if (failUpdate) { failUpdate = false; throw new Error("update failed"); }
        }
        if (/^\s*INSERT INTO connector_meeting\b/i.test(query)) inserts.push({ sql: query, params });
        return sql.query(query).run(...params as never[]);
      }),
      query: async (query: string, params: unknown[] = []) => wrap(() => {
        if (failVersions && query.includes("json_extract")) throw new Error("unsupported");
        return { rows: sql.query(query).values(...params as never[]) };
      }),
    }) },
    kv: {
      get: async (key: string) => bodies.has(key) ? { ok: true, data: { data: bodies.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } },
      put: async (key: string, value: string, options?: { ifNoneMatch?: string }) => {
        writes++;
        if (failWrite) { failWrite = false; return { ok: false, error: { code: "KV_WRITE_FAILED", message: "temporary" } }; }
        if (options?.ifNoneMatch === "*" && bodies.has(key)) {
          return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "already present" } };
        }
        bodies.set(key, value); return { ok: true };
      },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, sql, bodies, inserts, writes: () => writes, updates: () => updates,
    allowWrites: () => { failWrite = false; }, failUpdateOnce: () => { failUpdate = true; },
    failVersionReads: () => { failVersions = true; } };
}

test("ptx null speakers pass through both API clients and both storage writers without labels", async () => {
  const upstream: TranscriptionTranscript = {
    meeting_id: meeting.id, status: "completed",
    speakers: [{ id: "speaker_0", name: "Alice" }],
    segments: [
      { id: "seg_0", speaker_id: "unknown", speaker_name: null, start: 0, end: 1, text: "Unattributed words." },
      { id: "seg_1", speaker_id: "speaker_0", speaker_name: "Alice", start: 1, end: 2, text: "Hello." },
    ],
  };
  const api = createTranscriptionApiClient({
    baseUrl: "https://ptx.example", apiKey: "test-key",
    fetchImpl: (async () => Response.json(upstream)) as typeof fetch,
  });
  const backendResult = await api.getTranscript(meeting.id);
  if (backendResult.pending) throw new Error("Expected a completed transcript");
  expect(backendResult.transcript).toEqual(upstream);
  const client = createTranscriberClient("https://backend.example", {
    sessionStore: { getToken: () => "test-session", isExpired: () => false } as SessionStore,
    fetchImpl: (async () => Response.json(backendResult.transcript)) as typeof fetch,
  });
  const browserResult = await client.transcript(meeting.id);
  if (browserResult.status !== "ok" || browserResult.value.status !== "ready") throw new Error("Expected a ready transcript");
  expect(browserResult.value.transcript).toEqual(upstream);
  const expected = [
    { index: 0, speaker_name: null, text: "Unattributed words.", start_time: 0, end_time: 1 },
    { index: 1, speaker_name: "Alice", text: "Hello.", start_time: 1, end_time: 2 },
  ];
  for (const writer of ["browser", "backend"]) {
    const f = libraryFixture(); f.allowWrites();
    try {
      if (writer === "browser") {
        expect((await saveTranscriberMeeting(f.tcw, meeting, browserResult.value.transcript)).ok).toBe(true);
      } else {
        expect((await ensureConnectorSchema(webConnectorPort(f.tcw))).ok).toBe(true);
        const access = { sql: f.tcw.sql, kv: f.tcw.kv } as unknown as DelegatedAccess;
        const { gaps: _unvalidatedGaps, ...backendTranscript } = backendResult.transcript;
        const normalized = await normalizeTranscriberTranscript(meeting, backendTranscript);
        expect((await writeTranscriberMeeting(delegatedConnectorPort(access, async (operation) => operation()), normalized, { ensureSchema: false })).ok).toBe(true);
      }
      expect(f.sql.query("SELECT participants FROM connector_meeting").get())
        .toEqual({ participants: JSON.stringify([{ name: "Alice", email: null }]) });
      const stored = JSON.parse(f.bodies.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id))!);
      expect(stored).toEqual(expected);
      expect(transcriptCopyText(stored)).toBe("Unattributed words.\nAlice: Hello.");
    } finally { f.sql.close(); }
  }
});

for (const empty of [false, true]) {
  test(`SQL success then KV failure is repaired after reload (${empty ? "empty" : "nonempty"} transcript)`, async () => {
    const f = libraryFixture();
    const body = { ...transcript, segments: empty ? [] : transcript.segments };
    expect((await saveTranscriberMeeting(f.tcw, meeting, body)).ok).toBe(false);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM connector_meeting").get()).toEqual({ n: 1 });
    expect(await listSavedTranscriberMeetingIds(f.tcw)).toEqual({ ok: true, data: { saved: [], unknown: [meeting.id] } });
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
    expect(await listSavedTranscriberMeetingIds(f.tcw)).toEqual({ ok: true, data: { saved: [meeting.id], unknown: [] } });
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
  f.sql.close();
});
test("browser and backend ports persist identical connector rows and transcript bytes", async () => {
  const browser = libraryFixture(); browser.allowWrites();
  const backend = libraryFixture(); backend.allowWrites();
  try {
    const normalized = await normalizeTranscriberTranscript(meeting, transcript);
    const browserResult = await saveTranscriberMeeting(browser.tcw, meeting, transcript);
    expect(browserResult.ok).toBe(true);
    expect((await ensureConnectorSchema(webConnectorPort(backend.tcw))).ok).toBe(true);
    const access = { sql: backend.tcw.sql, kv: backend.tcw.kv } as unknown as DelegatedAccess;
    const backendResult = await writeTranscriberMeeting(
      delegatedConnectorPort(access, async (operation) => operation()), normalized, { ensureSchema: false },
    );
    expect(backendResult).toMatchObject({ ok: true, data: { id: normalized.meeting.id, row: "inserted", body: "written" } });
    expect(browser.inserts[0]!.sql).toBe(backend.inserts[0]!.sql);
    // created_at and updated_at are independent operation timestamps.
    expect(browser.inserts[0]!.params.slice(0, -2)).toEqual(backend.inserts[0]!.params.slice(0, -2));
    const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
    expect(browser.bodies.get(key)).toBe(normalized.body);
    expect(backend.bodies.get(key)).toBe(normalized.body);
    const stableColumns = `SELECT id, source, source_id, title, started_at, duration_secs,
      organizer_email, participants, summary_overview, summary_action_items, keywords, meeting_type, metadata
      FROM connector_meeting`;
    expect(browser.sql.query(stableColumns).get()).toEqual(backend.sql.query(stableColumns).get());
  } finally { browser.sql.close(); backend.sql.close(); }
});

test("interleaved browser and backend writers leave one row and preserve a legacy body", async () => {
  const f = libraryFixture(); f.allowWrites();
  try {
    expect((await ensureConnectorSchema(webConnectorPort(f.tcw))).ok).toBe(true);
    const normalized = await normalizeTranscriberTranscript(meeting, transcript);
    const access = { sql: f.tcw.sql, kv: f.tcw.kv } as unknown as DelegatedAccess;
    const [browser, backend] = await Promise.all([
      saveTranscriberMeeting(f.tcw, meeting, transcript),
      writeTranscriberMeeting(delegatedConnectorPort(access, async (operation) => operation()), normalized, { ensureSchema: false }),
    ]);
    expect(browser.ok).toBe(true);
    expect(backend.ok).toBe(true);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM connector_meeting").get()).toEqual({ n: 1 });
    const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
    expect(f.bodies.get(key)).toBe(normalized.body);
    const legacy = "11111111-1111-4111-8111-111111111111";
    f.sql.query("UPDATE connector_meeting SET id = ?, title = ?").run(legacy, "Manually edited");
    f.bodies.set(key, "manually edited transcript");
    expect((await writeTranscriberMeeting(
      delegatedConnectorPort(access, async (operation) => operation()), normalized, { ensureSchema: false },
    ))).toMatchObject({ ok: true, data: { id: legacy, row: "existing", body: "exists" } });
    expect(f.sql.query("SELECT id, title FROM connector_meeting").get()).toEqual({ id: legacy, title: "Manually edited" });
    expect(f.bodies.get(key)).toBe("manually edited transcript");
  } finally { f.sql.close(); }
});


test("autojoin uses Calendar title and scheduled start; manual recordings keep their URL title", async () => {
  const row = (await normalizeTranscriberTranscript({ ...meeting, metadata: {
    source: "google-calendar-autojoin", calendar_title: "Weekly planning", scheduled_start: "2026-08-19T09:30:00Z",
  } }, transcript)).meeting;
  expect(row.title).toBe("Weekly planning");
  expect(row.startedAt).toBe("2026-08-19T09:30:00Z");
  expect((await normalizeTranscriberTranscript({ ...meeting, metadata: { calendar_title: "Ignore me" } }, transcript)).meeting.title)
    .toBe("TinyCloudZcash (meet.ffmuc.net)");
});

test("the browser defers to server delivery for ten minutes, then repairs a missing body", async () => {
  const f = libraryFixture(); f.allowWrites();
  const completed = Date.parse("2026-10-08T10:00:00Z");
  const recent = { ...meeting, completed_at: new Date(completed).toISOString() };
  const states: Record<string, string> = {};
  let fetches = 0;
  let now = completed + 9 * 60_000;
  const client = {
    list: async () => ({ status: "ok", value: { meetings: [recent] } }),
    transcript: async () => { fetches++; return { status: "ok", value: { status: "ready", transcript } }; },
  } as unknown as TranscriberClient;
  try {
    const sync = () => syncTranscriberLibrary({
      tcw: f.tcw, client, deliveryActive: () => true, now: () => now,
      onState: (id, state) => { states[id] = state; },
    });
    await sync();
    expect(states[meeting.id]).toBe("saving");
    expect(fetches).toBe(0);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM connector_meeting").get()).toEqual({ n: 0 });
    now = completed + 10 * 60_000;
    await sync();
    expect(states[meeting.id]).toBe("saved");
    expect(fetches).toBe(1);
    expect(f.bodies.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id))).toBe(JSON.stringify(
      (await normalizeTranscriberTranscript(meeting, transcript)).sentences,
    ));
  } finally { f.sql.close(); }
});

test("a meeting shared into this list (TC-581) is imported at once even with server delivery active", async () => {
  const f = libraryFixture(); f.allowWrites();
  const ended = Date.parse("2026-10-08T10:00:00Z");
  const shared = { ...meeting, ended_at: new Date(ended).toISOString(), metadata: { source: "google-calendar-autojoin", shared: true } };
  let fetches = 0;
  const client = {
    list: async () => ({ status: "ok", value: { meetings: [shared] } }),
    transcript: async () => { fetches++; return { status: "ok", value: { status: "ready", transcript } }; },
  } as unknown as TranscriberClient;
  try {
    await syncTranscriberLibrary({ tcw: f.tcw, client, deliveryActive: () => true, now: () => ended + 60_000 });
    expect(fetches).toBe(1);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM connector_meeting").get()).toEqual({ n: 1 });
  } finally { f.sql.close(); }
});

test("without server delivery or a completion timestamp, the browser imports immediately", async () => {
  for (const row of [{ ...meeting, completed_at: "2026-10-08T10:00:00Z" }, { ...meeting, ended_at: null }]) {
    const f = libraryFixture(); f.allowWrites();
    let fetches = 0;
    const client = {
      list: async () => ({ status: "ok", value: { meetings: [row] } }),
      transcript: async () => { fetches++; return { status: "ok", value: { status: "ready", transcript } }; },
    } as unknown as TranscriberClient;
    try {
      await syncTranscriberLibrary({
        tcw: f.tcw, client, deliveryActive: () => !("completed_at" in row), now: () => Date.parse("2026-10-08T10:01:00Z"),
      });
      expect(fetches).toBe(1);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM connector_meeting").get()).toEqual({ n: 1 });
    } finally { f.sql.close(); }
  }
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

test("notetaker sync refreshes for newly imported and newly observed remote meetings, not mount history or failures", async () => {
  const f = libraryFixture();
  const changed: Array<{ source: string; sourceId: string } | undefined> = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changed.push(detail));
  const savedIds = ["initial"];
  const observedSaved = { initialized: false, ids: new Set<string>() };
  const rows = [{ ...meeting, id: "initial" }, meeting, { ...meeting, id: "broken" }];
  const client = {
    list: async () => ({ status: "ok", value: { meetings: rows } }),
    transcript: async () => ({ status: "ok", value: { status: "ready", transcript } }),
  } as unknown as TranscriberClient;
  const saver = {
    listSaved: async () => ({ ok: true, data: { saved: savedIds, unknown: [] } }),
    save: async (_: TinyCloudWeb, row: TranscriberMeeting) => {
      if (row.id === "broken") return { ok: false };
      savedIds.push(row.id);
      return { ok: true };
    },
  };
  try {
    await syncTranscriberLibrary({ tcw: f.tcw, client, saver, observedSaved });
    expect(changed).toEqual([{ source: TRANSCRIBER_MEETING_SOURCE, sourceId: meeting.id }]);
    rows.push({ ...meeting, id: "external" });
    savedIds.push("external"); // Another tab saved it; this tab has never observed it.
    await syncTranscriberLibrary({ tcw: f.tcw, client, saver, observedSaved });
    expect(changed).toEqual([
      { source: TRANSCRIBER_MEETING_SOURCE, sourceId: meeting.id },
      { source: TRANSCRIBER_MEETING_SOURCE, sourceId: "external" },
    ]);
    await syncTranscriberLibrary({ tcw: f.tcw, client, saver, observedSaved });
    expect(changed).toHaveLength(2);
  } finally {
    unsubscribe();
    f.sql.close();
  }
});

test("server-delivered notetaker transcript refreshes once without a browser fallback", async () => {
  const f = libraryFixture(); f.allowWrites();
  const completedAt = "2026-10-08T10:00:00Z";
  const initial = { ...meeting, completed_at: completedAt };
  const delivered = { ...meeting, id: "server-delivered", completed_at: completedAt };
  const rows = [initial];
  let fetches = 0;
  const client = {
    list: async () => ({ status: "ok", value: { meetings: rows } }),
    transcript: async () => { fetches++; return { status: "error" }; },
  } as unknown as TranscriberClient;
  const observedSaved = { initialized: false, ids: new Set<string>() };
  const changes: Array<{ source: string; sourceId: string } | undefined> = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail));
  const sync = () => syncTranscriberLibrary({
    tcw: f.tcw, client, observedSaved, deliveryActive: () => true,
    now: () => Date.parse(completedAt) + 60_000,
  });
  try {
    expect((await saveTranscriberMeeting(f.tcw, initial, transcript)).ok).toBe(true);
    await sync();
    expect(changes).toEqual([]); // Existing meeting is the mounted baseline.

    const normalized = await normalizeTranscriberTranscript(delivered, transcript);
    const access = { sql: f.tcw.sql, kv: f.tcw.kv } as unknown as DelegatedAccess;
    expect(await writeTranscriberMeeting(
      delegatedConnectorPort(access, async (operation) => operation()), normalized, { ensureSchema: false },
    )).toMatchObject({ ok: true, data: { row: "inserted", body: "written" } });
    rows.push(delivered);
    await sync();
    await sync();
    expect(changes).toEqual([{ source: TRANSCRIBER_MEETING_SOURCE, sourceId: delivered.id }]);
    expect(fetches).toBe(0); // The server already landed both the row and body inside the grace window.
  } finally {
    unsubscribe();
    f.sql.close();
  }
});
test("notetaker save finishing after sign-out does not refresh the next account", async () => {
  const f = libraryFixture();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  const started = Promise.withResolvers<void>();
  let current = true;
  const changed: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", () => changed.push("refresh"));
  const client = {
    list: async () => ({ status: "ok", value: { meetings: [meeting] } }),
    transcript: async () => ({ status: "ok", value: { status: "ready", transcript } }),
  } as unknown as TranscriberClient;
  try {
    const run = syncTranscriberLibrary({
      tcw: f.tcw, client, isCurrent: () => current,
      saver: {
        listSaved: async () => ({ ok: true, data: { saved: [], unknown: [] } }),
        save: () => { started.resolve(); return pending.promise; },
      },
    });
    await started.promise;
    current = false;
    pending.resolve({ ok: true });
    await run;
    expect(changed).toEqual([]);
  } finally {
    unsubscribe();
    f.sql.close();
  }
});

test("an unreadable completeness check cannot overwrite an existing body or stall other meetings", async () => {
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
  expect(states).toEqual({ [meeting.id]: "saved", [second.id]: "saved" });
  expect(f.bodies.get(brokenKey)).toBe((await normalizeTranscriberTranscript(meeting, transcript)).body);
  f.sql.close();
});

test("each saved-meeting completeness read gets its own scheduled lane turn", async () => {
  const f = libraryFixture(); f.allowWrites();
  expect((await saveTranscriberMeeting(f.tcw, meeting, transcript)).ok).toBe(true);
  let reads = 0;
  const result = await listSavedTranscriberMeetingIds(f.tcw, async (read) => {
    reads++;
    return read();
  });
  expect(result).toEqual({ ok: true, data: { saved: [meeting.id], unknown: [] } });
  // One SQL source-id query plus one KV body check for this saved meeting.
  expect(reads).toBe(2);
  f.sql.close();
});

test("slow listSaved is not subject to the per-call voice-note deadline", async () => {
  resetSpaceLaneForTests();
  setVoiceNoteSaveDeadlineForTests(5);
  let release!: (result: { ok: boolean; data: string[] }) => void;
  let settleKind: "resolved" | "rejected" | null = null;
  const client = { list: async () => ({ status: "ok", value: { meetings: [] } }) } as unknown as TranscriberClient;
  const sync = syncTranscriberLibrary({
    tcw: {} as TinyCloudWeb,
    client,
    saver: {
      listSaved: async (_tcw, scheduleRead) => scheduleRead!(
        () => new Promise((resolve) => { release = resolve; }),
      ),
      save: async () => ({ ok: true }),
    },
  }).then(() => { settleKind = "resolved" as const; }, () => { settleKind = "rejected" as const; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settleKind).toBeNull();
    release({ ok: true, data: { saved: [], unknown: [] } });
    await sync;
    expect(settleKind).toBe("resolved");
  } finally {
    setVoiceNoteSaveDeadlineForTests(null);
  }
});

test("a queued completeness read skips after sign-out so a new-session save can use the lane", async () => {
  resetSpaceLaneForTests();
  let releaseLane!: () => void;
  let enteredLane!: () => void;
  const laneGate = new Promise<void>((resolve) => { releaseLane = resolve; });
  const laneEntered = new Promise<void>((resolve) => { enteredLane = resolve; });
  const occupying = runOnSpaceLane(async () => { enteredLane(); await laneGate; }, undefined, "background");
  await laneEntered;

  let current = true;
  let announceReadQueued!: () => void;
  const readQueued = new Promise<void>((resolve) => { announceReadQueued = resolve; });
  let oldAccountReads = 0;
  const client = { list: async () => ({ status: "ok", value: { meetings: [] } }) } as unknown as TranscriberClient;
  const sync = syncTranscriberLibrary({
    tcw: {} as TinyCloudWeb,
    client,
    isCurrent: () => current,
    saver: {
      listSaved: async (_tcw, scheduleRead) => {
        announceReadQueued();
        await scheduleRead!(() => { oldAccountReads++; return Promise.resolve("old account read"); });
        return { ok: true, data: { saved: [], unknown: [] } };
      },
      save: async () => ({ ok: true }),
    },
  });
  await readQueued;
  current = false;
  const newSessionSave = runOnSpaceLane(async () => "new session save");
  releaseLane();
  try {
    await occupying;
    await expect(newSessionSave).resolves.toBe("new session save");
    await sync;
    expect(oldAccountReads).toBe(0);
  } finally {
    releaseLane();
  }
});

test("a voice-note lane save runs while the meetings list request is pending", async () => {
  resetSpaceLaneForTests();
  let releaseList!: (result: Awaited<ReturnType<TranscriberClient["list"]>>) => void;
  let announceList!: () => void;
  const listStarted = new Promise<void>((resolve) => { announceList = resolve; });
  const client = { list: () => {
    announceList();
    return new Promise((resolve) => { releaseList = resolve; });
  } } as unknown as TranscriberClient;
  const sync = syncTranscriberLibrary({
    tcw: {} as TinyCloudWeb,
    client,
    saver: { listSaved: async () => ({ ok: true, data: { saved: [], unknown: [] } }), save: async () => ({ ok: true }) },
  });
  await listStarted;

  await expect(runOnSpaceLane(async () => "voice note saved", {
    operation: "voice-note save while transcriber list is pending",
  })).resolves.toBe("voice note saved");

  releaseList({ status: "ok", value: { meetings: [] } });
  await sync;
});

test("transcriber space reads and writes use the lane, while transcript HTTP stays outside it", async () => {
  resetSpaceLaneForTests();
  let releaseLane!: () => void;
  let enteredLane!: () => void;
  const laneGate = new Promise<void>((resolve) => { releaseLane = resolve; });
  const laneEntered = new Promise<void>((resolve) => { enteredLane = resolve; });
  const occupying = runOnSpaceLane(async () => { enteredLane(); await laneGate; }, undefined, "background");
  await laneEntered;
  let listCalled = false;
  let listSavedCalled = false;
  let releaseTranscript!: (result: Awaited<ReturnType<TranscriberClient["transcript"]>>) => void;
  let announceTranscript!: () => void;
  const transcriptStarted = new Promise<void>((resolve) => { announceTranscript = resolve; });
  let saveCalled = false;
  let releaseWriteLane: () => void = () => {};
  const client = {
    list: async () => { listCalled = true; return { status: "ok", value: { meetings: [meeting] } }; },
    transcript: () => {
      announceTranscript();
      return new Promise((resolve) => { releaseTranscript = resolve; });
    },
  } as unknown as TranscriberClient;
  const sync = syncTranscriberLibrary({
    tcw: {} as TinyCloudWeb,
    client,
    saver: {
      listSaved: async (_tcw, scheduleRead) => scheduleRead!(async () => {
        listSavedCalled = true;
        return { ok: true, data: { saved: [], unknown: [] } };
      }),
      save: async () => { saveCalled = true; return { ok: true }; },
    },
  });

  try {
    expect(listCalled).toBe(true);
    expect(listSavedCalled).toBe(false);
    releaseLane();
    await occupying;
    await transcriptStarted;

    let enteredWriteLane!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWriteLane = resolve; });
    const writeLaneEntered = new Promise<void>((resolve) => { enteredWriteLane = resolve; });
    const otherWrite = runOnSpaceLane(async () => { enteredWriteLane(); await writeGate; }, undefined, "background");
    await writeLaneEntered;
    releaseTranscript({ status: "ok", value: { status: "ready", transcript } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveCalled).toBe(false);
    releaseWriteLane();
    await otherWrite;
    await sync;
    expect(saveCalled).toBe(true);
  } finally {
    releaseLane();
    releaseWriteLane();
  }
});

test("transcriber sync rechecks the account in the queued lane job before saving", async () => {
  let current = true;
  let writes = 0;
  const client = {
    list: async () => ({ status: "ok", value: { meetings: [meeting] } }),
    transcript: async () => {
      current = false; // The account changes while the network read is in flight.
      return { status: "ok", value: { status: "ready", transcript } };
    },
  } as unknown as TranscriberClient;
  await syncTranscriberLibrary({
    tcw: {} as TinyCloudWeb,
    client,
    isCurrent: () => current,
    saver: {
      listSaved: async () => ({ ok: true, data: { saved: [], unknown: [] } }),
      save: async () => { writes++; return { ok: true }; },
    },
  });
  expect(writes).toBe(0);
});

test("an account switch while a fetched transcript waits for the lane prevents its write", async () => {
  resetSpaceLaneForTests();
  let releaseRead!: () => void;
  let enteredRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readEntered = new Promise<void>((resolve) => { enteredRead = resolve; });
  const blockingRead = runOnSpaceLane(async () => { enteredRead(); await readGate; }, undefined, "background");
  await readEntered;

  let current = true;
  let releaseTranscript!: (result: Awaited<ReturnType<TranscriberClient["transcript"]>>) => void;
  let announceTranscript!: () => void;
  const transcriptStarted = new Promise<void>((resolve) => { announceTranscript = resolve; });
  let writes = 0;
  const client = {
    list: async () => ({ status: "ok", value: { meetings: [meeting] } }),
    transcript: () => {
      announceTranscript();
      return new Promise((resolve) => { releaseTranscript = resolve; });
    },
  } as unknown as TranscriberClient;
  const sync = syncTranscriberLibrary({
    tcw: {} as TinyCloudWeb,
    client,
    isCurrent: () => current,
    saver: {
      listSaved: async () => ({ ok: true, data: { saved: [], unknown: [] } }),
      save: async () => { writes++; return { ok: true }; },
    },
  });

  let releaseOtherWrite: () => void = () => {};
  try {
    releaseRead();
    await blockingRead;
    await transcriptStarted;
    let enterOtherWrite!: () => void;
    const otherWriteStarted = new Promise<void>((resolve) => { enterOtherWrite = resolve; });
    const otherWriteGate = new Promise<void>((resolve) => { releaseOtherWrite = resolve; });
    const otherWrite = runOnSpaceLane(async () => { enterOtherWrite(); await otherWriteGate; }, undefined, "background");
    await otherWriteStarted;
    releaseTranscript({ status: "ok", value: { status: "ready", transcript } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    releaseOtherWrite();
    await otherWrite;
    await sync;
    expect(writes).toBe(0);
  } finally {
    releaseRead();
    releaseOtherWrite();
  }
});
test("unreadable saved transcript bodies log only the incomplete meeting id and reason", async () => {
  const f = libraryFixture();
  f.allowWrites();
  const thrownMeeting = { ...meeting, id: "mtg_thrown" };
  expect((await saveTranscriberMeeting(f.tcw, meeting, transcript)).ok).toBe(true);
  expect((await saveTranscriberMeeting(f.tcw, thrownMeeting, transcript)).ok).toBe(true);
  f.tcw.kv.get = async (key: string) => {
    if (key === transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id)) {
      return { ok: false, error: { code: "KV_ERROR", message: "private payload" } };
    }
    throw new Error("private payload");
  };
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  try {
    const scan = await listSavedTranscriberMeetingIds(f.tcw);
    expect(scan.ok).toBe(true);
    if (!scan.ok) throw new Error("saved-ID scan failed");
    expect(scan.data.saved).toEqual([]);
    expect(scan.data.unknown.sort()).toEqual([meeting.id, thrownMeeting.id].sort());
    expect(debug).toHaveBeenCalledWith("[transcriberSave] incomplete meeting", meeting.id, "kv-read-failed");
    expect(debug).toHaveBeenCalledWith("[transcriberSave] incomplete meeting", thrownMeeting.id, "kv-read-threw");
    expect(debug.mock.calls.flat().join(" ")).not.toContain("private payload");
    const attempts: string[] = [];
    let unknownIds: string[] = [];
    const client = {
      list: async () => ({ status: "ok", value: { meetings: [meeting, thrownMeeting] } }),
      transcript: async (id: string) => { attempts.push(id); return { status: "error" }; },
    } as unknown as TranscriberClient;
    await syncTranscriberLibrary({
      tcw: f.tcw,
      client,
      deliveryActive: () => false,
      onPendingSnapshot: (async (_rows: unknown, _saved: unknown, unknown: string[]) => { unknownIds = unknown; }) as never,
    });
    expect(attempts).toEqual([meeting.id, thrownMeeting.id]);
    expect(unknownIds).toEqual([meeting.id, thrownMeeting.id]);
  } finally {
    debug.mockRestore();
    f.sql.close();
  }
});

// Publication refreshes use synthetic fixtures and expose only counts/versions on failure.
const publication2: TranscriberTranscript = {
  ...transcript, version: 2, duration_seconds: 200,
  speakers: [{ id: "sp2", name: "Fixture participant" }],
  segments: [{ id: "seg2", speaker_id: "sp2", speaker_name: "Fixture participant", start: 0, end: 200, text: "fixture-v2" }],
  text: "fixture-v2",
};
const readSavedRow = (f: ReturnType<typeof libraryFixture>, sourceId = meeting.id) =>
  f.sql.query("SELECT title, started_at, participants, duration_secs, metadata FROM connector_meeting WHERE source_id = ?")
    .get(sourceId) as { title: string; started_at: string; participants: string; duration_secs: number; metadata: string };
const savedVersion = (f: ReturnType<typeof libraryFixture>, sourceId = meeting.id) =>
  JSON.parse(readSavedRow(f, sourceId).metadata).ptx_transcript_version;
function refreshClient(rows: TranscriberMeeting[] = [{ ...meeting, transcript: { status: "completed", version: 2 } }], body = publication2) {
  const fetches: string[] = [];
  const client = {
    list: async () => ({ status: "ok", value: { meetings: rows } }),
    transcript: async (id: string) => { fetches.push(id); return { status: "ok", value: { status: "ready", transcript: { ...body, meeting_id: id } } }; },
  } as unknown as TranscriberClient;
  return { client, fetches };
}
async function savedFixture() {
  const f = libraryFixture(); f.allowWrites();
  expect((await saveTranscriberMeeting(f.tcw, meeting, transcript)).ok).toBe(true);
  return f;
}

test("first saves record the upstream publication version, defaulting to 1", async () => {
  for (const version of [undefined, 1, 2, 2.5]) {
    const f = libraryFixture(); f.allowWrites();
    try {
      expect((await saveTranscriberMeeting(f.tcw, meeting, { ...transcript, version })).ok).toBe(true);
      expect(savedVersion(f)).toBe(Number.isInteger(version) ? version : 1);
    } finally { f.sql.close(); }
  }
});

test("refresh archives the old row and body, updates publication fields and preserves title/start", async () => {
  const f = await savedFixture();
  f.sql.query("UPDATE connector_meeting SET title = ?, started_at = ?").run("fixture-custom", "2026-01-01T00:00:00Z");
  const old = readSavedRow(f);
  const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const oldBody = f.bodies.get(key);
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    expect((await refreshTranscriberMeeting(f.tcw, meeting, publication2)).ok).toBe(true);
    const archive = JSON.parse(f.bodies.get(archiveKvKey(meeting.id, 1))!);
    expect(archive.version).toBe(1);
    expect(Number.isFinite(Date.parse(archive.archived_at))).toBe(true);
    expect(archive.body === oldBody).toBe(true);
    for (const field of ["title", "participants", "duration_secs", "metadata"] as const) {
      expect(archive.row[field] === old[field]).toBe(true);
    }
    const updated = readSavedRow(f);
    expect(updated.title === old.title).toBe(true);
    expect(updated.started_at === old.started_at).toBe(true);
    expect(updated.duration_secs).toBe(200);
    expect(updated.participants === JSON.stringify([{ name: "Fixture participant", email: null }])).toBe(true);
    const normalized = await normalizeTranscriberTranscript(meeting, publication2);
    expect(f.bodies.get(key) === normalized.body).toBe(true);
    expect(JSON.parse(updated.metadata).transcript_text === publication2.text).toBe(true);
    expect(savedVersion(f)).toBe(2);
    expect(JSON.parse(updated.metadata).previous_transcript_versions).toEqual([1]);
    expect(changes).toEqual([meeting.id]);
  } finally { unsubscribe(); f.sql.close(); }
});

test("equal, lower, missing and non-integer publication versions do not write", async () => {
  const f = await savedFixture();
  try {
    const writes = f.writes();
    for (const version of [1, 0, undefined, 2.5, NaN]) {
      expect((await refreshTranscriberMeeting(f.tcw, meeting, { ...publication2, version })).ok).toBe(true);
      const { client, fetches } = refreshClient([{ ...meeting, transcript: { version } }]);
      await syncTranscriberLibrary({ tcw: f.tcw, client });
      expect(fetches).toHaveLength(0);
    }
    expect(f.writes()).toBe(writes);
    expect(f.updates()).toBe(0);
    expect(savedVersion(f)).toBe(1);
  } finally { f.sql.close(); }
});

test("legacy metadata without a publication version counts as 1", async () => {
  const f = await savedFixture();
  try {
    const metadata = JSON.parse(readSavedRow(f).metadata);
    delete metadata.ptx_transcript_version;
    f.sql.query("UPDATE connector_meeting SET metadata = ?").run(JSON.stringify(metadata));
    const versions = await listSavedTranscriberVersions(f.tcw);
    expect(versions.ok && versions.data.get(meeting.id)).toBe(1);
    await syncTranscriberLibrary({ tcw: f.tcw, client: refreshClient().client });
    expect(savedVersion(f)).toBe(2);
    expect(f.bodies.has(archiveKvKey(meeting.id, 1))).toBe(true);
  } finally { f.sql.close(); }
});

test("a failed row commit resumes next pass without replacing the original archive or duplicating events", async () => {
  const f = await savedFixture();
  const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const oldBody = f.bodies.get(key);
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    f.failUpdateOnce();
    const { client } = refreshClient();
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(savedVersion(f)).toBe(1);
    const firstArchive = f.bodies.get(archiveKvKey(meeting.id, 1));
    expect(JSON.parse(firstArchive!).body === oldBody).toBe(true);
    expect(changes).toHaveLength(0);
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(f.bodies.get(archiveKvKey(meeting.id, 1)) === firstArchive).toBe(true);
    expect(f.bodies.get(key) === (await normalizeTranscriberTranscript(meeting, publication2)).body).toBe(true);
    expect(savedVersion(f)).toBe(2);
    expect(JSON.parse(readSavedRow(f).metadata).previous_transcript_versions).toEqual([1]);
    expect(changes).toEqual([meeting.id]);
    const writes = f.writes();
    const updates = f.updates();
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(f.writes()).toBe(writes);
    expect(f.updates()).toBe(updates);
    expect(changes).toHaveLength(1);
  } finally { unsubscribe(); f.sql.close(); }
});

test("unsupported json_extract skips refreshes each pass but still imports first saves", async () => {
  const f = await savedFixture();
  f.failVersionReads();
  try {
    expect((await listSavedTranscriberVersions(f.tcw)).ok).toBe(false);
    const { client, fetches } = refreshClient([
      { ...meeting, transcript: { version: 2 } }, { ...meeting, id: "new-publication", transcript: { version: 2 } },
    ]);
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(fetches).toEqual(["new-publication"]);
    expect(savedVersion(f)).toBe(1);
    expect(savedVersion(f, "new-publication")).toBe(2);
    expect(f.bodies.has(archiveKvKey(meeting.id, 1))).toBe(false);
    expect(f.updates()).toBe(0);
  } finally { f.sql.close(); }
});

test("a shared meeting refreshes from whitelisted transcript.version during delivery grace", async () => {
  const f = await savedFixture();
  const ended = Date.parse("2026-10-08T10:00:00Z");
  try {
    const { client, fetches } = refreshClient([{ ...meeting, ended_at: new Date(ended).toISOString(),
      transcript: { status: "completed", version: 2 }, metadata: { shared: true } }]);
    await syncTranscriberLibrary({ tcw: f.tcw, client, deliveryActive: () => true, now: () => ended + 60_000 });
    expect(fetches).toEqual([meeting.id]);
    expect(savedVersion(f)).toBe(2);
  } finally { f.sql.close(); }
});

test("at most three refreshes run per pass; the next pass refreshes the rest", async () => {
  const f = libraryFixture(); f.allowWrites();
  try {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...meeting, id: `publication-${i}`, transcript: { version: 2 } }));
    for (const row of rows) expect((await saveTranscriberMeeting(f.tcw, row, transcript)).ok).toBe(true);
    const { client, fetches } = refreshClient(rows);
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(fetches).toHaveLength(3);
    expect(rows.map((row) => savedVersion(f, row.id))).toEqual([2, 2, 2, 1, 1]);
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(fetches).toHaveLength(5);
    expect(rows.map((row) => savedVersion(f, row.id))).toEqual([2, 2, 2, 2, 2]);
  } finally { f.sql.close(); }
});


test("a listed/fetched version mismatch and recent owned completion never refresh", async () => {
  const f = await savedFixture();
  try {
    const mismatch = refreshClient(undefined, { ...publication2, version: 3 });
    await syncTranscriberLibrary({ tcw: f.tcw, client: mismatch.client });
    expect(mismatch.fetches).toHaveLength(1);
    expect(savedVersion(f)).toBe(1);
    const completed = Date.parse("2026-10-08T10:00:00Z");
    const recent = refreshClient([{ ...meeting, completed_at: new Date(completed).toISOString(), transcript: { version: 2 } }]);
    await syncTranscriberLibrary({ tcw: f.tcw, client: recent.client, now: () => completed + 60_000 });
    expect(recent.fetches).toHaveLength(0);
    expect(f.updates()).toBe(0);
    await syncTranscriberLibrary({ tcw: f.tcw, client: recent.client, now: () => completed + 10 * 60_000 });
    expect(recent.fetches).toHaveLength(1);
    expect(savedVersion(f)).toBe(2);
  } finally { f.sql.close(); }
});

test("refresh without a row uses the normal first-save path", async () => {
  const f = libraryFixture(); f.allowWrites();
  try {
    expect((await ensureConnectorSchema(webConnectorPort(f.tcw))).ok).toBe(true);
    expect((await refreshTranscriberMeeting(f.tcw, meeting, publication2)).ok).toBe(true);
    expect(savedVersion(f)).toBe(2);
    expect(f.updates()).toBe(0);
    expect(f.bodies.has(archiveKvKey(meeting.id, 1))).toBe(false);
  } finally { f.sql.close(); }
});

test("M8: archive failure leaves body and row intact and the next pass retries", async () => {
  const f = await savedFixture();
  const old = JSON.stringify(readSavedRow(f));
  const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const body = f.bodies.get(key);
  const put = f.tcw.kv.put.bind(f.tcw.kv);
  let fail = true;
  f.tcw.kv.put = (async (...args: Parameters<typeof put>) => {
    if (fail && args[0] === archiveKvKey(meeting.id, 1)) return { ok: false, error: { code: "KV_QUOTA_EXCEEDED" } };
    return put(...args);
  }) as typeof put;
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", () => changes.push("changed"));
  try {
    const { client } = refreshClient();
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(JSON.stringify(readSavedRow(f)) === old).toBe(true);
    expect(f.bodies.get(key) === body).toBe(true);
    expect(changes).toHaveLength(0);
    fail = false;
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(savedVersion(f)).toBe(2);
    expect(changes).toHaveLength(1);
  } finally { unsubscribe(); f.sql.close(); }
});

test("M11: a throwing refresh does not stop other refreshes in the pass", async () => {
  const f = libraryFixture(); f.allowWrites();
  try {
    const rows = ["failure", "healthy"].map((id) => ({ ...meeting, id, transcript: { version: 2 } }));
    for (const row of rows) await saveTranscriberMeeting(f.tcw, row, transcript);
    const put = f.tcw.kv.put.bind(f.tcw.kv);
    f.tcw.kv.put = (async (...args: Parameters<typeof put>) => {
      if (args[0] === archiveKvKey("failure", 1)) throw new Error("archive unavailable");
      return put(...args);
    }) as typeof put;
    const { client, fetches } = refreshClient(rows);
    await syncTranscriberLibrary({ tcw: f.tcw, client });
    expect(fetches).toEqual(["failure", "healthy"]);
    expect(savedVersion(f, "failure")).toBe(1);
    expect(savedVersion(f, "healthy")).toBe(2);
  } finally { f.sql.close(); }
});

test("M12: ptx rollback refreshes forward from v1 through v2 to v3", async () => {
  const f = await savedFixture();
  const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const v1 = f.bodies.get(key);
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", () => changes.push("changed"));
  try {
    await syncTranscriberLibrary({ tcw: f.tcw, client: refreshClient().client });
    const v2 = f.bodies.get(key);
    await syncTranscriberLibrary({ tcw: f.tcw, client: refreshClient(
      [{ ...meeting, transcript: { version: 3 } }], { ...transcript, version: 3 },
    ).client });
    expect(savedVersion(f)).toBe(3);
    expect(f.bodies.get(key) === v1).toBe(true);
    expect(JSON.parse(readSavedRow(f).metadata).previous_transcript_versions).toEqual([1, 2]);
    expect(JSON.parse(f.bodies.get(archiveKvKey(meeting.id, 1))!).body === v1).toBe(true);
    expect(JSON.parse(f.bodies.get(archiveKvKey(meeting.id, 2))!).body === v2).toBe(true);
    expect(changes).toHaveLength(2);
  } finally { unsubscribe(); f.sql.close(); }
});

test("backoff skips three failing rows so the next pass reaches a healthy row", async () => {
  const f = libraryFixture(); f.allowWrites();
  const refreshBackoff = new Map<string, { failures: number; retryAt: number }>();
  const epoch = Date.parse("2026-10-13T00:00:00Z");
  let now = epoch + 1_000;
  try {
    const rows = ["fail-1", "fail-2", "fail-3", "healthy"].map((id) => ({ ...meeting, id, transcript: { version: 2 } }));
    for (const row of rows) await saveTranscriberMeeting(f.tcw, row, transcript);
    const put = f.tcw.kv.put.bind(f.tcw.kv);
    f.tcw.kv.put = (async (...args: Parameters<typeof put>) => {
      if (rows.slice(0, 3).some((row) => args[0] === archiveKvKey(row.id, 1))) throw new Error("archive unavailable");
      return put(...args);
    }) as typeof put;
    const { client, fetches } = refreshClient(rows);
    const sync = () => syncTranscriberLibrary({ tcw: f.tcw, client, refreshBackoff, now: () => now });
    await sync();
    expect(fetches).toHaveLength(3);
    expect(refreshBackoff.get("fail-1")).toEqual({ failures: 1, retryAt: epoch + 61_000 });
    await sync();
    expect(fetches).toEqual(["fail-1", "fail-2", "fail-3", "healthy"]);
    expect(savedVersion(f, "healthy")).toBe(2);
    now = epoch + 61_000;
    await sync();
    expect(refreshBackoff.get("fail-1")).toEqual({ failures: 2, retryAt: epoch + 181_000 });
    now = epoch + 181_000;
    f.tcw.kv.put = put;
    await sync();
    expect(refreshBackoff.size).toBe(0);
  } finally { f.sql.close(); }
});

test("compare-and-set repairs a stale v2 body after v3 commits first", async () => {
  const f = await savedFixture();
  const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const put = f.tcw.kv.put.bind(f.tcw.kv);
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const v2 = await normalizeTranscriberTranscript(meeting, publication2);
  const publication3 = { ...transcript, version: 3 };
  const v3 = await normalizeTranscriberTranscript(meeting, publication3);
  f.tcw.kv.put = (async (...args: Parameters<typeof put>) => {
    if (args[0] === key && args[1] === v2.body) { blocked.resolve(); await release.promise; }
    return put(...args);
  }) as typeof put;
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", () => changes.push("changed"));
  try {
    const older = refreshTranscriberMeeting(f.tcw, meeting, publication2, async () => publication3);
    await blocked.promise;
    expect((await refreshTranscriberMeeting(f.tcw, meeting, publication3)).ok).toBe(true);
    expect(savedVersion(f)).toBe(3);
    release.resolve();
    expect((await older).ok).toBe(true);
    expect(savedVersion(f)).toBe(3);
    expect(f.bodies.get(key) === v3.body).toBe(true);
    expect([...f.bodies.keys()].filter((key) => key.includes("/archive/"))).toEqual([archiveKvKey(meeting.id, 1)]);
    expect(changes).toHaveLength(1);
  } finally { release.resolve(); unsubscribe(); f.sql.close(); }
});

test("C4: a lost compare-and-set leaves a mismatched upstream version for the next pass", async () => {
  const f = await savedFixture();
  const key = transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id);
  const put = f.tcw.kv.put.bind(f.tcw.kv);
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const v2 = await normalizeTranscriberTranscript(meeting, publication2);
  const publication3 = { ...transcript, version: 3 };
  const publication4 = { ...publication2, version: 4, segments: [{ ...publication2.segments![0], text: "fixture-v4" }] };
  const puts: string[] = [];
  f.tcw.kv.put = (async (...args: Parameters<typeof put>) => {
    if (args[0] === key && args[1] === v2.body) { blocked.resolve(); await release.promise; }
    puts.push(args[0]);
    return put(...args);
  }) as typeof put;
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", () => changes.push("changed"));
  let repairFetches = 0;
  let writesBeforeRepair = 0;
  let eventsBeforeRepair = 0;
  let rowBeforeRepair = "";
  let archivesBeforeRepair: Array<[string, string]> = [];
  try {
    const older = refreshTranscriberMeeting(f.tcw, meeting, publication2, async () => {
      repairFetches++;
      expect(savedVersion(f)).toBe(3); // vNow: the v2 compare-and-set missed.
      expect(f.bodies.get(key)).toBe(v2.body);
      writesBeforeRepair = puts.length;
      eventsBeforeRepair = changes.length;
      rowBeforeRepair = JSON.stringify(readSavedRow(f));
      archivesBeforeRepair = [...f.bodies].filter(([key]) => key.includes("/archive/"));
      return publication4; // Upstream has advanced beyond the committed row.
    });
    await blocked.promise;
    expect((await refreshTranscriberMeeting(f.tcw, meeting, publication3)).ok).toBe(true);
    release.resolve();
    expect((await older).ok).toBe(true);
    expect(repairFetches).toBe(1);
    expect(f.bodies.get(key)).toBe(v2.body);
    expect(puts.slice(writesBeforeRepair)).toEqual([]); // No repair body or archive put.
    expect([...f.bodies].filter(([key]) => key.includes("/archive/"))).toEqual(archivesBeforeRepair);
    expect(changes.slice(eventsBeforeRepair)).toEqual([]);
    expect(JSON.stringify(readSavedRow(f))).toBe(rowBeforeRepair);
    expect(savedVersion(f)).toBe(3);

    await syncTranscriberLibrary({ tcw: f.tcw, client: refreshClient(
      [{ ...meeting, transcript: { version: 4 } }], publication4,
    ).client });
    expect(savedVersion(f)).toBe(4);
    expect(f.bodies.get(key)).toBe((await normalizeTranscriberTranscript(meeting, publication4)).body);
    expect(changes).toHaveLength(eventsBeforeRepair + 1);
  } finally { release.resolve(); unsubscribe(); f.sql.close(); }
});

const gapPublication: TranscriberTranscript = {
  ...transcript, version: 2, partial: true,
  gaps: [{ start: 41, end: 52, speaker_name: "Kenny Tucker" }],
  segments: transcript.segments!.map((segment, i) => ({ ...segment,
    source: i === 0 ? "recording" : "fallback", attribution: i === 0 ? "identified" : "overlap" })),
};

test("normalization preserves partial publications, gaps and segment provenance", async () => {
  const normalized = await normalizeTranscriberTranscript(meeting, gapPublication);
  expect(normalized.meeting.metadata).toMatchObject({ partial: true, gaps: gapPublication.gaps });
  expect(JSON.parse(normalized.body)).toEqual(normalized.sentences);
  expect(normalized.sentences.map(({ source, attribution }) => ({ source, attribution }))).toEqual([
    { source: "recording", attribution: "identified" }, { source: "fallback", attribution: "overlap" },
  ]);
  const legacy = await normalizeTranscriberTranscript(meeting, transcript);
  expect(legacy.meeting.metadata).not.toHaveProperty("partial");
  expect(legacy.meeting.metadata).not.toHaveProperty("gaps");
  expect(JSON.parse(legacy.body)).toEqual(transcript.segments!.map((segment, index) => ({
    index, speaker_name: segment.speaker_name, text: segment.text, start_time: segment.start, end_time: segment.end,
  })));
});

test("refresh writes gaps, partial and sentence provenance into an already saved meeting", async () => {
  const f = libraryFixture(); f.allowWrites();
  try {
    expect((await saveTranscriberMeeting(f.tcw, meeting, transcript)).ok).toBe(true);
    expect((await refreshTranscriberMeeting(f.tcw, meeting, gapPublication)).ok).toBe(true);
    const row = f.sql.query("SELECT metadata FROM connector_meeting").get() as { metadata: string };
    expect(JSON.parse(row.metadata)).toMatchObject({ partial: true, gaps: gapPublication.gaps, ptx_transcript_version: 2 });
    const body = JSON.parse(f.bodies.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, meeting.id))!);
    expect(body[0]).toMatchObject({ source: "recording", attribution: "identified" });
    expect(body[1]).toMatchObject({ source: "fallback", attribution: "overlap" });
  } finally { f.sql.close(); }
});
