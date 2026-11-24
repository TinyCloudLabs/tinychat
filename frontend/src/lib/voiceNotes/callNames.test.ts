import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "@/capture/captureEvents";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { saveCallNames } from "./callNames";
import { createTauriDesktopCaptureExtras } from "./desktop/tauriDesktopCaptureExtras";
import { registerDesktopCaptureExtras } from "./desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "./fakeDesktopCaptureExtras";
import { saveRecording } from "./recorderSaves";
import { saveVoiceNote, saveVoiceNoteTranscript } from "./voiceNoteStore";

// Names in the call, the save step: what the desktop app read during a recording moves onto the note's row once it
// exists, then the app's copy is cleared. Best-effort throughout: the save never waits on it or fails with it.

const PEOPLE = { v: 1, source: "call_window", app: "google-meet", truncated: false,
  people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }] };
const STEREO = { capture: { platform: "tauri", channels: 2 }, transcription_outcome: "pending" };

afterEach(() => registerDesktopCaptureExtras(null));

/** A row as the save hook finds it, and the SQL it is sent. */
function row(metadata: Record<string, unknown> = STEREO) {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('vn-rec-1', 'exo-voice-note', ?, '')", [JSON.stringify(metadata)]);
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

function desktop(read: Record<string, unknown> = { "rec-1": PEOPLE }) {
  const fake = createFakeDesktopCaptureExtras({ callNames: { enabled: true, permission: "granted", read } });
  registerDesktopCaptureExtras(fake.extras);
  return fake;
}

describe("saveCallNames", () => {
  test("with one other person in the call: the people, the suggestion and the name land on the row; the app's copy is cleared", async () => {
    const fake = desktop();
    const { tcw, stored } = row();
    const changed: unknown[] = [];
    const stop = captureEvents.on("library-changed", (detail) => changed.push(detail));
    try {
      expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("saved");
    } finally { stop(); }
    expect(stored()).toMatchObject({ ...STEREO, call_participants: PEOPLE, speaker_names: { Them: "Alex Example" },
      speaker_suggestions: { Them: { name: "Alex Example", source: "call_window", confidence: "high", reason: "one_other_participant", person: "p2" } } });
    expect(fake.calls).toEqual(["callNames.read:rec-1", "callNames.clear:rec-1"]);
    expect(fake.callNamesRead("rec-1")).toBeUndefined();
    // An open note reads its row again.
    expect(changed).toEqual([{ source: "exo-voice-note", sourceId: "rec-1" }]);
  });

  test("nothing to do off the desktop app, without the setting's support, or when nothing was read", async () => {
    const { tcw, statements } = row();
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("none");
    registerDesktopCaptureExtras(createFakeDesktopCaptureExtras().extras);
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("none");
    const fake = desktop({});
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("none");
    expect(fake.calls).toEqual(["callNames.read:rec-1"]);
    expect(statements).toEqual([]);
  });

  test("a name the user already gave Them stays", async () => {
    desktop();
    const { tcw, stored } = row({ ...STEREO, speaker_names: { Them: "Alex" } });
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("saved");
    expect(stored()).toEqual({ ...STEREO, speaker_names: { Them: "Alex" }, call_participants: PEOPLE });
  });

  test("what is not in the agreed shape is not written, and the app's copy is cleared so it never comes back", async () => {
    const fake = desktop({ "rec-1": { ...PEOPLE, v: 2 } });
    const { tcw, stored, statements } = row();
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("refused");
    expect(statements).toEqual([]);
    expect(stored()).toEqual(STEREO);
    expect(fake.calls).toEqual(["callNames.read:rec-1", "callNames.clear:rec-1"]);
    expect(fake.callNamesRead("rec-1")).toBeUndefined();
    // The next try has nothing to read, so nothing to warn about.
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("none");
  });

  test("a build without the commands is refused once, quietly; after that nothing asks again", async () => {
    const invoked: string[] = [];
    const bridge = {
      invoke: async (command: string) => { invoked.push(command); throw `Command ${command} not found`; },
      listen: async () => () => {},
    };
    registerDesktopCaptureExtras(createTauriDesktopCaptureExtras(bridge as never));
    const { tcw, stored, statements } = row();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      for (let commit = 0; commit < 3; commit++) expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("none");
      expect(invoked).toEqual(["call_names_read"]);
      expect(warn).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); info.mockRestore(); }
    expect(statements).toEqual([]);
    expect(stored()).toEqual(STEREO);
  });

  test("a recording of one side is not named, and its copy stays", async () => {
    const fake = desktop();
    const { tcw, stored } = row({ capture: { platform: "tauri", channels: 1 } });
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("no-row");
    expect(stored()).toEqual({ capture: { platform: "tauri", channels: 1 } });
    expect(fake.callNamesRead("rec-1")).toEqual(PEOPLE);
  });

  test("a failed step never throws; the next try saves the names or clears what the row already holds", async () => {
    const fake = desktop();
    const { tcw, stored } = row();
    fake.failNext("callNames.read", "reader busy");
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("failed");
    expect(stored()).toEqual(STEREO);
    // The write lands but the clear fails: the row has them, the app still holds its copy.
    fake.failNext("callNames.clear", "disk full");
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("failed");
    expect(stored().call_participants).toEqual(PEOPLE);
    expect(fake.callNamesRead("rec-1")).toEqual(PEOPLE);
    // The retry finds them on the row, writes nothing, and clears.
    const before = stored();
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1")).toBe("kept");
    expect(stored()).toEqual(before);
    expect(fake.callNamesRead("rec-1")).toBeUndefined();
  });

  test("a stopped account writes nothing", async () => {
    desktop();
    const { tcw, stored } = row();
    expect(await saveCallNames(tcw, "rec-1", "vn-rec-1", () => { throw new Error("Voice-note account work is paused"); })).toBe("failed");
    expect(stored()).toEqual(STEREO);
  });
});

// The space as the save path sees it: the connectors database and KV, in memory.
let count = 0;
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:call-names-${++count}`;
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

const recording = (id: string, channels?: 1 | 2) => ({ id, startedAt: Date.UTC(2026, 10, 18, 18), durationMs: 60_000,
  mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0, ...(channels ? { channels } : {}),
  version: 2 as const, source: "in_app" as const, options: { transcriber: "private-cloud" as const, identifySpeakers: false, uploadAudio: false } });
const AUDIO = { mimeType: "audio/mp4", size: 4, readPart: async () => new Uint8Array([1, 2, 3, 4]) };
const until = async (done: () => boolean) => { for (let turn = 0; turn < 200 && !done(); turn++) await Bun.sleep(5); };

describe("saving a recording", () => {
  test("a recording of both sides takes the names once its row exists; the save does not wait for them", async () => {
    const fake = desktop({ "call-1": PEOPLE });
    const { tcw, metadata } = space();
    const saved = await saveVoiceNote(tcw, recording("call-1", 2), AUDIO, "tauri");
    expect(saved.ok).toBe(true);
    await until(() => metadata("call-1")?.call_participants !== undefined && fake.callNamesRead("call-1") === undefined);
    expect(metadata("call-1")).toMatchObject({ call_participants: PEOPLE, speaker_names: { Them: "Alex Example" },
      speaker_suggestions: { Them: { name: "Alex Example" } }, capture: { channels: 2 } });
    expect(fake.callNamesRead("call-1")).toBeUndefined();
  });

  test("a reader that never answers does not hold up the save", async () => {
    const fake = desktop({ "call-3": PEOPLE });
    fake.extras.callNames!.read = () => new Promise<never>(() => {});
    const { tcw, metadata } = space();
    const saved = await Promise.race([saveVoiceNote(tcw, recording("call-3", 2), AUDIO, "tauri"),
      Bun.sleep(5_000).then(() => "held up" as const)]);
    expect(saved).not.toBe("held up");
    expect(saved !== "held up" && saved.ok).toBe(true);
    expect(metadata("call-3")?.call_participants).toBeUndefined();
  });

  test("a recording of one side never asks for names", async () => {
    const fake = desktop({ "mono-1": PEOPLE });
    const { tcw, metadata } = space();
    expect((await saveVoiceNote(tcw, recording("mono-1"), AUDIO, "tauri")).ok).toBe(true);
    await Bun.sleep(20);
    expect(fake.calls.filter((call) => call.startsWith("callNames"))).toEqual([]);
    expect(metadata("mono-1")?.call_participants).toBeUndefined();
  });

  test("a saved recording whose names never reached its row gets them on the next pass over saved notes, with no transcript", async () => {
    const fake = desktop({ "rec-1": PEOPLE });
    const { tcw, stored } = row();
    // As the pass at app start finds it: already saved (its row is known), the transcriber off.
    const saved = { ...recording("rec-1", 2), owner: "did:test", options: { transcriber: "off" as const, identifySpeakers: false, uploadAudio: false },
      ledger: { audio: { state: "saved" as const, rowId: "vn-rec-1", at: 1 } } };
    expect((await saveRecording(tcw, saved as never)).kind).toBe("already-saved");
    await until(() => fake.callNamesRead("rec-1") === undefined);
    expect(stored()).toMatchObject({ call_participants: PEOPLE, speaker_names: { Them: "Alex Example" } });
    // A recording of one side is not asked about.
    const mono = desktop({ "rec-1": PEOPLE });
    expect((await saveRecording(tcw, { ...saved, channels: 1 } as never)).kind).toBe("already-saved");
    await Bun.sleep(20);
    expect(mono.calls).toEqual([]);
  });

  test("a reader that fails leaves the save as it was, and the transcript commit saves the names after", async () => {
    const fake = desktop({ "call-2": PEOPLE });
    const { tcw, metadata } = space();
    fake.failNext("callNames.read", "reader busy");
    const saved = await saveVoiceNote(tcw, recording("call-2", 2), AUDIO, "tauri");
    expect(saved.ok).toBe(true);
    await until(() => fake.calls.includes("callNames.read:call-2"));
    await Bun.sleep(20);
    expect(metadata("call-2")?.call_participants).toBeUndefined();
    const committed = await saveVoiceNoteTranscript(tcw, "call-2", { rev: 1, speakers: ["Me", "Them"],
      sentences: [{ index: 0, speaker_name: "Them", text: "Hello.", start_time: 0, end_time: 1 }],
      metadata: { transcription_outcome: "transcribed", transcript_text: "Hello.", transcription_engine: "private-cloud" } });
    expect(committed.ok).toBe(true);
    await until(() => fake.callNamesRead("call-2") === undefined);
    expect(metadata("call-2")).toMatchObject({ call_participants: PEOPLE, speaker_names: { Them: "Alex Example" } });
  });
});
