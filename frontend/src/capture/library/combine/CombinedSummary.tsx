// TC-1152 v1b-b: a combined meeting's own summary, in its page (NoteDetailView), above the transcript.
// Shows the model's text only as plain React text (no markup, no links). The sources' own summaries
// (Fireflies, Gemini notes) stay on their own pages.
import { Loader2Icon } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import type { SummaryView } from "@/lib/meetingSummary/summaryRunner";

export function CombinedSummary(props: { summary: SummaryView; onRetry?: () => void }) {
  const { summary } = props;
  return (
    <section aria-labelledby="combined-summary-heading" data-testid="combined-summary" data-state={summary.status} className="flex flex-col gap-3">
      <h2 id="combined-summary-heading" className="text-headline">Summary</h2>
      {summary.status === "loading" && (
        <div role="status" data-testid="combined-summary-loading">
          <span className="sr-only">Loading the summary…</span>
          <Skeleton lines={3} />
        </div>
      )}
      {summary.status === "generating" && (
        <p role="status" data-testid="combined-summary-generating" className="flex items-center gap-2 text-callout text-muted-foreground">
          <Loader2Icon aria-hidden className="size-4 animate-spin" /> Generating summary…
        </p>
      )}
      {summary.status === "ready" && (
        <div className="flex flex-col gap-3">
          {summary.overview.split("\n\n").map((paragraph, index) => (
            <p key={index} className="text-body [overflow-wrap:anywhere]" data-testid="combined-summary-overview">{paragraph}</p>
          ))}
          {summary.actionItems.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="combined-summary-actions">
              <h3 className="text-callout font-medium">Action items</h3>
              <ul className="list-disc space-y-1 pl-5 text-body [overflow-wrap:anywhere]">
                {summary.actionItems.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {summary.status === "unavailable" && (
        <div className="flex flex-col gap-1" data-testid="combined-summary-unavailable" data-reason={summary.reason}>
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-callout text-muted-foreground">
            Summary unavailable
            {summary.reason !== "too_long" && props.onRetry && <>
              <span aria-hidden>·</span>
              <button type="button" onClick={props.onRetry} data-testid="combined-summary-retry"
                className="min-h-11 min-w-11 text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Retry</button>
            </>}
          </p>
          {summary.reason === "too_long" && <p className="text-callout text-muted-foreground">This meeting is too long to summarise.</p>}
          {summary.reason === "paywall" && <p className="text-callout text-muted-foreground">Summaries use your credits, and you’re out of them.</p>}
        </div>
      )}
    </section>
  );
}
