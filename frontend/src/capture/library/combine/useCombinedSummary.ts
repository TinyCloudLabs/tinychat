// TC-1152 v1b-b: the summary a combined meeting's page shows.
//
// What the page shows is the run's state when this session has one (generating, just finished, failed),
// else the stored summary columns (one SELECT per open). Opening the page never starts a run: a meeting
// with no stored summary shows "Summary unavailable · Retry", and only Retry (or a combine) calls the model.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { readCombinedSummary } from "@/lib/connectors/combinedMeetingStore";
import { storedSummaryView, type SummaryRunner, type SummaryView } from "@/lib/meetingSummary/summaryRunner";
import { scheduledSpace } from "@/lib/spaceQueue";
import type { LibraryItem } from "../LibraryRow";
import { isCombined } from "./combinedView";

const NEVER = () => () => undefined;

export function useCombinedSummary(options: { tcw: TinyCloudWeb; runner: SummaryRunner | undefined; item: LibraryItem | null }): { view: SummaryView | undefined; retry: () => void } {
  const { tcw, runner, item } = options;
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const id = item !== null && isCombined(item) && runner !== undefined ? item.id : null;
  const read = () => (runner !== undefined && id !== null ? runner.view(id) : undefined);
  // The same read on the server: a static render (tests) has no run.
  const job = useSyncExternalStore(runner?.subscribe ?? NEVER, read, read);
  const [stored, setStored] = useState<{ id: string; view: SummaryView } | null>(null);
  useEffect(() => {
    if (id === null) return;
    let live = true;
    void readCombinedSummary(space, id).then((read) => {
      if (!live) return;
      setStored({ id, view: read.ok && read.data !== null ? storedSummaryView(read.data) : { status: "unavailable", reason: "failed" } });
    });
    return () => { live = false; };
  }, [space, id]);
  if (id === null || runner === undefined) return { view: undefined, retry: () => undefined };
  const view: SummaryView = job ?? (stored?.id === id ? stored.view : { status: "loading" });
  return { view, retry: () => runner.retry(id) };
}
