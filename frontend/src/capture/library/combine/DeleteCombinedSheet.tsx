// TC-1152 S2c-1: "Delete combined meeting" confirmation. Says exactly what goes (the combined
// meeting) and what stays (the originals); the safe choice is first.
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import type { CombinedMeetingController } from "./useCombinedMeeting";

export function DeleteCombinedSheet(props: { remove: CombinedMeetingController["remove"]; title: string }) {
  const { remove } = props;
  return (
    <ResponsiveSheet
      open={remove.open}
      onOpenChange={(next) => { if (!next) remove.keep(); }}
      dismissible={!remove.busy}
      title="Delete combined meeting?"
      description={props.title}
      contentProps={{ "data-testid": "delete-combined-sheet" }}
      footer={
        <>
          <Button type="button" variant="outline" onClick={remove.keep} disabled={remove.busy} data-testid="delete-combined-keep">Keep it</Button>
          <Button type="button" variant="destructive" onClick={remove.confirm} disabled={remove.busy} data-testid="delete-combined-confirm">
            {remove.busy && <Loader2Icon aria-hidden className="motion-safe:animate-spin" />} Delete combined meeting
          </Button>
        </>
      }
    >
      <ResponsiveSheetBody>
        <div className="flex flex-col gap-3">
          <p className="text-callout">This removes only the combined meeting. The original captures it was made from stay in your Library, unchanged.</p>
          {remove.error && <p role="alert" className="text-callout text-destructive" data-testid="delete-combined-error">{remove.error}</p>}
        </div>
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}
