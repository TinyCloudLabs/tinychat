// A voice note's suggested speaker names on the note's Transcript: shown beside the label they are for, taken with
// Use (a rename like any other), dismissed, and absent in a build without the feature.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
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
const sentences: FirefliesSentence[] = [
  { index: 0, speaker_name: "Me", channel: 0 as const, text: "Who wants to start?", start_time: 0, end_time: 5 },
  { index: 1, speaker_name: "Speaker 1", channel: 1 as const, text: "I'm Alice Chen and I run the offsite planning.", start_time: 6, end_time: 20 },
  { index: 2, speaker_name: "Speaker 2", channel: 1 as const, text: "And this is Bob Stone.", start_time: 21, end_time: 35 },
  { index: 3, speaker_name: "Me", channel: 0 as const, text: "Thank you both.", start_time: 36, end_time: 38 },
];
/** A longer exchange: three turns of the one speaker a name is suggested for. `timed` false is a transcript without times. */
const exchange = (timed: boolean) => ["Me", "Speaker 1", "Me", "Speaker 1", "Me", "Speaker 1"].map((speaker_name, index) =>
  ({ index, speaker_name, text: `Turn ${index}.`, start_time: timed ? index * 10 : 0, end_time: timed ? index * 10 + 8 : 0 }));
const ALICE = { name: "Alice Chen", basis: "self-introduction", quote: "I'm Alice Chen" };
const BOB = { name: "Bob Stone", basis: "introduced", quote: "this is Bob Stone" };
/** The note's metadata as its page reads it: the row's, with the transcript revision the page shows. */
const page = (patch: Record<string, unknown> = {}, suggestions: Record<string, unknown> = {}) => ({
  transcription_outcome: "transcribed", transcription_engine: "private-cloud", transcript_hash: "rev-1",
  speaker_name_suggestions: { hash: "rev-1", model: "m", at: "2026-11-20T10:05:00.000Z", names: { "Speaker 1": ALICE, "Speaker 2": BOB }, dismissed: [], ...suggestions },
  ...patch,
});

/** `down`: every save fails, once the promise resolves. */
function space(metadata: Record<string, unknown>, options: { down?: Promise<void> } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('row-1', 'exo-voice-note', ?, '')", [JSON.stringify(metadata)]);
  const tcw = { did: "did:test", sql: { db: () => ({
    execute: async (sql: string, params: never[]) => {
      if (options.down === undefined) return { ok: true, data: { changes: sqlite.run(sql, params as never).changes } };
      await options.down;
      return { ok: false, error: { code: "X", message: "down" } };
    },
  }) } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse((sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'row-1'").get() as { metadata: string }).metadata) as Record<string, unknown> & { speaker_name_suggestions: { dismissed: string[] } };
  return { tcw, stored };
}

let considered: string[];
let suggested: string[];
const naming = (): NamingRunner => ({
  consider: (sourceId) => { considered.push(sourceId); },
  suggest: (sourceId) => { suggested.push(sourceId); },
  cancelAll: () => {},
  idle: async () => {},
});

let root: Root | null = null;
let cleanup: (() => void) | null = null;
// The flag is set on `import.meta.env` itself, as the replication tests set theirs: under `bun test` that is the
// environment the process started with, and a test file that replaces `process.env` leaves it behind.
beforeEach(() => {
  import.meta.env.VITE_SPEAKER_NAME_SUGGESTIONS = "true";
  considered = [];
  suggested = [];
});
afterEach(async () => {
  await act(async () => root?.unmount());
  cleanup?.();
  root = null;
  cleanup = null;
  delete import.meta.env.VITE_SPEAKER_NAME_SUGGESTIONS;
});

const noop = () => {};
/** The two hooks as NoteDetail joins them, over the Transcript the note page shows. */
function Probe(props: { tcw: TinyCloudWeb; metadata: Record<string, unknown>; naming: NamingRunner | undefined; turns?: FirefliesSentence[] }) {
  const speakerNames = useSpeakerNames({ tcw: props.tcw, row: ITEM, metadata: props.metadata, localId: null });
  const nameSuggestions = useNameSuggestions({ tcw: props.tcw, naming: props.naming, row: ITEM, metadata: props.metadata, overrides: speakerNames?.names });
  return <MemoryRouter>
    <Transcript item={ITEM} listStatus="ready" metadata={{ status: "ok", metadata: props.metadata }} transcript={{ status: "ok", sentences: props.turns ?? sentences }}
      audio={null} copyState="idle" onCopy={noop} onRetry={noop} pushed onBack={noop} speakerNames={speakerNames} nameSuggestions={nameSuggestions} />
  </MemoryRouter>;
}
const mount = async (tcw: TinyCloudWeb, metadata: Record<string, unknown>, runner: NamingRunner | undefined = naming(), turns?: FirefliesSentence[]) => {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tcw={tcw} metadata={metadata} naming={runner} turns={turns} />));
};
const all = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const labels = () => all("speaker-label").map((el) => el.textContent);
const questions = () => all("speaker-suggestion-name").map((el) => el.textContent);
const click = (el: HTMLElement | undefined) => { expect(el).toBeDefined(); return act(async () => el!.click()); };
/** Lets the saves in flight land: turns of the event loop until `landed` holds (a test that waits in vain fails on what it expects next). */
const until = (landed: () => boolean) => act(async () => {
  for (let turn = 0; turn < 500 && !landed(); turn++) await new Promise((resolve) => setImmediate(resolve));
});

test("a label with a suggested name shows the stored label, the name as a question, Use and Dismiss; the question opens the words it rests on", async () => {
  const { tcw } = space(page());
  await mount(tcw, page());
  expect(labels()).toEqual(["Me", "Speaker 1", "Speaker 2", "Me"]);
  expect(questions()).toEqual([`${COPY.suggestedName} Alice Chen?`, `${COPY.suggestedName} Bob Stone?`]);
  expect(all("speaker-suggestion-use").map((el) => el.getAttribute("aria-label"))).toEqual([COPY.useFor("Alice Chen", "Speaker 1"), COPY.useFor("Bob Stone", "Speaker 2")]);
  expect(all("speaker-suggestion-dismiss")).toHaveLength(2);
  // Nothing was renamed, and the note was offered to the runner when it opened.
  expect(considered).toEqual(["rec-1"]);

  expect(all("speaker-suggestion-evidence")).toHaveLength(0);
  expect(all("speaker-suggestion-name")[0]!.getAttribute("aria-expanded")).toBe("false");
  await click(all("speaker-suggestion-name")[0]);
  expect(all("speaker-suggestion-name")[0]!.getAttribute("aria-expanded")).toBe("true");
  expect(all("speaker-suggestion-evidence").map((el) => el.textContent)).toEqual([`${COPY.basis["self-introduction"]} ${COPY.quote("I'm Alice Chen")}`]);
});

test("a named label, a dismissed label and a stale suggestion show nothing", async () => {
  const named = page({ speaker_names: { "Speaker 1": "Alicia" } }, { dismissed: ["Speaker 2"] });
  await mount(space(named).tcw, named);
  expect(labels()).toEqual(["Me", "Alicia", "Speaker 2", "Me"]);
  expect(questions()).toEqual([]);
  await act(async () => root?.unmount());
  cleanup?.();

  // The note has been transcribed again: the stored suggestions are of the old transcript.
  const stale = page({ transcript_hash: "rev-2" });
  await mount(space(stale).tcw, stale);
  expect(labels()).toEqual(["Me", "Speaker 1", "Speaker 2", "Me"]);
  expect(questions()).toEqual([]);
});

test("a name taken from the call window keeps its Suggested mark and shows no second suggestion; another speaker's suggestion still shows", async () => {
  // The call's name for Speaker 1 is already its name (names in the call); a naming run suggested names for both.
  const named = page({ speaker_names: { "Speaker 1": "Alex Example" },
    speaker_suggestions: { "Speaker 1": { name: "Alex Example", source: "call_window", confidence: "high", reason: "one_other_participant", person: "p2", at: "" } } });
  await mount(space(named).tcw, named);
  expect(labels()).toEqual(["Me", "Alex Example", "Speaker 2", "Me"]);
  expect(all("speaker-suggested").map((el) => el.textContent)).toEqual([COPY.suggested]);
  expect(questions()).toEqual([`${COPY.suggestedName} Bob Stone?`]);
  // One name is left to take, so there is no Use all.
  expect(all("speaker-suggestions-all")).toHaveLength(0);
});

test("the rename form starts with the suggested name and still offers the other names in the call", async () => {
  const inCall = page({ call_participants: { v: 1, source: "call_window", app: "google-meet", truncated: false,
    people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alice Chen" }, { id: "p3", name: "Dana Lee" }] } });
  await mount(space(inCall).tcw, inCall);
  await click(all("speaker-label")[1]);
  const field = document.querySelector('[data-testid="speaker-rename-form"] input') as HTMLInputElement;
  expect(field.value).toBe("Alice Chen");
  const choices = [...document.querySelectorAll<HTMLElement>('[data-testid="speaker-choices"] button')];
  expect(choices.map((button) => button.textContent)).toEqual(["Robin Sample", "Dana Lee"]);
  await click(choices[1]);
  expect(field.value).toBe("Alice Chen, Dana Lee");
});

test("a suggestion is text, whatever it holds", async () => {
  const markup = page({}, { names: { "Speaker 1": { name: "<img src=x onerror=alert(1)>", basis: "inferred", quote: "<b>bold</b>" } } });
  await mount(space(markup).tcw, markup);
  await click(all("speaker-suggestion-name")[0]);
  expect(document.querySelector("img, b")).toBeNull();
  expect(questions()).toEqual([`${COPY.suggestedName} <img src=x onerror=alert(1)>?`]);
  expect(all("speaker-suggestion-evidence")[0]!.textContent).toContain("<b>bold</b>");
});

test("Use renames the speaker and saves the name; Undo puts the label and its suggestion back", async () => {
  const { tcw, stored } = space(page());
  await mount(tcw, page());
  await click(all("speaker-suggestion-use")[0]);
  await until(() => stored().speaker_names !== undefined);
  expect(labels()).toEqual(["Me", "Alice Chen", "Speaker 2", "Me"]);
  expect(questions()).toEqual([`${COPY.suggestedName} Bob Stone?`]);
  expect(stored().speaker_names).toEqual({ "Speaker 1": "Alice Chen" });
  expect(document.body.textContent).toContain(COPY.renamed("Speaker 1", "Alice Chen"));

  await click(all("speaker-rename-undo")[0]);
  await until(() => stored().speaker_names === undefined);
  expect(labels()).toEqual(["Me", "Speaker 1", "Speaker 2", "Me"]);
  expect(questions()).toHaveLength(2);
  expect(stored().speaker_names).toBeUndefined();
});

test("with two suggestions Use all names every suggested speaker; with one there is no Use all", async () => {
  const { tcw, stored } = space(page());
  await mount(tcw, page());
  expect(all("speaker-suggestions-all")[0]!.textContent).toContain(COPY.suggestionsFound(2));
  await click(all("speaker-suggestions-use-all")[0]);
  await until(() => Object.keys(stored().speaker_names ?? {}).length === 2);
  expect(labels()).toEqual(["Me", "Alice Chen", "Bob Stone", "Me"]);
  expect(stored().speaker_names).toEqual({ "Speaker 1": "Alice Chen", "Speaker 2": "Bob Stone" });
  expect(questions()).toEqual([]);
  expect(all("speaker-suggestions-all")).toHaveLength(0);
  await act(async () => root?.unmount());
  cleanup?.();

  const one = page({}, { names: { "Speaker 1": ALICE } });
  await mount(space(one).tcw, one);
  expect(questions()).toHaveLength(1);
  expect(all("speaker-suggestions-all")).toHaveLength(0);
});

test("Dismiss hides the suggestion at once and saves that with the note; nobody is renamed", async () => {
  const { tcw, stored } = space(page());
  await mount(tcw, page());
  await click(all("speaker-suggestion-dismiss")[0]);
  expect(questions()).toEqual([`${COPY.suggestedName} Bob Stone?`]);
  await until(() => stored().speaker_name_suggestions.dismissed.length === 1);
  expect(stored().speaker_name_suggestions.dismissed).toEqual(["Speaker 1"]);
  await click(all("speaker-suggestion-dismiss")[0]);
  await until(() => stored().speaker_name_suggestions.dismissed.length === 2);
  expect(questions()).toEqual([]);
  expect(stored().speaker_name_suggestions.dismissed).toEqual(["Speaker 1", "Speaker 2"]);
  expect(labels()).toEqual(["Me", "Speaker 1", "Speaker 2", "Me"]);
  expect(stored().speaker_names).toBeUndefined();
});

test("a Dismiss that cannot be saved shows the suggestion again", async () => {
  const down = Promise.withResolvers<void>();
  const { tcw } = space(page(), { down: down.promise });
  await mount(tcw, page());
  await click(all("speaker-suggestion-dismiss")[0]);
  expect(questions()).toHaveLength(1);
  down.resolve();
  await until(() => questions().length === 2);
  expect(questions()).toHaveLength(2);
});

test("the rename field starts with the suggested name", async () => {
  const { tcw } = space(page());
  await mount(tcw, page());
  await click(all("speaker-label")[1]);
  expect((document.querySelector('[data-testid="speaker-rename-form"] input') as HTMLInputElement).value).toBe("Alice Chen");
  await click(all("speaker-label")[0]);
  expect([...document.querySelectorAll<HTMLInputElement>('[data-testid="speaker-rename-form"] input')].map((input) => input.value)).toEqual(["", "Alice Chen"]);
});

for (const timed of [true, false]) {
  test(`a suggestion shows at the speaker's first label only, ${timed ? "with" : "without"} times: later turns keep the plain label, and its rename field still starts with the name`, async () => {
    const one = page({}, { names: { "Speaker 1": ALICE } });
    const { tcw, stored } = space(one);
    await mount(tcw, one, naming(), exchange(timed));
    expect(labels()).toEqual(["Me", "Speaker 1", "Me", "Speaker 1", "Me", "Speaker 1"]);
    expect(questions()).toHaveLength(1);
    expect(all("speaker-suggestion-use")).toHaveLength(1);
    expect(all("speaker-suggestion-dismiss")).toHaveLength(1);
    // The controls sit with the first of the three labels.
    expect(all("speaker-suggestion")[0]!.contains(all("speaker-label")[1]!)).toBe(true);

    await click(all("speaker-label")[5]);
    expect((document.querySelector('[data-testid="speaker-rename-form"] input') as HTMLInputElement).value).toBe("Alice Chen");
    await click([...document.querySelectorAll<HTMLElement>('[data-testid="speaker-rename-form"] button')].find((button) => button.textContent === COPY.cancel));

    await click(all("speaker-suggestion-dismiss")[0]);
    await until(() => stored().speaker_name_suggestions.dismissed.length === 1);
    expect(questions()).toEqual([]);
    expect(all("speaker-suggestion")).toHaveLength(0);
    expect(labels()).toEqual(["Me", "Speaker 1", "Me", "Speaker 1", "Me", "Speaker 1"]);
  });
}

test("Use at the first label names the speaker on every turn", async () => {
  const one = page({}, { names: { "Speaker 1": ALICE } });
  const { tcw, stored } = space(one);
  await mount(tcw, one, naming(), exchange(true));
  await click(all("speaker-suggestion-use")[0]);
  await until(() => stored().speaker_names !== undefined);
  expect(labels()).toEqual(["Me", "Alice Chen", "Me", "Alice Chen", "Me", "Alice Chen"]);
  expect(questions()).toEqual([]);
});

test("the transcript's menu has Suggest names on a note that can be named, and it asks the runner", async () => {
  const { tcw } = space(page());
  await mount(tcw, page());
  await click(all("note-suggest-names")[0]);
  expect(suggested).toEqual(["rec-1"]);
  await act(async () => root?.unmount());
  cleanup?.();

  // A transcript made on the device never leaves it, and a pasted one is not a recording.
  for (const metadata of [page({ transcription_engine: "whispercpp" }), page({ capture: "pasted" })]) {
    await mount(space(metadata).tcw, metadata);
    expect(all("note-suggest-names")).toHaveLength(0);
    await act(async () => root?.unmount());
    cleanup?.();
  }
});

test("in a build without suggested names nothing of them shows, even for a note that has some stored", async () => {
  delete import.meta.env.VITE_SPEAKER_NAME_SUGGESTIONS;
  const { tcw } = space(page());
  await mount(tcw, page());
  expect(labels()).toEqual(["Me", "Speaker 1", "Speaker 2", "Me"]);
  expect(questions()).toEqual([]);
  expect(all("speaker-suggestions-all")).toHaveLength(0);
  expect(all("note-suggest-names")).toHaveLength(0);
  expect(considered).toEqual([]);
  // The rename field offers no suggestion either.
  await click(all("speaker-label")[1]);
  expect((document.querySelector('[data-testid="speaker-rename-form"] input') as HTMLInputElement).value).toBe("");
});

test("without a runner (the surface made none) nothing shows either", async () => {
  const { tcw } = space(page());
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tcw={tcw} metadata={page()} naming={undefined} />));
  expect(questions()).toEqual([]);
  expect(all("note-suggest-names")).toHaveLength(0);
});
