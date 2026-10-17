import { readableError } from "@/lib/readableError";
// Settings → Voice notes: when recordings stop by themselves and the audio preference are available on every capture
// surface. Native transcription controls remain available only when their engine is present.
import { useContext, useEffect, useState, useSyncExternalStore } from "react";

import { homePlace, placeWhere } from "@/capture/home/desktop/desktopCopy";
import { CHECK_AGAIN, FINAL_COPY, privateNotOffered, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { SIGNED_OUT } from "@/capture/recorder/final/useTranscriptionChoice";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { PlatformContext } from "@/lib/platform";
import { useStorageReadOnly } from "@/lib/useStorageReadOnly";
import { localModelGuide, modelActionLabel } from "@/capture/recorder/final/localModelGuide";
import { isAppleSpeech, isOnDeviceReady, isOnDeviceStatusLoaded } from "@/lib/voiceNotes/onDeviceStt";
import { downloadOnDeviceModel, ensureOnDeviceModel, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { nativeVoiceNotesAvailable, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { effectiveTranscriber, readDefaultTranscriber, readStopAfterPreference, readUploadAudioPreference, setDefaultTranscriber, setStopAfterPreference, setUploadAudioPreference, subscribeTranscriberPreference } from "@/lib/voiceNotes/transcriberPreference";
import type { StopAfter } from "@/lib/voiceNotes/recordingSettings";
import { readLocalState } from "@/lib/voiceNotes/recordingSettingsLocal";
import { deviceName } from "@/lib/platform";

type Transcription = ReturnType<typeof useRecorder>["transcription"];

const UPLOAD_PAUSED = "Paused: storage full";

/** "Off" keeps only the 3-hour limit every recorder enforces, so it says so. */
const STOP_AFTER_OPTIONS: readonly { value: StopAfter; label: string }[] = [
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "60", label: "1 h" },
  { value: "120", label: "2 h" },
  { value: "off", label: "Off (3-hour limit)" },
];

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
  const stopAfter = useSyncExternalStore(subscribeTranscriberPreference, readStopAfterPreference, readStopAfterPreference);
  // The default the user chose (here or on another device); never the untouched default, so nobody is told about a choice they did not make.
  const chosenDefault = useSyncExternalStore(subscribeTranscriberPreference, () => readLocalState()?.fields.transcriber, () => undefined);
  const storageFull = useStorageReadOnly();
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

  const where = platform === "ios" || platform === "android" ? "on this phone" : placeWhere(homePlace(platform));
  const uploadHelp = uploadAudio
    ? "A copy of the audio is kept in your TinyCloud space. Transcripts and notes sync too. Private transcription still sends audio to be transcribed, then deletes it."
    : `Audio stays ${where}${platform === "web" ? ", and browsers can delete it" : ""}. Turn this on to keep a copy in TinyCloud. Transcripts and notes still sync to your TinyCloud space. Private transcription still sends audio to be transcribed, then deletes it.`;

  const stopAfterSetting = (
    <div className="flex flex-col gap-1" data-testid="voice-notes-stop-after">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label htmlFor="stop-recording-after" className="text-sm">Stop recording after</label>
        <select
          id="stop-recording-after"
          value={stopAfter}
          onChange={(event) => setStopAfterPreference(event.target.value as StopAfter)}
          className="min-h-11 max-w-full rounded-md border border-border bg-background px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-9 fine:text-sm"
        >
          {STOP_AFTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        {signedIn
          ? "New recordings stop by themselves after this long, on all your devices. Recordings never run longer than 3 hours."
          : "New recordings stop by themselves after this long. Recordings never run longer than 3 hours."}
      </p>
    </div>
  );
  // The saved choice follows the account to every device; one that cannot run it keeps the choice and says what it uses.
  const usedHere = chosenDefault !== undefined && signedIn ? effectiveTranscriber(chosenDefault, signedIn) : undefined;
  const fallbackNote = chosenDefault !== undefined && usedHere !== undefined && usedHere !== chosenDefault && (
    <p role="status" className="text-xs text-muted-foreground" data-testid="voice-notes-default-fallback">
      Your default is {TRANSCRIBER_NAME[chosenDefault]}, which {deviceName(platform)} can't run, so recordings here use {TRANSCRIBER_NAME[usedHere]}.{usedHere === "private-cloud" && " Private sends audio to be transcribed, then deletes it."} Your other devices keep {TRANSCRIBER_NAME[chosenDefault]}.
    </p>
  );
  const uploadSetting = (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex min-h-11 items-center">
          {/* A 44 px touch target around the 16 px box; the negative margins pull the visible box to the card's text edge. */}
          <label htmlFor="upload-audio-to-tinycloud" className="-ml-3.5 flex size-11 shrink-0 cursor-pointer items-center justify-center">
            <input id="upload-audio-to-tinycloud" type="checkbox" className="size-4 accent-primary" checked={uploadAudio}
              onChange={(event) => {
                setUploadError(null);
                void setUploadAudioPreference(event.target.checked).catch((caught: unknown) => setUploadError(readableError(caught)));
              }} />
          </label>
          <label htmlFor="upload-audio-to-tinycloud" className="-ml-1.5 cursor-pointer text-sm">Upload audio to TinyCloud</label>
          <InfoTip label="About audio storage" className="-my-3 fine:-my-1">Other devices cannot play or transcribe local-only audio. This device holds the only copy. Local transcription, chat and quota still work. You can upload an individual note later.</InfoTip>
        </div>
        <p className="pl-6 text-xs text-muted-foreground" data-testid="voice-notes-upload-help">{uploadHelp}</p>
        {storageFull && <p role="status" className="pl-6 text-xs text-muted-foreground">{UPLOAD_PAUSED}</p>}
      </div>
      {uploadError && <p role="alert" className="text-xs text-destructive">{uploadError}</p>}
    </>
  );

  if (!nativeVoiceNotesAvailable() || value === null) return <div className="flex flex-col gap-3">{stopAfterSetting}{fallbackNote}{uploadSetting}</div>;

  const { privateOffered, options } = transcriberOptions(signedIn, transcription);

  return (
    <div className="flex flex-col gap-3">
      {stopAfterSetting}
      {fallbackNote}
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
