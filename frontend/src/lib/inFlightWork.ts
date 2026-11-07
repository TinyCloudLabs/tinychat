import { useEffect, useState, useSyncExternalStore } from "react";
import { uploadRunner, type UploadStage } from "./audioUpload";
import { spaceLaneSnapshot, subscribeSpaceLane } from "./spaceWriteLane";
import { captureEngineAvailable } from "./voiceNotes/captureEngine";
import { VoiceNotes } from "./voiceNotes/nativeVoiceNotes";

/** Work a re-authorisation would cut off: an open recording, or an upload, save or sync still writing. */
export type InFlightWork = "recording" | "upload" | null;

const RUNNING_UPLOAD_STAGES: readonly UploadStage[] = ["preparing", "uploading", "queued", "transcribing", "saving"];
const RECORDING_POLL_MS = 1_000;

/** While `watching`, what is running now. The recorder has no change event, so its status is read once a second. */
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
    const read = () => {
      VoiceNotes.status().then(
        (status) => { if (active) setRecording(status.intent !== "stopped"); },
        // An unreadable recorder counts as recording: asking waits rather than risk cutting one off.
        () => { if (active) setRecording(true); },
      );
    };
    read();
    const timer = setInterval(read, RECORDING_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [watching]);
  if (recording) return "recording";
  return uploading || writing ? "upload" : null;
}
