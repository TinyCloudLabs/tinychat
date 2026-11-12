// The Library (TC-761): its heading with Refresh, the list, and the cohort
// meeting archive App hands it (`meetingsSlot`, MeetingsSection). On a phone
// it is a screen of its own with Back; beside Capture (wide) it is the lower
// half of the list pane.
//
// BOTH meeting data paths live here: the list reads the user's OWN space
// (useLibrary → listMeetingsRead, through the per-space queue), and
// `meetingsSlot` is the cohort read API's section.
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCwIcon } from "lucide-react";

import { countLocalOnlyRecordingWork, type LocalRecordingWork } from "@/lib/originMove";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/shell/PageHeader";
import { LOCAL_AUDIO_FILTER } from "@/shell/routes";
import { LibraryListView, type LibraryListViewProps } from "./LibraryListView";
import type { Library } from "./useLibrary";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { AppPlatform } from "@/lib/platform";

export const LOCAL_AUDIO_FILTER_LABEL = "Audio only in this browser";

/**
 * The filter the tinycloud.chat notice links to (`LOCAL_AUDIO_LIBRARY_PATH`): this account's recordings whose audio
 * is only in this browser, exactly as originMove.ts counts them. On from its address until cleared, so it stays while
 * one of its notes is open; read again whenever the list changes (an upload takes a note off it).
 */
function useLocalAudioFilter(all: Library["all"], countWork: () => Promise<LocalRecordingWork>): LibraryListViewProps["only"] {
  const [params, setParams] = useSearchParams();
  const requested = params.get(LOCAL_AUDIO_FILTER.param) === LOCAL_AUDIO_FILTER.value;
  const [on, setOn] = useState(requested);
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (requested) setOn(true);
  }, [requested]);
  useEffect(() => {
    if (!on) {
      setIds(null);
      return;
    }
    let live = true;
    void countWork().then((work) => { if (live) setIds(new Set(work.localAudio)); });
    return () => { live = false; };
  }, [on, all, countWork]);
  if (!on) return undefined;
  return {
    label: LOCAL_AUDIO_FILTER_LABEL,
    empty: "No recordings here have audio only in this browser.",
    ids,
    onClear: () => {
      setOn(false);
      if (requested) setParams((next) => { next.delete(LOCAL_AUDIO_FILTER.param); return next; }, { replace: true });
    },
  };
}

function RefreshButton(props: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.busy}
      aria-busy={props.busy}
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
  pipelines?: ReadonlyMap<string, NotePipeline>;
  activityViews?: ReadonlyMap<string, NotePipelineView>;
  platform?: AppPlatform;
  activityControl?: ReactNode;
  /** Reads the local-audio filter's recordings (tests). */
  countLocalWork?: () => Promise<LocalRecordingWork>;
}) {
  const { library } = props;
  const only = useLocalAudioFilter(library.all, props.countLocalWork ?? countLocalOnlyRecordingWork);
  const refresh = <div className="flex flex-wrap items-center gap-1">{props.activityControl}<RefreshButton onClick={library.refresh} busy={library.listing} /></div>;
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
          items={only ? library.all : library.items}
          filter={library.filter}
          onFilterChange={library.setFilter}
          onRetry={library.retry}
          now={props.now}
          selectedId={props.selectedId}
          pipelines={props.pipelines}
          activityViews={props.activityViews}
          platform={props.platform}
          only={only}
        />
        {props.meetingsSlot}
      </div>
    </>
  );
}
