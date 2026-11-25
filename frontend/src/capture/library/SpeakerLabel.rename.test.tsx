import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { SpeakerNamesContext, SpeakerNamesStatus } from "./SpeakerLabel";
import { TimestampedTranscript } from "./TimestampedTranscript";
import { useSpeakerNames } from "./useSpeakerNames";
import { patchRowSpeakerName } from "@/lib/voiceNotes/voiceNoteRows";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";

const sentences = [
  { index: 0, speaker_name: "Me", text: "Hello.", start_time: 0, end_time: 2 },
  { index: 1, speaker_name: "Them", text: "Let's begin.", start_time: 10, end_time: 12 },
  { index: 2, speaker_name: "Me", text: "Done.", start_time: 20, end_time: 22 },
];
const ROW = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1" };

function space(metadata: Record<string, unknown>) {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('row-1', ?, '')", [JSON.stringify(metadata)]);
  const tcw = { did: "did:test", sql: { db: () => ({
    execute: async (sql: string, params: never[]) =>
      ({ ok: true, data: { changes: sqlite.run(sql, params as never).changes } }),
  }) } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'row-1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
  return { tcw, stored, sqlite };
}

let root: Root | null = null;
let cleanup: (() => void) | null = null;
afterEach(async () => { await act(async () => root?.unmount()); cleanup?.(); root = null; cleanup = null; });

/** The labels the controller reports as suggested, for the assertions below. */
function Suggested() {
  const speakers = useContext(SpeakerNamesContext);
  return <output data-testid="suggested">{[...speakers?.suggested ?? []].join(",")}</output>;
}

function Probe(props: { tcw: TinyCloudWeb; metadata: Record<string, unknown>;
  row?: { id: string; source: string; sourceId: string } | null; localId?: string | null }) {
  const speakers = useSpeakerNames({ tcw: props.tcw, row: props.row === undefined ? ROW : props.row,
    metadata: props.metadata, localId: props.localId ?? null });
  return <SpeakerNamesContext.Provider value={speakers}>
    <SpeakerNamesStatus />
    <Suggested />
    <TimestampedTranscript sentences={sentences} hasAudio={false} />
  </SpeakerNamesContext.Provider>;
}

const mount = async (tcw: TinyCloudWeb, metadata: Record<string, unknown>, options: { row?: { id: string; source: string; sourceId: string } | null; localId?: string | null } = {}) => {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tcw={tcw} metadata={metadata} {...options} />));
};
const labels = () => [...document.querySelectorAll('[data-testid="speaker-label"]')].map((el) => el.textContent);
const rename = async (label: string, name: string) => {
  const target = [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-label"]')]
    .find((el) => el.textContent === label);
  expect(target).toBeDefined();
  await act(async () => target!.click());
  const input = document.querySelector("input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector('[data-testid="speaker-rename-form"]')!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

test("tapping a label renames the speaker, saves it with the note's row, and Undo puts it back", async () => {
  const { tcw, stored } = space({ transcript_provider: "tinycloud-private-transcription", note_kv_key: "k" });
  await mount(tcw, {});
  expect(labels()).toEqual(["Me", "Them", "Me"]);

  await act(async () => (document.querySelector('[data-testid="speaker-label"]') as HTMLElement).click());
  const input = document.querySelector("input") as HTMLInputElement;
  expect(input.placeholder).toBe("Your name");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Sam");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector('[data-testid="speaker-rename-form"]')!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  await settle();
  expect(labels()).toEqual(["Sam", "Them", "Sam"]);
  expect(document.body.textContent).toContain("Me is now Sam.");
  expect(stored()).toEqual({ transcript_provider: "tinycloud-private-transcription", note_kv_key: "k", speaker_names: { Me: "Sam" } });

  await act(async () => (document.querySelector('[data-testid="speaker-rename-undo"]') as HTMLElement).click());
  await settle();
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(stored().speaker_names).toBeUndefined();
  expect(stored().note_kv_key).toBe("k");
});

test("names saved on the row show when the note opens", async () => {
  const { tcw } = space({});
  await mount(tcw, { speaker_names: { Them: "Alice, Bob" } });
  expect(labels()).toEqual(["Me", "Alice, Bob", "Me"]);
});

test("a failed save puts the label back and says so", async () => {
  const tcw = { sql: { db: () => ({ execute: async () => ({ ok: false, error: { code: "X", message: "down" } }) }) } } as unknown as TinyCloudWeb;
  await mount(tcw, {});
  await act(async () => (document.querySelector('[data-testid="speaker-label"]') as HTMLElement).click());
  const input = document.querySelector("input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Sam");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector('[data-testid="speaker-rename-form"]')!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  await settle();
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(document.querySelector('[data-testid="speaker-rename-failed"]')).not.toBeNull();
});

test("the stored names round-trip through the row and clearing the last one removes the key", async () => {
  const { tcw, stored } = space({ capture: { platform: "ios" } });
  await patchRowSpeakerName(tcw, "row-1", "Me", "Sam");
  await patchRowSpeakerName(tcw, "row-1", "Them", "Alice, Bob");
  expect(stored()).toEqual({ capture: { platform: "ios" }, speaker_names: { Me: "Sam", Them: "Alice, Bob" } });
  await patchRowSpeakerName(tcw, "row-1", "Me", null);
  await patchRowSpeakerName(tcw, "row-1", "Them", null);
  expect(stored()).toEqual({ capture: { platform: "ios" } });
  await expect(patchRowSpeakerName(tcw, "missing", "Me", "Sam")).rejects.toThrow("missing");
});

test("a new transcript commit patches the row's metadata and leaves the names in place", async () => {
  const { tcw, stored, sqlite } = space({ transcript_provider: "assemblyai" });
  await patchRowSpeakerName(tcw, "row-1", "Me", "Sam");
  // The commit's own write (voiceNoteRows.ts: json_patch of the transcript keys).
  sqlite.run("UPDATE connector_meeting SET metadata = json_patch(COALESCE(metadata,'{}'), ?) WHERE id = 'row-1'",
    [JSON.stringify({ transcript_provider: "tinycloud-private-transcription", transcription_outcome: "transcribed" })]);
  expect(stored()).toEqual({ transcript_provider: "tinycloud-private-transcription", transcription_outcome: "transcribed", speaker_names: { Me: "Sam" } });
});

test("a rename queued behind a failed one does not put the failed name back: each write is recomputed over what landed", async () => {
  let calls = 0;
  let holdFirst: (() => void) | null = null;
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('row-1', ?, '')", [JSON.stringify({})]);
  const tcw = { did: "did:test", sql: { db: () => ({
    execute: async (sql: string, params: never[]) => {
      calls++;
      // Hold the first save until the second rename is already queued, then fail it.
      if (calls === 1) {
        const gate = Promise.withResolvers<void>();
        holdFirst = () => gate.resolve();
        await gate.promise;
        return { ok: false, error: { code: "X", message: "down" } };
      }
      return { ok: true, data: { changes: sqlite.run(sql, params as never).changes } };
    },
  }) } } as unknown as TinyCloudWeb;
  await mount(tcw, {});
  // The first rename's save is still in flight (and fails below); the second rename must not
  // carry the failed name into the row.
  await rename("Me", "Sam");
  expect(labels()).toEqual(["Sam", "Them", "Sam"]);
  await rename("Them", "Alice");
  holdFirst!();
  await settle();
  await settle();
  expect(labels()).toEqual(["Me", "Alice", "Me"]);
  const stored = JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'row-1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
  expect(stored).toEqual({ speaker_names: { Them: "Alice" } });
});

test("a note still on this phone renames and keeps the name in its capture ledger", async () => {
  const ledger: { speakerNames?: Record<string, string> | null } = { speakerNames: null };
  const recording = { id: "rec-1", owner: "did:test", rev: 3, ledger,
    startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
  // Only the two members the name lane needs; the rest are irrelevant here.
  const plugin = {
    listPending: async () => ({ recordings: [recording] }),
    updateLedger: async ({ id, did, rev, patch }: { id: string; did: string; rev: number; patch: { speakerNames?: Record<string, string> | null } }) => {
      if (id !== "rec-1") throw Object.assign(new Error("not found"), { code: "not_found" });
      if (did !== "did:test") throw Object.assign(new Error("owner"), { code: "owner_mismatch" });
      if (rev !== recording.rev) throw Object.assign(new Error("rev"), { code: "rev_conflict" });
      recording.rev = rev + 1;
      Object.assign(recording.ledger, patch);
      return { rev: recording.rev };
    },
  } as unknown as Parameters<typeof __setVoiceNotesForTests>[0];
  const { VoiceNotes } = await import("@/lib/voiceNotes/nativeVoiceNotes");
  const saved = VoiceNotes;
  __setVoiceNotesForTests(plugin, { available: true });
  try {
    const tcw = { did: "did:test" } as TinyCloudWeb;
    await mount(tcw, {}, { row: null, localId: "rec-1" });
    await settle();
    expect(labels()).toEqual(["Me", "Them", "Me"]);
    await rename("Me", "Sam");
    await settle();
    expect(labels()).toEqual(["Sam", "Them", "Sam"]);
    expect(ledger.speakerNames).toEqual({ Me: "Sam" });
  } finally {
    __setVoiceNotesForTests(saved, { available: null });
  }
});

test("a phone note owned by another account is read-only: the labels stay plain", async () => {
  const recording = { id: "rec-2", owner: "did:someone-else", rev: 1, ledger: {},
    startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
  const plugin = {
    listPending: async () => ({ recordings: [recording] }),
    updateLedger: async () => { throw new Error("must not be called"); },
  } as unknown as Parameters<typeof __setVoiceNotesForTests>[0];
  const { VoiceNotes } = await import("@/lib/voiceNotes/nativeVoiceNotes");
  const saved = VoiceNotes;
  __setVoiceNotesForTests(plugin, { available: true });
  try {
    const tcw = { did: "did:test" } as TinyCloudWeb;
    await mount(tcw, {}, { row: null, localId: "rec-2" });
    await settle();
    // Another account's note: no rename affordance at all — the labels stay plain text.
    expect(document.querySelectorAll('[data-testid="speaker-label"]').length).toBe(0);
    expect(document.body.textContent).toContain("Me");
    expect(document.body.textContent).toContain("Them");
    await act(async () => (document.querySelector("p") as HTMLElement).click());
    expect(document.querySelector("input")).toBeNull();
  } finally {
    __setVoiceNotesForTests(saved, { available: null });
  }
});

test("a rename and its Undo keep a name another writer saved before the write ran", async () => {
  const { tcw, stored, sqlite } = space({});
  const lane = tcw.sql.db as unknown as () => { execute: (sql: string, params: never[]) => Promise<unknown> };
  const direct = lane();
  let injected = false;
  (tcw.sql as { db: unknown }).db = () => ({
    execute: async (sql: string, params: never[]) => {
      if (!injected) {
        injected = true;
        // Another device saves Them -> Alice after this rename was queued and before its write runs.
        sqlite.run("UPDATE connector_meeting SET metadata = json_patch(metadata, '{\"speaker_names\":{\"Them\":\"Alice\"}}') WHERE id = 'row-1'");
      }
      return direct.execute(sql, params);
    },
  });
  await mount(tcw, {});
  await rename("Me", "Sam");
  await settle();
  expect(stored().speaker_names).toEqual({ Me: "Sam", Them: "Alice" });

  await act(async () => (document.querySelector('[data-testid="speaker-rename-undo"]') as HTMLElement).click());
  await settle();
  expect(stored().speaker_names).toEqual({ Them: "Alice" });
});

test("a timed transcript with one speaker still offers the rename control, on that speaker's first line", async () => {
  const { tcw } = space({});
  const lone = [
    { index: 0, speaker_name: "Me", text: "One.", start_time: 0, end_time: 2 },
    { index: 1, speaker_name: "Me", text: "Two.", start_time: 5, end_time: 7 },
  ];
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Lone() {
    const speakers = useSpeakerNames({ tcw, row: ROW, metadata: {}, localId: null });
    return <SpeakerNamesContext.Provider value={speakers}><TimestampedTranscript sentences={lone} hasAudio={false} /></SpeakerNamesContext.Provider>;
  }
  await act(async () => root!.render(<Lone />));
  expect(labels()).toEqual(["Me"]);
});

// Names in the call: the people the desktop app read from the meeting window, on the row's metadata.
const PEOPLE = { v: 1, source: "call_window", app: "google-meet", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }] };
const openLabel = async (label: string) => {
  const target = [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-label"]')].find((el) => el.textContent === label);
  expect(target).toBeDefined();
  await act(async () => target!.click());
};
const choices = () => [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-choices"] button')].map((el) => el.textContent);
const choose = async (name: string) => {
  const button = [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-choices"] button')].find((el) => el.textContent === name);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
const submit = () => act(async () => document.querySelector('[data-testid="speaker-rename-form"]')!
  .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
const field = () => document.querySelector<HTMLInputElement>('[data-testid="speaker-rename-form"] input')!;

test("a row with names from the call offers them when Them is renamed; a tap fills the field and Save commits", async () => {
  const { tcw, stored } = space({ call_participants: PEOPLE });
  await mount(tcw, { call_participants: PEOPLE });
  await openLabel("Them");
  expect(document.querySelector('[data-testid="speaker-choices"]')?.getAttribute("aria-label")).toBe("Names in the call");
  expect(choices()).toEqual(["Alex Example", "Dana Lee"]);
  await choose("Alex Example");
  expect(field().value).toBe("Alex Example");
  // Nothing is saved until Save.
  expect(stored().speaker_names).toBeUndefined();
  await choose("Dana Lee");
  expect(field().value).toBe("Alex Example, Dana Lee");
  await submit();
  await settle();
  expect(labels()).toEqual(["Me", "Alex Example, Dana Lee", "Me"]);
  expect(stored().speaker_names).toEqual({ Them: "Alex Example, Dana Lee" });
  expect(stored().call_participants).toEqual(PEOPLE);
});

test("Me is offered the name the meeting app marked as the user", async () => {
  const { tcw, stored } = space({ call_participants: PEOPLE });
  await mount(tcw, { call_participants: PEOPLE });
  await openLabel("Me");
  expect(choices()).toEqual(["Robin Sample"]);
  await choose("Robin Sample");
  await submit();
  await settle();
  expect(labels()).toEqual(["Robin Sample", "Them", "Robin Sample"]);
  expect(stored().speaker_names).toEqual({ Me: "Robin Sample" });
});

test("a name the label already shows is not offered again", async () => {
  const { tcw } = space({});
  await mount(tcw, { call_participants: PEOPLE, speaker_names: { Them: "Alex Example" } });
  await openLabel("Alex Example");
  expect(field().value).toBe("Alex Example");
  expect(choices()).toEqual(["Dana Lee"]);
});

test("a row without names from the call renames as before: no choices in the form", async () => {
  const { tcw } = space({});
  await mount(tcw, {});
  await openLabel("Them");
  expect(document.querySelector('[data-testid="speaker-choices"]')).toBeNull();
  expect([...document.querySelectorAll('[data-testid="speaker-rename-form"] button')].map((el) => el.textContent)).toEqual(["Save", "Cancel"]);
  // Stored names that are not in the agreed shape offer nothing either.
  await act(async () => root?.unmount());
  cleanup?.();
  await mount(tcw, { call_participants: { v: 2, people: [{ id: "p1", name: "Alex" }] } });
  await openLabel("Them");
  expect(document.querySelector('[data-testid="speaker-choices"]')).toBeNull();
});

test("the controller reports a label as suggested while its suggested name is the one shown", async () => {
  const suggestion = { name: "Alex Example", source: "call_window", confidence: "high", reason: "one_other_participant", person: "p2", at: "2026-11-18T18:20:00.000Z" };
  const metadata = { call_participants: PEOPLE, speaker_names: { Them: "Alex Example" }, speaker_suggestions: { Them: suggestion } };
  const { tcw } = space(metadata);
  await mount(tcw, metadata);
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(document.querySelector('[data-testid="suggested"]')!.textContent).toBe("Them");
  await rename("Alex Example", "Alexander");
  await settle();
  expect(labels()).toEqual(["Me", "Alexander", "Me"]);
  expect(document.querySelector('[data-testid="suggested"]')!.textContent).toBe("");
});

// A 1:1 call: the other person's name was suggested for Them (written through to speaker_names, marked in speaker_suggestions).
const SUGGESTION = { name: "Alex Example", source: "call_window", confidence: "high", reason: "one_other_participant", person: "p2", at: "2026-11-18T18:20:00.000Z" };
const ONE_ON_ONE = { v: 1, source: "call_window", app: "google-meet", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }] };
const SUGGESTED = { call_participants: ONE_ON_ONE, speaker_names: { Them: "Alex Example" }, speaker_suggestions: { Them: SUGGESTION } };
const marks = () => document.querySelectorAll('[data-testid="speaker-suggested"]').length;

test("a suggested name carries the Suggested mark; Save with the name unchanged keeps it and ends the mark", async () => {
  const { tcw, stored } = space(SUGGESTED);
  await mount(tcw, SUGGESTED);
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toBe(1);
  expect(document.querySelector('[data-testid="speaker-suggested"]')!.textContent).toBe("Suggested");
  await openLabel("Alex Example");
  expect(field().value).toBe("Alex Example");
  // The one other person is already in the field: nothing else to offer.
  expect(document.querySelector('[data-testid="speaker-choices"]')).toBeNull();
  await submit();
  await settle();
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toBe(0);
  // Only the mark changed: no status line and no Undo.
  expect(document.querySelector('[data-testid="speaker-rename-status"]')).toBeNull();
  expect(stored()).toEqual({ call_participants: ONE_ON_ONE, speaker_names: { Them: "Alex Example" } });
});

test("renaming a suggested name ends the mark, in storage too", async () => {
  const { tcw, stored } = space(SUGGESTED);
  await mount(tcw, SUGGESTED);
  await rename("Alex Example", "Alex");
  await settle();
  expect(labels()).toEqual(["Me", "Alex", "Me"]);
  expect(marks()).toBe(0);
  expect(document.body.textContent).toContain("Alex Example is now Alex.");
  expect(stored()).toEqual({ call_participants: ONE_ON_ONE, speaker_names: { Them: "Alex" } });
  // Undo puts the name back as the user's own: still no mark.
  await act(async () => (document.querySelector('[data-testid="speaker-rename-undo"]') as HTMLElement).click());
  await settle();
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toBe(0);
  expect(stored()).toEqual({ call_participants: ONE_ON_ONE, speaker_names: { Them: "Alex Example" } });
});

test("Go back to Them removes the suggested name and its mark", async () => {
  const { tcw, stored } = space(SUGGESTED);
  await mount(tcw, SUGGESTED);
  await openLabel("Alex Example");
  const reset = [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-rename-form"] button')].find((el) => el.textContent === "Go back to Them");
  await act(async () => reset!.click());
  await settle();
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(marks()).toBe(0);
  expect(document.body.textContent).toContain("Back to Them.");
  expect(stored()).toEqual({ call_participants: ONE_ON_ONE });
});

test("a failed save of a kept suggestion brings the mark back", async () => {
  const tcw = { sql: { db: () => ({ execute: async () => ({ ok: false, error: { code: "X", message: "down" } }) }) } } as unknown as TinyCloudWeb;
  await mount(tcw, SUGGESTED);
  await openLabel("Alex Example");
  await submit();
  await settle();
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toBe(1);
  expect(document.querySelector('[data-testid="speaker-rename-failed"]')).not.toBeNull();
});

test("names from the call with two other people suggest nothing: no mark, the names are choices", async () => {
  const { tcw } = space({ call_participants: PEOPLE });
  await mount(tcw, { call_participants: PEOPLE });
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(marks()).toBe(0);
  await openLabel("Them");
  expect(choices()).toEqual(["Alex Example", "Dana Lee"]);
});
