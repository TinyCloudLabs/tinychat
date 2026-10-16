import { readableError } from "@/lib/readableError";
import { useCallback, useEffect, useState } from "react";
import { VoiceNotes, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { clearDeletedPartialAudioIssue } from "../recorder/partialAudioIssues";
import { captureEvents } from "../captureEvents";
import { pruneDeletedFailureNotification } from "../activity/failureNotifications";

export function useLocalNotes(did: string | null, offline = false) {
  const [notes, setNotes] = useState<VoiceNoteRecording[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const effectiveDid = offline && !did ? (await VoiceNotes.getCaptureDefaults()).accountDid : did;
      const listed = await VoiceNotes.listPending();
      setNotes(listed.recordings.filter((note) => note.owner == null || (effectiveDid !== null && note.owner === effectiveDid))
        .sort((a, b) => b.startedAt - a.startedAt));
      setError(null);
    } catch (caught) { setError(readableError(caught)); }
  }, [did, offline]);
  useEffect(() => {
    void refresh();
    const events = ["committed", "recovered"] as const;
    const handles = events.map((event) => VoiceNotes.addListener(event, () => { void refresh(); }));
    return () => { for (const handle of handles) void handle.then((h) => h.remove()); };
  }, [refresh]);
  const remove = useCallback(async (id: string) => {
    await VoiceNotes.deleteAudio({ id });
    if (did) pruneDeletedFailureNotification(did, id);
    captureEvents.emit("note-deleted", { source: "exo-voice-note", sourceId: id });
    clearDeletedPartialAudioIssue(id);
    await refresh();
  }, [did, refresh]);
  return { notes, error, refresh, remove };
}
