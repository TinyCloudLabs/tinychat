import type { VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { localNoteStatus } from "./localCopy";

export function LocalNoteRow({ note, onOpen }: { note: VoiceNoteRecording; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="w-full rounded-xl border border-border p-4 text-left">
    <span className="block font-medium">Voice note · {new Date(note.startedAt).toLocaleString()}</span>
    <span className="block text-sm text-muted-foreground">{localNoteStatus(note)}</span>
  </button>;
}
