import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";

export function DeleteGranolaSheet(props: { open: boolean; title: string; busy: boolean; error: string | null; onKeep: () => void; onConfirm: () => void }) {
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
        <p className="text-callout">This deletes the meeting and its transcript from your space. Importing the same CSV or syncing Granola won’t bring it back until you choose “Allow deleted meetings back”. Any combined meeting that includes it is deleted too.</p>
        {props.error && <p role="alert" className="text-callout text-destructive" data-testid="delete-granola-error">{props.error}</p>}
      </div>
    </ResponsiveSheetBody>
  </ResponsiveSheet>;
}
