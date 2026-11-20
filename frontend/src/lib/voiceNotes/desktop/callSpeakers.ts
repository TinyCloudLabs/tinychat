// Who spoke when (Whisper route only). While a Mac recording of a Google Meet call runs, the desktop app samples which
// tile of the meeting window shows its "speaking" marker and keeps a timeline of it (`call_names_speaking_read`):
// per person id, when their marker was on and when it could be read. This module gives each remote line of the local
// transcript the person whose marker was on while it was said, by the rules below, and leaves "Them" wherever the
// rules do not hold. Pure: no I/O, no clock. The timeline and the roster hold ids only; no name passes through here.
//
// What a line gets: `speaker: "Them N"`, `speakerId: "call:<person id>"`, `channel: 1`, where N is the person's place
// among the call's people other than the user (`CallRoster.others`), so a new transcript of the same recording gets
// the same labels. Lines on the user's side (channel 0) are never touched.
import type { CallRoster } from "@/capture/library/callParticipants";
import type { LocalTranscript } from "../nativeVoiceNotes";

type Segment = LocalTranscript["segments"][number];
/** `[startMs, endMs]` on the recorder's clock, start before end. */
type Interval = readonly [number, number];
/** Sorted, not overlapping. */
type Intervals = readonly Interval[];

export interface SpeakingPerson {
  /** When the person's speaking marker was on. */
  speaking: Intervals;
  /** When the person's marker could be read. */
  seen: Intervals;
}

/** The timeline as `call_names_speaking_read` returns it, checked (`parseSpeakingTimeline`). */
export interface SpeakingTimeline {
  v: 1;
  app: string;
  /** "learned": the marker's classes were learned from the call itself, not read from the built-in rules. */
  mode: "rules" | "learned";
  rulesVersion: number;
  sampleMs: number;
  /** The user's person id, when the meeting window showed it. Never a key of `people`. */
  self: string | null;
  people: ReadonlyMap<string, SpeakingPerson>;
  selfSpeaking: Intervals;
  /** When the meeting window could not be seen (minimised, or no longer the meeting). */
  hidden: Intervals;
  /** The recorded time of each resume after a pause: where each recording segment starts. */
  breaks: readonly number[];
  /** More intervals were seen than kept: nothing is known after the last one kept. */
  truncated: boolean;
  /**
   * Every roster person id seen in the recording, in the roster's order, the user's included; null when the timeline
   * has none or it is not in the agreed shape. "Them N" is numbered by it when present.
   */
  order: readonly string[] | null;
}

/** The thresholds of plan section 4. Times are milliseconds. */
export const CALL_SPEAKER_RULES = Object.freeze({
  /** How far the marker lags behind the audio before the search; the Mac check measures it. */
  defaultDelayMs: 700,
  /** The search tries delays within this much of the default, per recording segment... */
  delaySearchMs: 1_000,
  /** ...in steps of this much. */
  delayStepMs: 50,
  /** The audio check runs per window of this length. */
  windowMs: 10 * 60_000,
  /** In a window, at least this share of the marker's "on" time is inside remote speech... */
  markerInSpeech: 0.6,
  /** ...and at least this share of the remote speech the marker could see has a marker on. */
  speechWithMarker: 0.4,
  /** Remote speech with no marker for this long inside a "seen" span means the marker could not see it. */
  blindMs: 10_000,
  /** Remote lines closer than this count as one stretch of speech for `blindMs`. */
  blindBridgeMs: 2_000,
  /** A line gets a person only if at least this share of it was seen (and none of it hidden)... */
  lineSeen: 0.6,
  /** ...the best person's marker covers at least this share of the line... */
  lineOverlap: 0.3,
  /** ...and at least this long... */
  lineOverlapMinMs: 400,
  /** ...and the second best covers at most this share of what the best covers. */
  secondBest: 0.5,
  /** A person whose marker is on mostly (more than this share) while the user speaks is the user. */
  selfShare: 0.5,
});

/** Person ids as the roster gives them: short, no spaces. Anything else means the timeline is not ours. */
const PERSON_ID = /^[A-Za-z0-9_-]{1,32}$/;
const APPS: ReadonlySet<string> = new Set(["google-meet", "zoom"]);
/** A day: no recording is longer (the recorder stops at eight hours). */
const MAX_TIME_MS = 24 * 60 * 60_000;
const MAX_PEOPLE = 200;
/** Every list together; the native timeline keeps at most 20,000 speaking intervals. */
const MAX_INTERVALS = 50_000;
const MAX_BREAKS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME_MS;

/** A sorted, non-overlapping list of `[start, end]` pairs, start before end, or null. Counts into `budget`. */
function parseIntervals(value: unknown, budget: { left: number }): Intervals | null {
  if (!Array.isArray(value)) return null;
  budget.left -= value.length;
  if (budget.left < 0) return null;
  const intervals: Interval[] = [];
  let previousEnd = 0;
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [start, end] = entry as unknown[];
    if (!isTime(start) || !isTime(end) || start >= end || start < previousEnd) return null;
    intervals.push([start, end]);
    previousEnd = end;
  }
  return intervals;
}

/** The timeline's `order`: unique person ids, at most one per person; null when absent or not in that shape. */
function parseOrder(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) return null;
  const ids = new Set<string>();
  for (const id of value as unknown[]) {
    if (typeof id !== "string" || !PERSON_ID.test(id) || ids.has(id)) return null;
    ids.add(id);
  }
  return [...ids];
}

/**
 * `value` as a speaking timeline, or null when anything in it is not the agreed shape: a wrong version, app or mode, a
 * person id that is not an id, the user among `people`, an interval out of order or overlapping the one before, a
 * break out of order, or more than the timeline can hold. Nothing is dropped and kept: one bad part refuses it all,
 * since a missing person could hand their lines to someone else.
 */
export function parseSpeakingTimeline(value: unknown): SpeakingTimeline | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.app !== "string" || !APPS.has(value.app)) return null;
  if (value.mode !== "rules" && value.mode !== "learned") return null;
  const rulesVersion = value.rules_version;
  const sampleMs = value.sample_ms;
  if (typeof rulesVersion !== "number" || !Number.isSafeInteger(rulesVersion) || rulesVersion < 0) return null;
  if (typeof sampleMs !== "number" || !Number.isSafeInteger(sampleMs) || sampleMs < 1 || sampleMs > 10_000) return null;
  const self = value.self;
  if (self !== null && (typeof self !== "string" || !PERSON_ID.test(self))) return null;
  if (typeof value.truncated !== "boolean" || !isRecord(value.people)) return null;
  const budget = { left: MAX_INTERVALS };
  const entries = Object.entries(value.people);
  if (entries.length > MAX_PEOPLE) return null;
  const people = new Map<string, SpeakingPerson>();
  for (const [id, entry] of entries) {
    if (!PERSON_ID.test(id) || id === self || !isRecord(entry)) return null;
    const speaking = parseIntervals(entry.speaking, budget);
    const seen = parseIntervals(entry.seen, budget);
    if (speaking === null || seen === null) return null;
    people.set(id, { speaking, seen });
  }
  const selfSpeaking = parseIntervals(value.self_speaking, budget);
  const hidden = parseIntervals(value.hidden, budget);
  if (selfSpeaking === null || hidden === null) return null;
  const breaks = value.breaks;
  if (!Array.isArray(breaks) || breaks.length > MAX_BREAKS) return null;
  let previous = -1;
  for (const at of breaks as unknown[]) {
    if (!isTime(at) || at <= previous) return null;
    previous = at;
  }
  // An `order` not in the agreed shape does not refuse the timeline: the people are then numbered as the roster has them.
  return { v: 1, app: value.app, mode: value.mode, rulesVersion, sampleMs, self, people, selfSpeaking, hidden,
    breaks: breaks as number[], truncated: value.truncated, order: parseOrder(value.order) };
}

// ── Interval arithmetic (sorted, non-overlapping lists) ─────────────────────────────────────────────────────────

const total = (list: Intervals): number => list.reduce((sum, [start, end]) => sum + end - start, 0);

/** Sorted, merged; intervals closer than `bridge` become one. */
function merge(list: readonly Interval[], bridge = 0): Interval[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1] + bridge) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const union = (lists: readonly Intervals[]): Interval[] => merge(lists.flat());

/** How long `a` and `b` overlap. */
function overlap(a: Intervals, b: Intervals): number {
  let sum = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const start = Math.max(a[i]![0], b[j]![0]);
    const end = Math.min(a[i]![1], b[j]![1]);
    if (end > start) sum += end - start;
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return sum;
}

/** How long `list` overlaps `[start, end]`. */
function overlapWith(list: Intervals, start: number, end: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (list[middle]![1] <= start) low = middle + 1;
    else high = middle;
  }
  let sum = 0;
  for (let i = low; i < list.length && list[i]![0] < end; i++) sum += Math.min(end, list[i]![1]) - Math.max(start, list[i]![0]);
  return sum;
}

/** What `a` and `b` both cover. */
function intersect(a: Intervals, b: Intervals): Interval[] {
  const result: Interval[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const start = Math.max(a[i]![0], b[j]![0]);
    const end = Math.min(a[i]![1], b[j]![1]);
    if (end > start) result.push([start, end]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return result;
}

/** `list` without what `cut` covers. */
function subtract(list: Intervals, cut: Intervals): Interval[] {
  const result: Interval[] = [];
  let j = 0;
  for (const [start, end] of list) {
    let from = start;
    while (j < cut.length && cut[j]![1] <= from) j++;
    for (let k = j; k < cut.length && cut[k]![0] < end; k++) {
      if (cut[k]![0] > from) result.push([from, cut[k]![0]]);
      from = Math.max(from, cut[k]![1]);
      if (from >= end) break;
    }
    if (from < end) result.push([from, end]);
  }
  return result;
}

/** The part of `list` inside `[from, to)`, moved `delay` earlier (marker time to audio time), kept inside `[from, to)`. */
function shiftWithin(list: Intervals, from: number, to: number, delay: number): Interval[] {
  const result: Interval[] = [];
  for (const [start, end] of list) {
    if (end <= from || start >= to) continue;
    const shiftedStart = Math.max(from, Math.max(start, from) - delay);
    const shiftedEnd = Math.min(to, Math.min(end, to) - delay);
    if (shiftedEnd > shiftedStart) result.push([shiftedStart, shiftedEnd]);
  }
  return result;
}

// ── Assignment ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface CallSpeakersResult {
  segments: LocalTranscript["segments"];
  /** How many lines got a person. */
  assigned: number;
  /** The delay used in each recording segment (empty when nothing was tried). */
  delaysMs: number[];
}

/** A remote line the rules may name: channel 1, still "Them", with the engine's own times. */
const remoteLine = (segment: Segment) => segment.channel === 1 && segment.speaker === "Them" && segment.timing === "engine"
  && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start;
const ownLine = (segment: Segment) => segment.channel === 0 && segment.timing === "engine"
  && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start;

/** Whether `assignCallSpeakers` could name any of these lines: the Whisper route, with remote lines it has times for. */
export function mayNameCallSpeakers(segments: LocalTranscript["segments"], engine: LocalTranscript["engine"]): boolean {
  return engine === "whispercpp" && segments.some(remoteLine);
}

/** The delay where `remote` (marker time) best covers `lines` (audio time), within `[from, to)`. */
function bestDelay(remote: Intervals, lines: Intervals, from: number, to: number, rules: typeof CALL_SPEAKER_RULES, base: number): number {
  let best = base;
  let bestScore = 0;
  const steps = Math.floor(rules.delaySearchMs / rules.delayStepMs);
  const markers = remote.filter(([start, end]) => end > from && start < to);
  const inRange = intersect(lines, [[from, to]]);
  if (markers.length === 0 || inRange.length === 0) return base;
  for (let step = -steps; step <= steps; step++) {
    const delay = base + step * rules.delayStepMs;
    const score = overlap(shiftWithin(markers, from, to, delay), inRange);
    // Ties keep the delay nearest the default.
    if (score > bestScore || (score === bestScore && score > 0 && Math.abs(delay - base) < Math.abs(best - base))) {
      best = delay;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The transcript's segments with each remote line given the person who said it, where the rules hold (plan section
 * 4): the delay is searched per recording segment; a 10-minute window whose marker and audio disagree names nobody;
 * a line is named only if it was seen, nothing of it was hidden, and one person's marker clearly covers it. Lines are
 * never split. Nothing is named on the Parakeet route (its times are made up), when the timeline is missing or not in
 * the agreed shape, or when the call has fewer than two people besides the user (by the timeline's `order`, else the
 * roster).
 */
export function assignCallSpeakers(input: {
  segments: LocalTranscript["segments"];
  engine: LocalTranscript["engine"];
  /** What `call_names_speaking_read` returned: checked here. */
  timeline: unknown;
  roster: CallRoster | null;
  rules?: typeof CALL_SPEAKER_RULES;
}): CallSpeakersResult {
  const rules = input.rules ?? CALL_SPEAKER_RULES;
  const unchanged: CallSpeakersResult = { segments: input.segments, assigned: 0, delaysMs: [] };
  if (input.engine !== "whispercpp") return unchanged;
  const timeline = parseSpeakingTimeline(input.timeline);
  if (timeline === null || timeline.people.size === 0) return unchanged;
  const userIds = new Set([...input.roster?.self ?? [], ...(timeline.self === null ? [] : [timeline.self])]);
  // The numbering: the timeline's own order of the roster's ids when it has one, else the roster's (the names file, or
  // the ids kept on this Mac). Either way, the user does not take a number.
  const others = timeline.order !== null ? timeline.order.filter((id) => !userIds.has(id)) : input.roster?.others ?? null;
  if (others === null || new Set(others).size < 2) return unchanged;
  const remoteIndexes = input.segments.flatMap((segment, index) => remoteLine(segment) ? [index] : []);
  if (remoteIndexes.length === 0) return unchanged;

  const rank = new Map(others.map((id, index) => [id, index + 1]));
  const themLines = merge(remoteIndexes.map((index) => [input.segments[index]!.start, input.segments[index]!.end] as const));
  const meLines = merge(input.segments.filter(ownLine).map((segment) => [segment.start, segment.end] as const));
  const bounds = [0, ...timeline.breaks.filter((at) => at > 0), Number.MAX_SAFE_INTEGER];

  // Per recording segment, the delay where the remote markers best cover the remote lines; then every list in audio time.
  const shifted = (people: readonly string[]) => {
    const remoteMarkers = union(people.map((id) => timeline.people.get(id)!.speaking));
    const delays = bounds.slice(0, -1).map((from, k) => {
      const to = bounds[k + 1]!;
      return bestDelay(remoteMarkers, themLines, from, to, rules, rules.defaultDelayMs);
    });
    const inAudio = (list: Intervals) => delays.flatMap((delay, k) => shiftWithin(list, bounds[k]!, bounds[k + 1]!, delay));
    return { delays, inAudio };
  };
  let candidates = [...timeline.people.keys()].filter((id) => !userIds.has(id));
  let audio = shifted(candidates);
  // A person whose marker is on mostly while the user speaks is the user's own tile, not someone on the other side.
  const user = candidates.filter((id) => {
    const speaking = audio.inAudio(timeline.people.get(id)!.speaking);
    const length = total(speaking);
    return length > 0 && overlap(speaking, meLines) > rules.selfShare * length;
  });
  if (user.length > 0) {
    candidates = candidates.filter((id) => !user.includes(id));
    audio = shifted(candidates);
  }
  if (!candidates.some((id) => rank.has(id))) return { ...unchanged, delaysMs: audio.delays };

  const speaking = new Map(candidates.map((id) => [id, audio.inAudio(timeline.people.get(id)!.speaking)]));
  const markerOn = union([...speaking.values()]);
  const hidden = audio.inAudio(timeline.hidden);
  // Remote speech with no marker for 10 s or more was not seen, whatever the "seen" spans say.
  const blind = subtract(merge(themLines, rules.blindBridgeMs), markerOn).filter(([start, end]) => end - start >= rules.blindMs);
  const seen = subtract(subtract(union(candidates.map((id) => audio.inAudio(timeline.people.get(id)!.seen))), hidden), blind);
  // Nothing is known after the last interval a truncated timeline kept.
  let horizon = Number.POSITIVE_INFINITY;
  if (timeline.truncated) {
    horizon = timeline.selfSpeaking.at(-1)?.[1] ?? 0;
    for (const person of timeline.people.values()) horizon = Math.max(horizon, person.speaking.at(-1)?.[1] ?? 0);
  }

  // The audio check: within `range` the markers are on while the other side speaks, and on for enough of what they
  // could see. Each person's "on" time counts on its own, so markers on together (as markers that show who is quiet
  // would be) count against the check, not for it.
  const checkPasses = (range: Intervals): boolean => {
    const speech = intersect(themLines, range);
    let onTime = 0;
    let onInSpeech = 0;
    for (const list of speaking.values()) {
      const on = intersect(list, range);
      onTime += total(on);
      onInSpeech += overlap(on, speech);
    }
    const seenSpeech = intersect(speech, seen);
    const seenTime = total(seenSpeech);
    return onTime > 0 && seenTime > 0 && onInSpeech >= rules.markerInSpeech * onTime
      && overlap(seenSpeech, markerOn) >= rules.speechWithMarker * seenTime;
  };
  const windows = new Map<number, boolean>();
  const windowPasses = (index: number): boolean => {
    let passes = windows.get(index);
    if (passes === undefined) {
      passes = checkPasses([[index * rules.windowMs, (index + 1) * rules.windowMs]]);
      windows.set(index, passes);
    }
    return passes;
  };
  // A timeline whose marker classes were learned from the call is trusted only if the whole call passes the check too.
  if (timeline.mode === "learned" && !checkPasses([[0, Number.MAX_SAFE_INTEGER]])) return { ...unchanged, delaysMs: audio.delays };

  let assigned = 0;
  const segments = input.segments.map((segment) => {
    if (!remoteLine(segment) || segment.end > horizon) return segment;
    const { start, end } = segment;
    const length = end - start;
    for (let index = Math.floor(start / rules.windowMs); index * rules.windowMs < end; index++) {
      if (!windowPasses(index)) return segment;
    }
    if (overlapWith(seen, start, end) < rules.lineSeen * length || overlapWith(hidden, start, end) > 0) return segment;
    let best: { id: string; time: number } | null = null;
    let second = 0;
    for (const [id, list] of speaking) {
      const time = overlapWith(list, start, end);
      if (best === null || time > best.time) {
        second = best?.time ?? 0;
        best = { id, time };
      } else if (time > second) second = time;
    }
    const n = best === null ? undefined : rank.get(best.id);
    if (best === null || n === undefined || best.time < Math.max(rules.lineOverlap * length, rules.lineOverlapMinMs)
      || second > rules.secondBest * best.time) return segment;
    assigned++;
    return { ...segment, speaker: `Them ${n}`, speakerId: `call:${best.id}`, channel: 1 as const };
  });
  return { segments: assigned === 0 ? input.segments : segments, assigned, delaysMs: audio.delays };
}
