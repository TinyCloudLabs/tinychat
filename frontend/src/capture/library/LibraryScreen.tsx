// The Library (TC-761): its heading with Refresh, the list, and the cohort
// meeting archive App hands it (`meetingsSlot`, MeetingsSection). On a phone
// it is a screen of its own with Back; beside Capture (wide) it is the lower
// half of the list pane.
//
// BOTH meeting data paths live here: the list reads the user's OWN space
// (useLibrary → listMeetingsRead, through the per-space queue), and
// `meetingsSlot` is the cohort read API's section.
import type { ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { PageHeader } from "@/shell/PageHeader";
import { LibraryListView } from "./LibraryListView";
import type { Library } from "./useLibrary";

function RefreshButton(props: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.busy}
      aria-label="Refresh the Library"
      className="tap-transparent flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-2 disabled:opacity-50 fine:size-9"
    >
      <RefreshCwIcon aria-hidden="true" className={cn("size-5", props.busy && "motion-safe:animate-spin")} />
    </button>
  );
}

export function LibraryScreen(props: {
  library: Library;
  meetingsSlot?: ReactNode;
  /** A screen of its own (compact), with Back. */
  pushed: boolean;
  onBack: () => void;
  /** The note open beside the list. */
  selectedId: string | null;
  now: Date;
  /** The column's width and gutters. */
  column: string;
}) {
  const { library } = props;
  const refresh = <RefreshButton onClick={library.refresh} busy={library.status === "loading"} />;
  return (
    <>
      {props.pushed ? (
        <PageHeader title="Library" back={props.onBack} className={props.column} trailing={refresh} />
      ) : (
        <div className={cn(props.column, "flex items-center gap-2 pt-2")}>
          <h2 className="flex-1 text-headline">Library</h2>
          <div className="-mr-2">{refresh}</div>
        </div>
      )}
      <div className={cn(props.column, "flex flex-col gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2")}>
        <LibraryListView
          status={library.status}
          items={library.items}
          filter={library.filter}
          onFilterChange={library.setFilter}
          onRetry={library.retry}
          now={props.now}
          selectedId={props.selectedId}
        />
        {props.meetingsSlot}
      </div>
    </>
  );
}
