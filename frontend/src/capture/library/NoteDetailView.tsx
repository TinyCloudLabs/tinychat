// One note in the Library (TC-761), a pure function of its props: the title
// and meta, its audio, how it got into the space, and its transcript with
// Copy. A voice note without a transcript shows where its transcription
// stands instead (moved from the Voice notes card): Transcribe, the progress,
// "No speech", or the failure with its reference and Retry.
//
// Pushed (a phone): the page header with Back. Beside the list (wide): the
// title as the pane's heading.
import type { ReactNode } from "react";
import { CheckIcon, CopyIcon, FileTextIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { TranscriptionRouteControl } from "@/capture/recorder/TranscriptionRouteControl";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import type { MeetingMetadataRead, TranscriptRead } from "@/lib/connectors/meetingExplorer";
import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import { transcriptionStatusText } from "@/lib/voiceNotes/voiceNoteTranscription";
import { voiceNoteTranscriptState, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { detailWhen, formatSpokenDuration } from "./formatters";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DesktopWhisperStatus } from "./DesktopWhisperStatus";
import { HowThisGotHere } from "./HowThisGotHere";
import { librarySourceLabel } from "./libraryKinds";
import type { LibraryItem } from "./LibraryRow";
import type { LibraryStatus } from "./LibraryListView";
import { LazySavedNote } from "./savedNote/LazySavedNote";
import type { SavedNoteStore } from "./savedNote/savedNoteStore";

export type AudioLoad = (signal: AbortSignal, onProgress: (loadedBytes: number, totalBytes: number) => void) => Promise<Blob | null>;

export interface NoteDetailViewProps {
  item: LibraryItem | null;
  /** The list's state, for a note opened before the list has answered. */
  listStatus: LibraryStatus;
  /** Undefined while it is read. */
  metadata: MeetingMetadataRead | undefined;
  transcript: TranscriptRead | undefined;
  /** Reads the note's audio; null when it has none stored. */
  loadAudio: AudioLoad | null;
  /** Private cloud transcription (voice notes in the phone app); absent elsewhere. */
  transcription?: VoiceNoteTranscriptionProps;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
  /** Reads again what did not load (the list, or this note). */
  onRetry: () => void;
  /** A screen of its own (compact), with Back; otherwise a pane beside the list. */
  pushed: boolean;
  onBack: () => void;
  /** Behind the recorder flag: a voice note opens as its editable note (a page, or a sheet on a phone) instead of this view. */
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
  if (!transcription) return null;
  const job = transcription.jobs.get(item.sourceId);
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
  const offered = transcription.availability === "available" && transcription.consented;
  if (job?.kind === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="voice-note-transcription-failed">
        <p role="alert" className="min-w-0 flex-1 text-callout text-destructive">
          {job.message}
          {job.reference && <span className="text-muted-foreground"> Reference: {job.reference}</span>}
        </p>
        {offered && job.retryable && (
          <Button type="button" variant="outline" onClick={() => transcription.onTranscribe(item.sourceId)} data-testid="voice-note-transcribe-retry">
            <RefreshCwIcon aria-hidden /> Retry
          </Button>
        )}
      </div>
    );
  }
  // Private cloud is available but not chosen (or chosen and unreachable): the recorder's route control.
  const choosable = transcription.availability === "available" || (transcription.availability === "failed" && transcription.consented);
  // Reached only when private cloud is "available"/"failed", which requires a signed-in account
  // (voiceNoteTranscriberFor) — transcription itself would be absent otherwise.
  if (!offered) return choosable ? <TranscriptionRouteControl transcription={transcription} signedIn /> : null;
  if (item.durationSecs !== null && item.durationSecs > transcription.maxSeconds) {
    return (
      <p data-testid="voice-note-too-long" className="text-callout text-muted-foreground">
        Notes up to {Math.round(transcription.maxSeconds / 60)} minutes can be transcribed from the phone.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-callout text-muted-foreground">Not transcribed</p>
      <Button type="button" variant="outline" onClick={() => transcription.onTranscribe(item.sourceId)} data-testid="voice-note-transcribe">
        <FileTextIcon aria-hidden /> Transcribe
      </Button>
    </div>
  );
}

/** The transcript text a voice note's row carries (`transcript_text`), for when its body can't be read. */
function savedText(metadata: MeetingMetadataRead): string | null {
  const text = metadata.status === "ok" ? metadata.metadata.transcript_text : null;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

function Transcript(props: NoteDetailViewProps & { item: LibraryItem }) {
  const { item, transcript, metadata } = props;
  const sentences = transcript?.status === "ok" ? transcript.sentences : [];
  const voiceNote = item.source === VOICE_NOTE_SOURCE;
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
      {transcript === undefined ? (
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
      ) : sentences.length > 0 ? (
        <div className="flex max-w-[68ch] flex-col gap-4 [-webkit-touch-callout:default] select-text">
          {transcriptBlocks(sentences).map((block, index) => (
            <div key={index}>
              {block.speaker && <p className="text-meta font-semibold text-muted-foreground">{block.speaker}</p>}
              <p className="whitespace-pre-wrap break-words text-body">{block.text}</p>
            </div>
          ))}
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
            fallback={
              // A plain function of its props (no hooks), so its "nothing to say" is known here.
              VoiceNoteTranscriptionStatus({
                item,
                outcome: voiceNoteTranscriptState(metadata.status === "ok" ? metadata.metadata : null).status,
                transcription: props.transcription,
              }) ?? <p className="text-callout text-muted-foreground">No transcript.</p>
            }
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
        key={item.id}
        item={item}
        metadata={metadata}
        loadAudio={props.loadAudio}
        tcw={props.savedNote.tcw}
        store={props.savedNote.store}
        layout={props.savedNote.layout}
        onBack={props.onBack}
        transcript={<Transcript {...props} item={item} />}
        footer={<HowThisGotHere source={item.source} read={metadata} onRetry={props.onRetry} />}
      />
    );
  }

  const title = item.title ?? "Untitled";
  const meta = metadata?.status === "ok" ? metadata.metadata : null;
  const audioKept = (meta?.audio as { stored?: unknown } | undefined)?.stored === true;
  return (
    <Frame title={title} pushed={props.pushed} onBack={props.onBack}>
      <header className="flex flex-col gap-1" data-testid="note-detail" data-note-id={item.id}>
        {!props.pushed && <h2 className="font-display text-title-1 [overflow-wrap:anywhere]">{title}</h2>}
        <p className="tnum text-meta text-muted-foreground">{noteMeta(item)}</p>
      </header>
      {props.loadAudio ? (
        <MeetingAudioPlayer key={item.id} load={props.loadAudio} />
      ) : item.source === VOICE_NOTE_SOURCE && meta && Object.keys(meta).length === 0 ? (
        <p role="status" className="text-callout text-muted-foreground" data-testid="voice-note-saving-from-phone">
          Saving from your phone…
        </p>
      ) : item.source === UPLOAD_MEETING_SOURCE && metadata?.status === "ok" && !audioKept ? (
        <p className="text-callout text-muted-foreground" data-testid="note-audio-missing">
          Only the transcript was saved; the audio wasn’t stored.
        </p>
      ) : null}
      <HowThisGotHere source={item.source} read={metadata} onRetry={props.onRetry} />
      <Transcript {...props} item={item} />
    </Frame>
  );
}
