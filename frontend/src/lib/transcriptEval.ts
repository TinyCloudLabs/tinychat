import type { FirefliesSentence } from "./connectors/firefliesClient";
import { isLocalContentWord } from "./localTranscriptTurns";

/** expected.json v1. Times are seconds; sentenceEnds are exclusive word indices. */
export interface EvalExpected {
  version: 1;
  split: string;
  kind: "speech" | "noise";
  turns: {
    id: string; speaker: string; start: number; end: number; text: string;
    sentenceEnds: number[]; tags: string[];
    words: { w: string; start: number; end: number; tag?: string }[];
  }[];
  landmarks?: { kind: "tone" | "word"; w?: string; segment: number; source_offset_s: number }[];
  vocabularyVersion: number;
}
export interface EvalWordLineage {
  text: string;
  start: number;
  end: number;
  channel: number | undefined;
  timing: "token" | "fallback" | "none";
}
export type EvalSentence = FirefliesSentence & { words?: readonly EvalWordLineage[] };
export interface EvalPlayback {
  /** One measurement per landmark and browser engine; these are measured onsets, not inferred offsets. */
  landmarks: readonly {
    engine: string; kind: "tone" | "word"; segment: number; source_offset_s: number;
    stereoOnset: number; monoOnset: number;
    /** Saved word onset, when token timing is available (B2). */
    savedStart?: number;
    /** Index of the sentence containing the landmark word. */
    sentenceIndex?: number;
  }[];
}
export interface EvalRuntime {
  maxSseGapSeconds: number;
  realTimeFactor: number;
  peakMemoryBytes: number;
}
export interface EvalInput {
  expected: EvalExpected;
  sentences: readonly EvalSentence[];
  noteDurationSeconds: number;
  /** Words found only in the glossary, without a corresponding reference token. */
  glossaryTerms?: readonly string[];
  runtime?: EvalRuntime;
  playback?: EvalPlayback;
  productionInputHash?: string;
}
export interface SpeakerScore {
  reference: number; output: number; substitutions: number; deletions: number; insertions: number;
  correct: number; /** Null when this speaker has no reference words; G3 counts insertions. */
  wer: number | null; deletionRate: number; attributedRecall: number;
}
export interface EvalScore {
  speakers: Record<string, SpeakerScore>;
  referenceWords: number;
  outputWords: number;
  /** Null when there are no reference words; G3/G13 cover insertions. */
  pooledWer: number | null;
  attributedRecall: number;
  misattributionRate: number;
  bleedRate: number;
  /** Numerator and denominator retained so the tagged gate uses a count, not rounded rates. */
  tagged: Record<string, { total: number; lost: number }>;
  turnCount: number;
  turnCovered: number;
  kendallTau: number;
  referenceSentences: number;
  unexplainedSplits: number;
  mergedTurns: number;
  noiseInsertions: number;
  glossaryFalsePositives: number;
  vocabularyTotal: number;
  vocabularyFound: number;
  timingP90StartError: number | null;
  fallbackTimedShare: number;
  sentenceSpanValid: boolean;
  runtime?: EvalRuntime;
  playback?: { maxToneGap: number | null; speechContained: boolean; maxWordStartError: number | null; complete: boolean };
  productionInputHash?: string;
}

interface Token { text: string; key: string; start: number | null; end: number | null; speaker: string; sentence: number; timing: EvalWordLineage["timing"]; tags?: readonly string[]; turn?: number }
const key = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
const tokens = (s: string) => s.split(/\s+/u).map(key).filter(Boolean);
const rate = (n: number, d: number) => d ? n / d : 0;
const crossSpeakerWindow = (a: Token, b: Token) => a.start !== null && b.start !== null && Math.abs(a.start - b.start) <= 15;
/** A glossary term is an entire contiguous phrase within one turn/sentence. */
function glossaryOccurrences(words: readonly Token[], terms: readonly string[][], group: "turn" | "sentence"): Token[][] {
  const found: Token[][] = [];
  for (const term of terms) {
    for (let i = 0; i <= words.length - term.length; i++) {
      let matches = true;
      for (let j = 0; j < term.length; j++) {
        if (words[i + j].key !== term[j] || words[i + j][group] !== words[i][group]) {
          matches = false;
          break;
        }
      }
      if (matches) found.push(words.slice(i, i + term.length));
    }
  }
  return found;
}

/** Minimum edit distance, retaining operation counts. Tie-break substitutions before deletions. */
function align(ref: readonly Token[], out: readonly Token[]) {
  const width = out.length + 1;
  const directions = new Uint8Array((ref.length + 1) * width);
  let previous = new Uint32Array(width);
  let current = new Uint32Array(width);
  for (let j = 0; j < width; j++) previous[j] = j;
  for (let i = 1; i <= ref.length; i++) {
    current[0] = i;
    for (let j = 1; j < width; j++) {
      const diagonal = previous[j - 1] + Number(ref[i - 1].key !== out[j - 1].key);
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      const at = i * width + j;
      if (diagonal <= deletion && diagonal <= insertion) {
        current[j] = diagonal;
        directions[at] = 0;
      } else if (deletion <= insertion) {
        current[j] = deletion;
        directions[at] = 1;
      } else {
        current[j] = insertion;
        directions[at] = 2;
      }
    }
    [previous, current] = [current, previous];
  }
  const pairs: [number, number][] = [];
  let sub = 0, del = 0, ins = 0, i = ref.length, j = out.length;
  while (i || j) {
    const direction = !i ? 2 : !j ? 1 : directions[i * width + j];
    if (direction === 0) {
      if (ref[i - 1].key === out[j - 1].key) pairs.push([i - 1, j - 1]);
      else sub++;
      i--; j--;
    } else if (direction === 1) { del++; i--; }
    else { ins++; j--; }
  }
  pairs.reverse();
  return { cost: previous[out.length], sub, del, ins, pairs };
}

export function scoreTranscript(input: EvalInput): EvalScore {
  const { expected, sentences } = input;
  if (expected.version !== 1) throw new Error("Unsupported expected.json version");
  const reference: Token[] = [];
  const referenceTurnEnds: number[] = [];
  for (const [turnIndex, turn] of expected.turns.entries()) {
    for (const word of turn.words) {
      const normalized = key(word.w);
      if (!normalized) continue;
      reference.push({ text: word.w, key: normalized, start: word.start, end: word.end, speaker: turn.speaker,
        sentence: -1, timing: "token", tags: [...new Set([...turn.tags, ...(word.tag ? [word.tag] : [])])], turn: turnIndex });
    }
    referenceTurnEnds.push(reference.length);
  }
  const output: Token[] = sentences.flatMap((sentence, sentenceIndex) => {
    const parts = sentence.text.split(/\s+/u).filter(Boolean);
    const lineage = sentence.words;
    if (lineage !== undefined && (lineage.length !== parts.length ||
      lineage.some((word, index) => key(word.text) !== key(parts[index]))))
      throw new Error(`Sentence ${sentenceIndex} source words do not match saved text`);
    return parts.map((text, index) => {
      const word = lineage?.[index];
      return { text, key: key(text), start: word && word.timing !== "none" ? word.start : null,
        end: word && word.timing !== "none" ? word.end : null, speaker: sentence.speaker_name ?? "You",
        sentence: sentenceIndex, timing: word?.timing ?? "none" };
    }).filter(word => word.key);
  });
  const speakers: Record<string, SpeakerScore> = {};
  const matchedRef = new Set<Token>();
  const matchedOut = new Set<Token>();
  const matchedByTurn = new Map<number, Token[]>();
  const alignedOutByRef = new Map<Token, Token>();
  for (const speaker of new Set([...reference.map(t => t.speaker), ...output.map(t => t.speaker)])) {
    const ref = reference.filter(t => t.speaker === speaker);
    const out = output.filter(t => t.speaker === speaker);
    const edit = align(ref, out);
    for (const [ri, oi] of edit.pairs) {
      const referenceWord = ref[ri], outputWord = out[oi];
      matchedRef.add(referenceWord); matchedOut.add(outputWord);
      alignedOutByRef.set(referenceWord, outputWord);
      const turn = referenceWord.turn!;
      const matches = matchedByTurn.get(turn);
      if (matches) matches.push(outputWord); else matchedByTurn.set(turn, [outputWord]);
    }
    speakers[speaker] = { reference: ref.length, output: out.length, substitutions: edit.sub,
      deletions: edit.del, insertions: edit.ins, correct: edit.pairs.length,
      wer: ref.length ? edit.cost / ref.length : null,
      deletionRate: rate(edit.del, ref.length), attributedRecall: rate(edit.pairs.length, ref.length) };
  }
  const crossRef = reference.filter(t => !matchedRef.has(t));
  const crossOut = output.filter(t => !matchedOut.has(t));
  let misattributed = 0;
  for (const word of crossOut) {
    const i = crossRef.findIndex(t => t.speaker !== word.speaker && t.key === word.key && crossSpeakerWindow(t, word));
    if (i !== -1) { misattributed++; crossRef.splice(i, 1); }
  }
  // G12 measures only extra mic content echoed from the remote reference.
  const otherWords = reference.filter(word => word.speaker === "Others");
  const bleed = crossOut.filter(word => word.speaker === "You" && isLocalContentWord(word.text) &&
    otherWords.some(ref => ref.key === word.key && crossSpeakerWindow(ref, word))).length;
  const tagged: EvalScore["tagged"] = {};
  for (const word of reference) for (const tag of word.tags ?? []) {
    const item = tagged[tag] ??= { total: 0, lost: 0 };
    item.total++;
    if (!matchedRef.has(word)) item.lost++;
  }
  // Coverage uses aligned reference words, not another greedy token search.
  // A word spliced into a neighbouring sentence is not evidence for a missing turn;
  // allow the same 0.5 s timing error that G16 permits for genuine short turns.
  const covered = expected.turns.map((turn, index) => {
    const wordCount = referenceTurnEnds[index] - (referenceTurnEnds[index - 1] ?? 0);
    return wordCount > 0 && (matchedByTurn.get(index)?.filter(word => {
      const sentence = sentences[word.sentence];
      return sentence.start_time <= turn.end + .5 && sentence.end_time >= turn.start - .5;
    }).length ?? 0) / wordCount >= .5;
  });
  const outputPositions = new Map(output.map((word, index) => [word, index]));
  // A contained short turn cannot break a longer turn's cluster. Close the
  // >0.3 s overlap relation transitively, irrespective of reference order.
  const cluster = expected.turns.map((_, index) => index);
  const root = (index: number): number => {
    while (cluster[index] !== index) {
      cluster[index] = cluster[cluster[index]];
      index = cluster[index];
    }
    return index;
  };
  for (let i = 0; i < expected.turns.length; i++) {
    for (let j = i + 1; j < expected.turns.length; j++) {
      const a = expected.turns[i], b = expected.turns[j];
      if (Math.min(a.end, b.end) - Math.max(a.start, b.start) > .3)
        cluster[root(j)] = root(i);
    }
  }
  const order = expected.turns.flatMap((turn, index) => {
    if (!covered[index]) return [];
    const positions = matchedByTurn.get(index)!.map(word => outputPositions.get(word)!).sort((a, b) => a - b);
    return [{ index, turn, at: (positions[(positions.length - 1) >> 1] + positions[positions.length >> 1]) / 2 }];
  });
  let concordant = 0, discordant = 0;
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
    const a = order[i], b = order[j];
    if (root(a.index) === root(b.index) || a.turn.start === b.turn.start || a.at === b.at) continue;
    if ((a.turn.start - b.turn.start) * (a.at - b.at) > 0) concordant++;
    else discordant++;
  }
  let unexplainedSplits = 0, referenceSentences = 0, mergedTurns = 0, refOffset = 0;
  for (const [turnIndex, turn] of expected.turns.entries()) {
    const ends = [...new Set([...turn.sentenceEnds, turn.words.length])].filter(n => n > 0 && n <= turn.words.length).sort((a, b) => a - b);
    referenceSentences += ends.length;
    const refWords = reference.slice(refOffset, refOffset = referenceTurnEnds[turnIndex]);
    let from = 0, normalizedFrom = 0, normalizedEnd = 0;
    for (const end of ends) {
      for (let i = from; i < end; i++) if (key(turn.words[i].w)) normalizedEnd++;
      const sequence = refWords.slice(normalizedFrom, normalizedEnd).flatMap(ref => {
        const found = alignedOutByRef.get(ref);
        return found ? [found] : [];
      });
      for (let i = 1; i < sequence.length; i++) if (sequence[i].sentence !== sequence[i - 1].sentence) {
        const split = sentences[sequence[i - 1].sentence].end_time;
        const explained = expected.turns.some((other, oi) => oi !== turnIndex && other.speaker !== turn.speaker &&
          ((other.start <= split && other.end >= split) || Math.abs(other.start - split) <= .5));
        if (!explained) unexplainedSplits++;
      }
      from = end;
      normalizedFrom = normalizedEnd;
    }
  }
  for (let i = 0; i < sentences.length; i++) {
    const turns = expected.turns.flatMap((turn, index) => matchedByTurn.get(index)?.some(t => t.sentence === i) ? [index] : []);
    if (turns.length > 1) mergedTurns += turns.length - 1;
  }
  const timedErrors: number[] = [];
  for (const ref of reference) {
    const out = alignedOutByRef.get(ref);
    if (out?.timing === "token" && out.start !== null)
      timedErrors.push(Math.abs(ref.start! - out.start));
  }
  timedErrors.sort((a, b) => a - b);
  const glossary = (input.glossaryTerms ?? []).map(tokens).filter(term => term.length);
  const vocabularyOccurrences = glossaryOccurrences(reference, glossary, "turn");
  const outputGlossary = glossaryOccurrences(output, glossary, "sentence");
  const glossaryFalsePositives = outputGlossary.filter(occurrence => !vocabularyOccurrences.some(referencePhrase =>
    referencePhrase.length === occurrence.length && referencePhrase.every((word, index) => alignedOutByRef.get(word) === occurrence[index]))).length;
  const sentenceSpanValid = sentences.every((sentence, index) => {
    const words = output.filter(t => t.sentence === index);
    if (!words.length) return true;
    if (words.every(word => word.timing === "none"))
      return sentence.start_time === 0 && sentence.end_time === input.noteDurationSeconds;
    return sentence.end_time - sentence.start_time <= 60;
  });
  const landmarks = input.playback?.landmarks ?? [];
  const engines = new Set(landmarks.map(l => l.engine));
  const tones = landmarks.filter(l => l.kind === "tone");
  const spoken = landmarks.filter(l => l.kind === "word");
  const speechContained = spoken.every(l => l.sentenceIndex !== undefined && sentences[l.sentenceIndex] !== undefined &&
    l.monoOnset >= sentences[l.sentenceIndex].start_time - .1 && l.monoOnset <= sentences[l.sentenceIndex].end_time + .1);
  const wordErrors = spoken.map(l => l.savedStart === undefined ? null : Math.abs(l.savedStart - l.monoOnset)).filter((n): n is number => n !== null);
  return {
    speakers, referenceWords: reference.length, outputWords: output.length,
    pooledWer: reference.length ? Object.values(speakers).reduce((n, s) => n + s.substitutions + s.deletions + s.insertions, 0) / reference.length : null,
    attributedRecall: rate(matchedRef.size, reference.length), misattributionRate: rate(misattributed, reference.length),
    bleedRate: rate(bleed, otherWords.length), tagged, turnCount: expected.turns.length,
    turnCovered: covered.filter(Boolean).length, kendallTau: expected.turns.length >= 2 && order.length < 2 ? -1
      : concordant + discordant ? (concordant - discordant) / (concordant + discordant) : 1,
    referenceSentences, unexplainedSplits, mergedTurns,
    noiseInsertions: expected.kind === "noise" ? output.length : 0, glossaryFalsePositives,
    vocabularyTotal: vocabularyOccurrences.length, vocabularyFound: vocabularyOccurrences.filter(occurrence => occurrence.every(word => matchedRef.has(word))).length,
    timingP90StartError: timedErrors.length ? timedErrors[Math.ceil(.9 * timedErrors.length) - 1] : null,
    fallbackTimedShare: rate(output.filter(t => t.timing === "fallback").length, output.length), sentenceSpanValid,
    runtime: input.runtime, productionInputHash: input.productionInputHash,
    playback: input.playback && { maxToneGap: tones.length ? Math.max(...tones.map(l => Math.abs(l.stereoOnset - l.monoOnset))) : null,
      speechContained, maxWordStartError: spoken.length && spoken.length === wordErrors.length ? Math.max(...wordErrors) : null,
      complete: !!expected.landmarks?.length && !!landmarks.length &&
        landmarks.length === expected.landmarks.length * engines.size &&
        [...engines].every(engine => expected.landmarks!.every(expectedLandmark =>
          landmarks.filter(measurement => measurement.engine === engine && measurement.kind === expectedLandmark.kind &&
            measurement.segment === expectedLandmark.segment && measurement.source_offset_s === expectedLandmark.source_offset_s).length === 1)) },
  };
}
