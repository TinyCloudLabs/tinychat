// In progress on Capture (TC-761): the upload the runner holds (running,
// failed, saved until dismissed, or paused for the user's key), and the
// notetaker sessions still moving. A row opens its sheet; End and Continue
// sit beside the row, never inside it. The recorder's and Library's rows join
// these later (PR4, PR6).
import { FileAudioIcon, Loader2Icon, VideoIcon } from "lucide-react";

import { uploadStatusText } from "@/chat/AudioUploadPanel";
import { ACTIVE_STATUSES, meetingTitle, statusLabel } from "@/chat/TranscriberSection";
import { Button } from "@/components/ui/button";
import type { UploadState } from "@/lib/audioUpload";
import type { TranscriberMeeting } from "@/lib/transcriberApi";
import { transcriberMeetingTitle } from "@/lib/transcriberSave";
import type { PausedUpload } from "./upload/pausedUpload";

export interface InProgressRowsViewProps {
  upload: UploadState | null;
  paused: PausedUpload | null;
  /** The notetaker sessions still moving. */
  meetings: readonly TranscriberMeeting[];
  busyId: string | null;
  onOpenUpload: () => void;
  onContinue: () => void;
  onOpenMeeting: () => void;
  onEnd: (id: string) => void;
}

const ROW_MAIN =
  "tap-transparent flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-1 text-left transition-colors hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RowText(props: { title: string; meta: string; spinning?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-callout font-semibold">{props.title}</span>
      <span className="flex items-center gap-1.5 truncate text-meta text-muted-foreground">
        {props.spinning && <Loader2Icon className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
        {props.meta}
      </span>
    </span>
  );
}

export function InProgressRowsView(props: InProgressRowsViewProps) {
  const { upload, paused, meetings } = props;
  const showPaused = upload === null && paused !== null;
  if (upload === null && !showPaused && meetings.length === 0) return null;
  const uploadBusy = upload !== null && upload.stage !== "saved" && upload.stage !== "failed" && upload.stage !== "elsewhere";
  return (
    <section aria-labelledby="in-progress-title" data-testid="in-progress">
      <h2 id="in-progress-title" className="text-headline">
        In progress
      </h2>
      <ul className="mt-2 flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-2">
        {upload !== null && (
          <li className="flex items-center gap-2 py-1" data-testid="in-progress-upload" data-stage={upload.stage}>
            <button type="button" className={ROW_MAIN} onClick={props.onOpenUpload}>
              <FileAudioIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <RowText title={upload.fileName} meta={uploadStatusText(upload)} spinning={uploadBusy} />
            </button>
          </li>
        )}
        {showPaused && (
          <li className="flex items-center gap-2 py-1" data-testid="in-progress-upload-paused">
            <button type="button" className={ROW_MAIN} onClick={props.onOpenUpload}>
              <FileAudioIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <RowText title={paused.fileName} meta="Upload paused" />
            </button>
            <Button type="button" size="sm" onClick={props.onContinue}>
              Continue
            </Button>
          </li>
        )}
        {meetings.map((meeting) => {
          const stoppable = ACTIVE_STATUSES.has(meeting.status) && meeting.status !== "processing";
          const busy = props.busyId === meeting.id;
          const title =
            meeting.metadata?.source === "google-calendar-autojoin" ? transcriberMeetingTitle(meeting) : meetingTitle(meeting.meeting_url);
          return (
            <li key={meeting.id} className="flex items-center gap-2 py-1" data-testid="in-progress-meeting">
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
