import { describe, expect, test } from "bun:test";
import { callRoster, parseCallParticipants, type CallRoster } from "@/capture/library/callParticipants";
import type { LocalTranscript } from "../nativeVoiceNotes";
import { assignCallSpeakers, parseSpeakingTimeline } from "./callSpeakers";

// Who spoke when on tiles that show video (rules version 4). Such a tile has no meter: the reader records when the
// tile had the active-speaker border (`active`). The border comes on about 0.6 s after a person starts, moves to the
// next speaker about 1.4 s after that person starts, and stays on the last speaker through silence.

type Segment = LocalTranscript["segments"][number];
type Turn = { who: string; start: number; end: number };

const roster = (people: { id: string; name: string; self?: true }[]): CallRoster =>
  callRoster(parseCallParticipants({ v: 1, source: "call_window", app: "google-meet", truncated: false, people }))!;
/** Robin is the user; Alex is Them 1 and Dana is Them 2. */
const ROSTER = roster([{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }]);

const segmentOf = (turn: Turn, index: number): Segment => turn.who === "p1"
  ? { start: turn.start, end: turn.end, text: `line ${index}`, speaker: "Me", channel: 0, timing: "engine" }
  : { start: turn.start, end: turn.end, text: `line ${index}`, speaker: "Them", channel: 1, timing: "engine" };

/** The border intervals a call of `turns` leaves: first on 600 ms after the first start, handed over 1400 ms after each next start. */
function borders(turns: Turn[], end: number): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  let holder: { who: string; from: number } | null = null;
  for (const turn of sorted) {
    if (holder === null) holder = { who: turn.who, from: turn.start + 600 };
    else if (holder.who !== turn.who) {
      (out[holder.who] ??= []).push([holder.from, turn.start + 1400]);
      holder = { who: turn.who, from: turn.start + 1400 };
    }
  }
  if (holder !== null) (out[holder.who] ??= []).push([holder.from, end]);
  return out;
}

/** A call where every tile shows video: no meter intervals at all. */
function videoCall(turns: Turn[], options: { self?: string | null; meters?: Record<string, [number, number][]>; camerasOff?: string[] } = {}) {
  const end = Math.max(...turns.map((turn) => turn.end)) + 30_000;
  const self = options.self === undefined ? "p1" : options.self;
  const all = borders(turns, end);
  const ids = [...new Set(turns.map((turn) => turn.who))].filter((id) => id !== self);
  const people = Object.fromEntries(ids.map((id) => [id, {
    speaking: options.meters?.[id] ?? [], seen: [[0, end]],
    ...(options.camerasOff?.includes(id) || !all[id] ? {} : { active: all[id] }),
  }]));
  const timeline = { v: 1, app: "google-meet", mode: "rules", rules_version: 4, sample_ms: 200, self, people,
    self_speaking: [], ...(self !== null && all[self] ? { self_active: all[self] } : {}), hidden: [], breaks: [], truncated: false,
    order: ["p1", "p2", "p3"] };
  return { segments: turns.map(segmentOf).sort((a, b) => a.start - b.start), timeline };
}

const assign = (setup: { segments: Segment[]; timeline: unknown }, extra: Partial<Parameters<typeof assignCallSpeakers>[0]> = {}) =>
  assignCallSpeakers({ segments: setup.segments, engine: "whispercpp", timeline: setup.timeline, roster: ROSTER, ...extra });
const labels = (segments: readonly Segment[]) => segments.map((segment) => segment.speaker);
const ids = (segments: readonly Segment[]) => segments.map((segment) => segment.speakerId ?? null);

const TALK: Turn[] = [
  { who: "p2", start: 0, end: 8_000 },
  { who: "p1", start: 9_000, end: 12_000 },
  { who: "p3", start: 13_000, end: 20_000 },
  { who: "p2", start: 22_000, end: 26_000 },
];

describe("lines of people whose tiles show video", () => {
  test("each remote line gets the person whose border was on while it was said", () => {
    const result = assign(videoCall(TALK));
    expect(labels(result.segments)).toEqual(["Them 1", "Me", "Them 2", "Them 1"]);
    expect(ids(result.segments)).toEqual(["call:p2", null, "call:p3", "call:p2"]);
    expect(result.assigned).toBe(3);
  });

  test("the border that stays on through a long silence does not take the next speaker's line", () => {
    const result = assign(videoCall([{ who: "p2", start: 0, end: 5_000 }, { who: "p3", start: 40_000, end: 42_000 }]));
    expect(ids(result.segments)).toEqual(["call:p2", "call:p3"]);
  });

  test("a line too short to tell at a change of speaker stays Them", () => {
    const result = assign(videoCall([{ who: "p2", start: 0, end: 5_000 }, { who: "p3", start: 6_000, end: 6_600 }, { who: "p2", start: 9_000, end: 14_000 }]));
    expect(labels(result.segments)).toEqual(["Them 1", "Them", "Them 1"]);
  });

  test("the user's own tile takes no line when the window did not say who the user is", () => {
    const setup = videoCall(TALK, { self: null });
    const result = assign(setup, { roster: roster([{ id: "p1", name: "Robin Sample" }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }]) });
    expect(ids(result.segments)).toEqual(["call:p2", null, "call:p3", "call:p2"]);
  });

  test("with one camera off, the meter names that person and the border names the other", () => {
    // Alex (p2) has the camera off: a meter, no border. Dana (p3) shows video.
    const setup = videoCall(TALK, { camerasOff: ["p2"], meters: { p2: [[700, 8_700], [22_700, 26_700]] } });
    const result = assign(setup);
    expect(ids(result.segments)).toEqual(["call:p2", null, "call:p3", "call:p2"]);
  });

  test("nothing is named when no tile gave a signal", () => {
    const setup = videoCall(TALK, { camerasOff: ["p2", "p3"] });
    expect(labels(assign(setup).segments)).toEqual(["Them", "Me", "Them", "Them"]);
  });
});

describe("the timeline's border intervals", () => {
  test("a timeline from a reader before version 4 reads as before, with no border intervals", () => {
    const parsed = parseSpeakingTimeline({ v: 1, app: "google-meet", mode: "rules", rules_version: 3, sample_ms: 200, self: "p1",
      people: { p2: { speaking: [[0, 1000]], seen: [[0, 5000]] } }, self_speaking: [], hidden: [], breaks: [], truncated: false });
    expect(parsed?.people.get("p2")?.active).toEqual([]);
    expect(parsed?.selfActive).toEqual([]);
  });

  test("border intervals are read, and a malformed list refuses the timeline", () => {
    const base = { v: 1, app: "google-meet", mode: "rules", rules_version: 4, sample_ms: 200, self: "p1",
      self_speaking: [], self_active: [[100, 900]], hidden: [], breaks: [], truncated: false };
    const good = parseSpeakingTimeline({ ...base, people: { p2: { speaking: [], seen: [[0, 5000]], active: [[1000, 4000]] } } });
    expect(good?.people.get("p2")?.active).toEqual([[1000, 4000]]);
    expect(good?.selfActive).toEqual([[100, 900]]);
    expect(parseSpeakingTimeline({ ...base, people: { p2: { speaking: [], seen: [[0, 5000]], active: [[4000, 1000]] } } })).toBeNull();
  });
});
