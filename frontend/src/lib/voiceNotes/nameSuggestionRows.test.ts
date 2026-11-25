// How a note's suggested speaker names are stored (`metadata.speaker_name_suggestions`), against a real space.
import { describe, expect, test } from "bun:test";

import { currentNameSuggestions, readNameSuggestions, shownNameSuggestions, TRANSCRIPT_HASH_KEY, type NameSuggestions } from "@/lib/speakerNaming/nameSuggestions";
import { CALL, namingSpace } from "@/lib/speakerNaming/namingSpace.fixture";
import { dismissRowNameSuggestions, writeRowNameSuggestions } from "./nameSuggestionRows";
import { patchRowSpeakerName } from "./voiceNoteRows";

const ALICE = { name: "Alice Chen", basis: "self-introduction", quote: "I'm Alice Chen" } as const;
const BOB = { name: "Bob Stone", basis: "introduced", quote: "this is Bob Stone" } as const;
const run = (hash: string, patch: Partial<NameSuggestions> = {}): NameSuggestions =>
  ({ hash, model: "moonshotai/kimi-k3.1-pro", at: "2026-11-20T10:05:00.000Z", names: { "Speaker 1": ALICE, "Speaker 2": BOB }, dismissed: [], ...patch });

describe("a note's suggested speaker names", () => {
  test("two automatic runs of one transcript write once: the second finds the first and leaves it, a Dismiss included", async () => {
    const space = namingSpace();
    const hash = await space.note("call", CALL);
    const id = space.rowId("call");
    expect(await writeRowNameSuggestions(space.tcw, id, run(hash), false)).toBe(true);
    expect(await dismissRowNameSuggestions(space.tcw, id, hash, ["Speaker 2"])).toBe(true);
    // Another device finished the same run a moment later, with another answer.
    expect(await writeRowNameSuggestions(space.tcw, id, run(hash, { names: { "Speaker 1": BOB }, at: "2026-11-20T10:05:09.000Z" }), false)).toBe(false);
    expect(space.metadata("call").speaker_name_suggestions).toEqual({ ...run(hash), dismissed: ["Speaker 2"] });
  });

  test("the value is written whole: a label an older run named is gone after a run that did not name it", async () => {
    const space = namingSpace();
    const first = await space.note("call", CALL);
    const id = space.rowId("call");
    await writeRowNameSuggestions(space.tcw, id, run(first), false);
    const second = await space.note("call", [...CALL, { index: 4, speaker_name: "Speaker 3", channel: 1, speaker_id: "C", text: "Sorry I am late.", start_time: 40, end_time: 52 }]);
    expect(await writeRowNameSuggestions(space.tcw, id, run(second, { names: { "Speaker 3": ALICE } }), false)).toBe(true);
    expect(space.metadata("call").speaker_name_suggestions).toEqual(run(second, { names: { "Speaker 3": ALICE } }));
  });

  test("the menu's run writes over the suggestions of the same transcript and clears what was dismissed", async () => {
    const space = namingSpace();
    const hash = await space.note("call", CALL);
    const id = space.rowId("call");
    await writeRowNameSuggestions(space.tcw, id, run(hash), false);
    await dismissRowNameSuggestions(space.tcw, id, hash, ["Speaker 1", "Speaker 2"]);
    expect(await writeRowNameSuggestions(space.tcw, id, run(hash, { names: { "Speaker 1": ALICE }, at: "2026-11-21T08:00:00.000Z" }), true)).toBe(true);
    expect(space.metadata("call").speaker_name_suggestions).toEqual(run(hash, { names: { "Speaker 1": ALICE }, at: "2026-11-21T08:00:00.000Z" }));
  });

  test("a Dismiss for suggestions that a new run has replaced does nothing", async () => {
    const space = namingSpace();
    const shown = await space.note("call", CALL);
    const id = space.rowId("call");
    await writeRowNameSuggestions(space.tcw, id, run(shown), false);
    const next = await space.note("call", CALL.map((sentence) => ({ ...sentence, text: `${sentence.text} Right.` })));
    await writeRowNameSuggestions(space.tcw, id, run(next), false);
    // The page still showed the first transcript's suggestions when Dismiss was tapped.
    expect(await dismissRowNameSuggestions(space.tcw, id, shown, ["Speaker 1"])).toBe(false);
    expect(space.metadata("call").speaker_name_suggestions).toEqual(run(next));
    // And with nothing stored at all.
    const bare = namingSpace();
    const hash = await bare.note("call", CALL);
    expect(await dismissRowNameSuggestions(bare.tcw, bare.rowId("call"), hash, ["Speaker 1"])).toBe(false);
    expect(bare.metadata("call")).not.toHaveProperty("speaker_name_suggestions");
  });

  test("a run with no names is stored too, and nothing else on the row changes: names the user gave stay", async () => {
    const space = namingSpace();
    const hash = await space.note("call", CALL);
    const id = space.rowId("call");
    await patchRowSpeakerName(space.tcw, id, "Me", "Roman");
    const before = space.metadata("call");
    await writeRowNameSuggestions(space.tcw, id, run(hash, { names: {} }), false);
    expect(space.metadata("call")).toEqual({ ...before, speaker_name_suggestions: run(hash, { names: {} }) });
    expect(space.metadata("call").speaker_names).toEqual({ Me: "Roman" });
  });

  test("only a voice note's row takes suggestions", async () => {
    const space = namingSpace();
    await space.note("call", CALL);
    space.meeting("fireflies", "m", "2026-11-20T09:50:00.000Z", 3600, []);
    expect(await writeRowNameSuggestions(space.tcw, "fireflies-m", run("h"), true)).toBe(false);
    expect(await writeRowNameSuggestions(space.tcw, "missing", run("h"), true)).toBe(false);
  });
});

describe("what a note shows of its suggestions", () => {
  const page = (hash: string, stored: NameSuggestions) => ({ [TRANSCRIPT_HASH_KEY]: hash, speaker_name_suggestions: stored });

  test("suggestions made from another revision of the transcript are stale and ignored", () => {
    expect(shownNameSuggestions(page("new", run("old")), {})).toEqual({});
    expect(currentNameSuggestions(page("new", run("old")))).toBeNull();
    expect(shownNameSuggestions(page("h", run("h")), {})).toEqual({ "Speaker 1": ALICE, "Speaker 2": BOB });
    // A note with no committed transcript has no revision to match.
    expect(shownNameSuggestions({ speaker_name_suggestions: run("h") }, {})).toEqual({});
  });

  test("a label the user named, and a dismissed label, show no suggestion", () => {
    expect(shownNameSuggestions(page("h", run("h")), { "Speaker 1": "Alicia" })).toEqual({ "Speaker 2": BOB });
    expect(shownNameSuggestions(page("h", run("h", { dismissed: ["Speaker 2"] })), {})).toEqual({ "Speaker 1": ALICE });
    expect(shownNameSuggestions(page("h", run("h")), {}, new Set(["Speaker 1", "Speaker 2"]))).toEqual({});
  });

  test("a stored value of another shape is read as far as it can be shown as plain text", () => {
    expect(readNameSuggestions({ speaker_name_suggestions: "Alice" })).toBeNull();
    expect(readNameSuggestions({ speaker_name_suggestions: { names: { "Speaker 1": ALICE } } })).toBeNull();
    expect(readNameSuggestions({ speaker_name_suggestions: { hash: "h", names: {
      "Speaker 1": { name: "  Alice \n Chen ", basis: "guessed", quote: 7 },
      "Speaker 2": { name: "" },
      "Speaker 3": "Bob",
    }, dismissed: ["Speaker 2", 3] } })).toEqual({ hash: "h", model: "", at: "", names: { "Speaker 1": { name: "Alice Chen", basis: "inferred", quote: "" } }, dismissed: ["Speaker 2"] });
  });
});
