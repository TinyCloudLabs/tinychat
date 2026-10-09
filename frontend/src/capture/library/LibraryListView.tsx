// The Library's list (TC-761), a pure function of its props: the kind filter,
// then the rows under their day, newest first. Loading shows skeleton rows; a
// list that did not load says so and offers Try again (never "nothing here");
// an empty filter says what it holds.
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { CheckIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { orphanIssues } from "../home/captureIssues";
import { SoftIssueRow } from "../home/SoftIssueRow";
import { useSoftHome } from "../home/softHome";
import { groupByDay } from "./formatters";
import { LIBRARY_FILTERS, emptyFilterText, matchesFilter, type LibraryFilter } from "./libraryKinds";
import { LibraryRow, type LibraryItem } from "./LibraryRow";

export type LibraryStatus = "loading" | "ready" | "failed";

export interface LibraryListViewProps {
  status: LibraryStatus;
  items: readonly LibraryItem[];
  filter: LibraryFilter;
  onFilterChange: (filter: LibraryFilter) => void;
  onRetry: () => void;
  now: Date;
  /** The note open beside the list (wide screens). */
  selectedId?: string | null;
}

/**
 * The kind filter: one choice of four (a Radix ToggleGroup, type "single", so a
 * radio group). Unlike the equal-width SegmentedControl, each option is as wide
 * as its label, so all four sit on one row in a phone's width and in the
 * narrow list pane, and wrap rather than cut a label with large text. The
 * selected one has the selected tint, a primary edge, a check and a heavier
 * label, so selection never rests on colour alone.
 */
export function LibraryFilterControl(props: { value: LibraryFilter; onValueChange: (value: LibraryFilter) => void }) {
  return (
    <ToggleGroup.Root
      type="single"
      value={props.value}
      // Pressing the selected option again would clear it; a filter always has one.
      onValueChange={(next) => {
        if (next) props.onValueChange(next as LibraryFilter);
      }}
      aria-label="Show"
      className="flex flex-wrap gap-1.5"
    >
      {LIBRARY_FILTERS.map((option) => {
        const selected = option.value === props.value;
        return (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            className={cn(
              "tap-transparent flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-callout font-medium transition-colors fine:min-h-8",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:opacity-60",
              selected ? "border-primary bg-selected font-semibold text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {selected && <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />}
            {option.label}
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}

export function LibraryListView(props: LibraryListViewProps) {
  const { status, items, filter, now } = props;
  const shown = items.filter((item) => matchesFilter(item.source, filter));
  // Soft skin only: recordings with a capture issue and no row yet, under the voice-note filters.
  const soft = useSoftHome();
  const orphans = soft && matchesFilter(VOICE_NOTE_SOURCE, filter) ? orphanIssues(items, soft.issues) : [];
  return (
    <div
      className={cn("flex flex-col gap-3", soft && "focus:outline-none")}
      data-testid="library-list"
      data-state={status}
      {...(soft ? { role: "region", "aria-label": "Library", tabIndex: -1, "data-return-focus": "" } : {})}
    >
      <LibraryFilterControl value={filter} onValueChange={props.onFilterChange} />
      {status === "loading" && items.length === 0 && orphans.length === 0 ? (
        <div role="status">
          <span className="sr-only">Loading your Library…</span>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} shape="row" />
          ))}
        </div>
      ) : status === "failed" && items.length === 0 && orphans.length === 0 ? (
        <Empty
          data-testid="library-failed"
          title="Couldn’t load your Library."
          description="Check your connection, then try again."
          action={
            <Button type="button" variant="outline" onClick={props.onRetry}>
              <RefreshCwIcon aria-hidden="true" /> Try again
            </Button>
          }
        />
      ) : shown.length === 0 && orphans.length === 0 ? (
        <Empty
          data-testid="library-empty"
          title={items.length === 0 ? "Nothing here yet." : emptyFilterText(filter)}
          description={items.length === 0 ? "Voice notes, uploads and meetings land here once they’re in your space." : undefined}
        />
      ) : (
        <>
          {status === "failed" && (
            <p role="alert" className="flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
              Couldn’t refresh the Library.
              <Button type="button" variant="link" size="sm" className="h-11 px-0 fine:h-8" onClick={props.onRetry}>
                Try again
              </Button>
            </p>
          )}
          {orphans.length > 0 && (
            <ul className="flex flex-col">
              {orphans.map((orphan) => (
                <SoftIssueRow key={`issue-${orphan.id}`} {...orphan} testId="voice-note-item" />
              ))}
            </ul>
          )}
          {groupByDay(shown, now).map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="sticky top-13 z-[5] bg-background py-1.5 text-meta font-semibold text-muted-foreground">{group.label}</h3>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <LibraryRow key={item.id} item={item} now={now} grouped selected={props.selectedId === item.id} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
