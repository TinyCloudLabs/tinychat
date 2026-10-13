// One note in the Library (TC-761), a pure function of its props: the title
// and meta, its audio, how it got into the space, and its transcript with
// Copy. A voice note without a transcript shows where its transcription
// stands instead (moved from the Voice notes card): Transcribe, the progress,
// "No speech", or the failure with its reference and Retry.
//
// Pushed (a phone): the page header with Back. Beside the list (wide): the
// title as the pane's heading.
import { useContext, type ReactNode } from "react";
import { CheckIcon, CopyIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { NotePipelineContext } from "@/capture/pipeline/NotePipelineContext";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import type { MeetingMetadataRead, TranscriptRead } from "@/lib/connectors/meetingExplorer";
import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import type { LocalTranscript } from "@/lib/voiceNotes/nativeVoiceNotes";
import { transcriptionStatusText } from "@/lib/voiceNotes/voiceNoteTranscription";
import { localTranscriptToSave, voiceNoteTitle, voiceNoteTranscriptState, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { detailWhen, formatSpokenDuration } from "./formatters";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DesktopWhisperStatus } from "./DesktopWhisperStatus";
import { OnDeviceNoteStatus } from "./OnDeviceNoteStatus";
import { TranscribeAction } from "./TranscribeAction";
import { privateCloudFits } from "./transcribeProviders";
import { HowThisGotHere } from "./HowThisGotHere";
import { librarySourceLabel } from "./libraryKinds";
import type { LibraryItem } from "./LibraryRow";
import type { LibraryStatus } from "./LibraryListView";
import { LazySavedNote } from "./savedNote/LazySavedNote";
import { SAVED_NOTE_COPY } from "./savedNote/savedNoteCopy";
import type { SavedNoteStore } from "./savedNote/savedNoteStore";

export type AudioLoad = (signal: AbortSignal, onProgress: (loadedBytes: number, totalBytes: number) => void) => Promise<Blob | null>;

/** A note's audio: fetched from the space as a blob, or a file still on this phone, played from its URL. */
export type NoteAudio = { load: AudioLoad } | { localUrl: () => Promise<string> };

export function noteAudioPlayerProps(audio: NoteAudio): { load: AudioLoad } | { resolveUrl: () => Promise<string> } {
  return "load" in audio ? { load: audio.load } : { resolveUrl: audio.localUrl };
}

export interface NoteDetailViewProps {
  item: LibraryItem | null;
  /** The list's state, for a note opened before the list has answered. */
  listStatus: LibraryStatus;
  /** Undefined while it is read. */
  metadata: MeetingMetadataRead | undefined;
  transcript: TranscriptRead | undefined;
  /** The device copy, keyed by source_id, while the space copy has not arrived. */
  localTranscript?: LocalTranscript | null;
  onLocalTranscriptRetry?: () => void;
  /** Where the note's audio comes from; null when it has none stored. */
  audio: NoteAudio | null;
  /** Private cloud transcription (voice notes in the phone app); absent elsewhere. */
  transcription?: VoiceNoteTranscriptionProps;
  /** Whether the Mac's after-stop Whisper job shows here; defaults to the final recorder in the Tauri shell. */
  desktopWhisper?: boolean;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
  /** Reads again what did not load (the list, or this note). */
  onRetry: () => void;
  /** A screen of its own (compact), with Back; otherwise a pane beside the list. */
  pushed: boolean;
  onBack: () => void;
  /** A voice note opens as its editable note (a page, or a sheet on a phone) instead of this view. */
  savedNote?: { tcw: TinyCloudWeb; layout: "page" | "sheet"; store?: SavedNoteStore };
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

function Frame(props: { title: string; pushed: boolean; onBack: () => void; children: ReactNode }) {
  return (
    <>
      {props.pushed && <PageHeader title={props.title} back={props.onBack} className={PAGE_COLUMN} />}
      <div className={props.pushed ? `${PAGE_COLUMN} flex flex-col gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-1` : "flex flex-col gap-6 px-6 pb-8 pt-6 expanded:px-8"}>
        {props.children}
      </div>
    </>
  );
}

/** Where a voice note's transcription stands, when it has no transcript; null when there is nothing to say or offer. */
export function VoiceNoteTranscriptionStatus(props: {
  item: LibraryItem;
  outcome: "none" | "transcribed" | "no_speech";
  transcription: VoiceNoteTranscriptionProps | undefined;
}) {
  const { item, transcription } = props;
  if (props.outcome === "no_speech") {
    return (
      <p data-testid="voice-note-no-speech" className="text-callout text-muted-foreground">
        No speech was found in this note.
      </p>
    );
  }
  const job = transcription?.jobs.get(item.sourceId);
  // Saved just now; the reads have not caught up yet. Never offer Transcribe again meanwhile.
  if (job?.kind === "done") {
    return (
      <p data-testid="voice-note-transcription-done" className="text-callout text-muted-foreground">
        {job.outcome === "no_speech" ? "No speech was found in this note." : "Transcript saved."}
      </p>
    );
  }
  if (job?.kind === "active") {
    return (
      <p role="status" data-testid="voice-note-transcription-status" className="flex items-center gap-2 text-callout text-muted-foreground">
        <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> {transcriptionStatusText(job.status)}
      </p>
    );
  }
  if (job?.kind === "held") {
    return (
      <div className="flex flex-col gap-2" data-testid="voice-note-transcription-held">
        <p role="status" className="min-w-0 text-callout text-muted-foreground">{job.message}</p>
        <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} />
      </div>
    );
  }
  if (job?.kind === "failed") {
    return (
      <div className="flex flex-col gap-2" data-testid="voice-note-transcription-failed">
        <p role="alert" className="min-w-0 text-callout text-destructive">
          {job.message}
          {job.reference && <span className="text-muted-foreground"> Reference: {job.reference}</span>}
        </p>
        {job.retryable && <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} label="Try again" />}
      </div>
    );
  }
  // Nothing to choose from: Local needs the phone's engine, Private needs private cloud on offer (or unreachable, with its own Check again).
  const localCapable = captureCapabilities().localTranscription;
  const choosable = transcription?.availability === "available" || (transcription?.availability === "failed" && transcription.consented);
  if (!localCapable && !choosable) return null;
  if (!localCapable && transcription && item.durationSecs !== null && !privateCloudFits(transcription, item.durationSecs)) {
    return (
      <p className="text-callout text-muted-foreground" data-testid="voice-note-transcription-over-limit">
        Private Transcription accepts notes up to {formatSpokenDuration(transcription.maxSeconds)}. This note is {formatSpokenDuration(item.durationSecs)}.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-callout text-muted-foreground">Not transcribed</p>
      <TranscribeAction noteId={item.sourceId} transcription={transcription} durationSecs={item.durationSecs} />
    </div>
  );
}

/**
 * What the Transcript section says while the note's pipeline (the stepper above it) is not done: the transcript step's
 * own words, or where it will appear. The current step's caption and cause are already in the stepper, so then it
 * only says where the transcript will show. Null when the step is done or skipped, and the plain states stand.
 */
export function transcriptStepLine(pipeline: NotePipeline): string | null {
  const step = pipeline.steps.find((candidate) => candidate.key === "transcript");
  if (step === undefined || step.state === "done" || step.state === "skipped") return null;
  if (pipeline.current === "transcript") return SAVED_NOTE_COPY.transcriptHere;
  return step.blocker?.cause ?? step.caption ?? SAVED_NOTE_COPY.transcriptAfterSpace;
}

/** A voice note with no transcript yet: where its pipeline stands, else what the phone says about its on-device transcription, else where private cloud stands, else "No transcript.". */
function NoTranscript(props: { item: LibraryItem; metadata: MeetingMetadataRead; transcription: VoiceNoteTranscriptionProps | undefined }) {
  const outcome = voiceNoteTranscriptState(props.metadata.status === "ok" ? props.metadata.metadata : null).status;
  const view = useContext(NotePipelineContext);
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
    const status = stepperCovers ? null : VoiceNoteTranscriptionStatus({ item: props.item, outcome, transcription: props.transcription });
    // "Will appear here" would sit beside a Transcribe action that says it won't unless asked.
    const shownLine = status !== null && line === SAVED_NOTE_COPY.transcriptHere ? null : line;
    return (
      <>
        {shownLine !== null && <p className="text-callout text-muted-foreground" data-testid="note-transcript-pipeline">{shownLine}</p>}
        {status}
        <OnDeviceNoteStatus noteId={props.item.sourceId} fallback={null} transcription={props.transcription} durationSecs={props.item.durationSecs} stepperShown />
      </>
    );
  }
  // A plain function of its props (no hooks), so its "nothing to say" is known here.
  const status = VoiceNoteTranscriptionStatus({ item: props.item, outcome, transcription: props.transcription }) ?? (
    <p className="text-callout text-muted-foreground" data-testid={props.item.onPhone ? "note-transcript-on-phone" : undefined}>
      {props.item.onPhone ? "No transcript yet. It shows here once this note is saved to your space." : "No transcript."}
    </p>
  );
  if (outcome === "no_speech") return status;
  return <OnDeviceNoteStatus noteId={props.item.sourceId} fallback={status} transcription={props.transcription} durationSecs={props.item.durationSecs} />;
}

/** The transcript text a voice note's row carries (`transcript_text`), for when its body can't be read. */
function savedText(metadata: MeetingMetadataRead): string | null {
  const text = metadata.status === "ok" ? metadata.metadata.transcript_text : null;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

export function Transcript(props: NoteDetailViewProps & { item: LibraryItem }) {
  const { item, transcript, metadata } = props;
  const voiceNote = item.source === VOICE_NOTE_SOURCE;
  const spaceNoSpeech = metadata?.status === "ok" && metadata.metadata.transcription_outcome === "no_speech";
  const local = voiceNote && !spaceNoSpeech && props.localTranscript?.noteId === item.sourceId ? props.localTranscript : null;
  const remoteSentences = transcript?.status === "ok" ? transcript.sentences : [];
  const sentences = remoteSentences.length > 0 ? remoteSentences
    : local?.outcome === "transcribed" ? localTranscriptToSave(local).sentences : [];
  return (
    <section aria-labelledby="note-transcript" data-testid="note-transcript" className="flex flex-col gap-3">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3">
        <h2 id="note-transcript" className="flex-1 text-headline">
          Transcript
        </h2>
        {sentences.length > 0 && (
          <Button type="button" variant="ghost" onClick={props.onCopy} className="-mr-2" data-testid="note-copy">
            {props.copyState === "copied" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {props.copyState === "copied" ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      {props.copyState === "failed" && (
        <p role="alert" className="text-meta text-destructive">
          Couldn’t copy. Select the text and copy it instead.
        </p>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {props.copyState === "copied" ? "Transcript copied to clipboard" : ""}
      </span>
      {sentences.length > 0 ? (
        <div className="flex max-w-[68ch] flex-col gap-4 [-webkit-touch-callout:default] select-text">
          {transcriptBlocks(sentences).map((block, index) => (
            <div key={index}>
              {block.speaker && <p className="text-meta font-semibold text-muted-foreground">{block.speaker}</p>}
              <p className="whitespace-pre-wrap break-words text-body">{block.text}</p>
            </div>
          ))}
        </div>
      ) : local?.outcome === "no_speech" ? (
        <p data-testid="voice-note-no-speech" className="text-callout text-muted-foreground">No speech was found in this note.</p>
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
        ) : (
          <DesktopWhisperStatus
            noteId={item.sourceId}
            enabled={props.desktopWhisper}
            localRead={props.localTranscript === undefined ? "loading" : "missing"}
            onReadRetry={props.onLocalTranscriptRetry}
            fallback={<NoTranscript item={item} metadata={metadata} transcription={props.transcription} />}
          />
        )
      ) : (
        <p className="text-callout text-muted-foreground" data-testid="note-transcript-absent">
          No transcript stored yet.
        </p>
      )}
    </section>
  );
}

export function NoteDetailView(props: NoteDetailViewProps) {
  const { item, metadata } = props;
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
        footer={item.onPhone ? undefined : <HowThisGotHere source={item.source} read={metadata} onRetry={props.onRetry} />}
      />
    );
  }

  const title = item.title ?? (item.source === VOICE_NOTE_SOURCE ? voiceNoteTitle(Date.parse(item.startedAt ?? "") || Date.now()) : "Untitled");
  const meta = metadata?.status === "ok" ? metadata.metadata : null;
  const audioKept = (meta?.audio as { stored?: unknown } | undefined)?.stored === true;
  return (
    <Frame title={title} pushed={props.pushed} onBack={props.onBack}>
      <header className="flex flex-col gap-1" data-testid="note-detail" data-note-id={item.id}>
        {!props.pushed && <h2 className="font-display text-title-1 [overflow-wrap:anywhere]">{title}</h2>}
        <p className="tnum text-meta text-muted-foreground">{noteMeta(item)}</p>
      </header>
      {props.audio ? (
        <MeetingAudioPlayer key={`${item.source}:${item.sourceId}`} {...noteAudioPlayerProps(props.audio)} durationSecs={item.durationSecs} />
      ) : item.source === VOICE_NOTE_SOURCE && meta && Object.keys(meta).length === 0 ? (
        <p role="status" className="text-callout text-muted-foreground" data-testid="voice-note-saving-from-phone">
          Saving from your phone…
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
