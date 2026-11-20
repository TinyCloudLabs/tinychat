import { describe, expect, test } from "bun:test";
import { callRoster, parseCallParticipants, type CallRoster } from "@/capture/library/callParticipants";
import type { LocalTranscript } from "../nativeVoiceNotes";
import { assignCallSpeakers, CALL_SPEAKER_RULES, parseSpeakingTimeline } from "./callSpeakers";

// Who spoke when: the pure assignment of remote lines to the people whose speaking marker was on (plan section 4).
// Calls are scripted as turns; the timeline is what the native sampler would record for them, with the marker
// lagging the audio by `delay`.

type Segment = LocalTranscript["segments"][number];
type Turn = { who: string; start: number; end: number };

const roster = (people: { id: string; name: string; self?: true }[]): CallRoster =>
  callRoster(parseCallParticipants({ v: 1, source: "call_window", app: "google-meet", truncated: false, people }))!;
/** Robin is the user; Alex is Them 1 and Dana is Them 2. */
const ROSTER = roster([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }]);

const segmentOf = (turn: Turn, index: number): Segment => turn.who === "me"
  ? { start: turn.start, end: turn.end, text: `line ${index}`, speaker: "Me", channel: 0, timing: "engine" }
  : { start: turn.start, end: turn.end, text: `line ${index}`, speaker: "Them", channel: 1, timing: "engine" };

/** Intervals as the timeline builder keeps them: sorted, gaps up to 1 s merged. */
function merged(list: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of [...list].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1] + 1000) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

interface CallOptions {
  /** The marker's lag behind the audio at time t (default 700 ms everywhere). */
  delay?: number | ((at: number) => number);
  /** Marker "on" time per person besides their turns (`[start, end]` in marker time). */
  extra?: Record<string, [number, number][]>;
  /** Turns whose marker never lit (the person was off screen). */
  unseenTurns?: (turn: Turn) => boolean;
  seen?: [number, number][];
  hidden?: [number, number][];
  breaks?: number[];
  mode?: "rules" | "learned";
  self?: string | null;
  truncated?: boolean;
}

/** The transcript lines and the timeline the sampler records for `turns`. */
function call(turns: Turn[], options: CallOptions = {}) {
  const delayAt = typeof options.delay === "function" ? options.delay : () => (options.delay as number | undefined) ?? 700;
  const segments = turns.map(segmentOf).sort((a, b) => a.start - b.start);
  const end = Math.max(...turns.map((turn) => turn.end)) + 5000;
  const speaking: Record<string, [number, number][]> = {};
  const self: [number, number][] = [];
  for (const turn of turns) {
    const marker: [number, number] = [turn.start + delayAt(turn.start), turn.end + delayAt(turn.start)];
    if (turn.who === "me") self.push(marker);
    else if (!options.unseenTurns?.(turn)) (speaking[turn.who] ??= []).push(marker);
  }
  for (const [id, list] of Object.entries(options.extra ?? {})) (speaking[id] ??= []).push(...list);
  const people = Object.fromEntries(Object.entries(speaking).map(([id, list]) =>
    [id, { speaking: merged(list), seen: options.seen ?? [[0, end]] }]));
  const timeline = { v: 1, app: "google-meet", mode: options.mode ?? "rules", rules_version: 3, sample_ms: 200,
    self: options.self === undefined ? "p1" : options.self, people, self_speaking: merged(self), hidden: options.hidden ?? [],
    breaks: options.breaks ?? [], truncated: options.truncated ?? false };
  return { segments, timeline };
}

const assign = (setup: { segments: Segment[]; timeline: unknown }, extra: Partial<Parameters<typeof assignCallSpeakers>[0]> = {}) =>
  assignCallSpeakers({ segments: setup.segments, engine: "whispercpp", timeline: setup.timeline, roster: ROSTER, ...extra });
const labels = (segments: readonly Segment[]) => segments.map((segment) => segment.speaker);
const ids = (segments: readonly Segment[]) => segments.map((segment) => segment.speakerId ?? null);

/** Alex, Dana and the user take clear turns with short gaps. */
const CLEAR: Turn[] = [
  { who: "me", start: 0, end: 3000 },
  { who: "p2", start: 3500, end: 9000 },
  { who: "p3", start: 9600, end: 15000 },
  { who: "me", start: 15500, end: 17000 },
  { who: "p2", start: 17500, end: 21000 },
  { who: "p3", start: 21500, end: 26000 },
];

describe("clear turns", () => {
  test("each remote line gets its speaker's label and id; the user's lines stay Me", () => {
    const result = assign(call(CLEAR));
    expect(labels(result.segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2"]);
    expect(ids(result.segments)).toEqual([null, "call:p2", "call:p3", null, "call:p2", "call:p3"]);
    expect(result.segments.map((segment) => segment.channel)).toEqual([0, 1, 1, 0, 1, 1]);
    expect(result.assigned).toBe(4);
    expect(result.delaysMs).toEqual([700]);
    // Text, times and timing are kept.
    expect(result.segments.map(({ start, end, text, timing }) => ({ start, end, text, timing })))
      .toEqual(call(CLEAR).segments.map(({ start, end, text, timing }) => ({ start, end, text, timing })));
  });

  test("N is the person's place among the people other than the user, in the roster's order", () => {
    const reversed = roster([{ id: "p1", name: "Robin Sample", self: true }, { id: "p3", name: "Dana Lee" }, { id: "p2", name: "Alex Example" }]);
    expect(labels(assign(call(CLEAR), { roster: reversed }).segments)).toEqual(["Me", "Them 2", "Them 1", "Me", "Them 2", "Them 1"]);
    // The user listed after the others does not take a number.
    const userLast = roster([{ id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }, { id: "p1", name: "Robin Sample", self: true }]);
    expect(labels(assign(call(CLEAR), { roster: userLast }).segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2"]);
  });

  test("a new transcript of the same recording gets the same labels, whatever order the timeline lists people in", () => {
    const setup = call(CLEAR);
    const first = assign(setup);
    const timeline = setup.timeline as { people: Record<string, unknown> };
    const reordered = { ...setup.timeline, people: Object.fromEntries(Object.entries(timeline.people).reverse()) };
    expect(assign({ segments: structuredClone(setup.segments), timeline: reordered })).toEqual(first);
    expect(assign(setup)).toEqual(first);
  });

  test("the input is not changed", () => {
    const setup = call(CLEAR);
    const before = structuredClone(setup.segments);
    assign(setup);
    expect(setup.segments).toEqual(before);
  });
});

test("a pause inside a turn keeps the turn with its speaker", () => {
  // Alex pauses 0.8 s between two lines, and 1.2 s inside the next one: the marker goes off for those pauses.
  const turns: Turn[] = [
    { who: "p2", start: 0, end: 4000 }, { who: "p2", start: 4800, end: 9000 },
    { who: "p3", start: 9500, end: 14000 },
  ];
  const setup = call(turns);
  const alex = { speaking: [[700, 4700], [5500, 7000], [8200, 9700]], seen: [[0, 20000]] };
  const segments = [...setup.segments, { start: 14500, end: 20000, text: "with a pause", speaker: "Them", channel: 1 as const, timing: "engine" as const }];
  const timeline = { ...setup.timeline, people: { ...(setup.timeline.people as object), p2: { ...alex, speaking: [...alex.speaking, [15200, 17000], [18200, 19900]] } } };
  expect(labels(assign({ segments, timeline }).segments)).toEqual(["Them 1", "Them 1", "Them 2", "Them 1"]);
});

test("two people speaking at once leave the line as Them", () => {
  const setup = call([{ who: "p2", start: 0, end: 5000 }, { who: "p3", start: 5500, end: 10000 }, { who: "p2", start: 10500, end: 16000 }],
    { extra: { p3: [[11200, 16700]] } });
  expect(labels(assign(setup).segments)).toEqual(["Them 1", "Them 2", "Them"]);
});

describe("a line spanning two speakers", () => {
  const span = (split: number) => {
    // One line from 0 to 10 s; Alex speaks until `split`, Dana after. The line is not split.
    const segments: Segment[] = [
      { start: 0, end: 10000, text: "both", speaker: "Them", channel: 1, timing: "engine" },
      { start: 11000, end: 15000, text: "Alex", speaker: "Them", channel: 1, timing: "engine" },
      { start: 16000, end: 20000, text: "Dana", speaker: "Them", channel: 1, timing: "engine" },
    ];
    const timeline = call([{ who: "p2", start: 11000, end: 15000 }, { who: "p3", start: 16000, end: 20000 }]).timeline;
    const people = timeline.people as Record<string, { speaking: [number, number][]; seen: [number, number][] }>;
    people.p2!.speaking.unshift([700, split + 700]);
    people.p3!.speaking.unshift([split + 700, 10700]);
    return assign({ segments, timeline }).segments;
  };

  test("keeps the majority speaker when the other spoke at most half as long", () => {
    expect(labels(span(7000))).toEqual(["Them 1", "Them 1", "Them 2"]);
    expect(labels(span(3000))).toEqual(["Them 2", "Them 1", "Them 2"]);
  });

  test("stays Them when the two spoke for similar times", () => {
    expect(labels(span(5500))).toEqual(["Them", "Them 1", "Them 2"]);
  });
});

test("a line the meeting window hid stays Them", () => {
  // Hidden from 9.8 s on the marker's clock: from 9.1 s in the audio.
  const setup = call(CLEAR, { hidden: [[9800, 16000]] });
  expect(labels(assign(setup).segments)).toEqual(["Me", "Them 1", "Them", "Me", "Them 1", "Them 2"]);
});

test("a line seen for less than 60% of it stays Them", () => {
  const setup = call(CLEAR, { seen: [[0, 12000], [15000, 40000]] });
  expect(labels(assign(setup).segments)).toEqual(["Me", "Them 1", "Them", "Me", "Them 1", "Them 2"]);
});

describe("people the marker does not show", () => {
  const FOUR = roster([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" },
    { id: "p3", name: "Dana Lee" }, { id: "p4", name: "Sam Placeholder" }]);
  const turns: Turn[] = [...CLEAR, { who: "p4", start: 26500, end: 32000 }, { who: "p2", start: 32500, end: 36000 }];

  test("a person whose tile was never seen leaves their lines as Them", () => {
    const setup = call(turns, { unseenTurns: (turn) => turn.who === "p4" });
    expect(labels(assign(setup, { roster: FOUR }).segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2", "Them", "Them 1"]);
  });

  test("a person in the timeline but not in the roster names nobody, and takes no line from anyone", () => {
    const setup = call(turns);
    expect(labels(assign(setup).segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2", "Them", "Them 1"]);
    // While both they and Alex are on, the line is shared: Them.
    const both = call(turns, { extra: { p4: [[18200, 21700]] } });
    expect(labels(assign(both).segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them", "Them 2", "Them", "Them 1"]);
  });
});

describe("the delay", () => {
  // Quick turns of 1.5 s with 0.2 s gaps: a delay 0.9 s off hands each line to the person before.
  const quick: Turn[] = Array.from({ length: 30 }, (_, index) => ({ who: index % 2 === 0 ? "p2" : "p3", start: index * 1700, end: index * 1700 + 1500 }));
  const expected = quick.map((_, index) => index % 2 === 0 ? "Them 1" : "Them 2");

  test("a delay the default gets wrong is found by the search", () => {
    const setup = call(quick, { delay: 1600 });
    const searched = assign(setup);
    expect(searched.delaysMs).toEqual([1600]);
    expect(labels(searched.segments)).toEqual(expected);
    // Without the search the same timeline names almost nothing, and nothing wrongly.
    const fixed = assign(setup, { rules: { ...CALL_SPEAKER_RULES, delaySearchMs: 0 } });
    expect(fixed.delaysMs).toEqual([700]);
    expect(fixed.assigned).toBe(1);
    expect(labels(fixed.segments).filter((label, index) => label !== "Them" && label !== expected[index])).toEqual([]);
  });

  test("each recording segment, between pauses, gets its own delay", () => {
    const later = quick.map((turn) => ({ ...turn, start: turn.start + 60_000, end: turn.end + 60_000 }));
    const setup = call([...quick, ...later], { delay: (at) => at < 60_000 ? 500 : 1300, breaks: [60_000] });
    const result = assign(setup);
    expect(result.delaysMs).toEqual([500, 1300]);
    expect(labels(result.segments)).toEqual([...expected, ...expected]);
  });

  test("a delay outside the search names no line wrongly in a call of longer turns", () => {
    const result = assign(call(CLEAR, { delay: 3000 }));
    const right = ["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2"];
    expect(result.delaysMs).toEqual([1700]);
    expect(labels(result.segments).filter((label, index) => label !== "Them" && label !== right[index])).toEqual([]);
  });
});

describe("the audio check, per 10-minute window", () => {
  const window2 = (turn: Turn): Turn => ({ ...turn, start: turn.start + 600_000, end: turn.end + 600_000 });

  test("a window where the marker is on while nobody on the other side speaks names nobody; other windows still do", () => {
    // In the second window Dana's marker is also on for 40 s of silence.
    const setup = call([...CLEAR, ...CLEAR.map(window2)], { extra: { p3: [[630_000, 670_000]] } });
    expect(labels(assign(setup).segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2", "Me", "Them", "Them", "Me", "Them", "Them"]);
  });

  test("a window where the marker misses most of the speech it could see names nobody", () => {
    // In the second window only Alex's first line lit; the rest of the remote speech had no marker (gaps under 10 s).
    let lit = false;
    const setup = call([...CLEAR, ...CLEAR.map(window2)], { unseenTurns: (turn) => {
      if (turn.start < 600_000) return false;
      if (!lit && turn.who === "p2") { lit = true; return false; }
      return true;
    } });
    expect(labels(assign(setup).segments).slice(6)).toEqual(["Me", "Them", "Them", "Me", "Them", "Them"]);
    expect(labels(assign(setup).segments).slice(0, 6)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2"]);
  });

  test("remote speech with no marker for 10 s or more is taken as not seen, so the rest of the window still counts", () => {
    const long: Turn[] = [...CLEAR, { who: "p4", start: 26500, end: 60000 }];
    const setup = call(long, { unseenTurns: (turn) => turn.who === "p4" });
    expect(labels(assign(setup).segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2", "Them"]);
    // Without the 10 s rule the 33 s nobody's marker covered fails the window's check.
    expect(assign(setup, { rules: { ...CALL_SPEAKER_RULES, blindMs: Number.POSITIVE_INFINITY } }).assigned).toBe(0);
  });
});

describe("the user", () => {
  test("is never named, and their marker does not compete for remote lines", () => {
    // The roster does not mark the user, and the meeting window did not either: Robin's tile is among the people.
    const unmarked = roster([{ id: "p1", name: "Robin Sample" }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }]);
    const turns: Turn[] = [...CLEAR, { who: "me", start: 27000, end: 31000 }, { who: "me", start: 32000, end: 36000 }];
    // Robin's tile lights while Robin speaks, and for a short "yes" over Dana's last line.
    const setup = call(turns, { self: null, extra: { p1: [[700, 3700], [16200, 17700], [22700, 24200], [27700, 31700], [32700, 36700]] } });
    const result = assign(setup, { roster: unmarked });
    expect(labels(result.segments)).toEqual(["Me", "Them 2", "Them 3", "Me", "Them 2", "Them 3", "Me", "Me"]);
    expect(ids(result.segments)).not.toContain("call:p1");
  });
});

test("a timeline in learned mode names lines as the rules do when the audio agrees, and nothing when it does not", () => {
  expect(assign(call(CLEAR, { mode: "learned" }))).toEqual(assign(call(CLEAR)));
  // Learned the wrong way round: "speaking" is the quiet tile, on whenever the person is silent.
  const inverted = call(CLEAR, { mode: "learned" });
  const silentAlex: [number, number][] = [[0, 3500], [9700, 17500], [21700, 31000]];
  const silentDana: [number, number][] = [[0, 9600], [15700, 21500], [26700, 31000]];
  const people = inverted.timeline.people as Record<string, { speaking: [number, number][] }>;
  people.p2!.speaking = silentAlex;
  people.p3!.speaking = silentDana;
  const result = assign(inverted);
  expect(result.assigned).toBe(0);
  expect(result.segments).toBe(inverted.segments);
});

describe("nothing is named", () => {
  const setup = call(CLEAR);
  const untouched = (result: ReturnType<typeof assign>) => {
    expect(result.assigned).toBe(0);
    expect(result.segments).toBe(setup.segments);
  };

  test("on the Parakeet route", () => untouched(assign(setup, { engine: "parakeet-tdt-0.6b-v3" })));
  test("without a roster", () => untouched(assign(setup, { roster: null })));
  test("with fewer than two people besides the user", () => {
    untouched(assign(setup, { roster: roster([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }]) }));
    // A second entry with the user's name is the user.
    untouched(assign(setup, { roster: roster([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" },
      { id: "p3", name: "robin  sample" }]) }));
  });
  test("without a timeline", () => {
    untouched(assign({ segments: setup.segments, timeline: null }));
    untouched(assign({ segments: setup.segments, timeline: undefined }));
  });
  test("with an empty timeline", () => untouched(assign({ segments: setup.segments, timeline: { ...setup.timeline, people: {} } })));
  test("for lines without the engine's own times", () => {
    const coarse = setup.segments.map((segment) => ({ ...segment, timing: "coarse" as const }));
    const result = assign({ segments: coarse, timeline: setup.timeline });
    expect(result.assigned).toBe(0);
  });
  test("for lines already named", () => {
    const named = setup.segments.map((segment) => segment.channel === 1 ? { ...segment, speaker: "Them 1" } : segment);
    expect(assign({ segments: named, timeline: setup.timeline }).assigned).toBe(0);
  });
});

test("a truncated timeline names lines up to the last interval it kept, and none after", () => {
  const turns: Turn[] = [...CLEAR, { who: "p2", start: 27000, end: 31000 }, { who: "p3", start: 31500, end: 36000 }];
  const setup = call(turns, { truncated: true });
  // The sampler kept nothing after Dana's line at 21.5 s; Alex's later line is partly covered by an interval the cap cut short.
  const people = setup.timeline.people as Record<string, { speaking: [number, number][] }>;
  people.p2!.speaking = people.p2!.speaking.filter(([start]) => start < 27000);
  people.p3!.speaking = people.p3!.speaking.filter(([start]) => start < 31000);
  people.p2!.speaking.push([27700, 28500]);
  const result = assign(setup);
  expect(labels(result.segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2", "Them", "Them"]);
});

describe("a timeline not in the agreed shape is refused whole", () => {
  const good = call(CLEAR).timeline;
  const person = { speaking: [[100, 200]], seen: [[0, 1000]] };
  const cases: Record<string, unknown> = {
    "a string": JSON.stringify(good),
    "an array": [good],
    "a number": 1,
    "version 2": { ...good, v: 2 },
    "no version": { ...good, v: undefined },
    "an unknown app": { ...good, app: "teams" },
    "an unknown mode": { ...good, mode: "guessed" },
    "a fractional rules version": { ...good, rules_version: 1.5 },
    "a negative rules version": { ...good, rules_version: -1 },
    "a zero sample period": { ...good, sample_ms: 0 },
    "a sample period of a minute": { ...good, sample_ms: 60_000 },
    "self as a number": { ...good, self: 1 },
    "self with a space": { ...good, self: "p 1" },
    "self among the people": { ...good, self: "p2" },
    "people as an array": { ...good, people: [person] },
    "a person id with a space": { ...good, people: { "p 2": person } },
    "a person id of 33 characters": { ...good, people: { ["p".repeat(33)]: person } },
    "an empty person id": { ...good, people: { "": person } },
    "a person without seen spans": { ...good, people: { p2: { speaking: [[0, 100]] } } },
    "a person as an array": { ...good, people: { p2: [[0, 100]] } },
    "an interval of three numbers": { ...good, people: { p2: { speaking: [[0, 100, 200]], seen: [] } } },
    "an interval ending before it starts": { ...good, people: { p2: { speaking: [[200, 100]], seen: [] } } },
    "an empty interval": { ...good, people: { p2: { speaking: [[100, 100]], seen: [] } } },
    "overlapping intervals": { ...good, people: { p2: { speaking: [[0, 200], [100, 300]], seen: [] } } },
    "intervals out of order": { ...good, people: { p2: { speaking: [[500, 600], [0, 100]], seen: [] } } },
    "a negative time": { ...good, people: { p2: { speaking: [[-100, 100]], seen: [] } } },
    "a fractional time": { ...good, people: { p2: { speaking: [[0.5, 100]], seen: [] } } },
    "a time as a string": { ...good, people: { p2: { speaking: [["0", 100]], seen: [] } } },
    "a time past a day": { ...good, people: { p2: { speaking: [[0, 86_400_001]], seen: [] } } },
    "too many people": { ...good, people: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`p${index}`, { speaking: [], seen: [] }])) },
    "too many intervals": { ...good, people: { p2: { speaking: Array.from({ length: 50_001 }, (_, index) => [index * 2, index * 2 + 1]), seen: [] } } },
    "no self_speaking": { ...good, self_speaking: undefined },
    "hidden out of order": { ...good, hidden: [[500, 600], [0, 100]] },
    "breaks out of order": { ...good, breaks: [5000, 1000] },
    "a repeated break": { ...good, breaks: [1000, 1000] },
    "a break as a string": { ...good, breaks: ["1000"] },
    "truncated as a string": { ...good, truncated: "false" },
    "no truncated": { ...good, truncated: undefined },
  };
  for (const [name, value] of Object.entries(cases)) {
    test(name, () => {
      expect(parseSpeakingTimeline(value)).toBeNull();
      const result = assign({ segments: call(CLEAR).segments, timeline: value });
      expect(result.assigned).toBe(0);
    });
  }

  test("the agreed shape is read, with unknown fields ignored", () => {
    const parsed = parseSpeakingTimeline({ ...good, extra: "ignored" });
    expect(parsed?.people.get("p2")?.speaking).toEqual([[4200, 9700], [18200, 21700]]);
    expect(parsed?.self).toBe("p1");
    expect(parseSpeakingTimeline({ ...good, self: null })?.self).toBeNull();
    expect(parseSpeakingTimeline({ ...good, mode: "learned", app: "zoom" })?.mode).toBe("learned");
    // Touching intervals are not overlapping.
    expect(parseSpeakingTimeline({ ...good, hidden: [[0, 100], [100, 200]] })?.hidden).toEqual([[0, 100], [100, 200]]);
  });
});

test("the roster holds ids only: the user's entries, and everyone else in the call's order", () => {
  expect(ROSTER).toEqual({ self: ["p1"], others: ["p2", "p3"] });
  expect(roster([{ id: "p2", name: "Alex Example" }, { id: "p1", name: "Robin Sample", self: true }, { id: "p3", name: "ROBIN SAMPLE" },
    { id: "p4", name: "Dana Lee" }])).toEqual({ self: ["p1", "p3"], others: ["p2", "p4"] });
  expect(callRoster(null)).toBeNull();
  expect(JSON.stringify(ROSTER)).not.toContain("Alex");
});

test("a two-hour call with thousands of turns is assigned in well under a second of work", () => {
  const turns: Turn[] = [];
  for (let at = 0, index = 0; at < 2 * 60 * 60_000; index++) {
    const length = 1200 + (index * 7919) % 6000;
    turns.push({ who: ["p2", "p3", "me", "p4"][index % 4]!, start: at, end: at + length });
    at += length + 300 + (index * 104729) % 900;
  }
  const four = roster([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" },
    { id: "p3", name: "Dana Lee" }, { id: "p4", name: "Sam Placeholder" }]);
  const setup = call(turns, { breaks: [30 * 60_000, 60 * 60_000, 90 * 60_000] });
  const started = performance.now();
  const result = assign(setup, { roster: four });
  expect(performance.now() - started).toBeLessThan(5_000);
  const remote = turns.filter((turn) => turn.who !== "me").length;
  expect(result.assigned).toBe(remote);
  expect(result.segments.filter((segment) => segment.channel === 1).every((segment) =>
    segment.speakerId === `call:${turns.find((turn) => turn.start === segment.start)!.who}`)).toBe(true);
});

describe("the timeline's own order of the people", () => {
  const withOrder = (order: unknown) => {
    const setup = call(CLEAR);
    return { segments: setup.segments, timeline: { ...setup.timeline, order } };
  };

  test("numbers Them N without the roster, the user excluded", () => {
    const result = assign(withOrder(["p1", "p2", "p3"]), { roster: null });
    expect(labels(result.segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2"]);
    expect(ids(result.segments)).toEqual([null, "call:p2", "call:p3", null, "call:p2", "call:p3"]);
    // Its order wins over the roster's.
    expect(labels(assign(withOrder(["p3", "p1", "p2"])).segments)).toEqual(["Me", "Them 2", "Them 1", "Me", "Them 2", "Them 1"]);
    // People seen in the recording but not in the call's list (or vice versa) keep their places.
    expect(labels(assign(withOrder(["p4", "p1", "p2", "p5", "p3"]), { roster: null }).segments))
      .toEqual(["Me", "Them 2", "Them 4", "Me", "Them 2", "Them 4"]);
  });

  test("with fewer than two people besides the user names nobody", () => {
    expect(assign(withOrder(["p1", "p2"])).assigned).toBe(0);
    expect(assign(withOrder([]), { roster: null }).assigned).toBe(0);
  });

  test("an order not in the agreed shape falls back to the roster, and keeps the timeline", () => {
    for (const order of [["p2", "p2", "p3"], ["p 2", "p3"], [2, 3], "p2,p3", { p2: 1 }, null,
      Array.from({ length: 201 }, (_, index) => `p${index}`)]) {
      const setup = withOrder(order);
      expect(parseSpeakingTimeline(setup.timeline)?.order).toBeNull();
      // The roster numbers the people...
      expect(labels(assign(setup).segments)).toEqual(["Me", "Them 1", "Them 2", "Me", "Them 1", "Them 2"]);
      // ...and without one nobody is named.
      expect(assign(setup, { roster: null }).assigned).toBe(0);
    }
    expect(parseSpeakingTimeline(call(CLEAR).timeline)?.order).toBeNull();
    expect(parseSpeakingTimeline(withOrder(["p1", "p2", "p3"]).timeline)?.order).toEqual(["p1", "p2", "p3"]);
  });
});
