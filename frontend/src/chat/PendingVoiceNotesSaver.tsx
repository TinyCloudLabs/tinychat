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

import { nativeVoiceNotesAvailable, VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { syncOnDeviceTranscript } from "@/lib/voiceNotes/onDeviceTranscriber";
import { voiceNoteTranscriberFor, type VoiceNoteTranscriber } from "@/lib/voiceNotes/voiceNoteTranscription";
import { savePendingRecordings, type PendingRun } from "@/lib/voiceNotes/recorderSaves";

/**
 * An on-device transcription that finishes after its note is already saved (the common case: the
 * space save is quick, on-device decode is not) has nothing left to trigger `saveRecording`'s own
 * sync, so this listens for it directly. `saveRecording` covers the opposite ordering.
 */
function installOnDeviceTranscriptSync(tcw: TinyCloudWeb): () => void {
  let disposed = false;
  const handle = OnDeviceStt.addListener("transcribed", ({ id }) => {
    if (disposed) return;
    void VoiceNotes.listPending()
      .then(({ recordings }) => {
        const recording = recordings.find((note) => note.id === id);
        if (recording) return syncOnDeviceTranscript(tcw, recording);
      })
      .catch((err: unknown) => console.warn("[OnDeviceStt] Could not sync a finished transcription", err));
  });
  return () => {
    disposed = true;
    void handle.then((h) => h.remove());
  };
}

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
  // A note the user chose on-device for runs through ExoStt/stt instead (committed-event driven,
  // not from here); private cloud never also picks it up.
  for (const recording of run.saved) if (recording.options?.transcriber !== "on-device") deps.transcriber?.noteSaved(recording);
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
    return installOnDeviceTranscriptSync(tcw);
  }, [tcw]);

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
