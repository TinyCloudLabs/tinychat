import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { registerDesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { VoiceNotes, __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { saveCallSpeakerNames } from "@/lib/voiceNotes/callNames";
import { callSpeakerLabels } from "./callParticipants";
import { SpeakerNamesContext, SpeakerNamesStatus } from "./SpeakerLabel";
import { TimestampedTranscript } from "./TimestampedTranscript";
import { useSpeakerNames } from "./useSpeakerNames";

// Who spoke when, on the page: a note whose row does not hold the names yet (only on this Mac, or its row cannot be
// read) shows each "Them N" label with the name of the person its lines carry, from this Mac's names file, marked
// Suggested, under the same rules as the 1:1 suggestion. Nothing here waits for the space.

const PEOPLE = { v: 1, source: "call_window", app: "google-meet", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }] };
const sentences = [
  { index: 0, speaker_name: "Me", text: "Shall we start?", start_time: 0, end_time: 3 },
  { index: 1, speaker_name: "Them 1", speaker_id: "call:p2", text: "Yes, the press kit is ready.", start_time: 3.5, end_time: 9 },
  { index: 2, speaker_name: "Them 2", speaker_id: "call:p3", text: "The pricing page is nearly done.", start_time: 9.6, end_time: 15 },
  { index: 3, speaker_name: "Me", text: "Great.", start_time: 15.5, end_time: 17 },
  { index: 4, speaker_name: "Them 1", speaker_id: "call:p2", text: "I will send it today.", start_time: 17.5, end_time: 21 },
];
const SPEAKERS = callSpeakerLabels(sentences);

type Ledger = { speakerNames?: Record<string, string> | null; speakerSuggestionsEnded?: string[] | null };

/** The capture ledger of one note on this Mac, as the name lane reads and writes it. */
function onThisMac(ledger: Ledger = {}) {
  const recording = { id: "rec-1", owner: "did:test", rev: 1, ledger: { ...ledger },
    startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
  const plugin = {
    listPending: async () => ({ recordings: [recording] }),
    updateLedger: async ({ id, did, rev, patch }: { id: string; did: string; rev: number; patch: Ledger }) => {
      if (id !== "rec-1" || did !== "did:test") throw Object.assign(new Error("owner"), { code: "owner_mismatch" });
      if (rev !== recording.rev) throw Object.assign(new Error("rev"), { code: "rev_conflict" });
      recording.rev = rev + 1;
      recording.ledger = { ...recording.ledger, ...structuredClone(patch) };
      return { rev: recording.rev };
    },
  };
  __setVoiceNotesForTests(plugin as never, { available: true });
  return { ledger: () => recording.ledger };
}

function desktop(read: Record<string, unknown> = { "rec-1": PEOPLE }) {
  const fake = createFakeDesktopCaptureExtras({ callNames: { enabled: true, permission: "granted", read } });
  registerDesktopCaptureExtras(fake.extras);
  return fake;
}

const original = VoiceNotes;
let root: Root | null = null;
let cleanup: (() => void) | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  cleanup?.();
  root = null;
  cleanup = null;
  registerDesktopCaptureExtras(null);
  __setVoiceNotesForTests(original, { available: null });
});

type Place = { localId?: string | null; unreadRow?: { id: string; source: string; sourceId: string } | null };

function Probe(props: { tcw: TinyCloudWeb; lines?: typeof sentences } & Place) {
  const lines = props.lines ?? sentences;
  const speakers = useSpeakerNames({ tcw: props.tcw, row: null, metadata: null, localId: props.localId ?? null,
    unreadRow: props.unreadRow ?? null, callSpeakers: props.lines ? callSpeakerLabels(lines) : SPEAKERS });
  return <SpeakerNamesContext.Provider value={speakers}>
    <SpeakerNamesStatus />
    <output data-testid="suggested">{[...speakers?.suggested ?? []].join(",")}</output>
    <TimestampedTranscript sentences={lines} hasAudio={false} />
  </SpeakerNamesContext.Provider>;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const mount = async (tcw: TinyCloudWeb, place: Place, lines?: typeof sentences) => {
  cleanup ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tcw={tcw} lines={lines} {...place} />));
  await settle();
};
const labels = () => [...document.querySelectorAll('[data-testid="speaker-label"]')].map((el) => el.textContent);
const marks = () => [...document.querySelectorAll('[data-testid="speaker-suggested"]')].length;
const suggested = () => document.querySelector('[data-testid="suggested"]')!.textContent;
const openLabel = async (label: string, nth = 0) => {
  const target = [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-label"]')].filter((el) => el.textContent === label)[nth];
  expect(target).toBeDefined();
  await act(async () => target!.click());
};
const field = () => document.querySelector<HTMLInputElement>('[data-testid="speaker-rename-form"] input')!;
const type = async (name: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), name);
  field().dispatchEvent(new window.Event("input", { bubbles: true }));
});
const submit = async () => {
  await act(async () => document.querySelector('[data-testid="speaker-rename-form"]')!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  await settle();
};
const button = async (text: string) => {
  const target = [...document.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent === text);
  expect(target).toBeDefined();
  await act(async () => target!.click());
  await settle();
};
/** A space that cannot be reached: it has no database to answer. */
const offline = { did: "did:test" } as TinyCloudWeb;
const LOCAL = { localId: "rec-1" };

test("a three-person call only on this Mac shows each Them N's name, marked Suggested, with the space unreachable", async () => {
  onThisMac();
  const fake = desktop();
  await mount(offline, LOCAL);
  expect(labels()).toEqual(["Me", "Alex Example", "Dana Lee", "Me", "Alex Example"]);
  expect(marks()).toBe(3);
  expect(suggested()).toBe("Them 1,Them 2");
  expect(fake.calls).toEqual(["callNames.read:rec-1"]);
  // Renaming Them 1 offers the other people in the call.
  await openLabel("Alex Example");
  expect([...document.querySelectorAll('[data-testid="speaker-choices"] button')].map((el) => el.textContent)).toEqual(["Dana Lee"]);
});

test("renaming one label ends its suggestion only; Undo and Go back act on that label", async () => {
  const mac = onThisMac();
  desktop();
  await mount(offline, LOCAL);
  await openLabel("Alex Example");
  await type("Sam Placeholder");
  await submit();
  expect(labels()).toEqual(["Me", "Sam Placeholder", "Dana Lee", "Me", "Sam Placeholder"]);
  expect(suggested()).toBe("Them 2");
  expect(mac.ledger()).toEqual({ speakerNames: { "Them 1": "Sam Placeholder" }, speakerSuggestionsEnded: ["Them 1"] });
  await button("Undo");
  expect(labels()).toEqual(["Me", "Alex Example", "Dana Lee", "Me", "Alex Example"]);
  // Put back as the user's own name: the mark does not come back, as with the 1:1 suggestion.
  expect(suggested()).toBe("Them 2");
  await openLabel("Dana Lee");
  await button("Go back to Them 2");
  expect(labels()).toEqual(["Me", "Alex Example", "Them 2", "Me", "Alex Example"]);
  expect(suggested()).toBe("");
  expect(mac.ledger().speakerSuggestionsEnded).toEqual(["Them 1", "Them 2"]);
  // The note opened again shows what the user chose; the ended suggestions do not come back.
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  await mount(offline, LOCAL);
  expect(labels()).toEqual(["Me", "Alex Example", "Them 2", "Me", "Alex Example"]);
  expect(marks()).toBe(0);
});

test("a name the user gave a label, or a suggestion they ended, wins over the suggestion", async () => {
  onThisMac({ speakerNames: { "Them 2": "Dana L." }, speakerSuggestionsEnded: ["Them 1"] });
  desktop();
  await mount(offline, LOCAL);
  expect(labels()).toEqual(["Me", "Them 1", "Dana L.", "Me", "Them 1"]);
  expect(marks()).toBe(0);
});

test("a label whose person is the user or not in the call, or a transcript without labels, gets nothing", async () => {
  onThisMac();
  desktop();
  const lines = sentences.map((sentence) => sentence.speaker_id === "call:p2" ? { ...sentence, speaker_id: "call:p1" }
    : sentence.speaker_id === "call:p3" ? { ...sentence, speaker_id: "call:p9" } : sentence);
  await mount(offline, LOCAL, lines);
  expect(labels()).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1"]);
  expect(marks()).toBe(0);
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  // A call with more people, without a timeline: as before, Them with no suggestion.
  await mount(offline, LOCAL, sentences.map((sentence) => sentence.speaker_name.startsWith("Them") ? { ...sentence, speaker_name: "Them", speaker_id: undefined } : sentence));
  expect(labels()).toEqual(["Me", "Them", "Me", "Them"]);
  expect(marks()).toBe(0);
});

test("two labels that get one name read as one speaker", async () => {
  onThisMac({ speakerNames: { "Them 2": "Alex Example" } });
  desktop();
  const lines = [sentences[0]!, sentences[1]!, sentences[2]!, sentences[3]!];
  await mount(offline, LOCAL, lines);
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
});

test("a rename on a row that cannot be read lands the label's suggestion first, so it never comes after the rename", async () => {
  desktop();
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('vn-rec-1', 'exo-voice-note', ?, '')", [JSON.stringify({ capture: { channels: 2 } })]);
  const tcw = { did: "did:test", spaceId: "did:test", sql: { db: () => ({
    query: async (sql: string, params: never[]) => ({ ok: true, data: { rows: sqlite.query(sql).values(...params) } }),
    execute: async (sql: string, params: never[]) => ({ ok: true, data: { changes: sqlite.run(sql, params).changes } }),
  }) } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'vn-rec-1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
  await mount(tcw, { unreadRow: { id: "vn-rec-1", source: "exo-voice-note", sourceId: "rec-1" } });
  expect(labels()).toEqual(["Me", "Alex Example", "Dana Lee", "Me", "Alex Example"]);
  await openLabel("Alex Example");
  await button("Go back to Them 1");
  expect(labels()).toEqual(["Me", "Them 1", "Dana Lee", "Me", "Them 1"]);
  // The names moved to the row, Them 1's suggestion was made and then ended by the reset.
  expect(stored()).toMatchObject({ call_participants: PEOPLE, speaker_suggestions_made: { "Them 1": expect.any(String) } });
  expect((stored().speaker_names as Record<string, string> | undefined)?.["Them 1"]).toBeUndefined();
  // The transcript commit's own save comes after: it does not bring Them 1's suggestion back.
  expect(await saveCallSpeakerNames(tcw, "rec-1", "vn-rec-1", SPEAKERS)).toBe("saved");
  expect(stored()).toMatchObject({ speaker_names: { "Them 2": "Dana Lee" } });
  expect((stored().speaker_names as Record<string, string>)["Them 1"]).toBeUndefined();
});
