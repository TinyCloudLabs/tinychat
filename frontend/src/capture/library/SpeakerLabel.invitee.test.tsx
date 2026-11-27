// The name a voice note's calendar link suggests for its one remote speaker ("Invited to this meeting"), on the
// note's Transcript: offered like a name a naming run suggested, never applied without Use, dismissed for the event
// it is about, and absent in a build without calendar linking.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ambiguousCalendarLink, linkedCalendarLink, type GoogleCalendarEvent } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import type { NamingRunner } from "@/lib/speakerNaming/namingRunner";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import type { LibraryItem } from "./LibraryRow";
import { Transcript } from "./NoteDetailView";
import { SPEAKER_NAMES_COPY as COPY } from "./speakerNamesCopy";
import { useNameSuggestions } from "./useNameSuggestions";
import { useSpeakerNames } from "./useSpeakerNames";

const ITEM: LibraryItem = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Call", startedAt: "2026-11-20T10:00:00.000Z", durationSecs: 40 };
/** A call of two: the user on the microphone, one voice on the other side. */
const sentences: FirefliesSentence[] = [
  { index: 0, speaker_name: "Me", channel: 0 as const, text: "Shall we start?", start_time: 0, end_time: 5 },
  { index: 1, speaker_name: "Speaker 1", channel: 1 as const, speaker_id: "A", text: "Yes. Here is where the pricing stands.", start_time: 6, end_time: 20 },
  { index: 2, speaker_name: "Me", channel: 0 as const, text: "Thank you.", start_time: 21, end_time: 23 },
];
const event = (id: string): GoogleCalendarEvent => ({ id, status: "confirmed", summary: "Pricing review",
  start: { dateTime: "2026-11-20T10:00:00Z" }, end: { dateTime: "2026-11-20T10:30:00Z" },
  attendees: [{ self: true, displayName: "Robin Sample", responseStatus: "accepted" }, { displayName: "Kim Lee", responseStatus: "accepted" }] });
const link = (id = "evt-1") => JSON.parse(JSON.stringify(linkedCalendarLink(event(id), { method: "time_overlap", confidence: "medium", overlap: 1 }, "2026-11-20T11:00:00.000Z"))) as Record<string, unknown>;
/** The note's metadata as its page reads it: linked to a meeting of two, and no naming run was made. */
const page = (patch: Record<string, unknown> = {}) => ({
  transcription_outcome: "transcribed", transcription_engine: "private-cloud", transcript_hash: "rev-1", calendar_link: link(), ...patch,
});
const KIM = `${COPY.suggestedName} Kim Lee?`;

/** `down`: every save fails, once the promise resolves. */
function space(metadata: Record<string, unknown>, options: { down?: Promise<void> } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('row-1', 'exo-voice-note', ?, '')", [JSON.stringify(metadata)]);
  /** Every statement that was to change the space. */
  const writes: string[] = [];
  const tcw = { did: "did:test", sql: { db: () => ({
    execute: async (sql: string, params: never[]) => {
      writes.push(sql);
      if (options.down === undefined) return { ok: true, data: { changes: sqlite.run(sql, params as never).changes } };
      await options.down;
      return { ok: false, error: { code: "X", message: "down" } };
    },
  }) } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'row-1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
  return { tcw, stored, writes };
}

const naming = (): NamingRunner => ({ consider: () => {}, suggest: () => {}, cancelAll: () => {}, idle: async () => {} });

let root: Root | null = null;
let cleanup: (() => void) | null = null;
// The flags are set on `import.meta.env` itself, as SpeakerLabel.suggestions.test.tsx sets its own.
beforeEach(() => {
  import.meta.env.VITE_SPEAKER_NAME_SUGGESTIONS = "true";
  import.meta.env.VITE_CALENDAR_LINKING = "true";
});
const unmount = async () => {
  await act(async () => root?.unmount());
  cleanup?.();
  root = null;
  cleanup = null;
};
afterEach(async () => {
  await unmount();
  delete import.meta.env.VITE_SPEAKER_NAME_SUGGESTIONS;
  delete import.meta.env.VITE_CALENDAR_LINKING;
});

const noop = () => {};
/** The two hooks as NoteDetail joins them, over the Transcript the note page shows. */
function Probe(props: { tcw: TinyCloudWeb; metadata: Record<string, unknown>; turns: FirefliesSentence[] }) {
  const speakerNames = useSpeakerNames({ tcw: props.tcw, row: ITEM, metadata: props.metadata, localId: null });
  const nameSuggestions = useNameSuggestions({ tcw: props.tcw, naming: naming(), row: ITEM, metadata: props.metadata, overrides: speakerNames?.names, sentences: props.turns });
  return <MemoryRouter>
    <Transcript item={ITEM} listStatus="ready" metadata={{ status: "ok", metadata: props.metadata }} transcript={{ status: "ok", sentences: props.turns }}
      audio={null} copyState="idle" onCopy={noop} onRetry={noop} pushed onBack={noop} speakerNames={speakerNames} nameSuggestions={nameSuggestions} />
  </MemoryRouter>;
}
const mount = async (tcw: TinyCloudWeb, metadata: Record<string, unknown>, turns: FirefliesSentence[] = sentences) => {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tcw={tcw} metadata={metadata} turns={turns} />));
};
const all = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const labels = () => all("speaker-label").map((el) => el.textContent);
const questions = () => all("speaker-suggestion-name").map((el) => el.textContent);
const click = (el: HTMLElement | undefined) => { expect(el).toBeDefined(); return act(async () => el!.click()); };
/** Lets the saves in flight land: turns of the event loop until `landed` holds (a test that waits in vain fails on what it expects next). */
const until = (landed: () => boolean) => act(async () => {
  for (let turn = 0; turn < 500 && !landed(); turn++) await new Promise((resolve) => setImmediate(resolve));
});
/** Shows `metadata` on a space that holds it, and gives back what it asked. */
const shown = async (metadata: Record<string, unknown>, turns?: FirefliesSentence[]) => {
  await mount(space(metadata).tcw, metadata, turns);
  const asked = questions();
  await unmount();
  return asked;
};

test("the one other person invited is offered for the one remote voice, with no naming run made; showing it writes nothing", async () => {
  const { tcw, stored, writes } = space(page());
  await mount(tcw, page());
  expect(labels()).toEqual(["Me", "Speaker 1", "Me"]);
  expect(questions()).toEqual([KIM]);
  expect(all("speaker-suggestion-use").map((el) => el.getAttribute("aria-label"))).toEqual([COPY.useFor("Kim Lee", "Speaker 1")]);
  expect(all("speaker-suggestion-dismiss")).toHaveLength(1);
  // The question opens what the name rests on: an invitation, and no words of the transcript.
  await click(all("speaker-suggestion-name")[0]);
  expect(all("speaker-suggestion-evidence").map((el) => el.textContent)).toEqual(["Invited to this meeting"]);
  // Nobody was renamed and nothing was saved: the row is as it was.
  await until(() => false);
  expect(writes).toEqual([]);
  expect(stored()).toEqual(page());
  expect(stored()).not.toHaveProperty("speaker_names");
});

test("Use is a rename like any other: the name is saved for that speaker, and the user's own side keeps its label", async () => {
  const { tcw, stored } = space(page());
  await mount(tcw, page());
  await click(all("speaker-suggestion-use")[0]);
  await until(() => stored().speaker_names !== undefined);
  expect(labels()).toEqual(["Me", "Kim Lee", "Me"]);
  expect(questions()).toEqual([]);
  expect(stored().speaker_names).toEqual({ "Speaker 1": "Kim Lee" });
  expect(stored().calendar_link).toEqual(link());
});

test("a name a naming run suggested for the label is shown in the invitee's place, and a label the user named shows neither", async () => {
  const run = (patch: Record<string, unknown> = {}) => ({ hash: "rev-1", model: "m", at: "2026-11-20T10:05:00.000Z",
    names: { "Speaker 1": { name: "Kimberly Lee", basis: "self-introduction", quote: "pricing stands" } }, dismissed: [], ...patch });
  expect(await shown(page({ speaker_name_suggestions: run() }))).toEqual([`${COPY.suggestedName} Kimberly Lee?`]);
  // Dismissed, the run's name is not replaced by the invitee either.
  expect(await shown(page({ speaker_name_suggestions: run({ dismissed: ["Speaker 1"] }) }))).toEqual([]);
  // A run that found no name leaves the label to the invitee.
  expect(await shown(page({ speaker_name_suggestions: run({ names: {} }) }))).toEqual([KIM]);

  const named = page({ speaker_names: { "Speaker 1": "Alex Example" }, speaker_name_suggestions: run() });
  await mount(space(named).tcw, named);
  expect(labels()).toEqual(["Me", "Alex Example", "Me"]);
  expect(questions()).toEqual([]);
});

test("nothing is offered when the call window saw names, the link is not to one event, more people are coming, or a second voice is heard", async () => {
  expect(await shown(page({ call_participants: { v: 1, source: "call_window", app: "google-meet", truncated: false,
    people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Kim Lee" }, { id: "p3", name: "Dana Lee" }] } }))).toEqual([]);
  expect(await shown(page({ calendar_link: JSON.parse(JSON.stringify(ambiguousCalendarLink([event("evt-1"), event("evt-2")]))) }))).toEqual([]);
  const three = event("evt-1");
  three.attendees!.push({ displayName: "Timo Varela", responseStatus: "needsAction" });
  expect(await shown(page({ calendar_link: JSON.parse(JSON.stringify(linkedCalendarLink(three, "user", "2026-11-20T11:00:00.000Z"))) }))).toEqual([]);
  expect(await shown(page(), [...sentences, { index: 3, speaker_name: "Speaker 2", channel: 1 as const, speaker_id: "B", text: "Sorry I am late.", start_time: 24, end_time: 40 }])).toEqual([]);
  // A recording of the user alone: "Me" is never offered a name from the calendar.
  expect(await shown(page(), [{ index: 0, speaker_name: "Me", text: "A note to myself, at some length.", start_time: 0, end_time: 60 }])).toEqual([]);
});

test("Dismiss hides it at once and is saved for the event it was about only; nobody is renamed", async () => {
  const { tcw, stored } = space(page());
  await mount(tcw, page());
  await click(all("speaker-suggestion-dismiss")[0]);
  expect(questions()).toEqual([]);
  await until(() => stored().invitee_suggestion_dismissed !== undefined);
  expect(stored()).toEqual({ ...page(), invitee_suggestion_dismissed: { event_id: "evt-1", labels: ["Speaker 1"] } });
  expect(labels()).toEqual(["Me", "Speaker 1", "Me"]);
  await unmount();

  // Opened again it stays dismissed; linked to another event since, the question may be asked again.
  expect(await shown(stored())).toEqual([]);
  expect(await shown({ ...stored(), calendar_link: link("evt-2") })).toEqual([KIM]);
});

test("a Dismiss that cannot be saved shows the suggestion again", async () => {
  const down = Promise.withResolvers<void>();
  const { tcw } = space(page(), { down: down.promise });
  await mount(tcw, page());
  await click(all("speaker-suggestion-dismiss")[0]);
  expect(questions()).toEqual([]);
  down.resolve();
  await until(() => questions().length === 1);
  expect(questions()).toEqual([KIM]);
});

test("in a build without calendar linking a stored link suggests nobody, and a naming run's names still show", async () => {
  delete import.meta.env.VITE_CALENDAR_LINKING;
  expect(await shown(page())).toEqual([]);
  const run = { hash: "rev-1", model: "m", at: "", names: { "Speaker 1": { name: "Kimberly Lee", basis: "thanked", quote: "Thank you" } }, dismissed: [] };
  expect(await shown(page({ speaker_name_suggestions: run }))).toEqual([`${COPY.suggestedName} Kimberly Lee?`]);
  // And with calendar linking on but suggested names off in the build, nothing of either shows.
  import.meta.env.VITE_CALENDAR_LINKING = "true";
  delete import.meta.env.VITE_SPEAKER_NAME_SUGGESTIONS;
  expect(await shown(page())).toEqual([]);
});
