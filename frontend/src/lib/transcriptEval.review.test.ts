import { describe, expect, test } from "bun:test";
import type { BatchResponse } from "./anarlog/transcription.gen";
import { localTranscriptSentences } from "./localTranscriptTurns";
import { scoreTranscript, type EvalExpected, type EvalInput, type EvalScore, type EvalSentence } from "./transcriptEval";
import { evaluateTranscriptGates, type EvalPr } from "./transcriptEvalGates";

interface Group { speaker: string; words: string[]; start: number; end?: number }
function fixture(groups: Group[]): EvalInput & { sentences: EvalSentence[] } {
  const turns = groups.map((group, index) => {
    const words = group.words.map((w, i) => ({ w, start: group.start + i * .3, end: group.start + i * .3 + .25 }));
    return { id: `turn${index}`, speaker: group.speaker, start: group.start,
      end: group.end ?? group.start + group.words.length * .3, text: group.words.join(" "),
      sentenceEnds: [words.length], tags: [], words };
  });
  const expected: EvalExpected = { version: 1, split: "dev", kind: "speech", turns, vocabularyVersion: 1 };
  const sentences: EvalSentence[] = turns.map((turn, index) => ({ index, speaker_name: turn.speaker,
    text: turn.text, start_time: turn.start, end_time: turn.end,
    words: turn.words.map(w => ({ text: w.w, start: w.start, end: w.end,
      channel: turn.speaker === "You" ? 0 : 1, timing: "token" })) }));
  return { expected, sentences, noteDurationSeconds: 300, runtime: { maxSseGapSeconds: 1,
    realTimeFactor: 1, peakMemoryBytes: 1000 }, productionInputHash: "hash" };
}
const words = (prefix: string, length: number) => Array.from({ length }, (_, i) => `${prefix}${i}`);
const landed = new Set<EvalPr>(["A3", "BR", "B2"]);
const gate = (baseline: EvalInput, candidate: EvalInput, id: string) =>
  evaluateTranscriptGates(scoreTranscript(candidate), { baseline: scoreTranscript(baseline), landed,
    fixtureName: "speech", goldenProductionInputHash: "hash" }).find(result => result.id === id)?.passed;

describe("TC-813 alignment review regressions", () => {
  test("coverage uses attributed alignment and a source sentence within the turn, not nearby invented words", () => {
    const base = fixture(Array.from({ length: 40 }, (_, i) => ({ speaker: "You",
      words: i === 10 || i === 20 ? ["okay"] : words(`turn${i}-`, 10), start: i * 5 })));
    const deleted = { ...base, sentences: base.sentences.filter((_, i) => ![10, 20, 30].includes(i)) };
    const invented = { ...base, sentences: deleted.sentences.map(s => {
      if (s.index !== 9 && s.index !== 19) return s;
      const last = s.words!.at(-1)!;
      return { ...s, text: `${s.text} okay`, words: [...s.words!, { text: "okay",
        start: last.start + .3, end: last.end + .3, channel: 0, timing: "token" as const }] };
    }) };
    expect(scoreTranscript(deleted).turnCovered).toBe(37);
    expect(scoreTranscript(invented).turnCovered).toBe(37);
    expect(gate(base, invented, "G8")).toBe(false);
  });

  test("zero-reference scores survive a gates.json round trip with undefined WER intact", () => {
    const input = fixture([]);
    input.expected.kind = "noise";
    input.sentences = [{ index: 0, speaker_name: "You", text: "phantom",
      start_time: 0, end_time: 1, words: [{ text: "phantom", start: 0,
        end: 1, channel: 0, timing: "token" }] }];
    const score = scoreTranscript(input);
    const stored = JSON.parse(JSON.stringify(score)) as EvalScore;
    expect(stored.pooledWer).toBeNull();
    expect(stored.speakers.You.wer).toBeNull();
    const results = evaluateTranscriptGates(score, { baseline: stored, landed,
      fixtureName: "silence-only", goldenProductionInputHash: "hash" });
    expect(results.find(result => result.id === "G4")?.passed).toBe(true);
    expect(results.find(result => result.id === "G3")?.passed).toBe(true);
  });

  test("Kendall excludes pairs in transitive overlap clusters", () => {
    const base = fixture([
      { speaker: "You", words: words("a", 3), start: 0, end: 2 },
      { speaker: "Others", words: words("b", 3), start: 1.5, end: 4 },
      { speaker: "Others", words: words("c", 3), start: 3.5, end: 6 },
    ]);
    const reordered = { ...base, sentences: [base.sentences[1], base.sentences[2], base.sentences[0]] };
    expect(scoreTranscript(reordered).turnCovered).toBe(3);
    expect(scoreTranscript(reordered).kendallTau).toBe(1);
    expect(gate(base, reordered, "G9")).toBe(true);
  });

  test("bleed counts You content insertions near Others, not function words or reverse direction", () => {
    const base = fixture([
      { speaker: "You", words: ["the", "release"], start: 0 },
      { speaker: "Others", words: ["the", "harbor"], start: 5 },
    ]);
    const inserted = (speaker: string, text: string, start: number): EvalInput => ({ ...base,
      sentences: [...base.sentences, { index: 2, speaker_name: speaker, text,
        start_time: start, end_time: start + .2, words: [{ text, start, end: start + .2,
          channel: speaker === "You" ? 0 : 1, timing: "token" }] }] });
    expect(scoreTranscript(inserted("Others", "release", 0)).bleedRate).toBe(0);
    expect(scoreTranscript(inserted("You", "the", 5)).bleedRate).toBe(0);
    expect(scoreTranscript(inserted("You", "harbor", 21)).bleedRate).toBe(0);
    expect(scoreTranscript(inserted("You", "harbor", 5)).bleedRate).toBe(.5);
  });

  test("G16 uses p90, not median: twenty shifted starts out of a hundred fail", () => {
    const base = fixture([{ speaker: "You", words: words("w", 100), start: 0 }]);
    const shifted = { ...base, sentences: [{ ...base.sentences[0], words: base.sentences[0].words!.map((w, i) =>
      i >= 80 ? { ...w, start: w.start + 1 } : w) }] };
    expect(scoreTranscript(shifted).timingP90StartError).toBe(1);
    expect(gate(base, shifted, "G16")).toBe(false);
  });

  test("a mismatched source-word list cannot silently become untimed", () => {
    const base = fixture([{ speaker: "You", words: ["hello", "world"], start: 0 }]);
    expect(() => scoreTranscript({ ...base, sentences: [{ ...base.sentences[0], text: "hello  world ." }] }))
      .toThrow("source words do not match saved text");
  });

  test("alignment normalizes NFKC and punctuation without changing word order", () => {
    const input = fixture([{ speaker: "You", words: ["TinyCloud", "dont"], start: 0 }]);
    input.sentences[0] = { ...input.sentences[0], text: "ＴｉｎｙＣｌｏｕｄ don't",
      words: [{ ...input.sentences[0].words![0], text: "ＴｉｎｙＣｌｏｕｄ" },
        { ...input.sentences[0].words![1], text: "don't" }] };
    expect(scoreTranscript(input).speakers.You.wer).toBe(0);
  });

  test("B0 cannot be selected before its filtering policy lands", () => {
    const response: BatchResponse = { metadata: null, results: { channels: [] } };
    expect(localTranscriptSentences(response)).toEqual([]);
    expect(localTranscriptSentences(response, { echo: "off" })).toEqual([]);
    // @ts-expect-error B0 diagnostics are deliberately unavailable until B0 lands.
    expect(() => localTranscriptSentences(response, { echo: "b0" })).toThrow("B0 echo policy has not landed");
  });
});
