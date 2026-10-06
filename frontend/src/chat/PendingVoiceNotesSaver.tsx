// TC-515: voice notes recorded offline (or whose save failed) wait on the phone
// (`listPending()`). Once the session is back, save them, without waiting for the
// user to open Connectors, where the Voice notes card's own mount-time retry
// would otherwise be the only thing to try.
//
// It is the card's retry: the same module-level single-flight
// (`savePendingRecordings`), so it never uploads a recording a second time
// alongside the card or the chat screen's bar. Saved notes go to private cloud
// transcription exactly as the card hands them over (when it is on for this
// account). Headless, like the app's other once-per-session lanes.

import { useEffect } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { nativeVoiceNotesAvailable } from "@/lib/voiceNotes/nativeVoiceNotes";
import { voiceNoteTranscriberFor, type VoiceNoteTranscriber } from "@/lib/voiceNotes/voiceNoteTranscription";
import { savePendingRecordings, type PendingRun } from "@/lib/voiceNotes/recorderSaves";

/**
 * Save what is on the phone, and hand each saved note to transcription. The availability check
 * runs alongside the save, so a note is offered to private cloud only once the account's
 * answer is in (`noteSaved` ignores it otherwise, as for the card).
 */
export async function savePendingVoiceNotes(deps: {
  save: () => Promise<PendingRun>;
  transcriber: Pick<VoiceNoteTranscriber, "check" | "noteSaved"> | null;
}): Promise<PendingRun> {
  const [run] = await Promise.all([deps.save(), deps.transcriber?.check()]);
  for (const recording of run.saved) deps.transcriber?.noteSaved(recording);
  return run;
}

export function PendingVoiceNotesSaver({
  tcw,
  backendUrl,
  sessionStore,
}: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
}) {
  useEffect(() => {
    if (!nativeVoiceNotesAvailable()) return;
    void savePendingVoiceNotes({
      save: () => savePendingRecordings(tcw),
      transcriber: voiceNoteTranscriberFor(tcw, backendUrl, sessionStore),
    })
      .then((run) => {
        if (run.lastError) console.warn("[VoiceNotes] Some notes are still on this phone:", run.lastError);
      })
      .catch((error: unknown) => console.warn("[VoiceNotes] Saving notes left on this phone failed", error));
  }, [backendUrl, sessionStore, tcw]);
  return null;
}
