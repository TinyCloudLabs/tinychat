import { expect, test } from "bun:test";
import { listsSpeakerName, parseCallParticipants, readCallParticipants, speakerChoices, suggestSpeakerNames,
  withSpeakerChoice, type CallParticipants } from "./callParticipants";
import { cleanSpeakerName, readSuggestedSpeakerNames, suggestedSpeakers } from "./speakerNames";

const AT = "2026-11-18T18:20:00.000Z";
/** Characters by code point, so this file holds no invisible character itself. */
const chars = (...codes: number[]) => String.fromCodePoint(...codes);
const call = (people: unknown[], extra: Record<string, unknown> = {}) =>
  ({ v: 1, source: "call_window", app: "google-meet", people, truncated: false, ...extra });
const parsed = (people: unknown[], extra: Record<string, unknown> = {}) => parseCallParticipants(call(people, extra))!;

const ONE_ON_ONE = parsed([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }]);
const GROUP = parsed([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }]);

test("what the desktop app hands over is read as the stored shape, names cleaned like speaker names", () => {
  expect(parseCallParticipants(call([{ id: "p1", name: "  Robin \n Sample ", self: true }, { id: "p2", name: "Alex" }], { app: "zoom" })))
    .toEqual({ v: 1, source: "call_window", app: "zoom", truncated: false,
      people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex" }] });
  const long = parsed([{ id: "p1", name: "x".repeat(200) }]);
  expect(long.people[0]!.name).toHaveLength(80);
  // Control characters and the ones that reorder text are no part of a name.
  expect(parsed([{ id: "p1", name: "Al\u0000ex \u202eEvil\u202c" }]).people[0]!.name).toBe("Alex Evil");
});

test("invisible marks are no part of a name, and a long name is cut between characters, never inside one", () => {
  // Zero-width space, non-joiner and joiner, the left-to-right and right-to-left marks, the Arabic letter mark.
  const hidden = `A${chars(0x200b)}l${chars(0x200c, 0x200d)}ex${chars(0x200e, 0x200f)} ${chars(0x061c)}Example`;
  expect(parsed([{ id: "p1", name: hidden }]).people[0]!.name).toBe("Alex Example");
  // 79 letters, then a character that takes two UTF-16 units, then more: the cut keeps that character whole.
  const face = chars(0x1f600);
  const cut = parsed([{ id: "p1", name: `${"x".repeat(79)}${face}yy` }]).people[0]!.name;
  expect(cut).toBe(`${"x".repeat(79)}${face}`);
  expect([...cut]).toHaveLength(80);
  expect(cleanSpeakerName(`${"x".repeat(80)}${face}`)).toBe("x".repeat(80));
  // Half a character would make this throw.
  expect(() => encodeURIComponent(cleanSpeakerName(`${"x".repeat(79)}${face}`))).not.toThrow();
});

test("anything not in the agreed shape is refused", () => {
  for (const value of [null, "names", [], call([{ id: "p1", name: "A" }], { v: 2 }), call([{ id: "p1", name: "A" }], { source: "screen" }),
    call([{ id: "p1", name: "A" }], { app: "teams" }), { v: 1, source: "call_window", app: "zoom", people: "A" }])
    expect(parseCallParticipants(value)).toBeNull();
  // Nobody with a usable name is no evidence at all.
  expect(parseCallParticipants(call([]))).toBeNull();
  expect(parseCallParticipants(call([{ id: "p1", name: "   " }, { id: "", name: "Alex" }, { name: "Alex" }, "Alex"]))).toBeNull();
});

test("an entry without a name or with a repeated id is dropped; self is only an explicit true", () => {
  const people = parsed([{ id: "p1", name: "Robin", self: "yes" }, { id: "p1", name: "Robin again" }, { id: "p2", name: "" },
    { id: "p3", name: "Alex", self: true }, { id: "p4".repeat(20), name: "Long id" }]).people;
  expect(people).toEqual([{ id: "p1", name: "Robin" }, { id: "p3", name: "Alex", self: true }]);
});

test("past 50 people the rest are dropped and the list says it was cut", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ id: `p${index + 1}`, name: `Person ${index + 1}` }));
  const read = parsed(many);
  expect(read.people).toHaveLength(50);
  expect(read.people.at(-1)!.name).toBe("Person 50");
  expect(read.truncated).toBe(true);
  expect(parsed(many.slice(0, 3), { truncated: true }).truncated).toBe(true);
});

test("the row's metadata holds them under call_participants", () => {
  expect(readCallParticipants({ call_participants: call([{ id: "p1", name: "Alex" }]), speaker_names: {} })?.people)
    .toEqual([{ id: "p1", name: "Alex" }]);
  expect(readCallParticipants({ speaker_names: { Them: "Alex" } })).toBeNull();
  expect(readCallParticipants(null)).toBeNull();
});

test("the other side is offered everyone but the user; the user's side is offered the user's own name", () => {
  expect(speakerChoices(GROUP, "Them")).toEqual(["Alex Example", "Dana Lee"]);
  expect(speakerChoices(GROUP, "Others")).toEqual(["Alex Example", "Dana Lee"]);
  expect(speakerChoices(GROUP, "Me")).toEqual(["Robin Sample"]);
  expect(speakerChoices(GROUP, "You")).toEqual(["Robin Sample"]);
  // A label of neither side is offered everyone.
  expect(speakerChoices(GROUP, "Speaker 1")).toEqual(["Robin Sample", "Alex Example", "Dana Lee"]);
  expect(speakerChoices(null, "Them")).toEqual([]);
});

test("each name is offered once, and the user's name is never offered for the other side", () => {
  const seenTwice = parsed([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Robin Sample" },
    { id: "p3", name: "Alex" }, { id: "p4", name: "Alex" }]);
  expect(speakerChoices(seenTwice, "Them")).toEqual(["Alex"]);
  expect(speakerChoices(seenTwice, "Me")).toEqual(["Robin Sample"]);
  // Without a name marked as the user, the user's side has nothing to offer and the other side has everyone.
  const unknownSelf = parsed([{ id: "p1", name: "Robin Sample" }, { id: "p2", name: "Alex" }]);
  expect(speakerChoices(unknownSelf, "Me")).toEqual([]);
  expect(speakerChoices(unknownSelf, "Them")).toEqual(["Robin Sample", "Alex"]);
});

test("one other person, with the user marked, is suggested for Them", () => {
  expect(suggestSpeakerNames(ONE_ON_ONE, AT)).toEqual({ Them: { name: "Alex Example", source: "call_window",
    confidence: "high", reason: "one_other_participant", person: "p2", at: AT } });
  // The user's own tile seen without its mark is still the user.
  const ownTile = parsed([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex" }, { id: "p3", name: "Robin Sample" }]);
  expect(suggestSpeakerNames(ownTile, AT).Them?.name).toBe("Alex");
});

test("no suggestion unless exactly one other person and the user marked", () => {
  expect(suggestSpeakerNames(GROUP, AT)).toEqual({});
  expect(suggestSpeakerNames(parsed([{ id: "p1", name: "Robin" }, { id: "p2", name: "Alex" }]), AT)).toEqual({});
  expect(suggestSpeakerNames(parsed([{ id: "p1", name: "Robin", self: true }]), AT)).toEqual({});
  expect(suggestSpeakerNames(parsed([{ id: "p1", name: "Alex" }]), AT)).toEqual({});
  expect(suggestSpeakerNames({ ...ONE_ON_ONE, truncated: true } as CallParticipants, AT)).toEqual({});
  expect(suggestSpeakerNames(null, AT)).toEqual({});
});

test("two people who share a name are two people: nothing is suggested, and the name is offered once", () => {
  const namesakes = parsed([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Alex Example" }]);
  expect(suggestSpeakerNames(namesakes, AT)).toEqual({});
  expect(speakerChoices(namesakes, "Them")).toEqual(["Alex Example"]);
});

test("the user's own entry in another case or with other spacing is still the user, not another person", () => {
  const people = [{ id: "p1", name: "Robin Sample", self: true as const }, { id: "p2", name: " robin  sample " }, { id: "p3", name: "Alex Example" }];
  // As parsed, and as an object whose names were never cleaned.
  for (const participants of [parsed(people), { ...ONE_ON_ONE, people }]) {
    expect(suggestSpeakerNames(participants, AT).Them).toMatchObject({ name: "Alex Example", person: "p3" });
    expect(speakerChoices(participants, "Them")).toEqual(["Alex Example"]);
    expect(speakerChoices(participants, "Me")).toEqual(["Robin Sample"]);
  }
});

test("a tapped name fills an empty field and is added to a field with names", () => {
  expect(withSpeakerChoice("", "Alex Example")).toBe("Alex Example");
  expect(withSpeakerChoice("  ", "Alex Example")).toBe("Alex Example");
  expect(withSpeakerChoice("Alex Example", "Dana Lee")).toBe("Alex Example, Dana Lee");
  expect(withSpeakerChoice("Alex Example ,", "Dana Lee")).toBe("Alex Example, Dana Lee");
  // Already there: nothing changes, whatever the case.
  expect(withSpeakerChoice("Alex Example, Dana Lee", "dana lee")).toBe("Alex Example, Dana Lee");
  // A name with a comma in it is one name.
  expect(withSpeakerChoice("Sample, Robin", "Sample, Robin")).toBe("Sample, Robin");
  expect(listsSpeakerName("Alex, Sample, Robin", "Sample, Robin")).toBe(true);
  expect(listsSpeakerName("Ann", "Anna")).toBe(false);
  expect(listsSpeakerName("", "Anna")).toBe(false);
  // The field never grows past the longest name kept.
  const full = `${"A".repeat(40)}, ${"B".repeat(30)}`;
  expect(withSpeakerChoice(full, "Carol Long-Name")).toBe(full);
});

test("a label reads as suggested exactly while its suggested name is the name shown", () => {
  const metadata = { speaker_names: { Them: "Alex Example" },
    speaker_suggestions: { Them: { name: "Alex Example", source: "call_window", confidence: "high", reason: "one_other_participant", person: "p2", at: AT } } };
  const suggestions = readSuggestedSpeakerNames(metadata);
  expect(suggestions).toEqual({ Them: "Alex Example" });
  expect([...suggestedSpeakers({ Them: "Alex Example" }, suggestions)]).toEqual(["Them"]);
  expect([...suggestedSpeakers({ Them: "Alexander" }, suggestions)]).toEqual([]);
  expect([...suggestedSpeakers({}, suggestions)]).toEqual([]);
  expect(readSuggestedSpeakerNames({ speaker_suggestions: { Them: { name: "" }, Me: "Robin", You: null } })).toEqual({});
  expect(readSuggestedSpeakerNames({ speaker_suggestions: ["Alex"] })).toEqual({});
});
