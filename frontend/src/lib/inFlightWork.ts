import { useEffect, useState, useSyncExternalStore } from "react";
import { uploadRunner, type UploadStage } from "./audioUpload";
import { spaceLaneSnapshot, subscribeSpaceLane } from "./voiceNotes/voiceNoteRows";
import { captureEngineAvailable } from "./voiceNotes/captureEngine";
import { VoiceNotes } from "./voiceNotes/nativeVoiceNotes";

/** Work a re-authorisation would cut off: an open recording, or an upload, save or sync still writing. */
export type InFlightWork = "recording" | "upload" | null;

const RUNNING_UPLOAD_STAGES: readonly UploadStage[] = ["preparing", "uploading", "queued", "transcribing", "saving"];
const RECORDING_POLL_MS = 1_000;
/** The browser recorder answers status() from memory; a read slower than this is treated as no answer. */
const RECORDER_STATUS_TIMEOUT_MS = 2_000;

/**
 * While `watching`, what is running now. The recorder has no change event, so its status is read once a second. A read
 * that fails or takes longer than two seconds counts as no recording, so a broken recorder never holds Continue forever;
 * the swap checks again just before it happens.
 */
export function useInFlightWork(watching: boolean): InFlightWork {
  const uploading = useSyncExternalStore(uploadRunner.subscribe, () => {
    const stage = uploadRunner.snapshot()?.stage;
    return stage !== undefined && RUNNING_UPLOAD_STAGES.includes(stage);
  });
  const writing = useSyncExternalStore(subscribeSpaceLane, () => spaceLaneSnapshot().busy);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!watching || !captureEngineAvailable()) {
      setRecording(false);
      return;
    }
    let active = true;
    let reading = false;
    const read = () => {
      if (reading) return;
      reading = true;
      // The app's compile target predates Promise.withResolvers.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("status_timeout")), RECORDER_STATUS_TIMEOUT_MS); });
      Promise.race([VoiceNotes.status(), timeout]).then(
        (status) => { if (active) setRecording(status.intent !== "stopped"); },
        () => { if (active) setRecording(false); },
      ).finally(() => { clearTimeout(timer); reading = false; });
    };
    read();
    const poll = setInterval(read, RECORDING_POLL_MS);
    return () => { active = false; clearInterval(poll); };
  }, [watching]);
  if (recording) return "recording";
  return uploading || writing ? "upload" : null;
}
