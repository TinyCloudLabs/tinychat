import type { VoiceNoteRecording } from "./nativeVoiceNotes";

/**
 * Eviction removes this device's bytes, so keep them while a local consumer may still read them:
 * - a local import that is preparing or failed (webStore.ts:482-523 `commitPreparingSession`,
 *   `completePreparingAudio`, `failPreparingAudio`, `retryPreparingAudio` write these). Live recordings have no `localAudio` and never pin on it;
 * - an on-device Whisper job that is requested and unfinished. Only `on-device` notes queue STT
 *   (desktopWhisper.ts:260-262 drains `waiting_for_model`, `queued`, `running`). Retry re-reads the staged
 *   file for `failed` and `waiting_for_model` (desktopWhisper.ts:339-345). `cancelled` and `done` never
 *   re-read bytes: drain skips `cancelled` and retry rejects it. Every new note starts at `waiting_for_model`
 *   (webStore.ts:259); that default is not a request unless the note was recorded with `on-device`, so other transcribers do not pin;
 * - a remote job whose stage is not `done`. Hosted uploads read local bytes until the transcript is saved and
 *   markHostedRemoteDone (hostedVoiceNotes.ts) writes `done`. Own-key ops never write `done`, so they pin only
 *   until `submitted`, the point after which the upload no longer reads local bytes.
 * Transcript state is not a pin. Phone producers never move `transcript.state` past `pending`: the on-device
 * transcriber writes `transcriptSync` and `outcome` only (onDeviceTranscriber.ts:282-284), and transcription
 * failures go to the space row (voiceNoteRows.ts:290). Private-cloud jobs read the space copy once local bytes
 * are gone (voiceNoteTranscription.ts:1272-1280).
 * A note without a ledger has no verified space copy, so it pins too.
 * A note with a pending outbox entry pins as well. That check is not in this predicate: the store
 * (webStore.ts `evictCachedAudio`) and the native evict paths test the outbox directly.
 *
 * Mirrored by the native eviction checks (CaptureCore RecordingLibrary.swift, RecordingLibrary.kt).
 */
const STT_PINNED_STATES: ReadonlySet<string> = new Set(["waiting_for_model", "queued", "running", "failed"]);

export function hasLocalWorkInProgress(note: VoiceNoteRecording): boolean {
  const ledger = note.ledger;
  if (!ledger) return true;
  const sttState: string | undefined = note.stt?.state;
  const sttPinned = note.options?.transcriber === "on-device" && sttState !== undefined && STT_PINNED_STATES.has(sttState);
  return (ledger.localAudio !== undefined && ledger.localAudio.state !== "ready")
    || sttPinned
    || (ledger.remote?.some((op) => op.stage !== "done" && (op.mode !== "own" || op.stage !== "submitted")) ?? false);
}
