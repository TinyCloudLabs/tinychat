import type { VoiceNoteRecording } from "./nativeVoiceNotes";

/**
 * Eviction removes this device's bytes, so keep them while a local consumer may still read them:
 * - a local import that is preparing or failed (webStore.ts:482-523 `commitPreparingSession`,
 *   `completePreparingAudio`, `failPreparingAudio`, `retryPreparingAudio` write these). Live recordings have no `localAudio` and never pin on it;
 * - an on-device Whisper job that is requested and unfinished. Only on-device notes, and notes the user
 *   explicitly chose Local for (`stt.requested`, written by the native enqueue: TranscriptionCore.swift:44,
 *   ResumableWork.kt:20-21), queue STT (desktopWhisper.ts:260-262 drains `waiting_for_model`, `queued`,
 *   `running`). Retry re-reads the staged file for `failed` and `waiting_for_model` (desktopWhisper.ts:339-345).
 *   `done` never re-reads bytes. `cancelled` pins only on mobile (`cancelledRetryable`): the native enqueue accepts a
 *   retry of a cancelled job and rewrites it to `queued`, so the staged bytes are still read. Desktop drain skips
 *   `cancelled` and retry rejects it, so desktop releases it. Every new note
 *   starts at `waiting_for_model` (webStore.ts:259); that default is not a request unless the note was recorded
 *   with `on-device` or the user chose Local, so other transcribers do not pin;
 * - a remote job whose stage is not `done`. Hosted uploads read local bytes until the transcript is saved and
 *   markHostedRemoteDone (hostedVoiceNotes.ts) writes `done`. Own-key ops never write `done`, so they pin only
 *   until `submitted`, the point after which the upload no longer reads local bytes.
 * Transcript state is not a pin. Phone producers never move `transcript.state` past `pending`: the on-device
 * transcriber writes `transcriptSync` and `outcome` only (onDeviceTranscriber.ts:282-284), and transcription
 * failures go to the space row (voiceNoteRows.ts:290). Private-cloud jobs and choices are pinned by
 * sourcePins.ts at the JS eviction gate; native stores must not initiate cache eviction themselves.
 * A note without a ledger has no verified space copy, so it pins too.
 * A note with a pending outbox entry pins as well. That check is not in this predicate: the store
 * (webStore.ts `evictCachedAudio`) and the native evict paths test the outbox directly.
 *
 * Mirrored by the native eviction checks (CaptureCore RecordingLibrary.swift, RecordingLibrary.kt).
 */
const STT_PINNED_STATES: ReadonlySet<string> = new Set(["waiting_for_model", "queued", "running", "failed"]);
const MOBILE_STT_PINNED_STATES: ReadonlySet<string> = new Set([...STT_PINNED_STATES, "cancelled"]);

export interface LocalWorkOptions {
  /** Mobile only: the native enqueue accepts a retry of a cancelled job, so its staged bytes are still needed. */
  cancelledRetryable?: boolean;
}

export function hasLocalWorkInProgress(note: VoiceNoteRecording, options: LocalWorkOptions = {}): boolean {
  const ledger = note.ledger;
  if (!ledger) return true;
  const sttState: string | undefined = note.stt?.state;
  const localIntent = note.options?.transcriber === "on-device" || note.stt?.requested === true;
  const pinnedStates = options.cancelledRetryable ? MOBILE_STT_PINNED_STATES : STT_PINNED_STATES;
  const sttPinned = localIntent && sttState !== undefined && pinnedStates.has(sttState);
  return (ledger.localAudio !== undefined && ledger.localAudio.state !== "ready")
    || sttPinned
    || (ledger.remote?.some((op) => op.stage !== "done" && (op.mode !== "own" || op.stage !== "submitted")) ?? false);
}
