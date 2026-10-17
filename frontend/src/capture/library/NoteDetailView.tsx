// One note in the Library (TC-761), a pure function of its props: the title
// and meta, its audio, how it got into the space, and its transcript with
// Copy. A voice note without a transcript shows where its transcription
// stands instead (moved from the Voice notes card): Transcribe, the progress,
// "No speech", or the failure with its reference and Retry.
//
// Pushed (a phone): the page header with Back. Beside the list (wide): the
// title as the pane's heading.
import { useContext, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { NotePlaybackContext } from "@/lib/audio/notePlayback";
import { appPlatform } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { openManageStorage } from "@/lib/openManageStorage";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { NotePipelineContext } from "@/capture/pipeline/NotePipelineContext";
import { privateAudioSourceFromMetadata, privateRefusal, type PrivateAudioSource, type VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import type { MeetingMetadataRead, TranscriptRead } from "@/lib/connectors/meetingExplorer";
import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { AppPlatform } from "@/lib/platform";
import { activityForNote, deviceName, noteStatus } from "../activity/activitySelector";
import type { LocalTranscript } from "@/lib/voiceNotes/nativeVoiceNotes";
import { transcriptionStatusText } from "@/lib/voiceNotes/voiceNoteTranscription";
import { storageFullPrecedesChoiceFailure, storageFullTranscriptCopy, TRANSCRIPT_STORAGE_FULL_CODE, transcriptionErrorCopy, voiceNoteTranscriptionFailureForCode } from "@/lib/voiceNotes/transcriptionErrors";
import { localTranscriptToSave, voiceNoteTitle, voiceNoteTranscriptState, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { detailWhen, formatSpokenDuration } from "./formatters";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DesktopWhisperStatus } from "./DesktopWhisperStatus";
import { OnDeviceNoteStatus } from "./OnDeviceNoteStatus";
import { privateRefusalCopy } from "@/capture/recorder/privateInstead";
import { TranscribeAction } from "./TranscribeAction";
import type { TranscribeActionProps } from "./TranscribeAction";
import { HowThisGotHere } from "./HowThisGotHere";
import { librarySourceLabel } from "./libraryKinds";
import { TimestampedTranscript, type TranscriptGap } from "./TimestampedTranscript";
import { hasPrivateCloudTimingProvenance, hasSegmentTimes, transcriptMarkdown } from "./transcriptSegments";
import type { TranscriptProvenance } from "@/lib/voiceNotes/voiceNoteCommits";
import type { LibraryItem } from "./LibraryRow";
import type { LibraryStatus } from "./LibraryListView";
import { LazySavedNote } from "./savedNote/LazySavedNote";
import { SAVED_NOTE_COPY } from "./savedNote/savedNoteCopy";
import type { SavedNoteStore } from "./savedNote/savedNoteStore";

export type AudioLoad = (signal: AbortSignal, onProgress: (loadedBytes: number, totalBytes: number) => void) => Promise<Blob | string | null>;

/** A note's audio: loaded through the player (a Blob from the space, or the phone's file URL; `onPhone` marks a note still on this phone), or a native URL resolved on demand. */
export type NoteAudio = { load: AudioLoad; channels?: 1 | 2; onPhone?: true } | { localUrl: () => Promise<string>; channels?: 1 | 2 };

export function noteAudioPlayerProps(audio: NoteAudio): { load: AudioLoad; channels?: 1 | 2 } | { resolveUrl: () => Promise<string>; channels?: 1 | 2 } {
  return "load" in audio ? { load: audio.load, channels: audio.channels } : { resolveUrl: audio.localUrl, channels: audio.channels };
}

export interface NoteDetailViewProps {
  item: LibraryItem | null;
  /** The list's state, for a note opened before the list has answered. */
  listStatus: LibraryStatus;
  /** Undefined while it is read. */
  metadata: MeetingMetadataRead | undefined;
  transcript: TranscriptRead | undefined;
  /** Provenance from the commit paired with the selected transcript body; null falls back to row metadata. */
  transcriptProvenance?: TranscriptProvenance | null;
  /** The device copy, keyed by source_id, while the space copy has not arrived. */
  localTranscript?: LocalTranscript | null;
  localTranscriptRead?: "timeout" | "failed" | null;
  onLocalTranscriptRetry?: () => void;
  /** Where the note's audio comes from; null when it has none stored. */
  audio: NoteAudio | null;
  /** Private cloud transcription (voice notes in the phone app); absent elsewhere. */
  transcription?: VoiceNoteTranscriptionProps;
  activityView?: NotePipelineView;
  platform?: AppPlatform;
  /** Whether the Mac's after-stop Whisper job shows here; defaults to the final recorder in the Tauri shell. */
  desktopWhisper?: boolean;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
  onCopyWithTimestamps?: () => void;
  /** Reads again what did not load (the list, or this note). */
  onRetry: () => void;
  /** A screen of its own (compact), with Back; otherwise a pane beside the list. */
  pushed: boolean;
  onBack: () => void;
  /** A voice note opens as its editable note (a page, or a sheet on a phone) instead of this view. */
  savedNote?: { tcw: TinyCloudWeb; layout: "page" | "sheet"; store?: SavedNoteStore };
  activityControl?: ReactNode;
}

/** Consecutive sentences of one speaker as one block. */
export function transcriptBlocks(sentences: readonly FirefliesSentence[]): { speaker: string | null; text: string }[] {
  const blocks: { speaker: string | null; text: string }[] = [];
  for (const sentence of sentences) {
    const speaker = sentence.speaker_name ?? null;
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === speaker) last.text = `${last.text} ${sentence.text}`;
    else blocks.push({ speaker, text: sentence.text });
  }
  return blocks;
}

export function noteMeta(item: LibraryItem): string {
  return [
    detailWhen(item.startedAt),
    item.durationSecs !== null ? formatSpokenDuration(item.durationSecs) : null,
    librarySourceLabel(item.source),
  ]
    .filter((part): part is string => !!part)
    .join(" · ");
}

function Frame(props: { title: string; pushed: boolean; onBack: () => void; activityControl?: ReactNode; children: ReactNode }) {
  return (
    <>
      {props.pushed && <PageHeader title={props.title} back={props.onBack} className={PAGE_COLUMN} trailing={props.activityControl} />}
      <div className={props.pushed ? `${PAGE_COLUMN} flex flex-col gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-1` : "flex flex-col gap-6 px-6 pb-8 pt-6 expanded:px-8"}>
        {!props.pushed && props.activityControl && <div className="flex justify-end">{props.activityControl}</div>}
        {props.children}
      </div>
    </>
  );
}

/** Private storage-full: Manage storage first. Retry follows the committed transcript state. */
function StorageFullActions(props: Pick<TranscribeActionProps, "noteId" | "transcription" | "durationSecs"> & { privateAudioSource?: PrivateAudioSource; hasCommittedTranscript: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" onClick={() => void openManageStorage()}>Manage storage</Button>
      <TranscribeAction noteId={props.noteId} transcription={props.transcription} durationSecs={props.durationSecs} privateAudioSource={props.privateAudioSource} rerun={props.hasCommittedTranscript} label="Transcribe again" />
    </div>
  );
}

/** Where a voice note's transcription stands, when it has no transcript; null when there is nothing to say or offer. */
export function VoiceNoteTranscriptionStatus(props: {
  item: LibraryItem;
  outcome: "none" | "pending" | "failed" | "skipped" | "transcribed" | "no_speech";
  errorCode?: string | null;
  transcription: VoiceNoteTranscriptionProps | undefined;
  privateAudioSource?: PrivateAudioSource;
  provider?: "private" | "powerful" | "unknown";
  hasCommittedTranscript?: boolean;
}) {
  const { item, transcription, privateAudioSource } = props;
  const provider = props.provider ?? "private";
  if (props.outcome === "no_speech") {
    return (
      <p data-testid="voice-note-no-speech" className="text-callout text-muted-foreground">
        No speech found
      </p>
    );
  }
  const refusal = transcription ? privateRefusal(transcription, item.durationSecs, null, privateAudioSource) : null;
  const job = transcription?.jobs.get(item.sourceId);
  // Saved just now; the reads have not caught up yet. Never offer Transcribe again meanwhile.
  if (job?.kind === "done") {
    return (
      <p data-testid="voice-note-transcription-done" className="text-callout text-muted-foreground">
        {job.outcome === "no_speech" ? "No speech found" : "Transcript saved."}
      </p>
    );
  }
  if (job?.kind === "active") {
    const status = transcriptionStatusText(job.status);
    const providerStatus = provider === "powerful" ? status.replaceAll("Private transcription", "Powerful (AssemblyAI)").replaceAll("private cloud", "Powerful")
      : provider === "unknown" ? status.replaceAll("Private transcription", "transcription").replaceAll("private cloud", "the transcription service") : status;
    return (
      <p role="status" data-testid="voice-note-transcription-status" className="flex items-center gap-2 text-callout text-muted-foreground" title={job.status.kind === "processing" && job.status.completed !== null && job.status.total !== null && job.status.total > 0 ? "Recordings are transcribed in parts" : undefined}>
        <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> {providerStatus}
      </p>
    );
  }
  if (job?.kind === "held") {
    return (
      <div className="flex flex-col gap-2" data-testid="voice-note-transcription-held">
        <p role="status" className="min-w-0 text-callout text-muted-foreground">{job.message}</p>
        <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} />
      </div>
    );
  }
  if (job?.kind === "failed") {
    const code = storageFullPrecedesChoiceFailure(props.outcome, props.errorCode, job.code)
      ? TRANSCRIPT_STORAGE_FULL_CODE : job.code;
    const failure = voiceNoteTranscriptionFailureForCode(code);
    const storageFull = code === TRANSCRIPT_STORAGE_FULL_CODE;
    return (
      <div className="flex flex-col gap-2" data-testid="voice-note-transcription-failed">
        <p role="alert" className="min-w-0 text-callout text-destructive">
          {storageFull ? storageFullTranscriptCopy(item.localAudioReady === true) : (transcriptionErrorCopy(code) ?? job.message)}
        </p>
        {job.reference && <ReferenceDetails reference={job.reference} />}
        {storageFull
          ? <StorageFullActions noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} hasCommittedTranscript={props.hasCommittedTranscript === true} />
          : job.retryable && failure.retryable && <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} label="Try again" />}
      </div>
    );
  }
  if (props.outcome === "failed") {
    const failure = voiceNoteTranscriptionFailureForCode(props.errorCode);
    const storageFull = failure.code === TRANSCRIPT_STORAGE_FULL_CODE;
    const canChoosePrivate = transcription?.availability === "available"
      || (transcription?.availability === "failed" && transcription.consented);
    return (
      <div className="flex flex-col gap-2" data-testid="voice-note-transcription-failed">
        <p role="alert" className="min-w-0 text-callout text-destructive">{storageFull ? storageFullTranscriptCopy(item.localAudioReady === true) : failure.message}</p>
        {storageFull
          ? <StorageFullActions noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} hasCommittedTranscript={props.hasCommittedTranscript === true} />
          : failure.retryable && (captureCapabilities().localTranscription || canChoosePrivate || transcription !== undefined)
            && <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} label="Try again" />}
      </div>
    );
  }

  // Local needs the phone's engine; Private needs an available (or checkable) cloud service.
  const localCapable = captureCapabilities().localTranscription;
  const choosable = transcription?.availability === "available" || (transcription?.availability === "failed" && transcription.consented);
  const pendingWithoutLiveJob = props.outcome === "pending" && (job === undefined || job.kind === "blocked");
  if (pendingWithoutLiveJob && props.provider === "private" && !item.onPhone
    && !localCapable && transcription?.availability !== "available") {
    return (
      <div className="flex flex-col gap-2" data-testid="voice-note-private-unavailable">
        <p className="text-callout text-muted-foreground">
          {transcription?.availability === "failed"
            ? "Private cloud isn’t reachable — we’ll retry."
            : "Private cloud availability is being checked — we’ll retry."}
        </p>
        {transcription?.consented
          && <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} />}
      </div>
    );
  }
  if (!localCapable && !choosable) return null;
  if (refusal?.kind === "browser-wav-too-large") {
    return (
      <div className="flex flex-col gap-2">
        <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} />
      </div>
    );
  }
  if (!localCapable && transcription) {
    if (refusal?.kind === "unknown") {
      // Limits unknown: no Private offer, but the recheck stays so the limits can come back.
      return (
        <div className="flex flex-col gap-2" data-testid="voice-note-transcription-limits-unknown">
          <p className="text-callout text-muted-foreground">
            Private&apos;s limits aren’t available right now. Try again later.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void transcription.onRecheck()}>Check again</Button>
        </div>
      );
    }
    if (refusal?.kind === "duration") {
      return (
        <p className="text-callout text-muted-foreground" data-testid="voice-note-transcription-over-limit">
          {privateRefusalCopy(refusal)}
        </p>
      );
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-callout text-muted-foreground">
        {props.outcome === "skipped" ? "Transcription skipped" : "Not transcribed"}
      </p>
      <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} privateAudioSource={privateAudioSource} />
    </div>
  );
}

function ReferenceDetails({ reference }: { reference: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  return <div className="flex flex-wrap items-center gap-2 text-callout text-muted-foreground"><span>Reference: {reference}</span><button type="button" className="min-h-11 text-primary" onClick={() => { if (!navigator.clipboard) { setResult("failed"); return; } void navigator.clipboard.writeText(reference).then(() => setResult("copied"), () => setResult("failed")); }}>Copy details</button>{result && <span role={result === "failed" ? "alert" : "status"}>{result === "copied" ? "Details copied." : "Couldn't copy details."}</span>}</div>;
}

/**
 * What the Transcript section says while the note's pipeline (the stepper above it) is not done: the transcript step's
 * own words, or where it will appear. The current step's caption and cause are already in the stepper, so then it
 * only says where the transcript will show. Null when the step is done or skipped, and the plain states stand.
 */
export function transcriptStepLine(pipeline: NotePipeline): string | null {
  const step = pipeline.steps.find((candidate) => candidate.key === "transcript");
  if (step === undefined || step.state === "done" || step.state === "skipped") return null;
  if (step.state === "waiting" && (step.caption?.startsWith("Queued for ") || step.caption?.startsWith("In the queue"))) return step.caption;
  if (pipeline.current === "transcript") return SAVED_NOTE_COPY.transcriptHere;
  return step.blocker?.cause ?? step.caption ?? SAVED_NOTE_COPY.transcriptAfterSpace;
}

/** A voice note with no transcript yet: where its pipeline stands, else what the phone says about its on-device transcription, else where private cloud stands, else "No transcript.". */
function NoTranscript(props: { item: LibraryItem; metadata: MeetingMetadataRead; transcription: VoiceNoteTranscriptionProps | undefined; hasCommittedTranscript: boolean }) {
  const outcome = voiceNoteTranscriptState(props.metadata.status === "ok" ? props.metadata.metadata : null).status;
  const errorCode = props.metadata.status === "ok" && typeof props.metadata.metadata.transcription_error_code === "string"
    ? props.metadata.metadata.transcription_error_code
    : null;
  const privateAudioSource = privateAudioSourceFromMetadata(props.metadata.status === "ok" ? props.metadata.metadata : null);
  const view = useContext(NotePipelineContext);
  const capture = props.metadata.status === "ok" ? props.metadata.metadata.capture : null;
  const options = capture && typeof capture === "object" ? (capture as { options?: { transcriber?: string } }).options : null;
  const provider = view?.provider === "powerful" || options?.transcriber === "assemblyai" ? "powerful" : view?.provider === "private" || options?.transcriber === "private-cloud" ? "private" : "unknown";
  const stepperShown = view !== null && !view.pipeline.done;
  const line = !stepperShown || outcome === "no_speech" ? null : transcriptStepLine(view.pipeline);
  // The phone is making this note's transcript and the stepper says where that stands. The private route's "Not transcribed"
  // and Transcribe would contradict it, so they are not offered; only the pipeline's own actions are.
  const onPhoneRoute = stepperShown && view.route === "on-device" && outcome !== "no_speech";
  if (line !== null || onPhoneRoute) {
    // The stepper above says what is happening and offers its action; what is left here adds something it does not.
    const job = props.transcription?.jobs.get(props.item.sourceId);
    // A private-cloud note the stepper still waits on (its hand-over is on its way) is spoken for by the stepper; once the
    // stepper skips the transcript step nothing will start one, and the Transcribe action below stands.
    const privateComing = stepperShown && line !== null && view.route === "private-cloud" && job === undefined;
    const stepperCovers = onPhoneRoute || privateComing || job?.kind === "active" || job?.kind === "failed";
    const status = stepperCovers ? null : VoiceNoteTranscriptionStatus({ item: props.item, outcome, errorCode, transcription: props.transcription, privateAudioSource, provider, hasCommittedTranscript: props.hasCommittedTranscript });
    // "Will appear here" would sit beside a Transcribe action that says it won't unless asked.
    const shownLine = status !== null && line === SAVED_NOTE_COPY.transcriptHere ? null : line;
    return (
      <>
        {shownLine !== null && <p className="text-callout text-muted-foreground" data-testid="note-transcript-pipeline">{shownLine}</p>}
        {status}
        <OnDeviceNoteStatus noteId={props.item.sourceId} fallback={null} transcription={props.transcription} durationSecs={props.item.durationSecs} privateAudioSource={privateAudioSource} stepperShown />
      </>
    );
  }
  // A plain function of its props (no hooks), so its "nothing to say" is known here.
  const status = VoiceNoteTranscriptionStatus({ item: props.item, outcome, errorCode, transcription: props.transcription, privateAudioSource, provider, hasCommittedTranscript: props.hasCommittedTranscript }) ?? (
    <p className="text-callout text-muted-foreground" data-testid={props.item.onPhone ? "note-transcript-on-phone" : undefined}>
      {props.item.onPhone ? "No transcript yet. It shows here once this note is saved to your space." : "No transcript."}
    </p>
  );
  if (outcome === "no_speech") return status;
  return <OnDeviceNoteStatus noteId={props.item.sourceId} fallback={status} transcription={props.transcription} durationSecs={props.item.durationSecs} privateAudioSource={privateAudioSource} />;
}

/** The transcript text a voice note's row carries (`transcript_text`), for when its body can't be read. */
function savedText(metadata: MeetingMetadataRead): string | null {
  const text = metadata.status === "ok" ? metadata.metadata.transcript_text : null;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

export function Transcript(props: NoteDetailViewProps & { item: LibraryItem }) {
  const [exportError, setExportError] = useState(false);
  const { item, transcript, metadata } = props;
  const voiceNote = item.source === VOICE_NOTE_SOURCE;
  const spaceNoSpeech = metadata?.status === "ok" && metadata.metadata.transcription_outcome === "no_speech";
  const local = voiceNote && !spaceNoSpeech && props.localTranscript?.noteId === item.sourceId ? props.localTranscript : null;
  const localSyncPending = props.activityView?.input?.transcript.onDevice?.sync?.state === "syncing" && local?.outcome === "transcribed";
  const remoteSentences = transcript?.status === "ok" ? transcript.sentences : [];
  const spaceReadFailed = remoteSentences.length === 0 && local !== null &&
    (transcript?.status === "failed" || metadata?.status === "failed");
  const isPrivateCloud = remoteSentences.length > 0
    && hasPrivateCloudTimingProvenance(metadata?.status === "ok" ? metadata.metadata : null, props.transcriptProvenance);
  const sentences = localSyncPending && local ? localTranscriptToSave(local).sentences : remoteSentences.length > 0 ? remoteSentences
    : local?.outcome === "transcribed" ? localTranscriptToSave(local).sentences : [];
  const shownLocal = localSyncPending || remoteSentences.length === 0 ? local : null;
  const shownProvider = shownLocal ? shownLocal.engine
    : props.transcriptProvenance?.provider ?? (metadata?.status === "ok" ? metadata.metadata.transcript_provider : null);
  // AssemblyAI letters its speakers afresh for every note it transcribes.
  const perNoteSpeakers = shownProvider === "assemblyai" && sentences.some((sentence) => sentence.speaker_name);
  const savedGaps = metadata?.status === "ok" ? metadata.metadata.gaps : null;
  const gaps = Array.isArray(savedGaps) ? savedGaps.filter((gap): gap is TranscriptGap =>
    gap !== null && typeof gap === "object" && Number.isFinite(gap.start) && Number.isFinite(gap.end)
    && gap.start >= 0 && gap.end > gap.start && (gap.speaker_name === null || typeof gap.speaker_name === "string")) : [];
  const hasProvenance = sentences.some((sentence) => sentence.source !== undefined);
  const timed = hasSegmentTimes(sentences, isPrivateCloud);
  const exportMarkdown = async () => {
    const markdown = transcriptMarkdown(item.title ?? "Voice note", item.startedAt, sentences, isPrivateCloud);
    const filename = `${(item.title ?? "Voice note").replaceAll(/[^\w -]/g, "").trim() || "voice-note"}.md`;
    setExportError(false);
    try {
      if ((appPlatform() === "ios" || appPlatform() === "android") && navigator.share) {
        await navigator.share({ files: [new File([markdown], filename, { type: "text/markdown" })], title: item.title ?? "Voice note" });
        return;
      }
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setExportError(true);
    }
  };
  const committedOutcome = voiceNote && props.transcriptProvenance !== null && props.transcriptProvenance !== undefined
    && metadata?.status === "ok"
    && (metadata.metadata.transcription_outcome === "transcribed" || metadata.metadata.transcription_outcome === "no_speech");
  const rerunJob = props.transcription?.jobs.get(item.sourceId);
  return (
    <section aria-labelledby="note-transcript" data-testid="note-transcript" className="flex flex-col gap-3">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3">
        <h2 id="note-transcript" className="flex-1 text-headline">
          Transcript
        </h2>
        {sentences.length > 0 && (
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" onClick={props.onCopy} data-testid="note-copy">
              {props.copyState === "copied" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              {props.copyState === "copied" ? "Copied" : "Copy"}
            </Button>
            {timed && <details className="relative">
              <summary className="flex min-h-11 cursor-pointer items-center rounded-md px-2 text-meta hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label="Transcript copy and export options">▾</summary>
              <div className="absolute right-0 z-10 min-w-48 rounded-md border bg-popover p-1 shadow-sm">
                <button type="button" className="block min-h-11 w-full rounded-sm px-3 py-2 text-left text-meta hover:bg-accent" onClick={props.onCopy}>Copy text</button>
                {props.onCopyWithTimestamps && <button type="button" className="block min-h-11 w-full rounded-sm px-3 py-2 text-left text-meta hover:bg-accent" onClick={props.onCopyWithTimestamps}>Copy with timestamps</button>}
                <button type="button" className="block min-h-11 w-full rounded-sm px-3 py-2 text-left text-meta hover:bg-accent" onClick={() => void exportMarkdown()}>Export as Markdown</button>
              </div>
            </details>}
          </div>
        )}
      </div>
      {props.copyState === "failed" && (
        <p role="alert" className="text-meta text-destructive">
          Couldn’t copy. Select the text and copy it instead.
        </p>
      )}
      {exportError && <p role="alert" className="text-meta text-destructive">Couldn’t export the transcript. Try again.</p>}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {props.copyState === "copied" ? "Transcript copied to clipboard" : ""}
      </span>
      {sentences.length > 0 || gaps.length > 0 ? (
        <div className="flex max-w-[68ch] flex-col gap-4 [-webkit-touch-callout:default] select-text">
          {localSyncPending && <p className="text-callout text-muted-foreground">Saved on {deviceName(props.platform ?? "web")} · syncing to your TinyCloud space</p>}
          {spaceReadFailed && <div className="flex flex-wrap items-center gap-2" data-testid="note-transcript-local-space-error">
            <p className="text-callout text-muted-foreground">On this device · Couldn’t check your space.</p>
            <Button type="button" variant="outline" onClick={props.onRetry}>Try again</Button>
          </div>}
          {timed || gaps.length > 0 || hasProvenance ? <TimestampedTranscript gaps={gaps} sentences={sentences} hasAudio={props.audio !== null} isPrivateCloud={isPrivateCloud} /> : transcriptBlocks(sentences).map((block, index) => (
            <div key={index}>
              {block.speaker && <p className="text-meta font-semibold text-muted-foreground">{block.speaker}</p>}
              <p className="whitespace-pre-wrap break-words text-body">{block.text}</p>
            </div>
          ))}
          {perNoteSpeakers && <p className="text-meta text-muted-foreground">
            AssemblyAI’s speaker labels apply within this note only. The same label in another note may be a different person.
          </p>}
        </div>
      ) : spaceNoSpeech || local?.outcome === "no_speech" ? (
        <div className="flex flex-col gap-2">
          {spaceReadFailed && <div className="flex flex-wrap items-center gap-2" data-testid="note-transcript-local-space-error">
            <p className="text-callout text-muted-foreground">On this device · Couldn’t check your space.</p>
            <Button type="button" variant="outline" onClick={props.onRetry}>Try again</Button>
          </div>}
          <p data-testid="voice-note-no-speech" className="text-callout text-muted-foreground">No speech found</p>
        </div>
      ) : transcript === undefined ? (
        <div role="status">
          <span className="sr-only">Loading the transcript…</span>
          <Skeleton lines={4} />
        </div>
      ) : transcript.status === "failed" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="note-transcript-failed">
          <p className="text-callout text-muted-foreground">Couldn’t load the transcript.</p>
          <Button type="button" variant="outline" onClick={props.onRetry}>
            <RefreshCwIcon aria-hidden /> Try again
          </Button>
        </div>
      ) : voiceNote ? (
        metadata === undefined ? (
          <Skeleton lines={1} className="w-40" />
        ) : metadata.status === "failed" ? (
          // Unknown whether it was transcribed (or had no speech): nothing is offered until the read lands.
          <p className="text-callout text-muted-foreground" data-testid="voice-note-transcript-unknown">
            Couldn’t check this note’s transcript.
          </p>
        ) : savedText(metadata) ? (
          // Marked transcribed, its transcript body missing: the text the row carries.
          <p className="max-w-[68ch] whitespace-pre-wrap break-words text-body" data-testid="voice-note-transcript-text">
            {savedText(metadata)}
          </p>
        ) : metadata.status === "ok" && metadata.metadata.transcription_outcome === "transcribed" ? (
          <div className="flex flex-wrap items-center gap-3" data-testid="voice-note-transcript-missing">
            <p className="text-callout text-muted-foreground">Couldn’t load this note’s full transcript.</p>
            <Button type="button" variant="outline" onClick={props.onRetry}>Try again</Button>
          </div>
        ) : metadata.status === "ok" && (metadata.metadata.audio as { stored?: unknown } | undefined)?.stored === false && !props.audio ? (
          <p className="text-callout text-muted-foreground" data-testid="voice-note-transcribe-on-device">
            Transcribe on your {((metadata.metadata.capture as { platform?: string } | undefined)?.platform === "ios") ? "iPhone"
              : ((metadata.metadata.capture as { platform?: string } | undefined)?.platform === "tauri") ? "Mac"
              : ((metadata.metadata.capture as { platform?: string } | undefined)?.platform === "android") ? "phone" : "browser"}
          </p>
        ) : (
          <DesktopWhisperStatus
            noteId={item.sourceId}
            enabled={props.desktopWhisper}
            localRead={props.localTranscript === undefined ? "loading" : props.localTranscriptRead ?? "missing"}
            onReadRetry={props.onLocalTranscriptRetry}
            fallback={<NoTranscript item={item} metadata={metadata} transcription={props.transcription} hasCommittedTranscript={props.transcriptProvenance != null} />}
          />
        )
      ) : (
        <p className="text-callout text-muted-foreground" data-testid="note-transcript-absent">
          No transcript stored yet.
        </p>
      )}
      {committedOutcome && (
        <div className="flex flex-col gap-2" data-testid="voice-note-transcription-rerun">
          {rerunJob?.kind === "active" && (
            <p role="status" className="flex items-center gap-2 text-callout text-muted-foreground">
              <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> {transcriptionStatusText(rerunJob.status)}
            </p>
          )}
          {rerunJob?.kind === "failed" && (
            <p role="alert" className="text-callout text-destructive" data-testid="voice-note-rerun-failed">
              {rerunJob.message}{rerunJob.reference && <span className="text-muted-foreground"> Reference: {rerunJob.reference}</span>}
            </p>
          )}
          <OnDeviceNoteStatus noteId={item.sourceId} fallback={null} transcription={props.transcription}
            durationSecs={item.durationSecs} rerunOnly />
          <DesktopWhisperStatus noteId={item.sourceId} fallback={null} enabled={props.desktopWhisper} rerunOnly />
          {rerunJob?.kind !== "active" && (
            <TranscribeAction noteId={item.sourceId} transcription={props.transcription} durationSecs={item.durationSecs}
              rerun label={rerunJob?.kind === "failed" ? "Try again" : "Transcribe again…"} />
          )}
        </div>
      )}
    </section>
  );
}

export function NoteDetailView(props: NoteDetailViewProps) {
  return <NotePlaybackProvider><NoteDetailViewContent {...props} /></NotePlaybackProvider>;
}

function NotePlaybackProvider({ children }: { children: ReactNode }) {
  const [seek, setSeek] = useState<{ seconds: number; nonce: number } | null>(null);
  const [clock, setClock] = useState({ elapsed: 0, playing: false });
  return <NotePlaybackContext.Provider value={{ seek, playFrom: (seconds) => setSeek((current) => ({ seconds, nonce: (current?.nonce ?? 0) + 1 })),
    elapsed: clock.elapsed, playing: clock.playing, onClock: (elapsed, playing) => setClock((current) =>
      current.elapsed === elapsed && current.playing === playing ? current : { elapsed, playing }) }}>
    {children}
  </NotePlaybackContext.Provider>;
}

function NoteDetailViewContent(props: NoteDetailViewProps) {
  const { item, metadata } = props;
  const activityJobs = props.activityView && props.platform ? activityForNote(props.activityView, props.platform) : [];
  // The Transcript fallback owns the durable failure's explanation and retry action.
  const activityStatus = noteStatus(activityJobs, props.activityView?.pipeline, false);
  const activityRetry = activityJobs.find((job) => job.retry)?.retry;
  if (item === null) {
    return (
      <Frame title="Note" pushed={props.pushed} onBack={props.onBack}>
        {props.listStatus === "loading" ? (
          <div role="status" data-testid="note-loading" className="flex flex-col gap-4">
            <span className="sr-only">Loading the note…</span>
            <Skeleton lines={2} className="max-w-sm" />
            <Skeleton lines={5} />
          </div>
        ) : props.listStatus === "failed" ? (
          <Empty
            data-testid="note-failed"
            title="Couldn’t load this note."
            description="Check your connection, then try again."
            action={
              <Button type="button" variant="outline" onClick={props.onRetry}>
                <RefreshCwIcon aria-hidden /> Try again
              </Button>
            }
          />
        ) : (
          <Empty data-testid="note-absent" title="This note isn’t in your Library." description="It may have been removed from your space." />
        )}
      </Frame>
    );
  }

  if (props.savedNote && item.source === VOICE_NOTE_SOURCE) {
    return (
      <LazySavedNote
        // The recording, so the sheet stays open when its stand-in becomes the space's row.
        key={item.sourceId}
        item={item}
        metadata={metadata}
        audio={props.audio}
        tcw={props.savedNote.tcw}
        store={props.savedNote.store}
        layout={props.savedNote.layout}
        onBack={props.onBack}
        transcript={<Transcript {...props} item={item} />}
        activityControl={props.activityControl}
        footer={item.onPhone ? undefined : <HowThisGotHere source={item.source} read={metadata} onRetry={props.onRetry} />}
      />
    );
  }

  const title = item.title ?? (item.source === VOICE_NOTE_SOURCE ? voiceNoteTitle(Date.parse(item.startedAt ?? "") || Date.now()) : "Untitled");
  const meta = metadata?.status === "ok" ? metadata.metadata : null;
  const audioKept = (meta?.audio as { stored?: unknown } | undefined)?.stored === true;
  return (
    <Frame title={title} pushed={props.pushed} onBack={props.onBack} activityControl={props.activityControl}>
      <header className="flex flex-col gap-1" data-testid="note-detail" data-note-id={item.id}>
        {!props.pushed && <h2 className="font-display text-title-1 [overflow-wrap:anywhere]">{title}</h2>}
        <p className="tnum text-meta text-muted-foreground">{noteMeta(item)}</p>
        {activityStatus && <div className="flex flex-wrap items-center gap-3" data-testid="note-detail-status"><p className={activityStatus.startsWith("Needs attention") ? "text-callout text-amber-700 dark:text-amber-300" : "text-callout text-muted-foreground"}>{activityStatus}</p>{activityJobs.flatMap((job) => job.action ? [job.action] : []).map((action, index) => <button key={`${action.label}:${index}`} type="button" className="min-h-11 text-callout text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={action.run}>{action.label}</button>)}{!activityJobs.some((job) => job.action) && activityRetry && <button type="button" className="min-h-11 text-callout text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={activityRetry}>Try again</button>}</div>}
      </header>
      {props.audio ? (
        <MeetingAudioPlayer key={`${item.source}:${item.sourceId}`} {...noteAudioPlayerProps(props.audio)} durationSecs={item.durationSecs}
          channels={(meta?.capture as { channels?: number } | undefined)?.channels === 2 || props.audio.channels === 2 ? 2 : 1} />
      ) : item.source === VOICE_NOTE_SOURCE && meta && Object.keys(meta).length === 0 ? (
        <p role="status" className="text-callout text-muted-foreground" data-testid="voice-note-saving-from-phone">
          Saving from {deviceName(props.platform)}…
        </p>
      ) : item.source === VOICE_NOTE_SOURCE && (meta?.audio as { stored?: unknown } | undefined)?.stored === false ? (
        <p role="status" className="text-callout text-muted-foreground" data-testid="voice-note-audio-on-device">
          Audio is on your {((meta?.capture as { platform?: string } | undefined)?.platform === "ios") ? "iPhone"
            : ((meta?.capture as { platform?: string } | undefined)?.platform === "tauri") ? "Mac"
            : ((meta?.capture as { platform?: string } | undefined)?.platform === "android") ? "phone" : "browser"}
        </p>
      ) : item.source === UPLOAD_MEETING_SOURCE && metadata?.status === "ok" && !audioKept ? (
        <p className="text-callout text-muted-foreground" data-testid="note-audio-missing">
          Only the transcript was saved; the audio wasn’t stored.
        </p>
      ) : null}
      {!item.onPhone && <HowThisGotHere source={item.source} read={metadata} onRetry={props.onRetry} />}
      <Transcript {...props} item={item} />
    </Frame>
  );
}
