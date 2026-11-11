import { readableError } from "@/lib/readableError";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceNotes, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { clearDeletedPartialAudioIssue } from "../recorder/partialAudioIssues";
import { captureEvents } from "../captureEvents";
import { pruneDeletedFailureNotification } from "../activity/failureNotifications";

export function useLocalNotes(did: string | null, offline = false) {
  const view = useRef({ did, offline });
  view.current = { did, offline };
  const loadedView = useRef<{ did: string | null; offline: boolean; accountDid: string | null } | null>(null);
  const [notes, setNotes] = useState<VoiceNoteRecording[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const current = () => view.current.did === did && view.current.offline === offline;
    try {
      const effectiveDid = offline && !did ? (await VoiceNotes.getCaptureDefaults()).accountDid : did;
      const listed = await VoiceNotes.listPending();
      if (!current()) return;
      loadedView.current = { did, offline, accountDid: effectiveDid };
      setNotes(listed.recordings.filter((note) => note.owner == null || (effectiveDid !== null && note.owner === effectiveDid))
        .sort((a, b) => b.startedAt - a.startedAt));
      setError(null);
    } catch (caught) {
      if (current()) { loadedView.current = { did, offline, accountDid: null }; setError(readableError(caught)); }
    }
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
  const visible = loadedView.current?.did === did && loadedView.current.offline === offline;
  return { accountDid: visible ? loadedView.current!.accountDid : null, notes: visible ? notes : [], error: visible ? error : null, refresh, remove };
}
