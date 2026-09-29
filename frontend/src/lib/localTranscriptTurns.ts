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
// times are only accurate to the chunk. Echo matching therefore compares word
// order within a window of seconds rather than per-word timestamps.

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

/** System-audio words starting within this many seconds of a mic phrase can
 *  explain it as echo. Wide because word times are only chunk-accurate. */
export const ECHO_WINDOW_SECONDS = 3;

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
 *  have been echoed. On a headphone call the mic hears no echo, so a user's
 *  occasional verbatim confirmation ("Friday at noon.") stays below it. */
export const ECHO_MIN_SHARE = 0.2;

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
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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

/** Longest order-preserving alignment of equal, non-empty keys, as index pairs. */
function alignKeys(a: readonly string[], b: readonly string[]): [number, number][] {
  const cols = b.length + 1;
  // lengths[i * cols + j] = LCS length of a[i..] and b[j..].
  const lengths = new Uint16Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * cols + j] = a[i] !== "" && a[i] === b[j]
        ? lengths[(i + 1) * cols + j + 1]! + 1
        : Math.max(lengths[(i + 1) * cols + j]!, lengths[i * cols + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] !== "" && a[i] === b[j]) {
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

/**
 * The mic words that are echo of system audio, to be dropped.
 *
 * A mic phrase (split at sentence punctuation and pauses) is echo only when
 * all of these hold, and otherwise it is kept, even if that leaves both copies:
 *  - it has at least two words;
 *  - at least ECHO_MIN_MATCH_RATIO of its words align, in order, with unused
 *    system-audio words starting within ECHO_WINDOW_SECONDS of it;
 *  - at least ECHO_MIN_CONTENT_MATCHES of the aligned words are content words.
 * System-audio words explain at most one mic phrase, so a user repeating what
 * the other side just said, after its echo was matched, is kept. A lone word
 * ("Friday.") is never dropped: it can be a genuine reply. And nothing is
 * dropped unless the recording shows echo throughout (ECHO_MIN_PHRASES,
 * ECHO_MIN_SHARE), which keeps verbatim confirmations on headphone calls.
 *
 * `words` must be sorted by start time. Recordings without both channels have
 * no echo.
 */
export function findMicEcho(words: readonly LocalWord[]): Set<LocalWord> {
  const echo = new Set<LocalWord>();
  const mic = words.filter((w) => w.channel === MIC_CHANNEL);
  const system = words.filter((w) => w.channel === SYSTEM_CHANNEL);
  if (mic.length === 0 || system.length === 0) return echo;

  const systemKeys = system.map((w) => matchKey(normalizedToken(w.text)));
  const used = new Array<boolean>(system.length).fill(false);
  // Phrase starts never decrease, so the window's lower edge only moves forward.
  let lower = 0;

  const echoPhrases: LocalWord[][] = [];
  for (const phrase of phrasesOf(mic)) {
    const tokens = phrase.map((w) => normalizedToken(w.text));
    const scored = tokens.filter((t) => t !== "").length;
    if (scored < 2) continue;

    const from = phrase[0]!.start - ECHO_WINDOW_SECONDS;
    const to = phrase[phrase.length - 1]!.end + ECHO_WINDOW_SECONDS;
    while (lower < system.length && system[lower]!.start < from) lower++;
    const candidates: number[] = [];
    for (let i = lower; i < system.length && system[i]!.start <= to; i++) {
      if (!used[i] && systemKeys[i] !== "") candidates.push(i);
    }
    if (candidates.length === 0) continue;

    const pairs = alignKeys(
      tokens.map(matchKey),
      candidates.map((i) => systemKeys[i]!),
    );
    const contentMatches = pairs.filter(([t]) => isContentToken(tokens[t]!)).length;
    if (pairs.length / scored < ECHO_MIN_MATCH_RATIO || contentMatches < ECHO_MIN_CONTENT_MATCHES) continue;

    echoPhrases.push(phrase);
    for (const [, c] of pairs) used[candidates[c]!] = true;
  }

  const echoable = phrasesOf(system).filter((phrase) => contentWords(phrase) >= ECHO_MIN_CONTENT_MATCHES).length;
  if (echoPhrases.length < ECHO_MIN_PHRASES || echoPhrases.length < ECHO_MIN_SHARE * echoable) return echo;
  for (const phrase of echoPhrases) for (const w of phrase) echo.add(w);
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
 * by start time, and consecutive same-speaker segments merged up to
 * MAX_TURN_SECONDS.
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
    if (segment !== undefined && w.start - segment.end <= SEGMENT_GAP_SECONDS) {
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
