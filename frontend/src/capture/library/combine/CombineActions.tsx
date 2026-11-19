// TC-1152 S2c-1: the Combine entry and the combined meeting's actions, in a note's header
// (NoteDetailView). A meeting capture offers "Combine with another capture…"; a combined meeting
// offers "Delete combined meeting" and, when a source's text changed, "a source changed · Re-combine".
import { GitMergeIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CombineDetail } from "./combinedView";

export function CombineActions(props: { combine: CombineDetail | undefined }) {
  const { combine } = props;
  if (!combine || (!combine.onCombine && !combine.combined)) return null;
  const combined = combine.combined;
  return (
    <div className="flex flex-col gap-2 pt-2" data-testid="combine-actions">
      {combined?.stale && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-callout text-amber-700 dark:text-amber-300" data-testid="combined-stale">
          A source changed
          {combined.onRecombine && <>
            <span aria-hidden>·</span>
            <button type="button" onClick={combined.onRecombine} data-testid="combined-recombine"
              className="min-h-11 text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Re-combine</button>
          </>}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {combine.onCombine && (
          <Button type="button" variant="outline" onClick={combine.onCombine} data-testid="combine-entry">
            <GitMergeIcon aria-hidden /> Combine with another capture…
          </Button>
        )}
        {combined && (
          <Button type="button" variant="outline" onClick={combined.onDelete} data-testid="combined-delete" className="text-destructive">
            <Trash2Icon aria-hidden /> Delete combined meeting
          </Button>
        )}
      </div>
    </div>
  );
}
