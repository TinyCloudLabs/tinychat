// Speaker turns for a local (Exo) recording: pure functions from Whisper's
// per-word, per-channel output to the sentences saved to Meetings.
//
// A local recording is stereo. Channel 0 is the microphone ("You") and channel
// 1 is system audio ("Others", the remote side of a call); a real capture
// confirmed the order. Two things made the saved transcript hard to read:
//
//  1. Word-by-word interleaving. Both channels' words were sorted into one
//     stream and split on every channel change, so simultaneous speech
//     alternated a word at a time. Each channel is now segmented on its own,
//     segments are ordered by start time, and consecutive segments from the
//     same speaker merge into one turn.
//  2. Echo. Without headphones the mic also hears the speakers, so the remote
//     side's words appear on both channels. A mic phrase that substantially
//     repeats system-audio words from the same moment is dropped, and those
//     words stay attributed to Others. This is deliberately conservative (see
//     findMicEcho): when unsure, both copies are kept.
//
// Timing caveat: at the pinned anarlog rev, whisper-local transcribes each VAD
// chunk (3–25 s) as one segment and spreads its words evenly across it, so word
// times are only accurate to the chunk. Echo matching therefore aligns word
// order with a timing tolerance of about a second, and requires the recording
// to show a consistent echo lag before anything is dropped.

import type { FirefliesSentence } from "./connectors/firefliesClient";

/** Channel of the recorded stereo file that holds the microphone. */
export const MIC_CHANNEL = 0;
/** Channel of the recorded stereo file that holds system audio. */
export const SYSTEM_CHANNEL = 1;

/** A pause longer than this ends a segment within one channel. */
export const SEGMENT_GAP_SECONDS = 1.5;

/** Consecutive same-speaker segments merge only while the turn spans at most
 *  this long. Keeps each saved sentence well under meeting chat's 90 s excerpt
 *  span (CHUNK_MAX_SPAN_SECS), past which its timestamps are withheld. */
export const MAX_TURN_SECONDS = 60;

/** A pause longer than this ends a phrase for echo matching. */
export const ECHO_PHRASE_GAP_SECONDS = 0.5;

/** A phrase is also cut at this many words, bounding the alignment work when
 *  Whisper emits a long stretch without punctuation or pauses. */
export const ECHO_MAX_PHRASE_WORDS = 64;

/** Survey pass: a mic word and a system-audio word with the same text pair up
 *  only when their start times are within this many seconds. The pairs measure
 *  the recording's echo lag. Wide because word times are only chunk-accurate. */
export const ECHO_WINDOW_SECONDS = 3;

/** Acoustic echo is near-simultaneous: the recording's measured echo lag (mic
 *  minus system-audio start) must be within this many seconds of zero. */
export const ECHO_MAX_LAG_SECONDS = 1;

/** Confirm pass: every aligned word pair's lag must be within this many
 *  seconds of the recording's echo lag. */
export const ECHO_LAG_TOLERANCE_SECONDS = 1;

/** Confirm pass: the aligned mic words and the (lag-shifted) system-audio words
 *  they repeat must overlap in time by at least this share of the shorter
 *  span. A reply spoken after the other side finished does not overlap. */
export const ECHO_MIN_OVERLAP = 0.5;

/** Share of a mic phrase's words that must align, in order, with system-audio
 *  words for the phrase to count as echo. */
export const ECHO_MIN_MATCH_RATIO = 0.6;

/** Aligned words that must be content words (not function words or
 *  backchannels such as "yeah", "okay", "right") for a phrase to count as echo. */
export const ECHO_MIN_CONTENT_MATCHES = 2;

/** Echo is a property of the setup (speakers, not headphones), so it shows up
 *  across a recording. Mic phrases are dropped only when at least this many
 *  qualify as echo… */
export const ECHO_MIN_PHRASES = 2;

/** …and they are at least this share of the system-audio phrases that could
 *  have been echoed. */
export const ECHO_MIN_SHARE = 0.2;

/** A mic phrase with more system-audio words than this in its time window is
 *  not matched (both copies are kept). Real speech stays far below it; only
 *  collapsed or degenerate timestamps reach it, and they would make matching
 *  quadratic. */
export const ECHO_MAX_CANDIDATES = 320;

export interface LocalWord {
  text: string;
  start: number;
  end: number;
  channel: number | undefined;
}

/** "You" for the mic, "Others" for system audio, numbered for any other
 *  channel, and no speaker when the word carries no channel. */
export function localChannelLabel(channel: number | undefined): string | null {
  if (channel === undefined) return null;
  if (channel === MIC_CHANNEL) return "You";
  if (channel === SYSTEM_CHANNEL) return "Others";
  return `Speaker ${channel + 1}`;
}

/** Words that never count as evidence of echo on their own: both sides of a
 *  call say them all the time. Compared without apostrophes. */
const FUNCTION_WORDS = new Set(
  (
    "a an the and or but nor so if then than as to of in on at by for with from into onto over about up down out off "
    + "is are was were be been being am do does did done have has had having "
    + "i me my mine you your yours we us our ours they them their theirs he him his she her hers it its "
    + "this that these those there here what which who whom whose how when where why "
    + "im ive id ill youre youve youll weve theyre theyve thats theres whats "
    + "dont doesnt didnt cant wont isnt arent wasnt werent "
    + "can could would should will shall may might must get got go going gonna wanna let lets "
    + "not no yes yeah yep yup nope ok okay oh ah uh um hmm mm mhm huh "
    + "like just really very right sure well also too all "
    + "thanks thank exactly totally absolutely definitely great cool nice good fine alright perfect agreed"
  ).split(" "),
);

/** Lowercase letters and digits only: "Friday." → "friday", "It's" → "its". */
function normalizedToken(text: string): string {
  // toLowerCase, not toLocaleLowerCase: locale-independent, and far faster.
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Equality key: a trailing plural "s" is ignored, so "elephants" matches "elephant". */
function matchKey(token: string): string {
  return token.length >= 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

function isContentToken(token: string): boolean {
  return token !== "" && !FUNCTION_WORDS.has(token);
}

function contentWords(phrase: readonly LocalWord[]): number {
  return phrase.filter((w) => isContentToken(normalizedToken(w.text))).length;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;

/** One channel's words split into phrases at sentence-ending punctuation,
 *  pauses, and ECHO_MAX_PHRASE_WORDS. */
function phrasesOf(channelWords: readonly LocalWord[]): LocalWord[][] {
  const phrases: LocalWord[][] = [];
  let current: LocalWord[] = [];
  for (const word of channelWords) {
    const prev = current[current.length - 1];
    if (
      prev !== undefined
      && (SENTENCE_END.test(prev.text)
        || word.start - prev.end > ECHO_PHRASE_GAP_SECONDS
        || current.length >= ECHO_MAX_PHRASE_WORDS)
    ) {
      phrases.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) phrases.push(current);
  return phrases;
}

/** Longest order-preserving alignment of a[0..n) with b[0..m) under `match`, as index pairs. */
function align(n: number, m: number, match: (i: number, j: number) => boolean): [number, number][] {
  const cols = m + 1;
  // lengths[i * cols + j] = alignment length of a[i..] and b[j..].
  const lengths = new Uint16Array((n + 1) * cols);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * cols + j] = match(i, j)
        ? lengths[(i + 1) * cols + j + 1]! + 1
        : Math.max(lengths[(i + 1) * cols + j]!, lengths[i * cols + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    // Taking a match is always optimal: any alignment that pairs i or j
    // elsewhere can swap that pair for (i, j).
    if (match(i, j)) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (lengths[(i + 1) * cols + j]! >= lengths[i * cols + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** First index whose value is >= t (`after`: > t) in an ascending array. */
function searchSorted(values: readonly number[], t: number, after: boolean): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (after ? values[mid]! <= t : values[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface EchoMatch {
  phrase: LocalWord[];
  /** Median mic-minus-system start time over the aligned word pairs. */
  lag: number;
}

/**
 * Mic phrases that repeat system audio: at least two words, at least
 * ECHO_MIN_MATCH_RATIO of them aligned in order with unused system-audio words,
 * each pair's lag (mic start − system start) within `tolerance` of `lag`, and at
 * least ECHO_MIN_CONTENT_MATCHES aligned content words. With `requireOverlap`,
 * the aligned spans must also overlap once shifted by `lag`. Each system-audio
 * word explains at most one mic phrase.
 */
function matchEchoPhrases(
  phrases: readonly LocalWord[][],
  phraseTokens: readonly string[][],
  system: readonly LocalWord[],
  systemStarts: readonly number[],
  systemKeys: readonly string[],
  lag: number,
  tolerance: number,
  requireOverlap: boolean,
): EchoMatch[] {
  const used = new Array<boolean>(system.length).fill(false);
  const matches: EchoMatch[] = [];
  for (const [p, phrase] of phrases.entries()) {
    const tokens = phraseTokens[p]!;
    const scored = tokens.filter((t) => t !== "").length;
    if (scored < 2) continue;

    // Phrase words are sorted by start, so this covers every pairable word.
    const lo = searchSorted(systemStarts, phrase[0]!.start - lag - tolerance, false);
    const hi = searchSorted(systemStarts, phrase[phrase.length - 1]!.start - lag + tolerance, true);
    if (hi - lo > ECHO_MAX_CANDIDATES) continue;
    const candidates: number[] = [];
    for (let i = lo; i < hi; i++) {
      if (!used[i] && systemKeys[i] !== "") candidates.push(i);
    }
    if (candidates.length === 0) continue;

    const keys = tokens.map(matchKey);
    const pairs = align(phrase.length, candidates.length, (i, j) => {
      const other = candidates[j]!;
      return keys[i] !== ""
        && keys[i] === systemKeys[other]
        && Math.abs(phrase[i]!.start - system[other]!.start - lag) <= tolerance;
    });
    const contentMatches = pairs.filter(([t]) => isContentToken(tokens[t]!)).length;
    if (pairs.length / scored < ECHO_MIN_MATCH_RATIO || contentMatches < ECHO_MIN_CONTENT_MATCHES) continue;

    if (requireOverlap) {
      const [firstMic, firstSys] = pairs[0]!;
      const [lastMic, lastSys] = pairs[pairs.length - 1]!;
      const micStart = phrase[firstMic]!.start;
      const micEnd = phrase[lastMic]!.end;
      const sysStart = system[candidates[firstSys]!]!.start + lag;
      const sysEnd = system[candidates[lastSys]!]!.end + lag;
      const overlap = Math.min(micEnd, sysEnd) - Math.max(micStart, sysStart);
      if (!(overlap > 0 && overlap >= ECHO_MIN_OVERLAP * Math.min(micEnd - micStart, sysEnd - sysStart))) continue;
    }

    matches.push({
      phrase,
      lag: median(pairs.map(([t, c]) => phrase[t]!.start - system[candidates[c]!]!.start)),
    });
    for (const [, c] of pairs) used[candidates[c]!] = true;
  }
  return matches;
}

/**
 * The mic words that are echo of system audio, to be dropped. Genuine speech
 * must never be dropped, so a phrase is dropped only when all of this holds;
 * otherwise it is kept, even if that leaves both copies:
 *
 *  1. Survey: phrases pair with system-audio words of the same text starting
 *     within ECHO_WINDOW_SECONDS (see matchEchoPhrases). At least
 *     ECHO_MIN_PHRASES of them have a small lag (ECHO_MAX_LAG_SECONDS); their
 *     median is the recording's echo lag. No stable small lag, no echo.
 *  2. Confirm: each phrase re-aligns with every word pair within
 *     ECHO_LAG_TOLERANCE_SECONDS of that lag, and the aligned spans overlap in
 *     time (ECHO_MIN_OVERLAP). A reply that repeats the other side ("Friday at
 *     noon.") comes after it, so it does not overlap and is kept.
 *  3. Gate: at least ECHO_MIN_PHRASES phrases confirm, and at least
 *     ECHO_MIN_SHARE of the system-audio phrases that could be echoed.
 *
 * A lone word ("Friday.") is never dropped, and neither is a phrase whose time
 * window holds more than ECHO_MAX_CANDIDATES system-audio words. `words` must
 * be sorted by start time. Recordings without both channels have no echo.
 */
export function findMicEcho(words: readonly LocalWord[]): Set<LocalWord> {
  const echo = new Set<LocalWord>();
  const mic = words.filter((w) => w.channel === MIC_CHANNEL);
  const system = words.filter((w) => w.channel === SYSTEM_CHANNEL);
  if (mic.length === 0 || system.length === 0) return echo;

  const phrases = phrasesOf(mic);
  const phraseTokens = phrases.map((phrase) => phrase.map((w) => normalizedToken(w.text)));
  const systemStarts = system.map((w) => w.start);
  const systemKeys = system.map((w) => matchKey(normalizedToken(w.text)));

  const surveyed = matchEchoPhrases(phrases, phraseTokens, system, systemStarts, systemKeys, 0, ECHO_WINDOW_SECONDS, false);
  const smallLags = surveyed.map((m) => m.lag).filter((l) => Math.abs(l) <= ECHO_MAX_LAG_SECONDS);
  if (smallLags.length < ECHO_MIN_PHRASES) return echo;
  const lag = median(smallLags);

  const confirmed = matchEchoPhrases(
    phrases, phraseTokens, system, systemStarts, systemKeys, lag, ECHO_LAG_TOLERANCE_SECONDS, true,
  );
  const echoable = phrasesOf(system).filter((phrase) => contentWords(phrase) >= ECHO_MIN_CONTENT_MATCHES).length;
  if (confirmed.length < ECHO_MIN_PHRASES || confirmed.length < ECHO_MIN_SHARE * echoable) return echo;
  for (const { phrase } of confirmed) for (const w of phrase) echo.add(w);
  return echo;
}

interface Turn {
  channel: number | undefined;
  words: LocalWord[];
  start: number;
  end: number;
}

/**
 * Readable speaker turns from a recording's words (sorted by start time):
 * mic echo dropped, each channel segmented on its own pauses, segments ordered
 * by start time, and consecutive same-speaker segments merged. No turn spans
 * more than MAX_TURN_SECONDS unless a single word does.
 */
export function localTranscriptTurns(words: readonly LocalWord[]): FirefliesSentence[] {
  const echo = findMicEcho(words);

  // Segments are created in order of their first word, i.e. by start time.
  const segments: Turn[] = [];
  const open = new Map<number | undefined, Turn>();
  for (const w of words) {
    if (echo.has(w)) {
      // A dropped echo phrase ends the segment, so the kept text on either
      // side of it is not joined across the Others turn it belongs to.
      open.delete(w.channel);
      continue;
    }
    const segment = open.get(w.channel);
    // Continuous speech is also split, at a word boundary, before a segment
    // would span more than MAX_TURN_SECONDS.
    if (
      segment !== undefined
      && w.start - segment.end <= SEGMENT_GAP_SECONDS
      && Math.max(segment.end, w.end) - segment.start <= MAX_TURN_SECONDS
    ) {
      segment.words.push(w);
      segment.end = Math.max(segment.end, w.end);
      continue;
    }
    const next: Turn = { channel: w.channel, words: [w], start: w.start, end: w.end };
    segments.push(next);
    open.set(w.channel, next);
  }

  const turns: Turn[] = [];
  for (const segment of segments) {
    const last = turns[turns.length - 1];
    if (
      last !== undefined
      && last.channel === segment.channel
      && Math.max(last.end, segment.end) - last.start <= MAX_TURN_SECONDS
    ) {
      last.words.push(...segment.words);
      last.end = Math.max(last.end, segment.end);
      continue;
    }
    turns.push(segment);
  }

  return turns.map((turn, index) => ({
    index,
    speaker_name: localChannelLabel(turn.channel),
    text: turn.words.map((w) => w.text).join(" "),
    start_time: turn.start,
    end_time: turn.end,
  }));
}
