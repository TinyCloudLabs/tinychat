// TC-4413: "Delete meeting?" confirmation for a Granola meeting. Says exactly what goes (the meeting, its
// transcript and the combined meetings that include it), that it cannot be undone, and how imports can be
// allowed back; the safe choice is first.
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";

/** What goes with the meeting: the count when it is known, the plain rule while it is not. */
export function combinedLine(count: number | null): string | null {
  if (count === null) return "Any combined meeting that includes it will be deleted too.";
  if (count === 0) return null;
  return count === 1
    ? "1 combined meeting that includes it will be deleted too."
    : `${count} combined meetings that include it will be deleted too.`;
}

export function DeleteGranolaSheet(props: { open: boolean; title: string; busy: boolean; error: string | null; combinedCount: number | null; source?: "granola" | "fireflies" | "google-meet"; onKeep: () => void; onConfirm: () => void }) {
  const combined = combinedLine(props.combinedCount);
  return <ResponsiveSheet open={props.open} onOpenChange={(next) => { if (!next) props.onKeep(); }} dismissible={!props.busy}
    title="Delete meeting?" description={props.title} contentProps={{ "data-testid": "delete-granola-sheet" }}
    footer={<>
      <Button type="button" variant="outline" onClick={props.onKeep} disabled={props.busy} data-testid="delete-granola-keep">Keep it</Button>
      <Button type="button" variant="destructive" onClick={props.onConfirm} disabled={props.busy} data-testid="delete-granola-confirm">
        {props.busy && <Loader2Icon aria-hidden className="motion-safe:animate-spin" />} Delete meeting
      </Button>
    </>}>
    <ResponsiveSheetBody>
      <div className="flex flex-col gap-3">
        <p className="text-callout">This deletes the meeting and its transcript from your space. It can’t be undone.</p>
        {combined && <p className="text-callout" data-testid="delete-granola-combined">{combined}</p>}
        <p className="text-callout">{props.source === "fireflies"
          ? "Syncing Fireflies won’t bring it back unless you choose “Allow deleted Fireflies meetings back”."
          : props.source === "google-meet"
            ? "Syncing Google Meet won’t bring it back unless you choose “Allow deleted Google Meet meetings back”."
            : "Importing the same CSV or syncing Granola won’t bring it back unless you choose “Allow deleted Granola meetings back”."}</p>
        {props.error && <p role="alert" className="text-callout text-destructive" data-testid="delete-granola-error">{props.error}</p>}
      </div>
    </ResponsiveSheetBody>
  </ResponsiveSheet>;
}
