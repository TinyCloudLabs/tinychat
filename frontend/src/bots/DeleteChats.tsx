// The owner's "Delete chats" with Main, in Main's chat sheet next to its settings. It asks first; on confirm the
// service clears Main's conversation and the saved history is deleted from the owner's space. TC-4080
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { BotsRouteMissing } from "./botsApi";
import { DELETE_CHATS_STRINGS as COPY } from "./botsStrings";
import type { DeleteChatsOutcome } from "./mainDeleteChats";

export interface DeleteChatsApi {
  run(): Promise<DeleteChatsOutcome>;
  /** Called once Main's conversation is cleared (also when some saved history is left), so the chat and its questions are read again. */
  onCleared?(): void;
}

const LINES: Record<DeleteChatsOutcome, string> = {
  deleted: COPY.deleted,
  busy: COPY.busy,
  archive_pending: COPY.archivePending,
  history_incomplete: COPY.historyIncomplete,
  signed_out: COPY.signedOut,
  failed: COPY.failed,
};

/** Renders nothing once the service answers 404 (the route is not on for this account). `onWorking` is true from the confirm until the answer. */
export function DeleteChats({ api, onWorking }: { api: DeleteChatsApi; onWorking?: (working: boolean) => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<DeleteChatsOutcome | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { if (confirming) box.current?.focus(); }, [confirming]);

  if (missing) return null;

  const run = async () => {
    setDeleting(true);
    onWorking?.(true);
    let outcome: DeleteChatsOutcome;
    try {
      outcome = await api.run();
    } catch (error) {
      onWorking?.(false);
      if (!alive.current) return;
      if (error instanceof BotsRouteMissing) { setMissing(true); return; }
      outcome = "failed";
    }
    onWorking?.(false);
    if (outcome === "deleted" || outcome === "history_incomplete") api.onCleared?.();
    if (!alive.current) return;
    setDeleting(false);
    setConfirming(false);
    setResult(outcome);
  };

  return (
    <section className="flex flex-col items-start gap-3" data-bots-delete-chats="">
      {confirming ? (
        <div
          ref={box}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-body`}
          className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p id={`${id}-title`} className="text-headline">{COPY.confirmTitle}</p>
          <p id={`${id}-body`} className="text-callout text-muted-foreground">{COPY.confirmBody}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void run()}>{deleting ? COPY.deleting : COPY.confirm}</Button>
            <Button type="button" variant="outline" disabled={deleting} onClick={() => setConfirming(false)}>{COPY.cancel}</Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => { setResult(null); setConfirming(true); }}>{COPY.start}</Button>
      )}
      {result ? <p role={result === "deleted" ? "status" : "alert"} className="text-callout text-muted-foreground">{LINES[result]}</p> : null}
    </section>
  );
}
