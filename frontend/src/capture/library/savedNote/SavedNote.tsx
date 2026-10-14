import { useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlatformContext } from "@/lib/platform";
import { voiceNoteTitle } from "@/lib/voiceNotes/voiceNoteStore";
import { uploadLocalVoiceNote } from "@/lib/voiceNotes/recorderSaves";
import { readableError } from "@/lib/readableError";
import { Button } from "@/components/ui/button";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder } from "../../recorder/RecorderProvider";
import { NotePipelineContext } from "../../pipeline/NotePipelineContext";
import { PipelineStepper } from "../../pipeline/PipelineStepper";
import { rowHasCommittedAudio, useNotePipeline, type NotePipelineSource } from "@/lib/voiceNotes/useNotePipeline";
import type { MeetingMetadataRead } from "@/lib/connectors/meetingExplorer";
import type { NoteAudio } from "../NoteDetailView";
import { TranscribeAction } from "../TranscribeAction";
import type { LibraryItem } from "../LibraryRow";
import { savedNoteMeta } from "./savedNoteMeta";
import { savedNoteStoreFor, type SavedNoteStore } from "./savedNoteStore";
import {
  SavedNotePage,
  SavedNoteSheet,
  type SavedNoteLayout,
} from "./SavedNoteView";
import { useSavedNoteScreen } from "./useSavedNoteScreen";

export interface SavedNoteProps {
  item: LibraryItem;
  metadata: MeetingMetadataRead | undefined;
  audio: NoteAudio | null;
  tcw: TinyCloudWeb;
  /** Where the note is read and saved; the device's note store and the space. */
  store?: SavedNoteStore;
  layout: SavedNoteLayout;
  /** The page's ← Capture; the sheet's close. */
  onBack: () => void;
  transcript: ReactNode;
  footer?: ReactNode;
}

/** A saved voice note's note and its audio, as a page or a sheet. */
export default function SavedNote({
  item,
  metadata,
  audio,
  tcw,
  store,
  layout,
  onBack,
  transcript,
  footer,
}: SavedNoteProps) {
  const recorder = useRecorder();
  const platform = useContext(PlatformContext);
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Read when the note loads, so the store (and the open editor) stay put when the row lands.
  const hasSpaceRow = useRef(item.onPhone !== true);
  hasSpaceRow.current = item.onPhone !== true;
  const space = useMemo(() => store ?? savedNoteStoreFor(tcw, () => hasSpaceRow.current), [store, tcw]);
  const screen = useSavedNoteScreen(item.sourceId, space);
  const rowMetadata = metadata?.status === "ok" ? metadata.metadata : null;
  const localOnly = (rowMetadata?.audio as { stored?: unknown } | undefined)?.stored === false;
  const hasLocalAudio = audio !== null && "localUrl" in audio;
  const capturePlatform = (rowMetadata?.capture as { platform?: string } | undefined)?.platform;
  const onDevice = capturePlatform === "ios" ? "iPhone" : capturePlatform === "tauri" ? "Mac"
    : capturePlatform === "android" ? "phone" : "browser";
  const upload = () => {
    setUploading(true);
    setUploadError(null);
    void uploadLocalVoiceNote(tcw, item.sourceId).catch((error: unknown) => setUploadError(readableError(error)))
      .finally(() => setUploading(false));
  };
  const pipelineMetadata = metadata?.status === "ok" ? metadata.metadata : undefined;
  const pipelineSource = useMemo<NotePipelineSource>(
    () => ({ tcw, rowExists: item.onPhone !== true, audioSaved: item.onPhone !== true && rowHasCommittedAudio(pipelineMetadata), metadata: pipelineMetadata }),
    [tcw, item.onPhone, pipelineMetadata],
  );
  const pipeline = useNotePipeline(item.sourceId, pipelineSource);
  const stepperShown = pipeline !== null && !pipeline.pipeline.done;
  const view = {
    screen,
    layout,
    theme,
    id: item.id,
    recordingId: item.sourceId,
    durationSecs: item.durationSecs,
    title: item.title ?? voiceNoteTitle(Date.parse(item.startedAt ?? "") || Date.now()),
    meta: savedNoteMeta(item, rowMetadata, platform, pipeline?.pipeline.done === true),
    stepper: stepperShown ? (
      <PipelineStepper
        pipeline={pipeline.pipeline}
        onAction={pipeline.onAction}
        actionError={pipeline.actionError}
        transcribeAction={localOnly && !hasLocalAudio ? null
          : <TranscribeAction noteId={item.sourceId} transcription={recorder.transcription} durationSecs={item.durationSecs} label="Try again" />}
      />
    ) : null,
    audio,
    audioStorage: localOnly ? (hasLocalAudio ? (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p>Audio stays on this {platform === "tauri" ? "Mac" : platform === "web" ? "browser" : "phone"}.</p>
        <Button type="button" variant="outline" disabled={uploading} onClick={upload}>
          {uploading ? "Uploading audio to your TinyCloud space…" : "Upload audio to TinyCloud"}
        </Button>
        {uploadError && <p role="alert">{uploadError}</p>}
      </div>
    ) : <div role="status"><p>Audio is on your {onDevice}</p><p>Transcribe on your {onDevice}</p></div>) : null,
    transcript,
    // The stepper is the route while the note is still getting here; the legacy route line would say it twice. A failed
    // metadata read is not a route: the footer's "Try again" is the only way to read it again, so it stays.
    footer: stepperShown && metadata?.status !== "failed" ? null : footer,
    partialAudio:
      recorder.captureIssues[item.sourceId]?.kind === "partial_audio",
    onBack,
  } as const;
  return (
    <NotePipelineContext.Provider value={pipeline}>
      {layout === "page" ? (
        <SavedNotePage {...view} />
      ) : (
        <SavedNoteSheet {...view} />
      )}
    </NotePipelineContext.Provider>
  );
}
