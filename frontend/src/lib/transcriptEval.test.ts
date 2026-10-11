import { describe, expect, test } from "bun:test";
import { scoreTranscript, type EvalExpected, type EvalInput, type EvalSentence } from "./transcriptEval";
import { evaluateTranscriptGates, type EvalGateId, type EvalGateOptions } from "./transcriptEvalGates";
import { localTranscriptSentences } from "./localTranscriptTurns";

const word = (n: number) => `word${n}`;
function fixture(groups: { speaker: string; count: number; start: number; tag?: string }[]): EvalInput & { sentences: EvalSentence[] } {
  const turns = groups.map((group, index) => {
    const words = Array.from({ length: group.count }, (_, offset) => ({ w: word(group.start + offset), start: index * 20 + offset * .2, end: index * 20 + offset * .2 + .15, tag: group.tag }));
    return { id: `turn${index}`, speaker: group.speaker, start: index * 20, end: index * 20 + Math.max(1, group.count * .2),
      text: words.map(w => w.w).join(" "), words, tags: group.tag ? [group.tag] : [], sentenceEnds: [words.length] };
  });
  const expected: EvalExpected = { version: 1, split: "dev", kind: "speech", turns, vocabularyVersion: 1 };
  const sentences: EvalSentence[] = turns.map((turn, index) => ({ index, speaker_name: turn.speaker, text: turn.text, start_time: turn.start, end_time: turn.end,
    words: turn.words.map(w => ({ text: w.w, start: w.start, end: w.end, channel: turn.speaker === "You" ? 0 : 1, timing: "token" })) }));
  return { expected, sentences, noteDurationSeconds: 150, runtime: { maxSseGapSeconds: 1, realTimeFactor: 1, peakMemoryBytes: 1000 },
    productionInputHash: "hash", playback: { landmarks: [] } };
}
const long = () => fixture([{ speaker: "You", count: 100, start: 0 }]);
const two = () => fixture([{ speaker: "You", count: 50, start: 0 }, { speaker: "Others", count: 50, start: 50 }]);
function sentence(input: EvalInput, index: number, words: NonNullable<EvalSentence["words"]>, changes: Partial<EvalSentence> = {}): EvalSentence {
  const old = input.sentences[index];
  return { ...old, text: words.map(w => w.text).join(" "), words, ...changes };
}
function assertGate(input: EvalInput, mutate: (input: EvalInput) => EvalInput, gate: EvalGateId, stage: EvalGateOptions["stage"] = "A3", fixtureName = "speech") {
  const baseline = scoreTranscript(input);
  const candidate = scoreTranscript(mutate(input));
  const results = evaluateTranscriptGates(candidate, { baseline, stage, fixtureName, goldenProductionInputHash: "hash" });
  expect(results.find(r => r.id === gate)?.applicable).toBe(true);
  expect(results.find(r => r.id === gate)?.passed).toBe(false);
  return { baseline, candidate, results };
}
function assertPass(input: EvalInput, stage: EvalGateOptions["stage"] = "A3") {
  const baseline = scoreTranscript(input);
  const results = evaluateTranscriptGates(baseline, { baseline, stage, fixtureName: "speech", goldenProductionInputHash: "hash" });
  expect(results.filter(r => !r.passed).map(r => r.id)).toEqual([]);
}
const without = (s: EvalSentence, n: number): EvalSentence => ({ ...s, words: s.words!.slice(0, -n), text: s.words!.slice(0, -n).map(w => w.text).join(" ") });

describe("TC-813 adversarial scoring cases 1–28", () => {
  test("1 deleted tails raise WER, deletion and lost-turn coverage", () => {
    const input = fixture(Array.from({ length: 4 }, (_, i) => ({ speaker: "You", count: 5, start: i * 5 })));
    const result = assertGate(input, x => ({ ...x, sentences: x.sentences.slice(0, 2) }), "G8");
    expect(result.results.find(r => r.id === "G1")?.passed).toBe(false);
    expect(result.results.find(r => r.id === "G2")?.passed).toBe(false);
  });
  test("2 deleted speaker fails deletion and attributed recall", () => {
    const input = two();
    const result = assertGate(input, x => ({ ...x, sentences: x.sentences.slice(0, 1) }), "G2");
    expect(result.results.find(r => r.id === "G5")?.passed).toBe(false);
  });
  test("3 duplicated turns fail pooled WER", () => {
    const input = two();
    assertGate(input, x => ({ ...x, sentences: [...x.sentences, { ...x.sentences[0], index: 2 }] }), "G4");
  });
  test("4 swapped speaker labels fail misattribution and recall", () => {
    const input = two();
    const result = assertGate(input, x => ({ ...x, sentences: x.sentences.map(s => ({ ...s, speaker_name: s.speaker_name === "You" ? "Others" : "You" })) }), "G6");
    expect(result.results.find(r => r.id === "G5")?.passed).toBe(false);
  });
  test("5 substituting 20/20 then deleting ten and substituting 30/10 never rewards deletion", () => {
    const input = long();
    const baseline = { ...input, sentences: [sentence(input, 0, input.sentences[0].words!.map((w, i) => i < 20 ? { ...w, text: `different${i}` } : w))] };
    const current = sentence(input, 0, input.sentences[0].words!.slice(10).map((w, i) => i < 30 ? { ...w, text: `replacement${i}` } : w));
    const result = assertGate(baseline, x => ({ ...x, sentences: [current] }), "G1");
    expect(result.candidate.speakers.You.deletions).toBeGreaterThan(result.baseline.speakers.You.deletions);
  });
  test("6 dropping two short turns fails turn coverage", () => {
    const input = fixture(Array.from({ length: 4 }, (_, i) => ({ speaker: "You", count: 2, start: i * 2 })));
    assertGate(input, x => ({ ...x, sentences: x.sentences.slice(0, 2) }), "G8");
  });
  test("7 reversing separated turns fails Kendall tau", () => {
    const input = fixture(Array.from({ length: 3 }, (_, i) => ({ speaker: "You", count: 3, start: i * 3 })));
    assertGate(input, x => ({ ...x, sentences: [...x.sentences].reverse() }), "G9");
  });
  test("8 simultaneous overlapping turns pass in either output order", () => {
    const input = fixture([{ speaker: "You", count: 5, start: 0 }, { speaker: "Others", count: 5, start: 5 }]);
    const simultaneous = input.expected.turns[1];
    simultaneous.start = 0;
    simultaneous.end = 1;
    simultaneous.words = simultaneous.words.map((word, i) => ({ ...word, start: i * .2, end: i * .2 + .15 }));
    input.sentences[1] = { ...input.sentences[1], start_time: 0, end_time: 1,
      words: input.sentences[1].words!.map((word, i) => ({ ...word, start: i * .2, end: i * .2 + .15 })) };
    assertPass(input, "BR");
    assertPass({ ...input, sentences: [...input.sentences].reverse() }, "BR");
  });
  test("9 artificial split inside a sentence fails unexplained splits", () => {
    const input = long();
    const a = sentence(input, 0, input.sentences[0].words!.slice(0, 50), { end_time: 10 });
    const b = sentence(input, 0, input.sentences[0].words!.slice(50), { index: 1, start_time: 10 });
    assertGate(input, x => ({ ...x, sentences: [a, b] }), "G10");
  });
  test("10 merging four separate turns fails merged-turn gate", () => {
    const input = fixture(Array.from({ length: 4 }, (_, i) => ({ speaker: "You", count: 2, start: i * 2 })));
    const merged = sentence(input, 0, input.sentences.flatMap(s => s.words ?? []), { end_time: 64 });
    assertGate(input, x => ({ ...x, sentences: [merged] }), "G11");
  });
  test("11 empty output is WER 1, deletion 1, coverage zero", () => {
    const input = long();
    const { candidate, results } = assertGate(input, x => ({ ...x, sentences: [] }), "G2");
    expect(candidate.speakers.You.wer).toBe(1);
    expect(candidate.speakers.You.deletionRate).toBe(1);
    expect(candidate.turnCovered).toBe(0);
    expect(results.find(r => r.id === "G5")?.passed).toBe(false);
  });
  test("12 inserted words under zero-reference speaker fail G3", () => {
    const input = long();
    assertGate(input, x => ({ ...x, sentences: [...x.sentences, { index: 1, speaker_name: "Others", text: "phantom", start_time: 1, end_time: 2 }] }), "G3");
  });
  test("13 hallucinated noise fails G13", () => {
    const input = fixture([]); input.expected.kind = "noise";
    assertGate(input, x => ({ ...x, sentences: [{ index: 0, speaker_name: "You", text: "phantom", start_time: 0, end_time: 150 }] }), "G13");
  });
  test("14 hallucinated glossary term fails G14", () => {
    const input = { ...long(), glossaryTerms: ["quasar"] };
    assertGate(input, x => ({ ...x, sentences: [...x.sentences, { index: 1, speaker_name: "You", text: "quasar", start_time: 1, end_time: 2 }] }), "G14");
  });
  test("15 cross-speaker echo duplication fails bleed", () => {
    const input = long();
    assertGate(input, x => ({ ...x, sentences: [...x.sentences, { ...x.sentences[0], speaker_name: "Others", index: 1 }] }), "G12");
  });
  for (const [number, tag] of [[16, "double-talk"], [17, "backchannel"], [16, "repeat"], [17, "correction"]] as const) {
    test(`${number} dropped ${tag} words fail tagged recall`, () => {
      const input = fixture([{ speaker: "You", count: 10, start: 0, tag }]);
      assertGate(input, x => ({ ...x, sentences: [without(x.sentences[0], 3)] }), "G7");
    });
  }
  test("18 lost glossary vocabulary fails recall", () => {
    const input = { ...long(), glossaryTerms: ["word0", "word1", "word2", "word3"] };
    assertGate(input, x => ({ ...x, sentences: [sentence(x, 0, x.sentences[0].words!.slice(4))] }), "G15");
  });
  test("19 shifted token starts fail p90 timing", () => {
    const input = long();
    assertGate(input, x => ({ ...x, sentences: [sentence(x, 0, x.sentences[0].words!.map(w => ({ ...w, start: w.start + 1 })))] }), "G16", "B2");
  });
  test("fallback timing over 20% fails G16 without losing lexical words", () => {
    const input = long();
    const result = assertGate(input, x => ({ ...x, sentences: [sentence(x, 0,
      x.sentences[0].words!.map((w, i) => i < 21 ? { ...w, timing: "fallback" as const } : w))] }), "G16", "B2");
    expect(result.candidate.speakers.You.deletions).toBe(0);
  });
  test("20 SSE gap, real-time factor, memory budgets fail G17", () => {
    const input = long();
    for (const runtime of [{ maxSseGapSeconds: 30, realTimeFactor: 1, peakMemoryBytes: 1000 },
      { maxSseGapSeconds: 1, realTimeFactor: 1.26, peakMemoryBytes: 1000 },
      { maxSseGapSeconds: 1, realTimeFactor: 1, peakMemoryBytes: 1101 }]) {
      assertGate(input, x => ({ ...x, runtime }), "G17");
    }
  });
  test("21 changed production input SHA-256 fails exact hash", () => {
    const input = long();
    assertGate(input, x => ({ ...x, productionInputHash: "different" }), "G18");
  });
  test("22 a timed 60 s sentence split at a reference sentence end passes", () => {
    const input = fixture([{ speaker: "You", count: 4, start: 0 }]);
    input.expected.turns[0].sentenceEnds = [2, 4];
    input.expected.turns[0].end = 120;
    input.expected.turns[0].words = input.expected.turns[0].words.map((word, i) =>
      ({ ...word, start: i * 30, end: (i + 1) * 30 }));
    const words = input.sentences[0].words!.map((word, i) =>
      ({ ...word, start: i * 30, end: (i + 1) * 30 }));
    const a = sentence(input, 0, words.slice(0, 2), { end_time: 60 });
    const b = sentence(input, 0, words.slice(2), { index: 1, start_time: 60, end_time: 120 });
    assertPass({ ...input, sentences: [a, b] }, "BR");
  });
  test("23 an interjection at the split explains an otherwise internal cut", () => {
    const input = fixture([{ speaker: "You", count: 4, start: 0 }, { speaker: "Others", count: 1, start: 4 }]);
    input.expected.turns[1].start = .3; input.expected.turns[1].end = .5;
    input.expected.turns[1].words[0].start = .35; input.expected.turns[1].words[0].end = .45;
    input.sentences[1] = { ...input.sentences[1], start_time: .3, end_time: .5,
      words: [{ ...input.sentences[1].words![0], start: .35, end: .45 }] };
    const a = sentence(input, 0, input.sentences[0].words!.slice(0, 2), { end_time: .4 });
    const b = sentence(input, 0, input.sentences[0].words!.slice(2), { index: 2, start_time: .4 });
    assertPass({ ...input, sentences: [a, input.sentences[1], b] }, "BR");
  });
  test("24 perfect transcript passes all applicable G1–G20", () => assertPass(long()));
  test("25 untimed 150 s transcript keeps full-note range and passes G19", () => {
    const input = fixture([{ speaker: "You", count: 3, start: 0 }]);
    input.sentences[0] = { ...input.sentences[0], words: input.sentences[0].words!.map(w => ({ ...w, timing: "none" as const })), start_time: 0, end_time: 150 };
    input.expected.landmarks = [{ kind: "tone", segment: 0, source_offset_s: 1 }];
    input.playback = { landmarks: [{ engine: "chromium", kind: "tone", segment: 0, source_offset_s: 1, stereoOnset: 1, monoOnset: 1 }] };
    assertPass(input, "BR");
  });
  test("26 invented sub-ranges on untimed text fail G19", () => {
    const input = fixture([{ speaker: "You", count: 3, start: 0 }]);
    input.sentences[0] = { ...input.sentences[0], words: input.sentences[0].words!.map(w => ({ ...w, timing: "none" as const })), start_time: 0, end_time: 150 };
    assertGate(input, x => ({ ...x, sentences: [{ ...x.sentences[0], end_time: 60 }] }), "G19", "BR");
  });
  test("27 dropped untimed text fails deletion and coverage", () => {
    const input = fixture([{ speaker: "You", count: 3, start: 0 }, { speaker: "Others", count: 3, start: 3 }, { speaker: "Others", count: 3, start: 6 }]);
    for (const index of [1, 2]) input.sentences[index] = { ...input.sentences[index],
      words: input.sentences[index].words!.map(w => ({ ...w, timing: "none" as const })), start_time: 0, end_time: 150 };
    const result = assertGate(input, x => ({ ...x, sentences: x.sentences.slice(0, 1) }), "G2");
    expect(result.results.find(r => r.id === "G8")?.passed).toBe(false);
  });
  test("28 cumulative 0.1 s per segment boundary fails maximum G20", () => {
    const input = long();
    input.sentences[0].end_time = 50;
    input.expected.landmarks = Array.from({ length: 12 }, (_, segment) => ({ kind: "tone" as const, segment, source_offset_s: 1 }));
    input.playback = { landmarks: input.expected.landmarks.map(l => ({ engine: "chromium", kind: "tone" as const, segment: l.segment, source_offset_s: 1,
      stereoOnset: l.segment * 4 + 1, monoOnset: l.segment * 4 + 1 })) };
    assertGate(input, x => ({ ...x, playback: { landmarks: x.playback!.landmarks.map(l => ({ ...l, monoOnset: l.monoOnset + l.segment * .1 })) } }), "G20", "BR", "multi-segment-landmarks");
  });
  test("G20 BR word containment and B2 word-start maximum use saved playback evidence", () => {
    const input = long();
    input.expected.landmarks = [
      { kind: "tone", segment: 0, source_offset_s: 1 },
      { kind: "word", w: "word5", segment: 0, source_offset_s: 2 },
    ];
    input.playback = { landmarks: [
      { engine: "chromium", kind: "tone", segment: 0, source_offset_s: 1, stereoOnset: 1, monoOnset: 1 },
      { engine: "chromium", kind: "word", segment: 0, source_offset_s: 2, stereoOnset: 2, monoOnset: 2, sentenceIndex: 0, savedStart: 2 },
    ] };
    assertGate(input, x => ({ ...x, playback: { landmarks: x.playback!.landmarks.map(l =>
      l.kind === "word" ? { ...l, monoOnset: 25 } : l) } }), "G20", "BR", "multi-segment-landmarks");
    assertGate(input, x => ({ ...x, playback: { landmarks: x.playback!.landmarks.map(l =>
      l.kind === "word" ? { ...l, savedStart: 2.51 } : l) } }), "G20", "B2", "multi-segment-landmarks");
  });
  test("cross-speaker identical tokens match only within ±15 seconds", () => {
    const input = fixture([{ speaker: "You", count: 1, start: 0 }]);
    const wrong = (at: number): EvalInput => ({ ...input, sentences: [{ ...input.sentences[0], speaker_name: "Others",
      words: input.sentences[0].words!.map(w => ({ ...w, start: at, end: at + .1 })) }] });
    expect(scoreTranscript(wrong(15)).misattributionRate).toBe(1);
    expect(scoreTranscript(wrong(15.01)).misattributionRate).toBe(0);
  });
  test("E ratchets silence and glossary false positives to zero and permits 1.5× real-time", () => {
    const noise = fixture([]);
    noise.expected.kind = "noise";
    noise.sentences = [{ index: 0, text: "quasar", speaker_name: "You", start_time: 0, end_time: 150 }];
    noise.glossaryTerms = ["quasar"];
    const baseline = scoreTranscript(noise);
    const options = { baseline, stage: "E" as const, fixtureName: "silence-only", goldenProductionInputHash: "hash" };
    const gates = evaluateTranscriptGates(baseline, options);
    expect(gates.find(g => g.id === "G13")?.passed).toBe(false);
    expect(gates.find(g => g.id === "G14")?.passed).toBe(false);
    const faster = scoreTranscript({ ...noise, runtime: { maxSseGapSeconds: 1, realTimeFactor: 1.5, peakMemoryBytes: 1000 } });
    expect(evaluateTranscriptGates(faster, options).find(g => g.id === "G17")?.passed).toBe(true);
  });
  test("multiword glossary terms require contiguous complete phrases", () => {
    const input = fixture([{ speaker: "You", count: 3, start: 0 }]);
    input.glossaryTerms = ["word0 word1"];
    expect(scoreTranscript(input).vocabularyTotal).toBe(1);
    expect(scoreTranscript(input).vocabularyFound).toBe(1);
    const partial = sentence(input, 0, input.sentences[0].words!.slice(1));
    expect(scoreTranscript({ ...input, sentences: [partial] }).vocabularyFound).toBe(0);
    const stray = sentence(input, 0, [{ ...input.sentences[0].words![0], text: "word0" }]);
    expect(scoreTranscript({ ...input, sentences: [stray] }).glossaryFalsePositives).toBe(0);
    const gap = fixture([{ speaker: "You", count: 3, start: 0 }]);
    gap.glossaryTerms = ["word0 word2"];
    gap.sentences[0] = sentence(gap, 0, [gap.sentences[0].words![0], gap.sentences[0].words![2]]);
    expect(scoreTranscript(gap).glossaryFalsePositives).toBe(1);
  });
  test("echo off preserves every word of two coincident channel utterances", () => {
    const phrase = ["Ship", "the", "release", "on", "Thursday"];
    const channel = (id: number) => ({
      alternatives: [{ transcript: "", confidence: 1, words: [0, 5].flatMap(at =>
        phrase.map((part, i) => ({ word: part, punctuated_word: part, start: at + i * .2 + id * .2,
          end: at + (i + 1) * .2 + id * .2, channel: id, confidence: 1, speaker: null }))) }],
    });
    const sentences = localTranscriptSentences({ metadata: null,
      results: { channels: [channel(0), channel(1)] } }, { echo: "off", detail: true });
    expect(sentences.flatMap(sentence => sentence.text.split(" "))).toHaveLength(20);
    expect(sentences.filter(sentence => sentence.speaker_name === "You").flatMap(sentence => sentence.text.split(" ")))
      .toEqual([...phrase, ...phrase]);
    expect(sentences.filter(sentence => sentence.speaker_name === "Others").flatMap(sentence => sentence.text.split(" ")))
      .toEqual([...phrase, ...phrase]);
  });
});
