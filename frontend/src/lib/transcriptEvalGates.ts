import type { EvalScore } from "./transcriptEval";

export type EvalGateId = `G${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20}`;
/** Non-applicable gates report passed=true and applicable=false, so every run has G1–G20 rows. */
export interface EvalGateResult { id: EvalGateId; passed: boolean; applicable: boolean; detail: string }
export type EvalPr = "A1" | "A2" | "A3" | "B0" | "B1" | "BR" | "B2" | "C" | "E" | "X" | "D";
export interface EvalGateOptions {
  /** A3 supplies the frozen mono/golden baseline; never synthesized from the candidate. */
  baseline: EvalScore;
  goldenProductionInputHash: string;
  /** PRs landed including the candidate PR; independent E ratchets persist if D lands later. */
  landed: ReadonlySet<EvalPr>;
  fixtureName: string;
}

/** Internal prerequisites; external TC-777 and real-capture evidence are checked by their own workflows. */
const prerequisites: Record<EvalPr, readonly EvalPr[]> = {
  A1: [], A2: ["A1"], A3: ["A2"], B0: ["A1", "A3"],
  B1: ["A3"], BR: ["A3", "B0"], B2: ["BR", "B1"],
  C: ["B2"], E: ["B1"], X: ["B2"], D: ["B2", "X"],
};

function validateLanded(landed: ReadonlySet<EvalPr>): void {
  for (const pr of landed) {
    for (const dependency of prerequisites[pr]) {
      if (!landed.has(dependency)) throw new Error(`${pr} requires landed ${dependency}`);
    }
  }
}

/** One percentage point or two reference words, whichever is larger. */
function delta(words: number): number { return Math.max(.01, 2 / Math.max(1, words)); }

/** A gate with missing required evidence fails closed rather than silently passing. */
export function evaluateTranscriptGates(score: EvalScore, options: EvalGateOptions): EvalGateResult[] {
  const { baseline: base, landed, fixtureName } = options;
  validateLanded(landed);
  const results: EvalGateResult[] = [];
  const hasBaseline = landed.has("A3");
  const add = (id: EvalGateId, passed: boolean, detail: string, applicable = hasBaseline) =>
    results.push({ id, passed: applicable ? passed : true, applicable, detail });
  const speakers = new Set([...Object.keys(base.speakers), ...Object.keys(score.speakers)]);
  const perSpeaker = (predicate: (candidate: NonNullable<EvalScore["speakers"][string]>, reference: NonNullable<EvalScore["speakers"][string]>) => boolean) =>
    [...speakers].every(speaker => {
      const original = base.speakers[speaker] ?? { reference: 0, output: 0, substitutions: 0, deletions: 0, insertions: 0, correct: 0, wer: null, deletionRate: 0, attributedRecall: 0 };
      const current = score.speakers[speaker] ?? { ...original, output: 0, substitutions: 0, deletions: original.reference, insertions: 0, correct: 0, wer: original.reference ? 1 : null, deletionRate: original.reference ? 1 : 0, attributedRecall: 0 };
      return predicate(current, original);
    });
  add("G1", perSpeaker((s, b) => !b.reference || (s.wer !== null && b.wer !== null && Number.isFinite(s.wer) && Number.isFinite(b.wer) && s.wer <= b.wer + delta(b.reference))), "per-speaker WER ≤ baseline + Δ");
  add("G2", perSpeaker((s, b) => !b.reference || s.deletionRate <= b.deletionRate + delta(b.reference)), "per-speaker deletion rate ≤ baseline + Δ");
  add("G3", perSpeaker((s, b) => !!b.reference || s.insertions <= b.insertions), "zero-reference speaker insertions ≤ baseline");
  add("G4", base.referenceWords === 0 && score.referenceWords === 0 && base.pooledWer === null && score.pooledWer === null ||
    base.referenceWords > 0 && score.referenceWords > 0 && base.pooledWer !== null && score.pooledWer !== null &&
    Number.isFinite(base.pooledWer) && Number.isFinite(score.pooledWer) && score.pooledWer <= base.pooledWer + .005,
    "pooled attributed WER ≤ baseline + 0.5 pt");
  add("G5", score.attributedRecall >= base.attributedRecall - delta(base.referenceWords) &&
    perSpeaker((s, b) => !b.reference || s.attributedRecall >= b.attributedRecall - delta(b.reference)), "overall and per-speaker attributed recall ≥ baseline − Δ");
  add("G6", score.misattributionRate <= base.misattributionRate + delta(base.referenceWords), "misattribution ≤ baseline + Δ");
  const tags = new Set([...Object.keys(base.tagged), ...Object.keys(score.tagged)]);
  add("G7", [...tags].every(tag => (score.tagged[tag]?.lost ?? 0) <= (base.tagged[tag]?.lost ?? 0) + Math.max(1, .02 * (base.tagged[tag]?.total ?? 0))), "tagged lost words ≤ baseline lost + max(1, 2% tagged)");
  add("G8", score.turnCovered >= base.turnCovered - 1, "turn coverage ≥ baseline − 1 turn");
  add("G9", !(base.turnCovered >= 2 && score.turnCovered < 2) && score.kendallTau >= base.kendallTau - .02, "Kendall τ ≥ baseline − 0.02; at least 2 covered turns when baseline has 2");
  add("G10", score.unexplainedSplits * 100 / Math.max(1, score.referenceSentences) <= base.unexplainedSplits * 100 / Math.max(1, base.referenceSentences) + 2, "unexplained splits per 100 reference sentences ≤ baseline + 2");
  add("G11", score.mergedTurns <= base.mergedTurns + Math.max(1, .01 * base.turnCount, 2), "merged turns ≤ baseline + Δ (max of 1% turns, 2 turns)");
  add("G12", score.bleedRate <= base.bleedRate + delta(base.speakers.Others?.reference ?? 0), "bleed ≤ baseline + Δ");
  add("G13", score.noiseInsertions <= base.noiseInsertions && !(landed.has("E") && fixtureName === "silence-only" && score.noiseInsertions !== 0), "noise insertions ≤ baseline; silence-only zero from E");
  add("G14", score.glossaryFalsePositives <= base.glossaryFalsePositives && (!landed.has("E") || score.glossaryFalsePositives === 0), "glossary false positives ≤ baseline; zero from E");
  add("G15", (score.vocabularyTotal === 0 || score.vocabularyFound / score.vocabularyTotal >= (base.vocabularyTotal ? base.vocabularyFound / base.vocabularyTotal : 0) - delta(score.vocabularyTotal)) &&
    (!landed.has("E") || score.vocabularyTotal === 0 || score.vocabularyFound / score.vocabularyTotal >= .9), "vocabulary recall ≥ baseline − Δ; ≥ 90% from E");
  add("G16", score.timingP90StartError !== null && score.timingP90StartError <= (landed.has("D") ? .3 : .5) && score.fallbackTimedShare <= .2,
    "p90 start error ≤ 0.5 s (D: 0.3 s), fallback-timed share ≤ 20%", hasBaseline && !!score.referenceWords && landed.has("B2"));
  add("G17", !!score.runtime && !!base.runtime && score.runtime.maxSseGapSeconds < 30 &&
    score.runtime.realTimeFactor <= base.runtime.realTimeFactor * (landed.has("E") ? 1.5 : 1.25) &&
    score.runtime.peakMemoryBytes <= base.runtime.peakMemoryBytes * 1.1,
    "SSE gap < 30 s; real-time ≤ 1.25× (E 1.5×); peak memory ≤ baseline + 10%");
  add("G18", !!score.productionInputHash && !!options.goldenProductionInputHash && score.productionInputHash === options.goldenProductionInputHash,
    "production input SHA-256 must exactly match golden hash");
  add("G19", score.sentenceSpanValid, "timed sentence ≤ 60 s; untimed sentence exactly whole note", hasBaseline && landed.has("BR"));
  add("G20", !!score.playback && score.playback.complete &&
    score.playback.maxToneGap !== null && Number.isFinite(score.playback.maxToneGap) && score.playback.maxToneGap <= .10 &&
    (landed.has("B2")
      ? score.playback.maxWordStartError !== null && Number.isFinite(score.playback.maxWordStartError) && score.playback.maxWordStartError <= .5
      : score.playback.speechContained),
    "per-engine maximum stereo/mono tone gap ≤ 0.10 s; speech containment (B2+: word start ≤ 0.5 s)",
    hasBaseline && landed.has("BR") && fixtureName === "multi-segment-landmarks");
  return results;
}
