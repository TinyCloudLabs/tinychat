import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { registerDesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { VoiceNotes, __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { SpeakerNamesContext, SpeakerNamesStatus } from "./SpeakerLabel";
import { TimestampedTranscript } from "./TimestampedTranscript";
import { useSpeakerNames } from "./useSpeakerNames";

// Names in the call for a note whose row does not hold them yet: a note only on this Mac (the space was down when
// it was saved), or one whose row cannot be read now. The page takes the names from the desktop app's copy.

const ONE_ON_ONE = { v: 1, source: "call_window", app: "google-meet", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }] };
const GROUP = { v: 1, source: "call_window", app: "zoom", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }] };
const sentences = [
  { index: 0, speaker_name: "Me", text: "Hello.", start_time: 0, end_time: 2 },
  { index: 1, speaker_name: "Them", text: "Let's begin.", start_time: 10, end_time: 12 },
  { index: 2, speaker_name: "Me", text: "Done.", start_time: 20, end_time: 22 },
];

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

function desktop(read: Record<string, unknown>) {
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

function Probe(props: { tcw: TinyCloudWeb } & Place) {
  const speakers = useSpeakerNames({ tcw: props.tcw, row: null, metadata: null, localId: props.localId ?? null,
    unreadRow: props.unreadRow ?? null });
  return <SpeakerNamesContext.Provider value={speakers}>
    <SpeakerNamesStatus />
    <output data-testid="suggested">{[...speakers?.suggested ?? []].join(",")}</output>
    <TimestampedTranscript sentences={sentences} hasAudio={false} />
  </SpeakerNamesContext.Provider>;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const mount = async (tcw: TinyCloudWeb, place: Place) => {
  cleanup ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tcw={tcw} {...place} />));
  await settle();
};
const remount = async (tcw: TinyCloudWeb, place: Place) => {
  await act(async () => root?.unmount());
  if (cleanup) document.body.replaceChildren();
  await mount(tcw, place);
};
const labels = () => [...document.querySelectorAll('[data-testid="speaker-label"]')].map((el) => el.textContent);
const marks = () => [...document.querySelectorAll('[data-testid="speaker-suggested"]')].map((el) => el.textContent);
const openLabel = async (label: string) => {
  const target = [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-label"]')].find((el) => el.textContent === label);
  expect(target).toBeDefined();
  await act(async () => target!.click());
};
const choices = () => [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-choices"] button')].map((el) => el.textContent);
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
const tcw = { did: "did:test" } as TinyCloudWeb;
const LOCAL = { localId: "rec-1" };

test("a 1:1 call only on this Mac shows the other person's name for Them, marked Suggested", async () => {
  onThisMac();
  const fake = desktop({ "rec-1": ONE_ON_ONE });
  await mount(tcw, LOCAL);
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toEqual(["Suggested"]);
  expect(document.querySelector('[data-testid="suggested"]')!.textContent).toBe("Them");
  // Reading is all the page does: the app's copy stays until the row holds it.
  expect(fake.calls).toEqual(["callNames.read:rec-1"]);
  expect(fake.callNamesRead("rec-1")).toEqual(ONE_ON_ONE);
  // Me is offered the user's own entry, as on a saved note.
  await openLabel("Me");
  expect(choices()).toEqual(["Robin Sample"]);
});

test("a call with more people only on this Mac offers their names, and suggests nothing", async () => {
  onThisMac();
  desktop({ "rec-1": GROUP });
  await mount(tcw, LOCAL);
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(marks()).toEqual([]);
  await openLabel("Them");
  expect(document.querySelector('[data-testid="speaker-choices"]')?.getAttribute("aria-label")).toBe("Names in the call");
  expect(choices()).toEqual(["Alex Example", "Dana Lee"]);
  await button("Dana Lee");
  await submit();
  expect(labels()).toEqual(["Me", "Dana Lee", "Me"]);
});

test("a rename while the note is only on this Mac wins over the suggestion and stays; Undo and Go back act as on a saved note", async () => {
  const mac = onThisMac();
  desktop({ "rec-1": ONE_ON_ONE });
  await mount(tcw, LOCAL);
  await openLabel("Alex Example");
  expect(field().value).toBe("Alex Example");
  await type("Alex");
  await submit();
  expect(labels()).toEqual(["Me", "Alex", "Me"]);
  expect(marks()).toEqual([]);
  expect(document.body.textContent).toContain("Alex Example is now Alex.");
  expect(mac.ledger()).toEqual({ speakerNames: { Them: "Alex" }, speakerSuggestionsEnded: ["Them"] });

  // Undo puts the name back as the user's own: no mark.
  await button("Undo");
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toEqual([]);
  expect(mac.ledger()).toEqual({ speakerNames: { Them: "Alex Example" }, speakerSuggestionsEnded: ["Them"] });

  // Go back to Them: the label shows Them, and the suggestion does not come back, not even when the note opens again.
  await openLabel("Alex Example");
  await button("Go back to Them");
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(marks()).toEqual([]);
  expect(mac.ledger()).toEqual({ speakerNames: {}, speakerSuggestionsEnded: ["Them"] });
  await remount(tcw, LOCAL);
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(marks()).toEqual([]);
});

test("Save with the suggested name unchanged keeps it as the user's name on this Mac", async () => {
  const mac = onThisMac();
  desktop({ "rec-1": ONE_ON_ONE });
  await mount(tcw, LOCAL);
  await openLabel("Alex Example");
  await submit();
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toEqual([]);
  expect(document.querySelector('[data-testid="speaker-rename-status"]')).toBeNull();
  expect(mac.ledger()).toEqual({ speakerNames: { Them: "Alex Example" }, speakerSuggestionsEnded: ["Them"] });
});

test("a name given on this Mac before the call's names were read is kept; Me can still be renamed", async () => {
  const mac = onThisMac({ speakerNames: { Them: "Sam" } });
  desktop({ "rec-1": ONE_ON_ONE });
  await mount(tcw, LOCAL);
  expect(labels()).toEqual(["Me", "Sam", "Me"]);
  expect(marks()).toEqual([]);
  await openLabel("Me");
  await type("Robin");
  await submit();
  expect(labels()).toEqual(["Robin", "Sam", "Robin"]);
  expect(mac.ledger()).toEqual({ speakerNames: { Them: "Sam", Me: "Robin" } });
});

test("renaming Me leaves the suggestion for Them in place", async () => {
  const mac = onThisMac();
  desktop({ "rec-1": ONE_ON_ONE });
  await mount(tcw, LOCAL);
  await openLabel("Me");
  await type("Robin");
  await submit();
  expect(labels()).toEqual(["Robin", "Alex Example", "Robin"]);
  expect(marks()).toEqual(["Suggested"]);
  expect(mac.ledger()).toEqual({ speakerNames: { Me: "Robin" } });
});

test("a native read that fails, refuses the shape or never answers changes nothing: Me and Them, renamable as before", async () => {
  for (const setUp of [
    (fake: ReturnType<typeof desktop>) => fake.failNext("callNames.read", "reader busy"),
    (fake: ReturnType<typeof desktop>) => { fake.extras.callNames!.read = () => new Promise<never>(() => {}); },
    (fake: ReturnType<typeof desktop>) => { fake.extras.callNames!.read = async () => ({ ...ONE_ON_ONE, v: 2 }); },
  ]) {
    onThisMac();
    const fake = desktop({ "rec-1": ONE_ON_ONE });
    setUp(fake);
    await remount(tcw, LOCAL);
    expect(labels()).toEqual(["Me", "Them", "Me"]);
    expect(marks()).toEqual([]);
    await openLabel("Them");
    expect(document.querySelector('[data-testid="speaker-choices"]')).toBeNull();
    // Nothing was cleared: a failed read is not a reason to drop the app's copy.
    expect(fake.calls.filter((call) => call.startsWith("callNames.clear"))).toEqual([]);
  }
});

test("off the desktop app, a note on this device renames as before", async () => {
  onThisMac();
  await mount(tcw, LOCAL);
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(marks()).toEqual([]);
});

// A row that exists but cannot be read now (the space is unreachable).
const UNREAD = { unreadRow: { id: "vn-rec-1", source: "exo-voice-note", sourceId: "rec-1" } };

/** The space: unreachable until `reachable` is set. */
function space() {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('vn-rec-1', 'exo-voice-note', ?, '')",
    [JSON.stringify({ capture: { platform: "tauri", channels: 2 } })]);
  const state = { reachable: false };
  const down = { ok: false, error: { code: "NETWORK_ERROR", message: "unreachable" } };
  const lane = {
    query: async (sql: string, params: never[]) => state.reachable ? { ok: true, data: { rows: sqlite.query(sql).values(...params) } } : down,
    execute: async (sql: string, params: never[]) => state.reachable ? { ok: true, data: { changes: sqlite.run(sql, params).changes } } : down,
  };
  const tcw = { did: "did:test", spaceId: "did:test", sql: { db: () => lane } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'vn-rec-1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
  return { tcw, stored, state };
}

test("a row that cannot be read shows the call's names from this Mac; a rename lands after the names, as on a row that had them", async () => {
  const { tcw: unreachable, stored, state } = space();
  const fake = desktop({ "rec-1": ONE_ON_ONE });
  await mount(unreachable, UNREAD);
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(marks()).toEqual(["Suggested"]);
  await openLabel("Me");
  expect(choices()).toEqual(["Robin Sample"]);
  await act(async () => (document.querySelector('[data-testid="speaker-rename-form"] button[type="button"]') as HTMLElement).click());

  // While the space cannot be reached, a rename cannot be saved: it says so and the label goes back.
  await openLabel("Alex Example");
  await type("Alex");
  await submit();
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(document.querySelector('[data-testid="speaker-rename-failed"]')).not.toBeNull();
  expect(fake.callNamesRead("rec-1")).toEqual(ONE_ON_ONE);

  // Reachable again: the call's names land first, with their suggestion, then the rename ends it.
  state.reachable = true;
  await openLabel("Alex Example");
  await button("Go back to Them");
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  expect(stored()).toEqual({ capture: { platform: "tauri", channels: 2 }, call_participants: ONE_ON_ONE });
  expect(fake.callNamesRead("rec-1")).toBeUndefined();
  expect(fake.calls.filter((call) => call === "callNames.clear:rec-1")).toHaveLength(1);
});

test("a row that cannot be read, with no names from this Mac, stays as it was: plain labels", async () => {
  const { tcw: unreachable } = space();
  const fake = desktop({ "rec-1": ONE_ON_ONE });
  fake.failNext("callNames.read", "reader busy");
  await mount(unreachable, UNREAD);
  expect(document.querySelectorAll('[data-testid="speaker-label"]').length).toBe(0);
  expect(document.body.textContent).toContain("Them");
  expect(marks()).toEqual([]);
});
