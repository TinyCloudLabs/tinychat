import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { parseCallParticipants, speakerChoices } from "./callParticipants";
import { transcriptBlocks } from "./NoteDetailView";
import { SpeakerLabel, SpeakerNamesContext } from "./SpeakerLabel";
import { NO_SPEAKER_NAMES, type SpeakerNames } from "./speakerNames";
import { isCallPersonLabel, OTHER_SIDE_LABELS, OWN_SIDE_LABELS } from "./speakerNamesCopy";
import { TimestampedTranscript } from "./TimestampedTranscript";
import type { SpeakerNamesController } from "./useSpeakerNames";

// Who spoke when: in a Mac recording of a call with three or more people, a remote line whose speaker the call window
// showed is labelled "Them 1", "Them 2", ... These labels are the other side, as "Them" is.

const GROUP = parseCallParticipants({ v: 1, source: "call_window", app: "google-meet", truncated: false, people: [
  { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }] });

const line = (index: number, speaker: string, text: string): FirefliesSentence =>
  ({ index, speaker_name: speaker, text, start_time: index * 5, end_time: index * 5 + 4 });

const THREE = [
  line(0, "Me", "Shall we start?"),
  line(1, "Them 1", "Yes, the press kit is ready."),
  line(2, "Them 2", "And the pricing page is nearly done."),
  line(3, "Them 2", "I will send it today."),
  line(4, "Me", "Great."),
];

test("Them followed by a number is one person of the other side; other labels are not", () => {
  for (const label of ["Them 1", "Them 2", "Them 12"]) {
    expect(isCallPersonLabel(label)).toBe(true);
    expect(OTHER_SIDE_LABELS.has(label)).toBe(true);
    expect(OWN_SIDE_LABELS.has(label)).toBe(false);
  }
  for (const label of ["Them", "Others"]) {
    expect(isCallPersonLabel(label)).toBe(false);
    expect(OTHER_SIDE_LABELS.has(label)).toBe(true);
  }
  for (const label of ["Them 0", "Them1", "them 1", "Them 1 ", " Them 1", "Them 01", "Them -1", "Them 1.5", "Me", "Speaker 1"]) {
    expect(isCallPersonLabel(label)).toBe(false);
    expect(OTHER_SIDE_LABELS.has(label)).toBe(false);
  }
});

test("renaming Them 1 offers the other people in the call, as renaming Them does", () => {
  expect(speakerChoices(GROUP, "Them 1")).toEqual(["Alex Example", "Dana Lee"]);
  expect(speakerChoices(GROUP, "Them 2")).toEqual(speakerChoices(GROUP, "Them"));
  expect(speakerChoices(GROUP, "Me")).toEqual(["Robin Sample"]);
});

test("transcript blocks are grouped by the name shown, so two labels with one name read as one speaker", () => {
  // Without names: as before, one block per label run.
  expect(transcriptBlocks(THREE).map((block) => block.speaker)).toEqual(["Me", "Them 1", "Them 2", "Me"]);
  expect(transcriptBlocks(THREE, NO_SPEAKER_NAMES)).toEqual(transcriptBlocks(THREE));
  // Two labels, two names: still two blocks.
  expect(transcriptBlocks(THREE, { "Them 1": "Alex Example", "Them 2": "Dana Lee" }).map((block) => block.speaker))
    .toEqual(["Me", "Them 1", "Them 2", "Me"]);
  // Both named Alex Example: one block, under the first line's label.
  expect(transcriptBlocks(THREE, { "Them 1": "Alex Example", "Them 2": "Alex Example" })).toEqual([
    { speaker: "Me", text: "Shall we start?" },
    { speaker: "Them 1", text: "Yes, the press kit is ready. And the pricing page is nearly done. I will send it today." },
    { speaker: "Me", text: "Great." },
  ]);
  // A Me/Them note reads exactly as before.
  const meThem = [line(0, "Me", "Hello."), line(1, "Them", "Hi."), line(2, "Them", "Ready."), line(3, "Me", "Go.")];
  expect(transcriptBlocks(meThem, { Them: "Alex Example" })).toEqual(transcriptBlocks(meThem));
});

let root: Root | null = null;
let cleanup: (() => void) | null = null;
afterEach(async () => { await act(async () => root?.unmount()); cleanup?.(); root = null; cleanup = null; });

function controller(names: SpeakerNames, suggested: string[] = []): SpeakerNamesController {
  return { names, suggested: new Set(suggested), choices: (original) => speakerChoices(GROUP, original),
    rename: () => undefined, undo: null, change: null, failed: false };
}

async function render(node: React.ReactNode) {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
const labels = () => [...document.querySelectorAll('[data-testid="speaker-label"]')].map((el) => el.textContent);
const marks = () => [...document.querySelectorAll('[data-testid="speaker-suggested"]')].map((el) => el.textContent);

test("the timed transcript labels each speaker by the name shown, merging two labels that show one name", async () => {
  await render(<SpeakerNamesContext.Provider value={controller({ "Them 1": "Alex Example", "Them 2": "Dana Lee" }, ["Them 1", "Them 2"])}>
    <TimestampedTranscript sentences={THREE} hasAudio={false} />
  </SpeakerNamesContext.Provider>);
  expect(labels()).toEqual(["Me", "Alex Example", "Dana Lee", "Me"]);
  expect(marks()).toEqual(["Suggested", "Suggested"]);
  await act(async () => root!.render(<SpeakerNamesContext.Provider value={controller({ "Them 1": "Alex Example", "Them 2": "Alex Example" })}>
    <TimestampedTranscript sentences={THREE} hasAudio={false} />
  </SpeakerNamesContext.Provider>));
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
});

test("a Me/Them note's timed transcript is labelled as before", async () => {
  const meThem = [line(0, "Me", "Hello."), line(1, "Them", "Hi."), line(2, "Them", "Ready."), line(3, "Me", "Go.")];
  await render(<SpeakerNamesContext.Provider value={controller(NO_SPEAKER_NAMES)}>
    <TimestampedTranscript sentences={meThem} hasAudio={false} />
  </SpeakerNamesContext.Provider>);
  expect(labels()).toEqual(["Me", "Them", "Me"]);
  await act(async () => root!.render(<TimestampedTranscript sentences={meThem} hasAudio={false} />));
  expect([...document.querySelectorAll('[data-testid="transcript-segment"] p.text-meta')].map((el) => el.textContent))
    .toEqual(["Me", "Them", "Me"]);
});

test("the rename form of Them 1 asks for one name and offers the other people in the call", async () => {
  await render(<SpeakerNamesContext.Provider value={controller(NO_SPEAKER_NAMES)}>
    <SpeakerLabel original="Them 1" />
    <SpeakerLabel original="Them" />
  </SpeakerNamesContext.Provider>);
  const [them1] = document.querySelectorAll<HTMLButtonElement>('[data-testid="speaker-label"]');
  await act(async () => them1!.click());
  const input = document.querySelector<HTMLInputElement>('[data-testid="speaker-rename-form"] input')!;
  expect(input.placeholder).toBe("Name");
  expect(input.getAttribute("aria-label")).toBe("Name for Them 1");
  expect([...document.querySelectorAll('[data-testid="speaker-choices"] button')].map((el) => el.textContent))
    .toEqual(["Alex Example", "Dana Lee"]);
});
