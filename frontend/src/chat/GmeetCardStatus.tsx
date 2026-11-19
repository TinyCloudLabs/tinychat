// Google Meet row extras on the Connectors card: what a sync that this card did
// not start is doing (the session-start lane, the connect dialog's background
// Notes), the offer to wait for it, and "Copy sync log". Counters and step names
// only — nothing here reads a title, a participant or transcript text.
import { useState, type FC } from "react";

import { Button } from "@/components/ui/button";
import type { GmeetLiveStatus } from "@/lib/connectors/gmeetSync";
import type { GmeetSyncLog } from "@/lib/connectors/gmeetSyncLog";

export type GmeetPressMode = "auto" | "snapshot";

export const gmeetPressLabel = (mode: GmeetPressMode): string => (mode === "snapshot" ? "Full rescan" : "Sync now");

/** One line of what the running sync is doing, or null when nothing is running. */
export function describeGmeetLive(status: GmeetLiveStatus): string | null {
  if (!status.running) return null;
  const progress = status.progress;
  let step: string | null = null;
  if (progress?.stage === "notes" && progress.notesTotal !== undefined) {
    step = `Notes ${progress.notesDone ?? 0}/${progress.notesTotal}`;
  } else if (progress?.stage === "notes-listing") {
    step = "Listing Docs in Drive";
  } else if (progress?.stage === "saving") {
    step = "Saving sync state";
  } else if (progress && progress.total !== null && progress.total > 0) {
    step = `Meet records ${progress.current}/${progress.total}`;
  }
  const lead = status.resumed
    ? "Resuming a Notes sync that an earlier page load left unfinished"
    : "Google Meet is syncing";
  return step === null ? lead : `${lead} · ${step}`;
}

/** Shown while a sync runs that this card did not start (and nothing was pressed). */
export const GmeetLiveLine: FC<{ status: GmeetLiveStatus }> = ({ status }) => {
  const line = describeGmeetLive(status);
  if (line === null) return null;
  return <p className="text-xs text-muted-foreground" role="status" data-testid="gmeet-live-status">{line}</p>;
};

/** A press that a running sync refused: live progress, and the choice to wait for it. */
export const GmeetBusyOffer: FC<{
  mode: GmeetPressMode;
  status: GmeetLiveStatus;
  queued: boolean;
  onWait: () => void;
  onCancel: () => void;
}> = ({ mode, status, queued, onWait, onCancel }) => {
  const label = gmeetPressLabel(mode);
  const line = describeGmeetLive(status);
  return (
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground" role="status" data-testid="gmeet-busy-offer">
      <p>Another Google Meet sync is running{line === null ? "." : ` — ${line}.`}</p>
      {queued ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{label} will start when it finishes.</span>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      ) : (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onWait}>Wait, then run {label}</Button>
        </div>
      )}
    </div>
  );
};

/** Copies the last run's log (counters, step names, error kinds) as JSON. */
export const CopyGmeetSyncLogButton: FC<{ getLog: () => GmeetSyncLog | null }> = ({ getLog }) => {
  const [note, setNote] = useState<string | null>(null);
  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      setNote("Clipboard isn’t available in this browser.");
      return;
    }
    const log = getLog();
    if (log === null) {
      setNote("No sync log yet.");
      return;
    }
    clipboard.writeText(JSON.stringify(log, null, 2)).then(
      () => setNote("Sync log copied."),
      () => setNote("Couldn’t copy the sync log."),
    );
  };
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={copy}>Copy sync log</Button>
      {note && <span role="status" className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
};
