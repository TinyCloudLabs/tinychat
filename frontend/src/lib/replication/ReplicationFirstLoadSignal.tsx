import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAuiState } from "@assistant-ui/react";
import { isIndexSyncing, subscribeIndexSyncing } from "../threadStore";
import { createFirstLoadTracker, markAppFirstLoadSettled } from "./replicationFirstLoad";

/**
 * Renders nothing. Marks the app's first data load settled once the chat list has loaded (its
 * `list()` returned, with rows or in an error state) and the warm-path background revalidate is
 * not running. Reads both from outside: threadStore and the thread-list adapter are not touched.
 */
export function ReplicationFirstLoadSignal(): null {
  const listLoading = useAuiState((s) => s.threads.isLoading);
  const revalidating = useSyncExternalStore(subscribeIndexSyncing, isIndexSyncing);
  const track = useRef(createFirstLoadTracker());
  const settled = track.current(listLoading, revalidating);
  useEffect(() => {
    if (settled) markAppFirstLoadSettled();
  }, [settled]);
  return null;
}
