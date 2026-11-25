import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { captureEvents } from "@/capture/captureEvents";
import type { ChatMessage } from "@/lib/chatApi";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { dismissRowNameSuggestions } from "@/lib/voiceNotes/nameSuggestionRows";
import { patchRowSpeakerName } from "@/lib/voiceNotes/voiceNoteRows";
import type { NameSuggestions } from "./nameSuggestions";
import { MAX_NAMING_REQUEST_BYTES, type NamingReadings } from "./namingChat";
import { createNamingRunner, type NamingRunner } from "./namingRunner";
import { CALL, CALL_REPLY, namingSpace, type NamingSpace } from "./namingSpace.fixture";

const VOICE_NOTE = "exo-voice-note";
const ALICE = { name: "Alice Chen", basis: "self-introduction", quote: "I'm Alice Chen" };
const BOB = { name: "Bob Stone", basis: "self-introduction", quote: "this is Bob Stone" };
const AGREED: NamingReadings = { replies: [CALL_REPLY, CALL_REPLY, CALL_REPLY], paywall: false };
const NO_NAMES = JSON.stringify({ speakers: ["S1", "S2", "S3"].map((speaker) => ({ speaker, name: "null", basis: "none", quote: "" })) });

let space: NamingSpace;
let runner: NamingRunner;
let calls: ChatMessage[][];
let signals: AbortSignal[];
let reply: (call: number) => NamingReadings | Promise<NamingReadings>;
let setting: () => Promise<boolean>;
let stopListening: () => void;

const make = () => createNamingRunner({
  tcw: space.tcw,
  automatic: () => setting(),
  read: async (messages, signal) => { calls.push(messages); signals.push(signal); return reply(calls.length); },
});
const stored = (id = "call") => space.metadata(id).speaker_name_suggestions as NameSuggestions | undefined;
const suggestionWrites = () => space.statements.filter((sql) => sql.startsWith("UPDATE") && sql.includes("speaker_name_suggestions"));
const changed = (sourceId = "call") => captureEvents.emit("library-changed", { source: VOICE_NOTE, sourceId });
/** Holds the model's answer until the test gives it; `asked` resolves when the run has reached the model. */
function hold() {
  const asked = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<NamingReadings>();
  reply = () => { asked.resolve(); return answer.promise; };
  return { asked: asked.promise, answer: answer.resolve };
}

beforeEach(() => {
  space = namingSpace();
  calls = [];
  signals = [];
  reply = () => AGREED;
  setting = async () => true;
  runner = make();
  // As CaptureSurface wires it: every change to a voice note asks the runner about that note.
  stopListening = captureEvents.on("library-changed", (detail) => { if (detail?.source === VOICE_NOTE) runner.consider(detail.sourceId); });
});
afterEach(() => { stopListening(); runner.cancelAll(); });

describe("naming a note's speakers", () => {
  test("a transcribed note gets names suggested for its remote speakers, and nobody is renamed", async () => {
    const hash = await space.note("call", CALL);
    await patchRowSpeakerName(space.tcw, space.rowId("call"), "Me", "Roman");
    const before = space.metadata("call");

    runner.consider("call");
    await runner.idle();

    expect(calls).toHaveLength(1);
    expect(stored()).toEqual({ hash, model: "moonshotai/kimi-k3.1-pro", at: expect.any(String), names: { "Speaker 1": ALICE, "Speaker 2": BOB }, dismissed: [] });
    expect(space.metadata("call")).toEqual({ ...before, speaker_name_suggestions: stored() });
    expect(space.metadata("call").speaker_names).toEqual({ Me: "Roman" });
    // The model read every turn, the user's own included, under labels that say nothing, with the names the space knows.
    const request = calls[0]![1]!.content;
    expect(request).toContain("S1 [00:00]: Hi, thanks for joining. Who wants to start?");
    expect(request).toContain("S2 [00:06]: Sure. I'm Alice Chen");
    expect(request).toContain("- Roman");
    expect(request).not.toContain("Speaker 1");
  });

  test("the people the call window showed while the note was recorded lead the names the model is given", async () => {
    await space.note("call", CALL);
    await patchRowSpeakerName(space.tcw, space.rowId("call"), "Me", "Roman");
    space.setMetadata("call", { earlier_speaker_names: ["Dana Ruiz"], call_participants: { v: 1, source: "call_window", app: "google-meet", truncated: false,
      // As the meeting app gave them: the user's own entry too, a name with stray spaces, and an entry that is not one.
      people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "  Alice   Chen " }, { id: "p3", name: "" }, { id: "p4", name: "Bob Stone" }] } });

    runner.consider("call");
    await runner.idle();

    const people = calls[0]![1]!.content.split("\n").filter((line) => line.startsWith("- ") && !/^- S\d/.test(line));
    expect(people).toEqual(["- Robin Sample", "- Alice Chen", "- Bob Stone", "- Dana Ruiz", "- Roman"]);
    // The call's names are evidence for the model only: nobody is named by them here.
    expect(space.metadata("call").speaker_names).toEqual({ Me: "Roman" });
  });

  test("the run's own write, a rename and another session do not run it again for the same transcript", async () => {
    await space.note("call", CALL);
    runner.consider("call");
    await runner.idle();
    expect(calls).toHaveLength(1);
    // The write announced itself (library-changed) and the listener asked again; so does every rename.
    changed();
    changed();
    await runner.idle();
    // Another session, or another device, opening the note.
    const later = make();
    later.consider("call");
    await later.idle();
    expect(calls).toHaveLength(1);
    expect(suggestionWrites()).toHaveLength(1);
  });

  test("one run per note at a time", async () => {
    await space.note("call", CALL);
    const model = hold();
    runner.consider("call");
    await model.asked;
    runner.consider("call");
    changed();
    runner.consider("call");
    model.answer(AGREED);
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(suggestionWrites()).toHaveLength(1);
  });

  test("a note whose readings found no name is marked as read and not read again", async () => {
    const hash = await space.note("call", CALL);
    reply = () => ({ replies: [NO_NAMES, NO_NAMES, NO_NAMES], paywall: false });
    runner.consider("call");
    await runner.idle();
    expect(stored()).toMatchObject({ hash, names: {}, dismissed: [] });
    changed();
    await runner.idle();
    expect(calls).toHaveLength(1);
  });

  test("a new transcript is named again and replaces the suggestions of the old one", async () => {
    const first = await space.note("call", CALL);
    runner.consider("call");
    await runner.idle();
    await dismissRowNameSuggestions(space.tcw, space.rowId("call"), first, ["Speaker 2"]);
    const second = await space.note("call", CALL.map((sentence) => ({ ...sentence, text: `${sentence.text} Right.` })));
    changed();
    await runner.idle();
    expect(calls).toHaveLength(2);
    expect(stored()).toMatchObject({ hash: second, dismissed: [] });
  });

  test("a transcript that lands while the old one is being read is named when that run ends", async () => {
    await space.note("call", CALL);
    const model = hold();
    runner.consider("call");
    await model.asked;
    const second = await space.note("call", CALL.map((sentence) => ({ ...sentence, text: `${sentence.text} Right.` })));
    changed();
    reply = () => AGREED;
    model.answer(AGREED);
    await runner.idle();
    expect(calls).toHaveLength(2);
    expect(stored()?.hash).toBe(second);
  });
});

describe("a naming run that fails", () => {
  const ONE_READING: NamingReadings = { replies: [CALL_REPLY, "I could not tell."], paywall: false };

  test("writes nothing, is tried once more on the next change, and then left alone; the menu still runs it", async () => {
    await space.note("call", CALL);
    const before = space.metadata("call");
    const updatedAt = space.updatedAt("call");
    reply = () => ONE_READING;

    runner.consider("call");
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(space.metadata("call")).toEqual(before);
    expect(space.updatedAt("call")).toBe(updatedAt);
    expect(suggestionWrites()).toEqual([]);

    changed();
    await runner.idle();
    expect(calls).toHaveLength(2);
    changed();
    runner.consider("call");
    await runner.idle();
    expect(calls).toHaveLength(2);
    expect(space.metadata("call")).toEqual(before);

    reply = () => AGREED;
    runner.suggest("call");
    await runner.idle();
    expect(calls).toHaveLength(3);
    expect(stored()?.names).toEqual({ "Speaker 1": ALICE, "Speaker 2": BOB });
  });

  test("a model call that throws is a failed run", async () => {
    await space.note("call", CALL);
    reply = () => { throw new Error("network"); };
    runner.consider("call");
    await runner.idle();
    expect(stored()).toBeUndefined();
    expect(suggestionWrites()).toEqual([]);
  });

  test("a refusal for credits is not retried, and no other note is tried on its own in this session", async () => {
    await space.note("call", CALL);
    await space.note("other", CALL);
    reply = () => ({ replies: [], paywall: true });
    runner.consider("call");
    await runner.idle();
    changed("call");
    changed("other");
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(stored()).toBeUndefined();
    // Asked for by the user, it runs.
    reply = () => AGREED;
    runner.suggest("other");
    await runner.idle();
    expect(calls).toHaveLength(2);
    expect(stored("other")?.names).toEqual({ "Speaker 1": ALICE, "Speaker 2": BOB });
  });
});

describe("Suggest names from the menu", () => {
  test("runs again on a note that has suggestions, and brings back what was dismissed", async () => {
    const hash = await space.note("call", CALL);
    runner.consider("call");
    await runner.idle();
    await dismissRowNameSuggestions(space.tcw, space.rowId("call"), hash, ["Speaker 1"]);
    reply = () => ({ replies: [CALL_REPLY, NO_NAMES, CALL_REPLY], paywall: false });

    runner.suggest("call");
    await runner.idle();

    expect(calls).toHaveLength(2);
    expect(stored()).toMatchObject({ hash, names: { "Speaker 1": ALICE, "Speaker 2": BOB }, dismissed: [] });
  });

  test("with Suggest speaker names off, only the menu runs it", async () => {
    await space.note("call", CALL);
    setting = async () => false;
    runner.consider("call");
    changed();
    await runner.idle();
    expect(calls).toHaveLength(0);
    expect(stored()).toBeUndefined();

    runner.suggest("call");
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(stored()?.names).toEqual({ "Speaker 1": ALICE, "Speaker 2": BOB });
  });

  test("a setting that cannot be read starts no run, and is no failure: the note is named once it can be read", async () => {
    await space.note("call", CALL);
    setting = async () => { throw new Error("settings unreadable"); };
    runner.consider("call");
    await runner.idle();
    changed();
    await runner.idle();
    changed();
    await runner.idle();
    expect(calls).toHaveLength(0);
    setting = async () => true;
    changed();
    await runner.idle();
    expect(calls).toHaveLength(1);
  });

  test("chosen while an automatic run is finding the setting off, it still runs, once", async () => {
    await space.note("call", CALL);
    const read = Promise.withResolvers<boolean>();
    const asked = Promise.withResolvers<void>();
    setting = () => { asked.resolve(); return read.promise; };
    runner.consider("call");
    await asked.promise;
    runner.suggest("call");
    read.resolve(false);
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(stored()?.names).toEqual({ "Speaker 1": ALICE, "Speaker 2": BOB });
  });

  test("chosen while an automatic run is at the model, that run is the one the user asked for", async () => {
    await space.note("call", CALL);
    const model = hold();
    runner.consider("call");
    await model.asked;
    runner.suggest("call");
    model.answer(AGREED);
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(suggestionWrites()).toHaveLength(1);
  });
});

describe("which notes are named", () => {
  const asked = async (sourceId = "call") => {
    runner.consider(sourceId);
    await runner.idle();
    runner.suggest(sourceId);
    await runner.idle();
    return calls.length;
  };
  const speaker = (label: string, seconds: number, extra: Partial<FirefliesSentence> = {}): FirefliesSentence =>
    ({ index: 0, speaker_name: label, text: "I'm Alice Chen.", start_time: 0, end_time: seconds, ...extra });

  test("Powerful and Private transcripts are; an on-device transcript never is, by itself or from the menu", async () => {
    await space.note("powerful", CALL, { engine: "assemblyai" });
    runner.consider("powerful");
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(stored("powerful")?.names).toEqual({ "Speaker 1": ALICE, "Speaker 2": BOB });

    await space.note("local", CALL, { engine: "whispercpp" });
    expect(await asked("local")).toBe(1);
    expect(stored("local")).toBeUndefined();
  });

  test("a pasted transcript is not", async () => {
    await space.note("call", CALL);
    space.setMetadata("call", { capture: "pasted" });
    expect(await asked()).toBe(0);
    expect(stored()).toBeUndefined();
  });

  test("a note without a transcript, or with no speech, is not", async () => {
    await space.note("call", CALL);
    space.sqlite.run("UPDATE voice_note_transcript SET outcome = 'no_speech' WHERE source_id = 'call'");
    expect(await asked()).toBe(0);
    space.sqlite.run("DELETE FROM voice_note_transcript WHERE source_id = 'call'");
    expect(await asked()).toBe(0);
    expect(await asked("not-in-the-space")).toBe(0);
  });

  test("a note with nobody to name is not: the two sides of a call, a few seconds of a voice, unplaced speech", async () => {
    await space.note("sides", [speaker("Me", 60, { channel: 0 }), speaker("Them", 60, { channel: 1 })]);
    await space.note("brief", [speaker("Me", 60, { channel: 0 }), speaker("Speaker 1", 9, { channel: 1, speaker_id: "A" })]);
    await space.note("unplaced", [speaker("Me", 60), speaker("Unknown speaker", 60)]);
    for (const id of ["sides", "brief", "unplaced"]) {
      expect(await asked(id)).toBe(0);
      expect(stored(id)).toBeUndefined();
    }
    expect(suggestionWrites()).toEqual([]);
  });

  test("a request over the API's size limit is not sent, measured in bytes", async () => {
    // Cyrillic takes two bytes a letter: under the limit in characters, over it in bytes.
    const letters = Math.ceil(MAX_NAMING_REQUEST_BYTES / 2) + 1;
    expect(letters).toBeLessThan(MAX_NAMING_REQUEST_BYTES);
    await space.note("long", [speaker("Me", 60, { channel: 0 }), speaker("Speaker 1", 60, { channel: 1, speaker_id: "A", text: "я".repeat(letters) })]);
    expect(await asked("long")).toBe(0);
    expect(stored("long")).toBeUndefined();

    await space.note("fits", [speaker("Me", 60, { channel: 0 }), speaker("Speaker 1", 60, { channel: 1, speaker_id: "A", text: `I'm Alice Chen. ${"я".repeat(letters - 5000)}` })]);
    reply = () => ({ replies: [NO_NAMES, NO_NAMES], paywall: false });
    runner.consider("fits");
    await runner.idle();
    expect(calls).toHaveLength(1);
    expect(stored("fits")).toMatchObject({ names: {} });
  });
});

describe("another account", () => {
  test("stopping the runner ends the run in flight: the request is aborted and nothing is written", async () => {
    await space.note("call", CALL);
    const model = hold();
    runner.consider("call");
    await model.asked;
    runner.cancelAll();
    expect(signals[0]!.aborted).toBe(true);
    model.answer(AGREED);
    await runner.idle();
    expect(stored()).toBeUndefined();
    expect(suggestionWrites()).toEqual([]);
  });
});
