// In progress on Capture (TC-761): the upload the runner holds (running,
// failed, saved until dismissed, or paused for the user's key), and the
// notetaker sessions still moving, and the voice notes still only on this
// phone (with Save now) or stopped at the limit. A row opens its sheet; End,
// Continue and Save now sit beside the row, never inside it. The Library's
// rows join these later (PR6).
import { AlertCircleIcon, FileAudioIcon, Loader2Icon, MicIcon, VideoIcon } from "lucide-react";

import { uploadStatusText } from "@/chat/AudioUploadPanel";
import { ACTIVE_STATUSES, meetingTitle, statusLabel } from "@/chat/TranscriberSection";
import { Button } from "@/components/ui/button";
import type { UploadState } from "@/lib/audioUpload";
import type { PendingListing } from "@/lib/voiceNotes/recorderSaves";
import type { TranscriberMeeting } from "@/lib/transcriberApi";
import { transcriberMeetingTitle } from "@/lib/transcriberSave";
import type { PausedUpload } from "./upload/pausedUpload";

/** The recorder's part of In progress (the phone app). */
export interface VoiceInProgress {
  /** What the phone last listed as still only on it (unknown, a count, or a listing that failed). */
  listing: PendingListing;
  /** A save of them is running. */
  saving: boolean;
  lastError: string | null;
  /** The last recording stopped itself at the limit. */
  limitNotice: string | null;
  onSaveNow: () => void;
}

export interface InProgressRowsViewProps {
  upload: UploadState | null;
  paused: PausedUpload | null;
  /** The notetaker sessions still moving. */
  meetings: readonly TranscriberMeeting[];
  busyId: string | null;
  voice?: VoiceInProgress;
  onOpenUpload: () => void;
  onContinue: () => void;
  onOpenMeeting: () => void;
  onEnd: (id: string) => void;
}

// The text keeps at least 12rem; with large text that leaves no room, and the
// row's trailing action wraps below it instead of squeezing it.
const ROW = "flex flex-wrap items-center gap-x-2 py-1";
const ROW_MAIN =
  "tap-transparent flex min-h-14 min-w-[12rem] flex-1 items-center gap-3 rounded-lg px-1 text-left transition-colors hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RowText(props: { title: string; meta: string; spinning?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="line-clamp-2 text-callout font-semibold [overflow-wrap:anywhere]">{props.title}</span>
      <span className="flex items-center gap-1.5 text-meta text-muted-foreground [overflow-wrap:anywhere]">
        {props.spinning && <Loader2Icon className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
        {props.meta}
      </span>
    </span>
  );
}

export function InProgressRowsView(props: InProgressRowsViewProps) {
  const { upload, paused, meetings, voice } = props;
  const showPaused = upload === null && paused !== null;
  const voiceCount = voice?.listing.state === "ok" ? voice.listing.count : 0;
  const voicePending = voiceCount > 0;
  // A listing that failed is never shown as "nothing pending": it gets its own row with Try again.
  const voiceListFailed = voice?.listing.state === "error" ? voice.listing.message : null;
  const voiceLimit = voice?.limitNotice ?? null;
  if (upload === null && !showPaused && meetings.length === 0 && !voicePending && !voiceListFailed && !voiceLimit) return null;
  const uploadBusy = upload !== null && upload.stage !== "saved" && upload.stage !== "failed" && upload.stage !== "elsewhere";
  return (
    <section aria-labelledby="in-progress-title" data-testid="in-progress">
      <h2 id="in-progress-title" className="text-headline">
        In progress
      </h2>
      <ul className="mt-2 flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-2">
        {upload !== null && (
          <li className={ROW} data-testid="in-progress-upload" data-stage={upload.stage}>
            <button type="button" className={ROW_MAIN} onClick={props.onOpenUpload}>
              <FileAudioIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <RowText title={upload.fileName} meta={uploadStatusText(upload)} spinning={uploadBusy} />
            </button>
          </li>
        )}
        {showPaused && (
          <li className={ROW} data-testid="in-progress-upload-paused">
            <button type="button" className={ROW_MAIN} onClick={props.onOpenUpload}>
              <FileAudioIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <RowText title={paused.fileName} meta="Upload paused" />
            </button>
            <Button type="button" size="sm" onClick={props.onContinue}>
              Continue
            </Button>
          </li>
        )}
        {voice && voicePending && (
          <li className={ROW} data-testid="voice-note-pending">
            <span className="flex min-h-14 min-w-[12rem] flex-1 items-center gap-3 px-1">
              <MicIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <RowText
                title={voiceCount === 1 ? "1 voice note on this phone" : `${voiceCount} voice notes on this phone`}
                meta={voice.lastError ?? "Not in your space yet"}
                spinning={voice.saving}
              />
            </span>
            <Button type="button" size="sm" onClick={voice.onSaveNow} disabled={voice.saving} data-testid="voice-note-retry">
              Save now
            </Button>
          </li>
        )}
        {voice && voiceListFailed && (
          <li className={ROW} data-testid="voice-note-list-failed">
            <span className="flex min-h-14 min-w-[12rem] flex-1 items-center gap-3 px-1">
              <AlertCircleIcon className="size-5 shrink-0 text-warning" aria-hidden="true" />
              <RowText title="Couldn't check this phone for unsaved notes" meta={voiceListFailed} spinning={voice.saving} />
            </span>
            <Button type="button" size="sm" variant="outline" onClick={voice.onSaveNow} disabled={voice.saving} data-testid="voice-note-list-retry">
              Try again
            </Button>
          </li>
        )}
        {voiceLimit && (
          <li className={ROW}>
            <span className="flex min-h-14 min-w-[12rem] flex-1 items-center gap-3 px-1">
              <MicIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                <span className="text-callout font-semibold">Voice note</span>
                <span className="text-meta text-warning [overflow-wrap:anywhere]" data-testid="voice-note-limit">
                  {voiceLimit}
                </span>
              </span>
            </span>
          </li>
        )}
        {meetings.map((meeting) => {
          const stoppable = ACTIVE_STATUSES.has(meeting.status) && meeting.status !== "processing";
          const busy = props.busyId === meeting.id;
          const title =
            meeting.metadata?.source === "google-calendar-autojoin" ? transcriberMeetingTitle(meeting) : meetingTitle(meeting.meeting_url);
          return (
            <li key={meeting.id} className={ROW} data-testid="in-progress-meeting">
              <button type="button" className={ROW_MAIN} onClick={props.onOpenMeeting}>
                <VideoIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <RowText title={title} meta={`Notetaker · ${statusLabel(meeting.status)}`} spinning={meeting.status === "processing"} />
              </button>
              {stoppable && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => props.onEnd(meeting.id)}
                  aria-label="End meeting and transcribe now"
                >
                  {busy ? "Ending…" : "End"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
