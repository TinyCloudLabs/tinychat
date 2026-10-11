// Settings → Voice notes (plan §2.7): the default transcriber for new recordings. Native-only
// (mobile voice notes don't exist on web/desktop), and signed-out capture already locks to
// on-device regardless of this choice (CaptureDefaults.options, CaptureModels.swift/.kt).
import { useEffect, useState, useSyncExternalStore } from "react";

import { CHECK_AGAIN, FINAL_COPY, privateNotOffered, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { SIGNED_OUT } from "@/capture/recorder/final/useTranscriptionChoice";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { localModelGuide, modelActionLabel } from "@/capture/recorder/final/localModelGuide";
import { isOnDeviceReady } from "@/lib/voiceNotes/onDeviceStt";
import { downloadOnDeviceModel, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { nativeVoiceNotesAvailable, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { readDefaultTranscriber, setDefaultTranscriber, subscribeTranscriberPreference } from "@/lib/voiceNotes/transcriberPreference";

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

/** The default mode as the engine holds it. A choice moves it only once the engine has taken it; a refusal is shown. */
export function useDefaultTranscriber() {
  const [value, setValue] = useState<TranscriberId | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      readDefaultTranscriber().then(setValue).catch((err: unknown) => {
        console.error("[VoiceNotes] Could not read the default transcriber", err);
        setError(`Could not read the default transcriber: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    read();
    return subscribeTranscriberPreference(read);
  }, []);
  const choose = (next: TranscriberId) => {
    setError(null);
    // The control follows the engine's default through the preference listener, so it only moves once the engine has it.
    setDefaultTranscriber(next).catch((err: unknown) => {
      console.error("[VoiceNotes] Could not save the default transcriber", err);
      setError(`Could not save the default transcriber: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  return { value, error, choose };
}

export function VoiceNotesTranscriberSettings() {
  const { transcription, signedIn } = useRecorder();
  const { value, error, choose } = useDefaultTranscriber();
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const downloadError = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.downloadError, onDeviceSttStore.downloadError);
  const modelGuide = localModelGuide(sttStatus, { start: () => void downloadOnDeviceModel(), error: downloadError });
  const modelFailed = modelGuide.action?.label === FINAL_COPY.modelTryAgain;

  if (!nativeVoiceNotesAvailable() || value === null) return null;

  const { privateOffered, options } = transcriberOptions(signedIn, transcription);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">New recordings are transcribed this way by default. Each recording can still choose a different route.</p>
      <SegmentedControl<TranscriberId> aria-label="Default transcriber" value={value} onValueChange={choose} options={options} />
      {!privateOffered && <PrivateUnavailable signedIn={signedIn} transcription={transcription} />}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {value === "on-device" && (
        <div className="flex items-center justify-between gap-3 text-xs" data-testid="voice-notes-on-device-model">
          <span className={modelFailed ? "text-destructive" : "text-muted-foreground"} role={modelFailed ? "alert" : undefined}>
            {sttStatus.models.length === 0 ? "On-device model: Checking…" : isOnDeviceReady(sttStatus) ? "On-device model: Ready" : modelGuide.reason}
          </span>
          {modelGuide.action && !isOnDeviceReady(sttStatus) && (
            <Button type="button" variant="outline" size="sm" onClick={modelGuide.action.run}>
              {modelActionLabel(modelGuide.action)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
