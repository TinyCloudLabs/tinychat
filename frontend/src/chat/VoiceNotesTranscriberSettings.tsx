import { readableError } from "@/lib/readableError";
// Settings → Voice notes: the audio preference is available on every capture surface.
// Native transcription controls remain available only when their engine is present.
import { useContext, useEffect, useState, useSyncExternalStore } from "react";

import { CHECK_AGAIN, FINAL_COPY, privateNotOffered, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { SIGNED_OUT } from "@/capture/recorder/final/useTranscriptionChoice";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { PlatformContext } from "@/lib/platform";
import { localModelGuide, modelActionLabel } from "@/capture/recorder/final/localModelGuide";
import { isAppleSpeech, isOnDeviceReady, isOnDeviceStatusLoaded } from "@/lib/voiceNotes/onDeviceStt";
import { downloadOnDeviceModel, ensureOnDeviceModel, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { nativeVoiceNotesAvailable, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { readDefaultTranscriber, readUploadAudioPreference, setDefaultTranscriber, setUploadAudioPreference, subscribeTranscriberPreference } from "@/lib/voiceNotes/transcriberPreference";

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
  const notOffered = privateNotOffered(transcription?.availability, transcription?.checkErrorCode);
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
    if (!nativeVoiceNotesAvailable()) return;
    const read = () => {
      readDefaultTranscriber().then(setValue).catch((err: unknown) => {
        console.error("[VoiceNotes] Could not read the default transcriber", err);
        setError(`Could not read the default transcriber: ${readableError(err)}`);
      });
    };
    read();
    return subscribeTranscriberPreference(read);
  }, []);
  const choose = (next: TranscriberId) => {
    setError(null);
    // The control follows the engine's default through the preference listener, so it only moves once the engine has it.
    setDefaultTranscriber(next).then(
      // Choosing Local here is the request for the on-device model; keeping or restoring it elsewhere is not.
      () => { if (next === "on-device" && captureCapabilities().localTranscription) ensureOnDeviceModel({ retry: true }); },
      (err: unknown) => {
        console.error("[VoiceNotes] Could not save the default transcriber", err);
        setError(`Could not save the default transcriber: ${readableError(err)}`);
      },
    );
  };
  return { value, error, choose };
}

export function VoiceNotesTranscriberSettings() {
  const platform = useContext(PlatformContext);
  const uploadAudio = useSyncExternalStore(subscribeTranscriberPreference, readUploadAudioPreference, readUploadAudioPreference);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { transcription, signedIn } = useRecorder();
  const { value, error, choose } = useDefaultTranscriber();
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const downloadError = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.downloadError, onDeviceSttStore.downloadError);
  const modelGuide = localModelGuide(sttStatus, { start: () => void downloadOnDeviceModel(), error: downloadError });
  const modelLabel = isAppleSpeech(sttStatus) ? "On-device speech" : "On-device model";
  const modelFailed = modelGuide.action?.label === FINAL_COPY.modelTryAgain;

  useEffect(() => {
    if (platform === "web") void navigator.storage?.persist?.().catch(() => undefined);
  }, [platform]);

  const uploadSetting = (
    <>
      <div className="flex items-start gap-3">
        <input id="upload-audio-to-tinycloud" type="checkbox" checked={uploadAudio}
          onChange={(event) => {
            setUploadError(null);
            void setUploadAudioPreference(event.target.checked).catch((caught: unknown) => setUploadError(readableError(caught)));
          }} />
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="upload-audio-to-tinycloud">Upload audio to TinyCloud</label>
          <p className="text-xs text-muted-foreground">Audio stays on this {platform === "tauri" ? "Mac" : platform === "web" ? "browser" : "phone"}. Transcripts and notes still sync to your TinyCloud space. Private transcription still sends audio to be transcribed, then deletes it.</p>
          {platform === "web" && <p className="text-xs text-muted-foreground">Audio stays in this browser. Browsers can delete it. Turn on Upload audio to keep a copy in TinyCloud.</p>}
          <InfoTip label="About audio storage">Other devices cannot play or transcribe local-only audio. This device holds the only copy. Local transcription, chat and quota still work. You can upload an individual note later.</InfoTip>
        </div>
      </div>
      {uploadError && <p role="alert" className="text-xs text-destructive">{uploadError}</p>}
    </>
  );

  if (!nativeVoiceNotesAvailable() || value === null) return <div className="flex flex-col gap-3">{uploadSetting}</div>;

  const { privateOffered, options } = transcriberOptions(signedIn, transcription);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">New recordings are transcribed this way by default. Each recording can still choose a different route.</p>
      {uploadSetting}
      <SegmentedControl<TranscriberId> aria-label="Default transcriber" value={value} onValueChange={choose} options={options} />
      {!privateOffered && <PrivateUnavailable signedIn={signedIn} transcription={transcription} />}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {value === "on-device" && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 text-xs" data-testid="voice-notes-on-device-model">
          <span className={modelFailed ? "text-destructive" : "text-muted-foreground"} role={modelFailed ? "alert" : undefined}>
            {!isOnDeviceStatusLoaded(sttStatus) ? `${modelLabel}: Checking…` : isOnDeviceReady(sttStatus) ? `${modelLabel}: Ready` : modelGuide.reason}
          </span>
          {modelGuide.action && !isOnDeviceReady(sttStatus) && (
            <Button type="button" variant="outline" size="sm" onClick={modelGuide.action.run} className="ml-auto">
              {modelActionLabel(modelGuide.action)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
