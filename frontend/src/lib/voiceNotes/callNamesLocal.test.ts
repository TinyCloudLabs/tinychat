import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { saveCallNames } from "./callNames";
import { registerDesktopCaptureExtras } from "./desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "./fakeDesktopCaptureExtras";
import { readLedgerSuggestionsEnded, saveLedgerSpeakerNames } from "./ledgerSpeakerNames";
import { VoiceNotes, __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { saveRecording } from "./recorderSaves";
import { patchRowSpeakerName } from "./voiceNoteRows";
import { saveVoiceNote } from "./voiceNoteStore";

// Names in the call for a note saved while the space was down: the page used the desktop app's copy, and the user may
// have renamed Them on this Mac. When the note reaches the space later, its row must be the row it would have had if
// the space had been reachable from the start, and the app's copy is cleared once.

const ONE_ON_ONE = { v: 1, source: "call_window", app: "google-meet", truncated: false,
  people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }] };

const original = VoiceNotes;
afterEach(() => {
  registerDesktopCaptureExtras(null);
  __setVoiceNotesForTests(original, { available: null });
});

let count = 0;
/** The space as the save path sees it: the connectors database and KV, in memory. */
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:call-names-local-${++count}`;
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

type Ledger = { speakerNames?: Record<string, string> | null; speakerSuggestionsEnded?: string[] | null };

/** A recording of both sides of a call, on this Mac, with its capture ledger as the device holds it. */
function onThisMac(tcw: TinyCloudWeb, ledger: Ledger = {}) {
  const recording = { id: "call-1", owner: tcw.did, rev: 1, channels: 2 as const, startedAt: Date.UTC(2026, 10, 18, 18),
    durationMs: 60_000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    version: 2 as const, source: "in_app" as const, ledger: { ...ledger } as Ledger,
    options: { transcriber: "private-cloud" as const, identifySpeakers: false, uploadAudio: false } };
  const plugin = {
    listPending: async () => ({ recordings: [structuredClone(recording)] }),
    getTranscript: async () => ({ transcript: null }),
    updateLedger: async ({ rev, patch }: { rev: number; patch: Ledger }) => {
      if (rev !== recording.rev) throw Object.assign(new Error("rev"), { code: "rev_conflict" });
      recording.rev = rev + 1;
      recording.ledger = { ...recording.ledger, ...structuredClone(patch) };
      return { rev: recording.rev };
    },
  };
  __setVoiceNotesForTests(plugin as never, { available: true });
  return recording;
}

function desktop() {
  const fake = createFakeDesktopCaptureExtras({ callNames: { enabled: true, permission: "granted", read: { "call-1": ONE_ON_ONE } } });
  registerDesktopCaptureExtras(fake.extras);
  return fake;
}

const AUDIO = { mimeType: "audio/mp4", size: 4, readPart: async () => new Uint8Array([1, 2, 3, 4]) };
const until = async (done: () => boolean) => { for (let turn = 0; turn < 200 && !done(); turn++) await Bun.sleep(5); };
const clears = (fake: ReturnType<typeof desktop>) => fake.calls.filter((call) => call === "callNames.clear:call-1").length;
/** The suggestion's time is when it was made: the one field two saves at different moments cannot share. */
const withoutTimes = (metadata: Record<string, unknown> | null) => JSON.parse(JSON.stringify(metadata).replace(/"at":"[^"]*"/g, '"at":"-"')) as unknown;

/** The note saved once its names were in the space: the save, then the user's rename on the row. */
async function savedOnline(rename?: string | null) {
  const fake = desktop();
  const { tcw, metadata } = space();
  const recording = onThisMac(tcw);
  expect((await saveVoiceNote(tcw, recording as never, AUDIO, "tauri")).ok).toBe(true);
  await until(() => fake.callNamesRead("call-1") === undefined);
  if (rename !== undefined) await patchRowSpeakerName(tcw, `vn-call-1`, "Them", rename);
  return metadata("call-1");
}

/** The note renamed on this Mac first (the ledger write the page makes), then saved once the space is back. */
async function savedLater(rename?: string | null) {
  const fake = desktop();
  const { tcw, metadata } = space();
  const recording = onThisMac(tcw);
  if (rename !== undefined) await saveLedgerSpeakerNames(tcw, "call-1", (stored) => {
    const next = { ...stored };
    if (rename === null) delete next.Them; else next.Them = rename;
    return next;
  }, "Them");
  expect((await saveVoiceNote(tcw, recording as never, AUDIO, "tauri")).ok).toBe(true);
  await until(() => fake.callNamesRead("call-1") === undefined);
  // The next pass over saved notes finds nothing left on this Mac.
  const saved = { ...recording, ledger: { ...recording.ledger, audio: { state: "saved" as const, rowId: "vn-call-1", at: 1 } } };
  expect((await saveRecording(tcw, saved as never)).kind).toBe("already-saved");
  await Bun.sleep(20);
  expect(clears(fake)).toBe(1);
  return { metadata: metadata("call-1"), fake };
}

describe("a note named on this Mac, saved to the space later", () => {
  test("untouched: the row gets the people and the suggestion, as it would have online", async () => {
    const later = await savedLater();
    expect(later.metadata).toMatchObject({ call_participants: ONE_ON_ONE, speaker_names: { Them: "Alex Example" },
      speaker_suggestions: { Them: { name: "Alex Example", person: "p2" } } });
    expect(withoutTimes(later.metadata)).toEqual(withoutTimes(await savedOnline()));
  });

  test("renamed on this Mac: the user's name is saved, never replaced, and nothing is suggested", async () => {
    const later = await savedLater("Alex");
    expect(later.metadata).toMatchObject({ call_participants: ONE_ON_ONE, speaker_names: { Them: "Alex" } });
    expect(later.metadata?.speaker_suggestions).toBeUndefined();
    expect(later.metadata).toEqual(await savedOnline("Alex"));
  });

  test("the suggestion kept on this Mac (Save unchanged, or Undo back to it) is saved as the user's name", async () => {
    const later = await savedLater("Alex Example");
    expect(later.metadata?.speaker_names).toEqual({ Them: "Alex Example" });
    expect(later.metadata?.speaker_suggestions).toBeUndefined();
    expect(later.metadata).toEqual(await savedOnline("Alex Example"));
  });

  test("put back to Them on this Mac: the row has the people but no name and no second suggestion", async () => {
    const later = await savedLater(null);
    expect(later.metadata?.call_participants).toEqual(ONE_ON_ONE);
    expect(later.metadata?.speaker_names).toBeUndefined();
    expect(later.metadata?.speaker_suggestions).toBeUndefined();
    expect(later.metadata).toEqual(await savedOnline(null));
  });
});

describe("the ended suggestions in the capture ledger", () => {
  test("are read fresh at save time; a device that cannot answer ends nothing", async () => {
    const { tcw } = space();
    onThisMac(tcw, { speakerSuggestionsEnded: ["Them"] });
    expect(await readLedgerSuggestionsEnded("call-1")).toEqual(["Them"]);
    expect(await readLedgerSuggestionsEnded("other")).toEqual([]);
    __setVoiceNotesForTests({ listPending: async () => { throw new Error("busy"); } } as never, { available: true });
    expect(await readLedgerSuggestionsEnded("call-1")).toEqual([]);
  });

  test("a label is ended once, whatever else the ledger holds", async () => {
    const { tcw } = space();
    const recording = onThisMac(tcw, { speakerNames: { Me: "Robin" }, speakerSuggestionsEnded: ["Them"] });
    await saveLedgerSpeakerNames(tcw, "call-1", (stored) => ({ ...stored, Them: "Alex" }), "Them");
    expect(recording.ledger).toEqual({ speakerNames: { Me: "Robin", Them: "Alex" }, speakerSuggestionsEnded: ["Them"] });
  });

  test("the save's retry after a transcript commit honours them too", async () => {
    const fake = desktop();
    const { tcw, metadata } = space();
    const recording = onThisMac(tcw, { speakerSuggestionsEnded: ["Them"] });
    fake.failNext("callNames.read", "reader busy");
    expect((await saveVoiceNote(tcw, recording as never, AUDIO, "tauri")).ok).toBe(true);
    await until(() => fake.calls.includes("callNames.read:call-1"));
    await Bun.sleep(20);
    expect(metadata("call-1")?.call_participants).toBeUndefined();
    expect(await saveCallNames(tcw, "call-1", "vn-call-1")).toBe("saved");
    expect(metadata("call-1")?.call_participants).toEqual(ONE_ON_ONE);
    expect(metadata("call-1")?.speaker_names).toBeUndefined();
    expect(metadata("call-1")?.speaker_suggestions).toBeUndefined();
    expect(clears(fake)).toBe(1);
  });
});
