import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { SpeakerNamesContext, SpeakerNamesStatus } from "./SpeakerLabel";
import { TimestampedTranscript } from "./TimestampedTranscript";
import { useSpeakerNames } from "./useSpeakerNames";
import { patchRowSpeakerNames } from "@/lib/voiceNotes/voiceNoteRows";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";

const sentences = [
  { index: 0, speaker_name: "Me", text: "Hello.", start_time: 0, end_time: 2 },
  { index: 1, speaker_name: "Them", text: "Let's begin.", start_time: 10, end_time: 12 },
  { index: 2, speaker_name: "Me", text: "Done.", start_time: 20, end_time: 22 },
];
const ROW = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1" };

function space(metadata: Record<string, unknown>, organizer: { email: string; participants?: string } | null = null) {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, organizer_email TEXT, participants TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('row-1', ?, ?, ?, '')",
    [organizer?.email ?? null, organizer?.participants ?? "[]", JSON.stringify(metadata)]);
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

function Probe(props: { tcw: TinyCloudWeb; metadata: Record<string, unknown>;
  row?: { id: string; source: string; sourceId: string } | null; localId?: string | null }) {
  const speakers = useSpeakerNames({ tcw: props.tcw, row: props.row === undefined ? ROW : props.row,
    metadata: props.metadata, localId: props.localId ?? null });
  return <SpeakerNamesContext.Provider value={speakers}>
    <SpeakerNamesStatus />
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
const settle = () => act(async () => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 20); await promise; });

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
  await patchRowSpeakerNames(tcw, "row-1", { Me: "Sam", Them: "Alice, Bob" });
  expect(stored()).toEqual({ capture: { platform: "ios" }, speaker_names: { Me: "Sam", Them: "Alice, Bob" } });
  await patchRowSpeakerNames(tcw, "row-1", {});
  expect(stored()).toEqual({ capture: { platform: "ios" } });
  await expect(patchRowSpeakerNames(tcw, "missing", { Me: "Sam" })).rejects.toThrow("missing");
});

test("a new transcript commit patches the row's metadata and leaves the names in place", async () => {
  const { tcw, stored, sqlite } = space({ transcript_provider: "assemblyai" });
  await patchRowSpeakerNames(tcw, "row-1", { Me: "Sam" });
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

test("a meeting someone else organized never pre-fills the own-side field with the organizer's name", async () => {
  // The signed-in account can attend a meeting organized by somebody else: organizer_email names
  // that organizer, not this account. With no own-name source on the row the field stays blank
  // rather than save a stranger's name as "Me" — even though the row carries the organizer.
  const { tcw } = space({}, { email: "sam@example.com", participants: '[{"name":"Sam Rivera","email":"sam@example.com"}]' });
  await mount(tcw, {});
  await act(async () => (document.querySelector('[data-testid="speaker-label"]') as HTMLElement).click());
  expect((document.querySelector("input") as HTMLInputElement).value).toBe("");
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
