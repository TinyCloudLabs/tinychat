import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { callSpeakerLabels, parseCallParticipants, suggestCallSpeakerNames } from "@/capture/library/callParticipants";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { saveCallSpeakerNames } from "./callNames";
import { registerDesktopCaptureExtras } from "./desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "./fakeDesktopCaptureExtras";
import { VoiceNotes, __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { patchRowSpeakerName, readRowCallParticipants, writeCallSpeakerSuggestions } from "./voiceNoteRows";
import { saveRecording } from "./recorderSaves";
import { saveVoiceNote, saveVoiceNoteTranscript } from "./voiceNoteStore";

// Who spoke when, the save step: once a transcript with "Them N" labels is committed, each label's suggested name goes
// onto the note's row, once, never over a name the user gave, and never again once the user ended it.

const PEOPLE = { v: 1, source: "call_window", app: "google-meet", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }] };
const STEREO = { capture: { platform: "tauri", channels: 2 }, transcription_outcome: "transcribed" };
const AT = "2026-11-20T10:00:00.000Z";
const SENTENCES = [
  { index: 0, speaker_name: "Me", text: "Shall we start?", start_time: 0, end_time: 3, channel: 0 as const },
  { index: 1, speaker_name: "Them 1", speaker_id: "call:p2", text: "Yes.", start_time: 3.5, end_time: 9, channel: 1 as const },
  { index: 2, speaker_name: "Them 2", speaker_id: "call:p3", text: "Ready.", start_time: 9.6, end_time: 15, channel: 1 as const },
  { index: 3, speaker_name: "Them 1", speaker_id: "call:p2", text: "Good.", start_time: 17.5, end_time: 21, channel: 1 as const },
];
const LABELS = { "Them 1": "p2", "Them 2": "p3" };
const suggestion = (name: string, person: string, at = AT) =>
  ({ name, source: "call_window", confidence: "high", reason: "speaking_marker", person, at });

const original = VoiceNotes;
afterEach(() => {
  registerDesktopCaptureExtras(null);
  __setVoiceNotesForTests(original, { available: null });
});

/** One voice-note row, and the SQL it is sent. */
function row(metadata: Record<string, unknown> = STEREO, source = "exo-voice-note") {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('vn-rec-1', ?, ?, '')", [source, JSON.stringify(metadata)]);
  const statements: string[] = [];
  const tcw = { did: "did:test", spaceId: "did:test", sql: { db: () => ({
    query: async (sql: string, params: never[]) => ({ ok: true, data: { rows: sqlite.query(sql).values(...params) } }),
    execute: async (sql: string, params: never[]) => {
      statements.push(sql);
      return { ok: true, data: { changes: sqlite.run(sql, params).changes } };
    },
  }) } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'vn-rec-1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
  return { tcw, stored, statements };
}

/** The note's capture ledger on this Mac, with the labels whose suggestion the user ended while it was only here. */
function ledger(ended: string[] = []) {
  __setVoiceNotesForTests({ listPending: async () => ({ recordings: [{ id: "rec-1", owner: "did:test", rev: 1,
    ledger: { speakerSuggestionsEnded: ended } }] }) } as never, { available: true });
}

const SUGGESTIONS = suggestCallSpeakerNames(parseCallParticipants(PEOPLE), LABELS, AT);

describe("the labels and their suggestions", () => {
  test("each Them N label carries one person id; a label with mixed or missing ids names nobody", () => {
    expect(callSpeakerLabels(SENTENCES)).toEqual(LABELS);
    expect(callSpeakerLabels([...SENTENCES, { speaker_name: "Them 2", speaker_id: "call:p4" }])).toEqual({ "Them 1": "p2" });
    expect(callSpeakerLabels([{ speaker_name: "Them 3" }, { speaker_name: "Them 4", speaker_id: "p4" },
      { speaker_name: "Them", speaker_id: "call:p2" }, { speaker_name: "Them 5", speaker_id: "call:p 5" }])).toEqual({});
    expect(callSpeakerLabels([])).toEqual({});
  });

  test("a suggestion names the person of the call, never the user, and nobody unknown", () => {
    expect(SUGGESTIONS).toEqual({ "Them 1": suggestion("Alex Example", "p2"), "Them 2": suggestion("Dana Lee", "p3") });
    expect(suggestCallSpeakerNames(parseCallParticipants(PEOPLE), { "Them 1": "p1", "Them 2": "p9" }, AT)).toEqual({});
    expect(suggestCallSpeakerNames(null, LABELS, AT)).toEqual({});
    // Only Them N labels are suggested for.
    expect(suggestCallSpeakerNames(parseCallParticipants(PEOPLE), { Them: "p2" }, AT)).toEqual({});
  });
});

describe("writeCallSpeakerSuggestions", () => {
  test("writes each label's name and suggestion once", async () => {
    const { tcw, stored } = row();
    expect(await writeCallSpeakerSuggestions(tcw, "vn-rec-1", SUGGESTIONS, [])).toBe(2);
    expect(stored()).toEqual({ ...STEREO,
      speaker_names: { "Them 1": "Alex Example", "Them 2": "Dana Lee" },
      speaker_suggestions: { "Them 1": suggestion("Alex Example", "p2"), "Them 2": suggestion("Dana Lee", "p3") },
      speaker_suggestions_made: { "Them 1": AT, "Them 2": AT } });
    const before = stored();
    expect(await writeCallSpeakerSuggestions(tcw, "vn-rec-1", suggestCallSpeakerNames(parseCallParticipants(PEOPLE), LABELS, "later"), [])).toBe(0);
    expect(stored()).toEqual(before);
  });

  test("a name the user gave a label stays, even one given a moment before", async () => {
    const { tcw, stored } = row({ ...STEREO, speaker_names: { "Them 1": "Alex E." } });
    expect(await writeCallSpeakerSuggestions(tcw, "vn-rec-1", SUGGESTIONS, [])).toBe(2);
    expect(stored()).toEqual({ ...STEREO, speaker_names: { "Them 1": "Alex E.", "Them 2": "Dana Lee" },
      speaker_suggestions: { "Them 2": suggestion("Dana Lee", "p3") }, speaker_suggestions_made: { "Them 1": AT, "Them 2": AT } });
  });

  test("a suggestion the user ended on this device is not made", async () => {
    const { tcw, stored } = row();
    await writeCallSpeakerSuggestions(tcw, "vn-rec-1", SUGGESTIONS, ["Them 2"]);
    expect(stored()).toEqual({ ...STEREO, speaker_names: { "Them 1": "Alex Example" },
      speaker_suggestions: { "Them 1": suggestion("Alex Example", "p2") }, speaker_suggestions_made: { "Them 1": AT, "Them 2": AT } });
  });

  test("a suggestion the user put back on the row is not made again", async () => {
    const { tcw, stored } = row();
    await writeCallSpeakerSuggestions(tcw, "vn-rec-1", SUGGESTIONS, []);
    // Go back to Them 1, then a new transcript of the recording is committed.
    await patchRowSpeakerName(tcw, "vn-rec-1", "Them 1", null);
    await writeCallSpeakerSuggestions(tcw, "vn-rec-1", SUGGESTIONS, []);
    expect(stored()).toEqual({ ...STEREO, speaker_names: { "Them 2": "Dana Lee" },
      speaker_suggestions: { "Them 2": suggestion("Dana Lee", "p3") }, speaker_suggestions_made: { "Them 1": AT, "Them 2": AT } });
  });

  test("writes nothing on a row of one side, another source, a missing row, or for another label", async () => {
    const mono = row({ capture: { platform: "tauri" } });
    expect(await writeCallSpeakerSuggestions(mono.tcw, "vn-rec-1", SUGGESTIONS, [])).toBe(0);
    const upload = row(STEREO, "exo-upload");
    expect(await writeCallSpeakerSuggestions(upload.tcw, "vn-rec-1", SUGGESTIONS, [])).toBe(0);
    const { tcw, stored, statements } = row();
    expect(await writeCallSpeakerSuggestions(tcw, "vn-missing", SUGGESTIONS, [])).toBe(0);
    statements.length = 0;
    expect(await writeCallSpeakerSuggestions(tcw, "vn-rec-1", { 'Them"': SUGGESTIONS["Them 1"]!, Them: SUGGESTIONS["Them 1"]! }, [])).toBe(0);
    expect(statements).toEqual([]);
    expect(stored()).toEqual(STEREO);
  });

  test("the row's call participants are read back as checked", async () => {
    expect(await readRowCallParticipants(row({ ...STEREO, call_participants: PEOPLE }).tcw, "vn-rec-1")).toEqual(parseCallParticipants(PEOPLE));
    expect(await readRowCallParticipants(row().tcw, "vn-rec-1")).toBeNull();
    expect(await readRowCallParticipants(row({ ...STEREO, call_participants: { ...PEOPLE, v: 2 } }).tcw, "vn-rec-1")).toBeNull();
  });
});

describe("saveCallSpeakerNames", () => {
  test("takes the people from this Mac while it has them, and leaves its copy for the names' own save", async () => {
    ledger();
    const fake = createFakeDesktopCaptureExtras({ callNames: { read: { "rec-1": PEOPLE } } });
    registerDesktopCaptureExtras(fake.extras);
    const { tcw, stored } = row();
    expect(await saveCallSpeakerNames(tcw, "rec-1", "vn-rec-1", LABELS)).toBe("saved");
    expect(stored()).toMatchObject({ speaker_names: { "Them 1": "Alex Example", "Them 2": "Dana Lee" } });
    expect(fake.callNamesRead("rec-1")).toEqual(PEOPLE);
    expect(await saveCallSpeakerNames(tcw, "rec-1", "vn-rec-1", LABELS)).toBe("kept");
  });

  test("takes the people from the row once they left this Mac, and skips what the user ended here", async () => {
    ledger(["Them 1"]);
    registerDesktopCaptureExtras(createFakeDesktopCaptureExtras({ callNames: {} }).extras);
    const { tcw, stored } = row({ ...STEREO, call_participants: PEOPLE });
    expect(await saveCallSpeakerNames(tcw, "rec-1", "vn-rec-1", LABELS)).toBe("saved");
    expect(stored()).toMatchObject({ speaker_names: { "Them 2": "Dana Lee" }, speaker_suggestions: { "Them 2": { reason: "speaking_marker" } } });
    expect((stored().speaker_names as Record<string, string>)["Them 1"]).toBeUndefined();
  });

  test("does nothing without labels or people, and never throws", async () => {
    const { tcw, statements } = row();
    expect(await saveCallSpeakerNames(tcw, "rec-1", "vn-rec-1", {})).toBe("none");
    expect(await saveCallSpeakerNames(tcw, "rec-1", "vn-rec-1", LABELS)).toBe("none");
    expect(statements).toEqual([]);
    const withPeople = row({ ...STEREO, call_participants: PEOPLE });
    expect(await saveCallSpeakerNames(withPeople.tcw, "rec-1", "vn-rec-1", LABELS, () => { throw new Error("Voice-note account work is paused"); })).toBe("failed");
    expect(withPeople.stored()).toEqual({ ...STEREO, call_participants: PEOPLE });
  });
});

// The space as the save path sees it: the connectors database and KV, in memory.
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = "did:test:call-speakers";
  const sql = {
    db(name: string) {
      expect(name).toBe(CONNECTORS_SQL_DB_NAME);
      return {
        async query(statement: string, params: unknown[] = []) {
          try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
        async execute(statement: string, params: unknown[] = []) {
          try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
      };
    },
  };
  const kv = {
    async put(key: string, value: string, options?: { ifNoneMatch?: string }) {
      if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value);
      return { ok: true, data: {} };
    },
    async get(key: string) {
      return values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async list({ path }: { path: string }) {
      return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
    },
  };
  const tcw = { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb;
  const metadata = (id: string) => {
    const found = sqlite.query("SELECT metadata FROM connector_meeting WHERE source_id = ?").get(id) as { metadata: string } | null;
    return found ? JSON.parse(found.metadata) as Record<string, unknown> : null;
  };
  return { tcw, metadata };
}
const until = async (done: () => boolean) => { for (let turn = 0; turn < 200 && !done(); turn++) await Bun.sleep(5); };

test("committing a transcript with Them N labels puts each label's suggested name on the row; Them stays as it was", async () => {
  const fake = createFakeDesktopCaptureExtras({ callNames: { read: { "call-1": PEOPLE } } });
  registerDesktopCaptureExtras(fake.extras);
  const { tcw, metadata } = space();
  const recording = { id: "call-1", startedAt: Date.UTC(2026, 10, 20, 9), durationMs: 60_000, mimeType: "audio/mp4", sizeBytes: 4,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0, channels: 2 as const, version: 2 as const, source: "in_app" as const,
    options: { transcriber: "on-device" as const, identifySpeakers: false, uploadAudio: false } };
  const audio = { mimeType: "audio/mp4", size: 4, readPart: async () => new Uint8Array([1, 2, 3, 4]) };
  expect((await saveVoiceNote(tcw, recording, audio, "tauri")).ok).toBe(true);
  // The names reach the row and leave this Mac; three people, so no suggestion for Them.
  await until(() => fake.callNamesRead("call-1") === undefined);
  expect(metadata("call-1")).toMatchObject({ call_participants: PEOPLE });
  expect(metadata("call-1")?.speaker_names).toBeUndefined();
  const committed = await saveVoiceNoteTranscript(tcw, "call-1", { rev: 1, speakers: ["Me", "Them 1", "Them 2"], sentences: SENTENCES,
    metadata: { transcription_outcome: "transcribed", transcript_text: "Yes.", transcription_engine: "whispercpp" } });
  expect(committed.ok).toBe(true);
  await until(() => metadata("call-1")?.speaker_suggestions_made !== undefined);
  expect(metadata("call-1")).toMatchObject({
    speaker_names: { "Them 1": "Alex Example", "Them 2": "Dana Lee" },
    speaker_suggestions: { "Them 1": { name: "Alex Example", reason: "speaking_marker", person: "p2" },
      "Them 2": { name: "Dana Lee", reason: "speaking_marker", person: "p3" } } });
  expect(Object.keys(metadata("call-1")?.speaker_names as object)).toEqual(["Them 1", "Them 2"]);
});

describe("the pass over notes already saved", () => {
  const LOCAL = { version: 2, noteId: "rec-1", transcriber: "on-device", rev: 1, engine: "whispercpp", model: "QuantizedLargeTurbo",
    language: "en", outcome: "transcribed", diarized: true, createdAt: AT, segments: [
      { start: 0, end: 3000, text: "Shall we start?", speaker: "Me", channel: 0, timing: "engine" },
      { start: 3500, end: 9000, text: "Yes.", speaker: "Them 1", speakerId: "call:p2", channel: 1, timing: "engine" },
      { start: 9600, end: 15000, text: "Ready.", speaker: "Them 2", speakerId: "call:p3", channel: 1, timing: "engine" },
    ] };
  /** A Mac note saved to the space before its transcript was ready: its row is known, the transcript is only here. */
  const saved = (channels: 1 | 2 = 2) => ({ id: "rec-1", owner: "did:test", startedAt: Date.UTC(2026, 10, 20, 9), durationMs: 60_000,
    mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0, channels, version: 2, source: "in_app",
    options: { transcriber: "on-device", identifySpeakers: false, uploadAudio: false },
    ledger: { audio: { state: "saved", rowId: "vn-rec-1", at: 1 } } });
  const thisMac = (transcript: unknown) => {
    const reads: string[] = [];
    __setVoiceNotesForTests({
      listPending: async () => ({ recordings: [saved()] }),
      getTranscript: async ({ id }: { id: string }) => { reads.push(id); return { transcript }; },
    } as never, { available: true });
    return reads;
  };

  test("puts the suggested names of this Mac's transcript on the row, once, with no transcript commit", async () => {
    const reads = thisMac(LOCAL);
    // The names reached the row earlier; the transcript has not been committed (this space takes no KV writes).
    const { tcw, stored } = row({ ...STEREO, call_participants: PEOPLE });
    expect((await saveRecording(tcw, saved() as never)).kind).toBe("already-saved");
    await until(() => stored().speaker_suggestions_made !== undefined);
    expect(reads).toContain("rec-1");
    expect(stored()).toMatchObject({ speaker_names: { "Them 1": "Alex Example", "Them 2": "Dana Lee" },
      speaker_suggestions: { "Them 1": { reason: "speaking_marker", person: "p2" }, "Them 2": { reason: "speaking_marker", person: "p3" } } });
    // The next pass changes nothing, and a name the user gave meanwhile stays.
    await patchRowSpeakerName(tcw, "vn-rec-1", "Them 1", "Alex E.");
    const before = stored();
    await saveRecording(tcw, saved() as never);
    await Bun.sleep(30);
    expect(stored()).toEqual(before);
  });

  test("does nothing for a transcript without Them N labels, without a transcript here, or for a recording of one side", async () => {
    const plain = { ...LOCAL, segments: LOCAL.segments.map((segment) => segment.channel === 1 ? { ...segment, speaker: "Them", speakerId: undefined } : segment) };
    for (const transcript of [plain, null, { ...LOCAL, noteId: "rec-2" }]) {
      thisMac(transcript);
      const { tcw, stored } = row({ ...STEREO, call_participants: PEOPLE });
      await saveRecording(tcw, saved() as never);
      await Bun.sleep(30);
      expect(stored()).toEqual({ ...STEREO, call_participants: PEOPLE });
    }
    const reads = thisMac(LOCAL);
    const { tcw, stored } = row({ ...STEREO, call_participants: PEOPLE });
    await saveRecording(tcw, saved(1) as never);
    await Bun.sleep(30);
    expect(reads.length).toBeLessThanOrEqual(1);
    expect(stored()).toEqual({ ...STEREO, call_participants: PEOPLE });
  });
});
