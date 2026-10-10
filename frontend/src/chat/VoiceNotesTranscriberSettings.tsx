// Settings → Voice notes (plan §2.7): the default transcriber for new recordings. Native-only
// (mobile voice notes don't exist on web/desktop), and signed-out capture already locks to
// on-device regardless of this choice (CaptureDefaults.options, CaptureModels.swift/.kt).
import { useEffect, useState, useSyncExternalStore } from "react";

import { CHECK_AGAIN, privateNotOffered, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { SIGNED_OUT } from "@/capture/recorder/final/useTranscriptionChoice";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { onDeviceSttStore, onDeviceModelLine, primaryOnDeviceModel } from "@/lib/voiceNotes/onDeviceSttStore";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { nativeVoiceNotesAvailable, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { readDefaultTranscriber, setDefaultTranscriber } from "@/lib/voiceNotes/transcriberPreference";

type Transcription = ReturnType<typeof useRecorder>["transcription"];

/** The same three routes the recorder names; Private is offered only when the recorder would offer it. */
export function transcriberOptions(signedIn: boolean, transcription: Transcription) {
  const privateOffered = signedIn && transcription?.availability === "available";
  const options: { value: TranscriberId; label: string; disabled?: boolean }[] = [
    { value: "off", label: TRANSCRIBER_NAME.off },
    { value: "on-device", label: TRANSCRIBER_NAME["on-device"] },
    { value: "private-cloud", label: TRANSCRIBER_NAME["private-cloud"], disabled: !privateOffered },
  ];
  return { privateOffered, options };
}

/** Why Private is not offered, with the recorder's retry when its check failed. */
export function PrivateUnavailable(props: { signedIn: boolean; transcription: Transcription }) {
  const { signedIn, transcription } = props;
  const notOffered = privateNotOffered(transcription?.availability);
  return (
    <div className="flex items-center justify-between gap-3 text-xs" data-testid="voice-notes-private-unavailable">
      <span className="text-muted-foreground">
        {TRANSCRIBER_NAME["private-cloud"]}: {signedIn ? notOffered.reason : SIGNED_OUT}
      </span>
      {signedIn && notOffered.canRecheck && transcription && (
        <Button type="button" variant="outline" size="sm" onClick={transcription.onRecheck}>
          {CHECK_AGAIN}
        </Button>
      )}
    </div>
  );
}

export function VoiceNotesTranscriberSettings() {
  const { transcription, signedIn } = useRecorder();
  const [value, setValue] = useState<TranscriberId | null>(null);
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const model = primaryOnDeviceModel(sttStatus);
  const modelLine = onDeviceModelLine(sttStatus);

  useEffect(() => {
    void readDefaultTranscriber().then(setValue).catch((err: unknown) => console.warn("[VoiceNotes] Could not read the default transcriber", err));
  }, []);

  if (!nativeVoiceNotesAvailable() || value === null) return null;

  const choose = (next: TranscriberId) => {
    setValue(next);
    void setDefaultTranscriber(next).catch((err: unknown) => console.warn("[VoiceNotes] Could not save the default transcriber", err));
  };

  const { privateOffered, options } = transcriberOptions(signedIn, transcription);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">New recordings are transcribed this way by default. Each recording can still choose a different route.</p>
      <SegmentedControl<TranscriberId> aria-label="Default transcriber" value={value} onValueChange={choose} options={options} />
      {!privateOffered && <PrivateUnavailable signedIn={signedIn} transcription={transcription} />}
      {value === "on-device" && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">On-device model: {modelLine.text}</span>
          {model && model.state !== "ready" && model.state !== "downloading" && model.state !== "queued" && (
            <Button type="button" variant="outline" size="sm" onClick={() => void OnDeviceStt.downloadNow({ allowCellular: false })}>
              Download
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
