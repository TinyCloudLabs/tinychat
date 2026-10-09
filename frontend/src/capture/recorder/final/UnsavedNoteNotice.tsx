import { useState } from "react";
import { useRecorder, type RecorderValue } from "../RecorderProvider";
import { Button } from "@/components/ui/button";
import { NOTES_COPY } from "./notesCopy";
import { dismissUnsavedNote, useUnsavedNote } from "./notes/notesUiState";

// This file is in the main bundle (the overlay draws it on the saved receipt): keep it light.

export type CopyState = "idle" | "copied" | "failed";

export function UnsavedNoteNoticeView({
  hasText,
  copy,
  onCopy,
  onDismiss,
}: {
  hasText: boolean;
  copy: CopyState;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="unsaved-note-notice"
      className="rounded-xl border border-warning/40 bg-surface-2 p-3 text-callout text-foreground shadow-sm"
    >
      <p className="m-0 font-semibold text-warning">{NOTES_COPY.noteLostAtDone}</p>
      {copy === "failed" && (
        <p className="m-0 mt-1 text-destructive">{NOTES_COPY.copyNoteFailed}</p>
      )}
      {copy === "copied" && (
        <p role="status" className="m-0 mt-1 text-muted-foreground">
          {NOTES_COPY.noteCopied}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        {hasText && (
          <Button type="button" size="sm" className="min-h-11" onClick={onCopy}>
            {NOTES_COPY.copyNote}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-11"
          onClick={onDismiss}
        >
          {NOTES_COPY.dismissNoteNotice}
        </Button>
      </div>
    </div>
  );
}

/**
 * On the saved receipt of a recording that ended with its note unsaved: says so, and keeps the text until the user
 * copies it, dismisses this, or another recording starts.
 */
export function UnsavedNoteNotice({
  writeClipboard = (text: string) => navigator.clipboard.writeText(text),
}: {
  writeClipboard?: (text: string) => Promise<void>;
}) {
  const unsaved = useUnsavedNote();
  const [copy, setCopy] = useState<CopyState>("idle");
  if (unsaved === null) return null;
  return (
    <UnsavedNoteNoticeView
      hasText={unsaved.md !== ""}
      copy={copy}
      onCopy={() => {
        void (async () => writeClipboard(unsaved.md))().then(
          () => setCopy("copied"),
          (error: unknown) => {
            console.error("[Recorder] Could not copy the unsaved note", error);
            setCopy("failed");
          },
        );
      }}
      onDismiss={dismissUnsavedNote}
    />
  );
}

/** Whether a saved or failed recording's receipt is on screen, where ReceiptNoteNotice carries the notice. */
export function receiptIsOpen(
  recorder: Pick<RecorderValue, "phase" | "outcome" | "sheetOpen">,
): boolean {
  return recorder.sheetOpen && recorder.phase === "idle" && recorder.outcome !== null;
}

/** True while the shell should carry the lost-note notice itself: a note is retained and the open receipt isn't showing it. */
export function useShellNoteNotice(): boolean {
  const recorder = useRecorder();
  return useUnsavedNote() !== null && !receiptIsOpen(recorder);
}

/**
 * The lost-note notice once the receipt has closed (its timers dismiss it on their own), so Copy note stays reachable
 * until the user dismisses it. The shell draws it above the tab bar on a phone, and at the top centre of the window beside the rail or sidebar.
 */
export function ShellNoteNotice({ layout }: { layout: "tabbar" | "beside" }) {
  const shown = useShellNoteNotice();
  if (!shown) return null;
  if (layout === "tabbar")
    return (
      <div className="px-3 py-1" data-testid="shell-note-notice">
        <UnsavedNoteNotice />
      </div>
    );
  return (
    <div
      data-testid="shell-note-notice"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+1rem)] z-40 mx-auto max-w-xl px-5"
    >
      <div className="pointer-events-auto">
        <UnsavedNoteNotice />
      </div>
    </div>
  );
}

/** The notice on a saved or failed recording's receipt, below the header: positioned over the receipt, which it doesn't move. */
export function ReceiptNoteNotice() {
  const recorder = useRecorder();
  const unsaved = useUnsavedNote();
  // Nothing at all without a lost note, so the classic receipt (and the flag off) is unchanged.
  if (unsaved === null || recorder.phase !== "idle" || recorder.outcome === null)
    return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-10 mx-auto max-w-xl px-5">
      <div className="pointer-events-auto">
        <UnsavedNoteNotice />
      </div>
    </div>
  );
}
