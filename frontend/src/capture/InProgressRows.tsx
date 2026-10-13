// In progress on Capture (TC-761): the upload the runner holds (running,
// failed, saved until dismissed, or paused for the user's key), and the
// notetaker sessions still moving, and the voice notes still only on this
// phone (with Save now) or stopped at the limit. A row opens its sheet; End,
// Continue and Save now sit beside the row, never inside it. What has landed
// is under Recent and in the Library.
import { AlertCircleIcon, FileAudioIcon, Loader2Icon, MicIcon, VideoIcon } from "lucide-react";

import { uploadStatusText } from "@/chat/AudioUploadPanel";
import { ACTIVE_STATUSES, meetingTitle, statusLabel } from "@/chat/TranscriberSection";
import type { UploadState } from "@/lib/audioUpload";
import type { PendingListing } from "@/lib/voiceNotes/recorderSaves";
import type { TranscriberMeeting } from "@/lib/transcriberApi";
import { transcriberMeetingTitle } from "@/lib/transcriberSave";
import type { PausedUpload } from "./upload/pausedUpload";
import { HOME_COPY } from "./home/homeCopy";

/** The recorder's part of In progress (the phone app). */
export interface VoiceInProgress {
  /** What the phone last listed as still only on it (unknown, a count, or a listing that failed). */
  listing: PendingListing;
  /** A save of them is running. */
  saving: boolean;
  /** Current network state, from the same pending-store snapshot as the listing. */
  online?: boolean;
  /** Per-note upload state, used to keep Save now hidden while work is moving. */
  pendingNotes?: readonly { id: string; upload?: { state: "waiting" | "uploading" | "retrying" } }[];
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

// The same look as the voice card (home.css): a glass card, the title over a dim line,
// and a pill beside it. The text keeps its room; with large text the pill wraps below it.
function RowText(props: { title: string; meta: string; spinning?: boolean }) {
  return (
    <span className="soft-card-text">
      <b>{props.title}</b>
      <span>
        {props.spinning && <Loader2Icon className="soft-card-spin animate-spin" aria-hidden="true" />}
        {props.meta}
      </span>
    </span>
  );
}

function Pill(props: { label: string; onClick: () => void; disabled?: boolean; quiet?: boolean; testId?: string; ariaLabel?: string }) {
  return (
    <span className="soft-pill-hit" data-hit-area="">
      <button
        type="button"
        className="soft-pill"
        data-quiet={props.quiet ? "true" : undefined}
        onClick={props.onClick}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        data-testid={props.testId}
      >
        {props.label}
      </button>
    </span>
  );
}

/**
 * Whether there is anything in progress to show (the rows render nothing
 * otherwise). A phone listing that failed counts: it has its recovery row.
 */
export function inProgressShown(props: Pick<InProgressRowsViewProps, "upload" | "paused" | "meetings" | "voice">): boolean {
  const { upload, paused, meetings, voice } = props;
  const voiceShown =
    voice !== undefined &&
    ((voice.listing.state === "ok" && voice.listing.count > 0) || voice.listing.state === "error" || !!voice.limitNotice);
  return upload !== null || paused !== null || meetings.length > 0 || voiceShown;
}

export function InProgressRowsView(props: InProgressRowsViewProps) {
  const { upload, paused, meetings, voice } = props;
  const showPaused = upload === null && paused !== null;
  const voiceCount = voice?.listing.state === "ok" ? voice.listing.count : 0;
  const voicePending = voiceCount > 0;
  // A listing that failed is never shown as "nothing pending": it gets its own row with Try again.
  const voiceListFailed = voice?.listing.state === "error" ? voice.listing.message : null;
  const voiceLimit = voice?.limitNotice ?? null;
  if (!inProgressShown(props)) return null;
  const uploadBusy = upload !== null && upload.stage !== "saved" && upload.stage !== "failed" && upload.stage !== "elsewhere";
  return (
    <section aria-labelledby="in-progress-title" data-testid="in-progress">
      <h2 id="in-progress-title" className="soft-sect">
        In progress
      </h2>
      <ul className="soft-in-progress-list">
        {upload !== null && (
          <li className="soft-card" data-testid="in-progress-upload" data-stage={upload.stage}>
            <button type="button" className="soft-card-main" onClick={props.onOpenUpload}>
              <FileAudioIcon className="soft-ico soft-card-icon" aria-hidden="true" />
              <RowText title={upload.fileName} meta={uploadStatusText(upload)} spinning={uploadBusy} />
            </button>
          </li>
        )}
        {showPaused && (
          <li className="soft-card" data-testid="in-progress-upload-paused">
            <button type="button" className="soft-card-main" onClick={props.onOpenUpload}>
              <FileAudioIcon className="soft-ico soft-card-icon" aria-hidden="true" />
              <RowText title={paused.fileName} meta="Upload paused" />
            </button>
            <Pill label="Continue" onClick={props.onContinue} />
          </li>
        )}
        {voice && voicePending && (
          <li className="soft-card" data-testid="voice-note-pending">
            <span className="soft-card-main">
              <MicIcon className="soft-ico soft-card-icon" aria-hidden="true" />
              <RowText
                title={voiceCount === 1 ? "1 voice note on this phone" : `${voiceCount} voice notes on this phone`}
                meta={voice.lastError ?? (voice.saving ? HOME_COPY.savingToSpace : HOME_COPY.notInSpace)}
                spinning={voice.saving}
              />
            </span>
            <Pill label="Save now" onClick={voice.onSaveNow} disabled={voice.saving} testId="voice-note-retry" />
          </li>
        )}
        {voice && voiceListFailed && (
          <li className="soft-card" data-testid="voice-note-list-failed">
            <span className="soft-card-main">
              <AlertCircleIcon className="soft-ico soft-card-icon" aria-hidden="true" />
              <RowText title="Couldn't check this phone for unsaved notes" meta={voiceListFailed} spinning={voice.saving} />
            </span>
            <Pill label="Try again" quiet onClick={voice.onSaveNow} disabled={voice.saving} testId="voice-note-list-retry" />
          </li>
        )}
        {voiceLimit && (
          <li className="soft-card">
            <span className="soft-card-main">
              <MicIcon className="soft-ico soft-card-icon" aria-hidden="true" />
              <span className="soft-card-text">
                <b>Voice note</b>
                <span data-warn="true" data-testid="voice-note-limit">
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
            <li key={meeting.id} className="soft-card" data-testid="in-progress-meeting">
              <button type="button" className="soft-card-main" onClick={props.onOpenMeeting}>
                <VideoIcon className="soft-ico soft-card-icon" aria-hidden="true" />
                <RowText title={title} meta={`Notetaker · ${statusLabel(meeting.status)}`} spinning={meeting.status === "processing"} />
              </button>
              {stoppable && (
                <Pill
                  label={busy ? "Ending…" : "End"}
                  quiet
                  disabled={busy}
                  onClick={() => props.onEnd(meeting.id)}
                  ariaLabel="End meeting and transcribe now"
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
