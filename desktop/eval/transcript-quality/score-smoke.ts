import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scoreTranscript, type EvalExpected } from "../../../frontend/src/lib/transcriptEval";
import { whisperLocalTranscript } from "../../../frontend/src/lib/voiceNotes/desktop/whisperTranscript";
import { localTranscriptToSave } from "../../../frontend/src/lib/voiceNotes/voiceNoteStore";
import type { BatchResponse } from "../../../frontend/src/lib/anarlog/transcription.gen";
import type { WhisperModel } from "../../../frontend/src/lib/localTranscriber";

const [fixtureDir, outputDir] = process.argv.slice(2);
if (!fixtureDir || !outputDir) throw new Error("usage: bun score-smoke.ts FIXTURE_DIR RUN_DIR");
const expected = JSON.parse(await readFile(join(fixtureDir, "expected.json"), "utf8")) as EvalExpected;
const response = JSON.parse(await readFile(join(outputDir, "response.json"), "utf8")) as BatchResponse;
const run = JSON.parse(await readFile(join(outputDir, "run.json"), "utf8")) as {
  modelPath: string; noteDurationSeconds: number; input: string; vocabulary: string;
};
if (expected.version !== 1 || run.input !== "mono" || run.vocabulary !== "off" ||
    !Number.isFinite(run.noteDurationSeconds) || run.noteDurationSeconds <= 0) {
  throw new Error("invalid A2 smoke fixture or runner metadata");
}
const model: WhisperModel = run.modelPath.includes("tiny.en") ? "QuantizedTinyEn" :
  run.modelPath.includes("small") ? "QuantizedSmall" :
  run.modelPath.includes("large") ? "QuantizedLargeTurbo" : "QuantizedBase";
const local = whisperLocalTranscript({ id: "smoke", durationMs: Math.round(run.noteDurationSeconds * 1000) },
  model, response, { detail: true });
const sentences = localTranscriptToSave(local).sentences;
if (!sentences.length) throw new Error("smoke fixture produced no saved speech");
const score = scoreTranscript({ expected, sentences, noteDurationSeconds: run.noteDurationSeconds });
console.log(JSON.stringify({ transcript: sentences.map(sentence => sentence.text), score }, null, 2));
