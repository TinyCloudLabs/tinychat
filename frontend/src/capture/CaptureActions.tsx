// Capture's actions (TC-761): Upload and Meeting open their sheets; the middle
// slot holds the recorder's Record button where there is one (the phone app).
// Wide screens get the same row; there is no separate wide bar yet.
import type { ReactNode } from "react";
import { UploadIcon, VideoIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const ACTION =
  "tap-transparent flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 px-3 text-callout font-medium text-foreground transition-colors hover:bg-accent active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export interface CaptureActionsProps {
  onUpload: () => void;
  /** Absent when the backend has no notetaker (the list is dark). */
  onMeeting?: () => void;
  /** The recorder's Record button (phone app), between the two. */
  record?: ReactNode;
  className?: string;
}

export function CaptureActions({ onUpload, onMeeting, record, className }: CaptureActionsProps) {
  return (
    <div className={cn("flex gap-2", className)} data-testid="capture-actions">
      <button type="button" className={ACTION} onClick={onUpload} aria-label="Upload audio" data-testid="capture-upload">
        <UploadIcon className="size-5 shrink-0" aria-hidden="true" />
        Upload
      </button>
      {record}
      {onMeeting && (
        <button type="button" className={ACTION} onClick={onMeeting} aria-label="Send a notetaker to a meeting" data-testid="capture-meeting">
          <VideoIcon className="size-5 shrink-0" aria-hidden="true" />
          Meeting
        </button>
      )}
    </div>
  );
}
