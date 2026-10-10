// Upload · Recorder · Meeting above the tab bar (TC-871), in the Soft skin.
// Recorder is the primary dark pill and starts a recording exactly as
// RecordButton does: it records when idle and reopens the recorder while one
// is under way; it waits until the recorder has heard what is already running.
import { MicIcon, UploadIcon, VideoIcon } from "lucide-react";

import { recorderActive, useRecorder } from "../recorder/RecorderProvider";
import { HOME_COPY } from "./homeCopy";

function RecorderAction() {
  const recorder = useRecorder();
  if (!recorder.available) return null;
  const idle = !recorderActive(recorder);
  return (
    <button
      type="button"
      className="soft-act soft-act-main"
      onClick={() => (idle ? recorder.record() : recorder.openSheet())}
      disabled={idle && !recorder.ready}
      aria-label={idle ? HOME_COPY.recordLabel : HOME_COPY.openRecorderLabel}
      data-testid={idle ? "voice-note-record" : "capture-open-recorder"}
    >
      <MicIcon className="soft-ico" aria-hidden="true" />
      {HOME_COPY.recorder}
    </button>
  );
}

export function SoftActions(props: {
  onUpload: () => void;
  onMeeting?: () => void;
}) {
  return (
    <div className="soft-actions" data-testid="capture-actions">
      <button
        type="button"
        className="soft-act"
        onClick={props.onUpload}
        aria-label={HOME_COPY.uploadLabel}
        data-testid="capture-upload"
      >
        <UploadIcon className="soft-ico" aria-hidden="true" />
        {HOME_COPY.upload}
      </button>
      <RecorderAction />
      {props.onMeeting && (
        <button
          type="button"
          className="soft-act"
          onClick={props.onMeeting}
          aria-label={HOME_COPY.meetingLabel}
          data-testid="capture-meeting"
        >
          <VideoIcon className="soft-ico" aria-hidden="true" />
          {HOME_COPY.meeting}
        </button>
      )}
    </div>
  );
}
