// Shared transcript normalization and saving for desktop notes and uploads.
// Local recording capture runs through the shared recorder engine.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { upsertMeeting, type NormalizedMeeting, type StoreResult, type UpsertMeetingOutcome } from "./connectors/connectorStore";
import type { FirefliesSentence } from "./connectors/firefliesClient";
import { localChannelLabel, localTranscriptTurns, type LocalWord } from "./localTranscriptTurns";
import type { BatchResponse } from "./anarlog/transcription.gen";

/** Source of local transcripts saved in the Meetings store. */
export const LOCAL_MEETING_SOURCE = "exo-local";
export const LOCAL_MEETING_SOURCE_LABEL = "Exo Local";

export type WhisperModel =
  | "QuantizedTinyEn"
  | "QuantizedTiny"
  | "QuantizedBaseEn"
  | "QuantizedBase"
  | "QuantizedSmallEn"
  | "QuantizedSmall"
  | "QuantizedLargeTurbo";

export interface LocalWhisperModel {
  id: WhisperModel;
  label: string;
  /** English-only ggml models transcribe English better than their multilingual twin. */
  englishOnly: boolean;
  /** Approximate on-disk size; shown so the download isn't a surprise. */
  approxSizeMb: number;
}

/** Quantized whisper.cpp models exposed at the pinned rev. Sizes are anarlog's
 *  `WhisperModel::model_size_bytes` (crates/whisper-local-model) in decimal MB. */
export const LOCAL_WHISPER_MODELS: readonly LocalWhisperModel[] = [
  { id: "QuantizedTinyEn", label: "Whisper Tiny (English)", englishOnly: true, approxSizeMb: 44 },
  { id: "QuantizedTiny", label: "Whisper Tiny (multilingual)", englishOnly: false, approxSizeMb: 44 },
  { id: "QuantizedBaseEn", label: "Whisper Base (English)", englishOnly: true, approxSizeMb: 82 },
  { id: "QuantizedBase", label: "Whisper Base (multilingual)", englishOnly: false, approxSizeMb: 82 },
  { id: "QuantizedSmallEn", label: "Whisper Small (English)", englishOnly: true, approxSizeMb: 264 },
  { id: "QuantizedSmall", label: "Whisper Small (multilingual)", englishOnly: false, approxSizeMb: 264 },
  { id: "QuantizedLargeTurbo", label: "Whisper Large Turbo", englishOnly: false, approxSizeMb: 874 },
];

/** A transcript made on this Mac by whisper.cpp. */
export interface OnDeviceTranscriptResult {
  engine?: "on-device";
  sessionId: string;
  /** ISO timestamp captured at start(), used for the meeting's startedAt. */
  startedAt: string;
  model: WhisperModel;
  language: string;
  /** Raw whisper.cpp batch response (channels → alternatives → words). */
  response: BatchResponse;
}

export type LocalTranscriptResult = OnDeviceTranscriptResult;

/** A bounded transcript save timed out. */
class LocalTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalTimeoutError";
  }
}

const ignore = () => {};

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LocalTimeoutError(`Timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ── Normalization → Meetings store ─────────────────────────────────────

function collectWords(response: BatchResponse): LocalWord[] {
  const words: LocalWord[] = [];
  for (const channel of response.results?.channels ?? []) {
    const alt = channel.alternatives?.[0];
    for (const w of alt?.words ?? []) {
      const text = (w.punctuated_word ?? w.word ?? "").trim();
      if (!text) continue;
      const start = Number.isFinite(w.start) ? w.start : null;
      const end = Number.isFinite(w.end) ? w.end : null;
      if (start === null || end === null) continue;
      words.push({ text, start, end, channel: w.channel });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

export function normalizeLocalTranscript(
  r: LocalTranscriptResult,
): { meeting: NormalizedMeeting; sentences: FirefliesSentence[] } {
  const sentences = localTranscriptTurns(collectWords(r.response));

  // Fallback: a channel alternative with a transcript but no word timings still
  // saves as one sentence, rather than silently dropping speech.
  if (sentences.length === 0) {
    for (const [i, channel] of (r.response.results?.channels ?? []).entries()) {
      const text = channel.alternatives?.[0]?.transcript?.trim();
      if (!text) continue;
      sentences.push({
        index: sentences.length,
        speaker_name: localChannelLabel(i),
        text,
        start_time: 0,
        end_time: 0,
      });
    }
  }

  // Turns are ordered by start, so the last one need not end last.
  const lastEnd = sentences.reduce((end, s) => Math.max(end, s.end_time), 0);
  const transcriptText = sentences.map((s) => s.text).join("\n");
  const speakerNames = [...new Set(sentences.map((s) => s.speaker_name).filter((n): n is string => n !== null))];
  const started = r.startedAt;

  return {
    meeting: {
      id: crypto.randomUUID(),
      source: LOCAL_MEETING_SOURCE,
      sourceId: `local:${r.sessionId}`,
      title: `Local recording ${new Date(started).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`,
      startedAt: started,
      durationSecs: lastEnd > 0 ? Math.round(lastEnd) : null,
      organizerEmail: null,
      participants: speakerNames.map((name) => ({ name, email: null })),
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: {
        capture: "local",
        transcript_provider: "whispercpp",
        model: r.model,
        language: r.language,
        transcript_text: transcriptText || null,
        // Deliberately no audio_path: the recording stays on this Mac and the
        // space must not learn a local filesystem path.
        speaker_labels: "channel-you-others",
      },
    },
    sentences,
  };
}

/** A normalized transcript with speech, ready to save (and to re-save verbatim on retry). */
export type PreparedLocalTranscript = ReturnType<typeof normalizeLocalTranscript>;

export const NO_SPEECH_MESSAGE = "No speech was transcribed — nothing was saved.";

/** Normalize once for the save and every retry of it. Throws when there is no
 *  speech, so silence never becomes an empty meeting. */
export function prepareLocalTranscript(r: LocalTranscriptResult): PreparedLocalTranscript {
  const prepared = normalizeLocalTranscript(r);
  if (prepared.sentences.length === 0) throw new Error(NO_SPEECH_MESSAGE);
  return prepared;
}

/** Write the local transcript into the user's space. upsertMeeting is keyed on
 *  (source, sourceId) and rewrites the transcript KV body, so re-running it
 *  with the same prepared value repairs a partial earlier write. */
export async function saveLocalTranscript(
  tcw: TinyCloudWeb,
  prepared: PreparedLocalTranscript,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  return upsertMeeting(tcw, prepared.meeting, prepared.sentences);
}

/** How long one TinyCloud save (meeting row + transcript body) may take. */
const LOCAL_SAVE_TIMEOUT_MS = 60_000;

export type LocalTranscriptSaver = (
  prepared: PreparedLocalTranscript,
) => Promise<StoreResult<UpsertMeetingOutcome>>;

/**
 * Saves one prepared transcript at a time, each bounded by `timeoutMs`. A save
 * that timed out may still be writing, so the next one first waits (also
 * bounded) for it to settle instead of writing beside it.
 */
export function createLocalTranscriptSaver(
  tcw: TinyCloudWeb,
  options: { timeoutMs?: number; save?: typeof saveLocalTranscript } = {},
): LocalTranscriptSaver {
  const timeoutMs = options.timeoutMs ?? LOCAL_SAVE_TIMEOUT_MS;
  const save = options.save ?? saveLocalTranscript;
  /** The last save started, until it settles — even after its caller timed out. */
  let writing: Promise<unknown> | null = null;
  let busy = false;
  return async (prepared) => {
    if (busy) throw new Error("The transcript is already being saved");
    busy = true;
    try {
      if (writing !== null) {
        await withTimeout(writing.then(ignore, ignore), timeoutMs, "the previous save to finish");
      }
      const attempt = save(tcw, prepared);
      writing = attempt;
      const settled = () => {
        if (writing === attempt) writing = null;
      };
      attempt.then(settled, settled);
      return await withTimeout(attempt, timeoutMs, "TinyCloud to save the transcript");
    } finally {
      busy = false;
    }
  };
}
