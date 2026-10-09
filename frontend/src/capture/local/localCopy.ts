import type { VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";

export const LOCAL_ONLY_COPY = "Saved only on this phone (and in its backups) until you sign in.";

export function localNoteStatus(note: VoiceNoteRecording): string {
  if (note.stt?.state === "running") return `Transcribing on this phone · ${note.stt.windowsDone} windows`;
  if (note.stt?.state === "waiting_for_model") return "Waiting for the on-device model";
  if (note.stt?.state === "failed") return `Couldn't transcribe: ${note.stt.error ?? "unknown error"}`;
  if (note.stt?.state === "done") return note.ledger?.transcript.outcome === "no_speech" ? "No speech" : "Transcribed";
  if (note.recovered) return "Recovered after Exo closed";
  return "Saved on this phone";
}
