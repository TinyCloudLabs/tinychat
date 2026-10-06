// The receipt when a recording lands (plan §2.7): it says where the note is,
// with the route's last node checked. A save that failed says the note is
// still on the phone and offers Save now.
import { AlertCircleIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RECEIPT_KEPT, RECEIPT_SAVED, receiptMetaText } from "./recorderCopy";
import { RouteLine, type RouteNode } from "./RouteLine";

export interface SavedReceiptProps {
  outcome: "saved" | "failed";
  /** The saved note (absent after a failure). */
  saved?: { durationMs: number; at: number } | null;
  route: readonly RouteNode[];
  /** Private cloud has the note now. */
  transcribing?: boolean;
  error?: string | null;
  /** A save of the notes on this phone is running. */
  retrying?: boolean;
  onOpen?: () => void;
  onDone: () => void;
  onSaveNow: () => void;
  className?: string;
}

export function SavedReceipt(props: SavedReceiptProps) {
  const saved = props.outcome === "saved";
  return (
    <section
      aria-label={saved ? RECEIPT_SAVED : RECEIPT_KEPT}
      data-testid="voice-note-receipt"
      data-outcome={props.outcome}
      className={cn("flex flex-col gap-3 rounded-xl border border-border p-4 motion-safe:animate-rise-in", props.className)}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className={cn("text-headline", !saved && "flex items-start gap-2")}>
          {!saved && <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />}
          {saved ? RECEIPT_SAVED : RECEIPT_KEPT}
        </h3>
        {saved && props.saved && <p className="tnum text-meta text-muted-foreground">{receiptMetaText(props.saved.durationMs, props.saved.at)}</p>}
        {!saved && props.error && (
          <p role="alert" className="text-meta text-muted-foreground">
            {props.error}
          </p>
        )}
      </div>
      <RouteLine nodes={props.route} landed={saved} />
      {saved && props.transcribing && <p className="text-meta text-muted-foreground">Transcribing in private cloud…</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {saved ? (
          <>
            {props.onOpen && (
              <Button type="button" variant="outline" onClick={props.onOpen} data-testid="voice-note-receipt-open">
                Open
              </Button>
            )}
            <Button type="button" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
            <Button type="button" onClick={props.onSaveNow} disabled={props.retrying} data-testid="voice-note-retry">
              {props.retrying && <Loader2Icon className="animate-spin" aria-hidden="true" />} Save now
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
