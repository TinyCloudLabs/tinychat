import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { BatchResponse, StreamResponse, TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import { PARAKEET_MODEL_ID } from "@/lib/localTranscriber";
import { saveCallNames } from "../callNames";
import { CALL_ROSTERS_KEY, nameCallSpeakersOnThisMac, rememberCallRoster, rememberedCallRoster } from "../callSpeakersOnThisMac";
import { getDesktopCaptureExtras, registerDesktopCaptureExtras } from "../desktopCaptureExtras";
import { createFakeDesktopCaptureExtras, type FakeDesktopCaptureExtrasOptions } from "../fakeDesktopCaptureExtras";
import type { LocalTranscript, VoiceNoteRecording } from "../nativeVoiceNotes";
import { localTranscriptToSave } from "../voiceNoteStore";
import type { WebStore } from "../web/webStore";
import type { DesktopBridge } from "./desktopVoiceNotes";
import { createDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";
import { createTauriDesktopCaptureExtras } from "./tauriDesktopCaptureExtras";

// Who spoke when, wired: the Whisper job reads the speaking timeline and the call's people on this Mac after the
// transcript is built and before it is stored, and stores the remote lines with their labels and person ids. A read
// that fails or never answers stores the transcript with "Them", without failing or holding it up.

const PEOPLE = { v: 1, source: "call_window", app: "google-meet", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }] };
const TURNS = [
  { channel: 0, start: 0, end: 3000 }, { channel: 1, start: 3500, end: 9000 }, { channel: 1, start: 9600, end: 15000 },
  { channel: 0, start: 15500, end: 17000 }, { channel: 1, start: 17500, end: 21000 }, { channel: 1, start: 21500, end: 26000 },
];
const TIMELINE = { v: 1, app: "google-meet", mode: "rules", rules_version: 3, sample_ms: 200, self: "p1",
  people: { p2: { speaking: [[4200, 9700], [18200, 21700]], seen: [[0, 60000]] }, p3: { speaking: [[10300, 15700], [22200, 26700]], seen: [[0, 60000]] } },
  self_speaking: [[700, 3700], [16200, 17700]], hidden: [], breaks: [], truncated: false };
const NAMED = ["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2"];
const PLAIN = ["Me", "Them", "Them", "Me", "Them", "Them"];

const chunk = (turn: typeof TURNS[number], index: number): StreamResponse => ({ type: "Results", start: turn.start / 1000,
  duration: (turn.end - turn.start) / 1000, is_final: true, speech_final: true, from_finalize: false,
  channel: { alternatives: [{ transcript: `line ${index}`, words: [], confidence: 1 }] }, metadata: {} as never, channel_index: [turn.channel, 2] });
const response = { metadata: { duration: 60, channels: 2 }, results: { channels: [{ alternatives: [{ transcript: "lines", words: [], confidence: 1 }] }] } } as unknown as BatchResponse;

/** A localStorage for the kept rosters. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return { get length() { return items.size; }, clear: () => items.clear(), getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null, removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)) };
}
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() }));
afterEach(() => {
  registerDesktopCaptureExtras(null);
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function desktop(callNames: FakeDesktopCaptureExtrasOptions["callNames"] = { enabled: true, permission: "granted",
  read: { "note-1": PEOPLE }, speaking: { "note-1": TIMELINE } }) {
  const fake = createFakeDesktopCaptureExtras({ callNames });
  registerDesktopCaptureExtras(fake.extras);
  return fake;
}

/** A queue over one stereo note; `job()` runs its first transcription, `rerun()` a new one. */
function queueFor(options: { model?: string; channels?: 1 | 2;
  nameCallSpeakers?: Parameters<typeof createDesktopWhisperQueue>[0]["nameCallSpeakers"] } = {}) {
  const model = options.model ?? "QuantizedLargeTurbo";
  const saved: LocalTranscript[] = [];
  const note = { id: "note-1", durationMs: 60_000, channels: options.channels ?? 2, owner: null,
    options: { transcriber: "on-device" } } as unknown as VoiceNoteRecording;
  const store = {
    // The job's status is stored with the note, so a finished note is not picked up again.
    updateStt: async (_id: string, stt: VoiceNoteRecording["stt"]) => { note.stt = stt; },
    listPending: async () => ({ recordings: [note] }),
    getTranscript: async () => ({ transcript: saved.at(-1) ?? null }),
    putTranscriptForOwner: async ({ transcript }: { transcript: LocalTranscript }) => { saved.push(structuredClone(transcript)); return { transcript }; },
  } as unknown as WebStore;
  const files = {
    invoke: async (command: string) => command === "recorder_models_get" ? model
      : command === "recorder_models_list" ? [{ id: model, downloaded: true }] : undefined,
  } as unknown as DesktopBridge;
  let listener: (event: TranscriptionEvent) => void = () => {};
  const finish = (id: string) => {
    TURNS.forEach((turn, index) => listener({ type: "progress", session_id: id, event: { type: "segment", response: chunk(turn, index), percentage: index / TURNS.length } }));
    listener({ type: "completed", session_id: id, mode: "streamed", response } as TranscriptionEvent);
  };
  const whisper: DesktopWhisperBridge = {
    startServer: async () => "http://127.0.0.1:0",
    stopServer: async () => {},
    stopTranscription: async () => {},
    onTranscription: async (cb) => { listener = cb; return () => {}; },
    startTranscription: async ({ id }) => finish(id),
    startLocalStt: async ({ id }) => {
      listener({ type: "completed", session_id: id, mode: "streamed", response: { metadata: { duration: 60, channels: 2 }, results: { channels: [
        { alternatives: [{ transcript: "hello", confidence: 1, words: [{ word: "hello", start: 0.5, end: 1, confidence: 1, channel: 0 }] }] },
        { alternatives: [{ transcript: "yes", confidence: 1, words: [{ word: "yes", start: 4, end: 5, confidence: 1, channel: 1 }] }] },
      ] } } as unknown as BatchResponse } as TranscriptionEvent);
    },
  };
  const queue = createDesktopWhisperQueue({ store, files, whisper, captureLive: () => false, nameCallSpeakers: options.nameCallSpeakers });
  const settled = async (start: () => Promise<void>) => {
    const count = saved.length;
    const done = Promise.withResolvers<void>();
    let seenRunning = false;
    const stop = queue.subscribe(() => {
      const state = queue.snapshot().get("note-1")?.state;
      if (state === "transcribing") seenRunning = true;
      if ((state === "done" && (seenRunning || saved.length > count)) || state === "failed") done.resolve();
    });
    await start();
    await done.promise;
    stop();
    // The job tidies up (its staged audio) after it reports done; the next one starts after that.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return queue.snapshot().get("note-1");
  };
  return {
    saved,
    job: () => settled(() => queue.noteCommitted(note)),
    rerun: (rev: number) => settled(() => queue.rerun({ id: "note-1", rev, baseRev: rev - 1, baseHash: "hash" })),
    dispose: () => queue.dispose(),
  };
}

const labels = (transcript: LocalTranscript | undefined) => transcript?.segments.map((segment) => segment.speaker);

describe("the Whisper job", () => {
  test("stores a three-person call with each remote line's label and person id", async () => {
    const fake = desktop();
    const run = queueFor();
    try {
      expect((await run.job())?.state).toBe("done");
    } finally { run.dispose(); }
    const [transcript] = run.saved;
    expect(labels(transcript)).toEqual(NAMED);
    expect(transcript!.segments.map((segment) => segment.speakerId ?? null)).toEqual([null, "call:p2", "call:p3", null, "call:p2", "call:p3"]);
    expect(transcript!.segments.map((segment) => segment.channel)).toEqual([0, 1, 1, 0, 1, 1]);
    expect(fake.calls).toEqual(["callNames.readSpeaking:note-1", "callNames.read:note-1"]);
    // Saved with the transcript as the contract says: the label as the speaker, the id beside it; no name anywhere.
    const save = localTranscriptToSave(transcript!);
    expect(save.sentences.map((sentence) => [sentence.speaker_name, sentence.speaker_id ?? null, sentence.channel])).toEqual([
      ["Me", null, 0], ["Them 1", "call:p2", 1], ["Them 2", "call:p3", 1], ["Me", null, 0], ["Them 1", "call:p2", 1], ["Them 2", "call:p3", 1]]);
    expect(save.speakers).toEqual(["Me", "Them 1", "Them 2"]);
    expect(JSON.stringify(transcript)).not.toContain("Alex");
    expect(JSON.stringify(transcript)).not.toContain("Dana");
  });

  test("a new transcript of the same recording gets the same labels after the names have left this Mac", async () => {
    const fake = desktop();
    const run = queueFor();
    try {
      await run.job();
      // The note reached the space: the names moved to its row and the app's copy was cleared. The timeline stays.
      await fake.extras.callNames!.clear("note-1");
      expect((await run.rerun(2))?.state).toBe("done");
    } finally { run.dispose(); }
    expect(run.saved.map((transcript) => transcript.rev)).toEqual([1, 2]);
    expect(labels(run.saved[1])).toEqual(NAMED);
    expect(run.saved[1]!.segments).toEqual(run.saved[0]!.segments);
  });

  test("names the lines when the names were moved to the row before the transcription ended", async () => {
    const fake = desktop();
    rememberCallRoster("note-1", PEOPLE as never);
    await fake.extras.callNames!.clear("note-1");
    const run = queueFor();
    try { await run.job(); } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(NAMED);
  });

  test("a timeline read that never answers stores the transcript with Them after the bounded wait", async () => {
    const fake = desktop();
    const callNames = fake.extras.callNames!;
    callNames.readSpeaking = () => new Promise(() => {});
    const run = queueFor({ nameCallSpeakers: (note, transcript) => nameCallSpeakersOnThisMac(note, transcript, 50) });
    const started = performance.now();
    try {
      expect((await run.job())?.state).toBe("done");
    } finally { run.dispose(); }
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(labels(run.saved[0])).toEqual(PLAIN);
  });

  test("a names read that never answers stores the transcript with Them after the bounded wait", async () => {
    const fake = desktop();
    fake.extras.callNames!.read = () => new Promise(() => {});
    const run = queueFor({ nameCallSpeakers: (note, transcript) => nameCallSpeakersOnThisMac(note, transcript, 50) });
    try { await run.job(); } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(PLAIN);
  });

  test("a read that fails, or an answer not in the agreed shape, stores the transcript with Them", async () => {
    const fake = desktop();
    fake.failNext("callNames.readSpeaking", "speaking file unreadable");
    const run = queueFor();
    try {
      expect((await run.job())?.state).toBe("done");
      expect(labels(run.saved[0])).toEqual(PLAIN);
    } finally { run.dispose(); }
    desktop({ enabled: true, permission: "granted", read: { "note-1": PEOPLE }, speaking: { "note-1": { ...TIMELINE, v: 2 } } });
    const again = queueFor();
    try { await again.job(); } finally { again.dispose(); }
    expect(labels(again.saved[0])).toEqual(PLAIN);
  });

  test("a naming step that throws stores the transcript with Them", async () => {
    const run = queueFor({ nameCallSpeakers: async () => { throw new Error("boom"); } });
    try {
      expect((await run.job())?.state).toBe("done");
    } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(PLAIN);
  });

  test("asks nothing on the Parakeet route, for a recording of one side, or in a build without the timeline", async () => {
    const fake = desktop();
    const parakeet = queueFor({ model: PARAKEET_MODEL_ID });
    try { await parakeet.job(); } finally { parakeet.dispose(); }
    expect(parakeet.saved[0]?.engine).toBe("parakeet-tdt-0.6b-v3");
    expect(parakeet.saved[0]?.segments.some((segment) => segment.speakerId)).toBe(false);
    const mono = queueFor({ channels: 1 });
    try { await mono.job(); } finally { mono.dispose(); }
    expect(mono.saved[0]?.segments.some((segment) => segment.speakerId)).toBe(false);
    expect(fake.calls).toEqual([]);
    const older = desktop({ enabled: true, permission: "granted", read: { "note-1": PEOPLE } });
    const run = queueFor();
    try { await run.job(); } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(PLAIN);
    expect(older.calls).toEqual([]);
  });

  test("a call with one other person keeps Them, for the 1:1 suggestion", async () => {
    desktop({ enabled: true, permission: "granted", speaking: { "note-1": TIMELINE },
      read: { "note-1": { ...PEOPLE, people: PEOPLE.people.slice(0, 2) } } });
    const run = queueFor();
    try { await run.job(); } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(PLAIN);
  });
});

describe("the people by id, kept on this Mac", () => {
  test("saving the names to the row keeps their ids, without names, before the app's copy is cleared", async () => {
    const fake = desktop();
    const sqlite = new Database(":memory:");
    sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
    sqlite.run("INSERT INTO connector_meeting VALUES ('vn-note-1', 'exo-voice-note', ?, '')", [JSON.stringify({ capture: { channels: 2 } })]);
    const tcw = { did: "did:test", sql: { db: () => ({
      query: async (sql: string, params: never[]) => ({ ok: true, data: { rows: sqlite.query(sql).values(...params) } }),
      execute: async (sql: string, params: never[]) => ({ ok: true, data: { changes: sqlite.run(sql, params).changes } }),
    }) } } as unknown as TinyCloudWeb;
    expect(await saveCallNames(tcw, "note-1", "vn-note-1")).toBe("saved");
    expect(fake.callNamesRead("note-1")).toBeUndefined();
    expect(rememberedCallRoster("note-1")).toEqual({ self: ["p1"], others: ["p2", "p3"] });
    const kept = localStorage.getItem(CALL_ROSTERS_KEY)!;
    expect(kept).not.toContain("Alex");
    expect(kept).not.toContain("Robin");
  });

  test("are kept 30 days, and unreadable storage keeps nothing", () => {
    const now = Date.UTC(2026, 10, 20);
    rememberCallRoster("old", PEOPLE as never, now - 31 * 24 * 60 * 60_000);
    rememberCallRoster("new", PEOPLE as never, now);
    expect(rememberedCallRoster("old", now)).toBeNull();
    expect(rememberedCallRoster("new", now)).toEqual({ self: ["p1"], others: ["p2", "p3"] });
    expect(Object.keys(JSON.parse(localStorage.getItem(CALL_ROSTERS_KEY)!))).toEqual(["new"]);
    localStorage.setItem(CALL_ROSTERS_KEY, "{not json");
    expect(rememberedCallRoster("new", now)).toBeNull();
    localStorage.setItem(CALL_ROSTERS_KEY, JSON.stringify({ new: { self: ["p 1"], others: ["p2"], at: now } }));
    expect(rememberedCallRoster("new", now)).toBeNull();
  });
});

describe("the Tauri binding", () => {
  const bridgeWith = (reply: (command: string, args?: Record<string, unknown>) => unknown) => {
    const log: string[] = [];
    const bridge = {
      invoke: async (command: string, args?: Record<string, unknown>) => { log.push(`${command}:${JSON.stringify(args ?? {})}`); return reply(command, args); },
      listen: async () => () => {},
    } as unknown as DesktopBridge;
    return { bridge, log };
  };

  test("reads the timeline with call_names_speaking_read, beside the names", async () => {
    const { bridge, log } = bridgeWith((command) => command === "call_names_speaking_read" ? TIMELINE : null);
    const callNames = createTauriDesktopCaptureExtras(bridge).callNames!;
    expect(await callNames.readSpeaking!("note-1")).toEqual(TIMELINE);
    expect(log).toEqual(['call_names_speaking_read:{"id":"note-1"}']);
  });

  test("a build without the command answers null from then on, and keeps the names", async () => {
    const { bridge, log } = bridgeWith((command) => {
      if (command === "call_names_speaking_read") throw new Error("Command call_names_speaking_read not found");
      return PEOPLE;
    });
    const extras = createTauriDesktopCaptureExtras(bridge);
    registerDesktopCaptureExtras(extras);
    expect(await extras.callNames!.readSpeaking!("note-1")).toBeNull();
    expect(await extras.callNames!.readSpeaking!("note-2")).toBeNull();
    expect(log.filter((line) => line.startsWith("call_names_speaking_read"))).toHaveLength(1);
    expect(getDesktopCaptureExtras()?.callNames).toBeDefined();
    expect(await extras.callNames!.read("note-1")).toEqual(PEOPLE);
  });

  test("any other failure is the caller's to handle", async () => {
    const { bridge } = bridgeWith(() => { throw new Error("speaking file too large"); });
    const extras = createTauriDesktopCaptureExtras(bridge);
    await expect(extras.callNames!.readSpeaking!("note-1")).rejects.toThrow("speaking file too large");
    expect(extras.callNames).toBeDefined();
  });
});

test("the fake has readSpeaking only when given timelines, and the timeline stays when the names are cleared", async () => {
  expect(createFakeDesktopCaptureExtras({ callNames: {} }).extras.callNames?.readSpeaking).toBeUndefined();
  const fake = createFakeDesktopCaptureExtras({ callNames: { read: { "note-1": PEOPLE }, speaking: { "note-1": TIMELINE } } });
  await fake.extras.callNames!.clear("note-1");
  expect(await fake.extras.callNames!.readSpeaking!("note-1")).toEqual(TIMELINE);
  expect(await fake.extras.callNames!.readSpeaking!("note-2")).toBeNull();
  expect(fake.calls).toEqual(["callNames.clear:note-1", "callNames.readSpeaking:note-1", "callNames.readSpeaking:note-2"]);
});

describe("a timeline with its own order of the people", () => {
  const ORDERED = { ...TIMELINE, order: ["p1", "p2", "p3"] };

  test("names the lines with the names file gone and nothing kept on this Mac", async () => {
    desktop({ enabled: true, permission: "granted", read: {}, speaking: { "note-1": ORDERED } });
    const run = queueFor();
    try { await run.job(); } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(NAMED);
    expect(rememberedCallRoster("note-1")).toBeNull();
  });

  test("names the lines when the names read never answers", async () => {
    const fake = desktop({ enabled: true, permission: "granted", read: { "note-1": PEOPLE }, speaking: { "note-1": ORDERED } });
    fake.extras.callNames!.read = () => new Promise(() => {});
    const run = queueFor({ nameCallSpeakers: (note, transcript) => nameCallSpeakersOnThisMac(note, transcript, 50) });
    try { await run.job(); } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(NAMED);
  });

  test("an order not in the agreed shape falls back to the names file", async () => {
    desktop({ enabled: true, permission: "granted", read: { "note-1": PEOPLE }, speaking: { "note-1": { ...TIMELINE, order: ["p1", "p1"] } } });
    const run = queueFor();
    try { await run.job(); } finally { run.dispose(); }
    expect(labels(run.saved[0])).toEqual(NAMED);
  });
});
