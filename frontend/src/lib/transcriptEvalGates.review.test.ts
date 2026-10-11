import { describe, expect, test } from "bun:test";
import type { EvalScore } from "./transcriptEval";
import { evaluateTranscriptGates, type EvalGateId, type EvalGateOptions, type EvalPr } from "./transcriptEvalGates";

// Distinct baseline and candidate metrics isolate gate thresholds from scorer behavior.
const base: EvalScore = {
  speakers: {
    Others: { reference: 200, output: 200, substitutions: 40, deletions: 0, insertions: 0, correct: 160,
      wer: .2, deletionRate: 0, attributedRecall: .8 },
  },
  referenceWords: 200, outputWords: 200, pooledWer: .2, attributedRecall: .8,
  misattributionRate: 0, bleedRate: .05, tagged: {}, turnCount: 4, turnCovered: 4, kendallTau: .96,
  referenceSentences: 50, unexplainedSplits: 1, mergedTurns: 0,
  noiseInsertions: 0, glossaryFalsePositives: 0, vocabularyTotal: 100, vocabularyFound: 95,
  timingP90StartError: .2, fallbackTimedShare: 0, sentenceSpanValid: true,
  runtime: { maxSseGapSeconds: 1, realTimeFactor: 1, peakMemoryBytes: 100 },
  productionInputHash: "production-hash",
};

function result(id: EvalGateId, candidate: EvalScore, baseline: EvalScore = base,
  landed: ReadonlySet<EvalPr> = new Set<EvalPr>(["A3"]), fixtureName = "speech") {
  const options: EvalGateOptions = { baseline, landed, fixtureName, goldenProductionInputHash: "production-hash" };
  const gate = evaluateTranscriptGates(candidate, options).find(g => g.id === id);
  expect(gate).toBeDefined();
  return gate!;
}
function assertGate(id: EvalGateId, candidate: EvalScore, passed: boolean, baseline: EvalScore = base,
  landed: ReadonlySet<EvalPr> = new Set<EvalPr>(["A3"]), fixtureName = "speech") {
  expect(result(id, candidate, baseline, landed, fixtureName)).toMatchObject({ applicable: true, passed });
}

const prs = (...names: EvalPr[]): ReadonlySet<EvalPr> => new Set(names);

describe("review: independent gate boundaries", () => {
  test("G4 uses a distinct baseline and the frozen half-point pooled WER allowance", () => {
    assertGate("G4", { ...base, pooledWer: .205 }, true);
    assertGate("G4", { ...base, pooledWer: .206 }, false);
    assertGate("G4", { ...base, pooledWer: null }, false);
    assertGate("G4", { ...base, pooledWer: Infinity }, false);
    assertGate("G4", base, false, { ...base, pooledWer: null });
  });

  test("G4 treats two undefined WERs with no reference as comparable; G3 still handles insertions", () => {
    const noReference: EvalScore = { ...base, speakers: {}, referenceWords: 0, outputWords: 0, pooledWer: null };
    const inserted: EvalScore = { ...noReference, outputWords: 1,
      speakers: { You: { reference: 0, output: 1, substitutions: 0, deletions: 0, insertions: 1,
        correct: 0, wer: null, deletionRate: 0, attributedRecall: 0 } } };
    assertGate("G4", noReference, true, noReference);
    assertGate("G4", inserted, true, noReference);
    assertGate("G3", inserted, false, noReference);
    assertGate("G4", { ...noReference, pooledWer: 0 }, false, noReference);
    assertGate("G4", noReference, false, { ...noReference, pooledWer: 0 });
  });

  test("G9 requires two covered turns even when baseline and candidate tau look vacuously perfect", () => {
    assertGate("G9", { ...base, turnCovered: 1, kendallTau: 1 }, false, { ...base, kendallTau: 1, turnCovered: 1 });
    assertGate("G9", { ...base, turnCovered: 0, kendallTau: -1 }, false, { ...base, kendallTau: -1, turnCovered: 0 });
    assertGate("G9", { ...base, turnCovered: 2, kendallTau: .94 }, true);
    assertGate("G9", { ...base, turnCovered: 2, kendallTau: .939 }, false);
  });

  test("G10 counts unexplained splits per hundred reference sentences, allowing only two over baseline", () => {
    assertGate("G10", { ...base, referenceSentences: 100, unexplainedSplits: 4 }, true);
    assertGate("G10", { ...base, referenceSentences: 100, unexplainedSplits: 5 }, false);
  });

  test("G12 compares bleed to a distinct baseline plus max(one point, two Others reference words)", () => {
    assertGate("G12", { ...base, bleedRate: .06 }, true);
    assertGate("G12", { ...base, bleedRate: .061 }, false);
    const fewerOthers = { ...base, speakers: { Others: { ...base.speakers.Others, reference: 100 } } };
    assertGate("G12", { ...fewerOthers, bleedRate: .07 }, true, fewerOthers);
    assertGate("G12", { ...fewerOthers, bleedRate: .071 }, false, fewerOthers);
  });
});

describe("review: landed PR DAG and persistent ratchets", () => {
  test("A1 and A2 cannot activate A3 baselines before they exist", () => {
    const candidate = { ...base, pooledWer: 1, sentenceSpanValid: false, timingP90StartError: null };
    const rows = evaluateTranscriptGates(candidate, { baseline: base, landed: prs("A1", "A2"),
      fixtureName: "multi-segment-landmarks", goldenProductionInputHash: "production-hash" });
    expect(rows).toHaveLength(20);
    expect(rows.every(row => !row.applicable && row.passed)).toBe(true);
    expect(result("G4", candidate, base, prs("A1", "A2", "A3"))).toMatchObject({ applicable: true, passed: false });
  });

  test("E before BR/B2 cannot activate timing, sentence span, or landmark gates", () => {
    const mono = { ...base, timingP90StartError: null, sentenceSpanValid: false, playback: undefined };
    for (const id of ["G16", "G19", "G20"] as const) {
      expect(result(id, mono, base, prs("A3", "B1", "E"), "multi-segment-landmarks"))
        .toMatchObject({ applicable: false, passed: true });
    }
    expect(result("G16", mono, base, prs("A3", "BR", "E")))
      .toMatchObject({ applicable: false, passed: true });
    assertGate("G19", mono, false, base, prs("A3", "BR", "E"));
    assertGate("G16", mono, false, base, prs("A3", "BR", "B2", "E"));
  });

  test("E's silence, glossary, vocabulary and runtime rules survive D", () => {
    const beforeE = prs("A3", "BR", "B2", "D");
    const afterE = prs("A3", "BR", "B2", "E", "X", "D");
    const silenceBaseline: EvalScore = { ...base, speakers: { You: { reference: 0, output: 1,
      substitutions: 0, deletions: 0, insertions: 1, correct: 0, wer: null, deletionRate: 0,
      attributedRecall: 0 } }, referenceWords: 0, outputWords: 1, pooledWer: null, noiseInsertions: 1,
      turnCount: 0, turnCovered: 0 };
    const silenceCandidate = { ...silenceBaseline, noiseInsertions: 1 };
    assertGate("G13", silenceCandidate, true, silenceBaseline, beforeE, "silence-only");
    assertGate("G13", silenceCandidate, false, silenceBaseline, afterE, "silence-only");
    assertGate("G13", { ...silenceCandidate, noiseInsertions: 0 }, true, silenceBaseline, afterE, "silence-only");
    assertGate("G13", silenceCandidate, true, silenceBaseline, afterE, "speech");
    const glossaryBaseline = { ...base, glossaryFalsePositives: 1 };
    assertGate("G14", glossaryBaseline, true, glossaryBaseline, beforeE);
    assertGate("G14", glossaryBaseline, false, glossaryBaseline, afterE);
    assertGate("G14", { ...glossaryBaseline, glossaryFalsePositives: 0 }, true, glossaryBaseline, afterE);
    const recallBaseline = { ...base, vocabularyFound: 89 };
    assertGate("G15", recallBaseline, true, recallBaseline, beforeE);
    assertGate("G15", recallBaseline, false, recallBaseline, afterE);
    assertGate("G15", { ...recallBaseline, vocabularyFound: 90 }, true, recallBaseline, afterE);
    const runtime = { ...base, runtime: { ...base.runtime!, realTimeFactor: 1.26 } };
    assertGate("G17", runtime, false, base, beforeE);
    assertGate("G17", runtime, true, base, afterE);
    assertGate("G17", { ...runtime, runtime: { ...runtime.runtime!, realTimeFactor: 1.51 } }, false, base, afterE);
  });

  test("B2 enables p90 timing and D alone tightens 0.5 s to 0.3 s", () => {
    const b2 = prs("A3", "BR", "B2");
    const d = prs("A3", "BR", "B2", "D");
    assertGate("G16", { ...base, timingP90StartError: .5, fallbackTimedShare: .2 }, true, base, b2);
    assertGate("G16", { ...base, timingP90StartError: .501 }, false, base, b2);
    assertGate("G16", { ...base, timingP90StartError: .5, fallbackTimedShare: .201 }, false, base, b2);
    assertGate("G16", { ...base, timingP90StartError: null }, false, base, b2);
    assertGate("G16", { ...base, timingP90StartError: .301 }, true, base, b2);
    assertGate("G16", { ...base, timingP90StartError: .301 }, false, base, d);
    assertGate("G16", { ...base, timingP90StartError: .3 }, true, base, d);
  });

  test("BR's G20 requires complete tone and speech evidence, B2 switches to word onsets", () => {
    const playback = { complete: true, maxToneGap: .1, speechContained: true, maxWordStartError: .6 };
    const candidate = { ...base, playback };
    const br = prs("A3", "BR", "E");
    const b2 = prs("A3", "BR", "B2", "E");
    assertGate("G20", candidate, true, base, br, "multi-segment-landmarks");
    assertGate("G20", { ...candidate, playback: { ...playback, speechContained: false } }, false, base, br, "multi-segment-landmarks");
    assertGate("G20", candidate, false, base, b2, "multi-segment-landmarks");
    assertGate("G20", { ...candidate, playback: { ...playback, maxWordStartError: .5, speechContained: false } }, true, base, b2, "multi-segment-landmarks");
    assertGate("G20", { ...candidate, playback: { ...playback, maxToneGap: .101 } }, false, base, br, "multi-segment-landmarks");
    assertGate("G20", { ...candidate, playback: { ...playback, maxToneGap: null } }, false, base, br, "multi-segment-landmarks");
    assertGate("G20", { ...candidate, playback: { ...playback, maxWordStartError: null } }, false, base, b2, "multi-segment-landmarks");
    assertGate("G20", { ...candidate, playback: { ...playback, complete: false } }, false, base, br, "multi-segment-landmarks");
    expect(result("G20", candidate, base, br)).toMatchObject({ applicable: false, passed: true });
  });
});
