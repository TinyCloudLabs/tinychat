import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlatformContext } from "@/lib/platform";
import { voiceNoteTitle } from "@/lib/voiceNotes/voiceNoteStore";
import { uploadLocalVoiceNote } from "@/lib/voiceNotes/recorderSaves";
import { readableError } from "@/lib/readableError";
import { Button } from "@/components/ui/button";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder } from "../../recorder/RecorderProvider";
import { NotePipelineContext } from "../../pipeline/NotePipelineContext";
import { activityForNote, noteStatus } from "../../activity/activitySelector";
import { TranscribeAction } from "../TranscribeAction";
import { rowHasCommittedAudio, useNotePipeline, type NotePipelineSource, type NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { MeetingMetadataRead } from "@/lib/connectors/meetingExplorer";
import type { NoteAudio } from "../NoteDetailView";
import { privateAudioSourceFromMetadata } from "@/capture/recorder/transcriptionProps";
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
  activityControl?: ReactNode;
}

/** A saved voice note's note and its audio, as a page or a sheet. */
function SavedNoteContent({
  item,
  metadata,
  audio,
  tcw,
  store,
  layout,
  onBack,
  transcript,
  footer,
  activityControl,
  pipeline,
}: SavedNoteProps & { pipeline: NotePipelineView | null }) {
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
  const privateAudioSource = privateAudioSourceFromMetadata(rowMetadata);
  const localOnly = (rowMetadata?.audio as { stored?: unknown } | undefined)?.stored === false;
  const hasLocalAudio = audio !== null && ("localUrl" in audio || audio.onPhone === true);
  const upload = () => {
    setUploading(true);
    setUploadError(null);
    void uploadLocalVoiceNote(tcw, item.sourceId, true).catch((error: unknown) => setUploadError(readableError(error)))
      .finally(() => setUploading(false));
  };
  const stepperShown = pipeline !== null && !pipeline.pipeline.done;
  const jobs = activityForNote(pipeline ?? undefined, platform);
  // The Transcript fallback owns the durable failure's explanation and retry action.
  // The Transcript section, where the transcript will appear, carries the transcription status.
  const statusJobs = jobs.filter((job) => job.kind !== "transcribe");
  const status = noteStatus(statusJobs, pipeline?.pipeline, false);
  const actions = statusJobs.flatMap((job) => job.action ? [job.action] : job.retry ? [{ label: "Try again", run: job.retry }] : []);
  const cloudFailedWithoutRetry = pipeline?.input?.route === "private-cloud" && pipeline.pipeline.steps.some((step) => step.key === "transcript" && step.state === "failed" && !step.blocker?.action);
  const view = {
    screen,
    layout,
    theme,
    id: item.id,
    recordingId: item.sourceId,
    durationSecs: item.durationSecs,
    channels: (rowMetadata?.capture as { channels?: number } | undefined)?.channels === 2 || audio?.channels === 2 ? 2 : 1,
    title: item.title ?? voiceNoteTitle(Date.parse(item.startedAt ?? "") || Date.now()),
    meta: savedNoteMeta(item, rowMetadata, platform, pipeline?.pipeline.done === true),
    stepper: status ? <div className="flex flex-wrap items-center gap-3" data-testid="note-detail-status"><p className={status.startsWith("Needs attention") ? "sn-hint text-amber-700 dark:text-amber-300" : "sn-hint"}>{status}</p>{actions.map((action, index) => <button key={`${action.label}:${index}`} type="button" className="min-h-11 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={action.run}>{action.label}</button>)}{cloudFailedWithoutRetry && <TranscribeAction noteId={item.sourceId} transcription={recorder.transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} label="Try again" />}{pipeline?.actionError && <p role="alert" className="text-callout text-destructive">{pipeline.actionError}</p>}</div> : null,
    audio,
    audioStorage: localOnly ? (hasLocalAudio ? (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p>Audio stays on this {platform === "tauri" ? "Mac" : platform === "web" ? "browser" : "phone"}.</p>
        <Button type="button" variant="outline" disabled={uploading} onClick={upload}>
          {uploading ? "Uploading audio to your TinyCloud space…" : "Upload audio to TinyCloud"}
        </Button>
        {uploadError && <p role="alert">{uploadError}</p>}
      </div>
    ) : null) : null,
    transcript,
    // The stepper is the route while the note is still getting here; the legacy route line would say it twice. A failed
    // metadata read is not a route: the footer's "Try again" is the only way to read it again, so it stays.
    footer: stepperShown && metadata?.status !== "failed" ? null : footer,
    activityControl,
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

const MemoSavedNoteContent = memo(SavedNoteContent);

export default function SavedNote(props: SavedNoteProps) {
  const pipelineMetadata = props.metadata?.status === "ok" ? props.metadata.metadata : undefined;
  const pipelineSource = useMemo<NotePipelineSource>(
    () => ({ tcw: props.tcw, rowExists: props.item.onPhone !== true, audioSaved: props.item.onPhone !== true && rowHasCommittedAudio(pipelineMetadata), metadata: pipelineMetadata, durationSecs: props.item.durationSecs }),
    [props.tcw, props.item.onPhone, props.item.durationSecs, pipelineMetadata],
  );
  const live = useNotePipeline(props.item.sourceId, pipelineSource);
  const [visible, setVisible] = useState<NotePipelineView | null>(live);
  const latest = useRef(live);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    latest.current = live;
    if (live !== null) setVisible((current) => current === null ? live : current);
    if (timer.current === null) timer.current = setTimeout(() => { timer.current = null; setVisible(latest.current); }, 250);
  }, [live]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return <MemoSavedNoteContent {...props} pipeline={visible} />;
}
