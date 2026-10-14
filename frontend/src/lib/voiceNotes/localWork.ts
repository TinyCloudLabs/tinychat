import type { VoiceNoteRecording } from "./nativeVoiceNotes";

/**
 * Eviction removes this device's bytes, so keep them while any local consumer may still read them:
 * - a local import that is preparing or failed (no playable copy yet);
 * - an on-device Whisper job that is not done. Desktop stages the local file on every run, and
 *   cancelled, failed, and waiting states all resume by re-reading it;
 * - a transcript that is not done, unless the transcriber is `off`. `pending` is every new note's
 *   initial state, so it pins until a transcriber finishes it. Cancelled pins too: a user retry reads bytes;
 * - a remote job whose stage is not `done`. Hosted uploads read local bytes and stay non-done until the
 *   transcript is saved (markHostedRemoteDone in hostedVoiceNotes.ts). Own-key ops never write `done`, so
 *   they pin only until `submitted`, the point after which the upload no longer reads local bytes;
 * A note without a ledger has no verified space copy, so it pins too.
 *
 * Mirrored by the native eviction checks (CaptureCore RecordingLibrary.swift, RecordingLibrary.kt).
 */
export function hasLocalWorkInProgress(note: VoiceNoteRecording): boolean {
  const ledger = note.ledger;
  if (!ledger) return true;
  const transcriptUnfinished = note.options?.transcriber !== "off" && ledger.transcript?.state !== "done";
  return (ledger.localAudio !== undefined && ledger.localAudio.state !== "ready")
    || (note.stt !== undefined && note.stt.state !== "done")
    || transcriptUnfinished
    || (ledger.remote?.some((op) => op.stage !== "done" && (op.mode !== "own" || op.stage !== "submitted")) ?? false);
}
