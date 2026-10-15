import { useEffect, useState } from "react";
import { debugEvents, debugLogEnabled, subscribeDebugLog, type DebugEvent } from "@/lib/debugLog";
import { isStorageFullError } from "@/lib/storageStatus";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** What the log shows. A storage-full entry shows a label, never the raw code or message; the copied log keeps them. */
export function displayEvent(event: DebugEvent): object {
  const storageFull = isStorageFullError({ code: event.code }) || (event.chain ?? []).some(isStorageFullError);
  if (!storageFull) return event;
  const { code: _code, chain, ...rest } = event;
  return { ...rest, label: "Storage full", chain: chain?.map(({ name, status }) => ({ name, status, label: "Storage full" })) };
}

export function DebugLogRow() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  // A changing revision keeps useSyncExternalStore's snapshot stable between events.
  const [, setRevision] = useState(0);
  useEffect(() => subscribeDebugLog(() => setRevision((n) => n + 1)), []);
  if (!debugLogEnabled()) return null;
  const entries = debugEvents();
  return <>
    <button type="button" onClick={() => setOpen(true)}
      className="flex min-h-11 w-full items-center justify-between rounded-md px-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span>Debug log</span><span className="text-xs text-muted-foreground">{entries.length} events</span>
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Debug log</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">Recent request details and pipeline errors from this app session.</p>
        <div className="flex items-center justify-end gap-3">
          {copyError && <span role="alert" className="text-xs text-destructive">Could not copy the log.</span>}
          <Button size="sm" variant="outline" onClick={async () => {
            try {
              await navigator.clipboard.writeText(debugEvents().map((event) => JSON.stringify(event)).join("\n"));
              setCopied(true);
              setCopyError(false);
            } catch { setCopyError(true); }
          }}>{copied ? "Copied" : "Copy"}</Button>
        </div>
        <pre className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
          aria-label="Debug events">{entries.length ? entries.map((event) => JSON.stringify(displayEvent(event))).join("\n") : "No events yet."}</pre>
      </DialogContent>
    </Dialog>
  </>;
}
