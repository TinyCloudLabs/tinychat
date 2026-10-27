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
  const tcw = { sql: { db: () => ({
    execute: async (sql: string, params: never[]) => ({ ok: true, data: { changes: sqlite.run(sql, params as never).changes } }),
  }) } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'row-1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
  return { tcw, stored, sqlite };
}

let root: Root | null = null;
let cleanup: (() => void) | null = null;
afterEach(async () => { await act(async () => root?.unmount()); cleanup?.(); root = null; cleanup = null; });

function Probe(props: { tcw: TinyCloudWeb; metadata: Record<string, unknown> }) {
  const speakers = useSpeakerNames({ tcw: props.tcw, row: ROW, metadata: props.metadata });
  return <SpeakerNamesContext.Provider value={speakers}>
    <SpeakerNamesStatus />
    <TimestampedTranscript sentences={sentences} hasAudio={false} />
  </SpeakerNamesContext.Provider>;
}

const mount = async (tcw: TinyCloudWeb, metadata: Record<string, unknown>) => {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tcw={tcw} metadata={metadata} />));
};
const labels = () => [...document.querySelectorAll('[data-testid="speaker-label"]')].map((el) => el.textContent);
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
