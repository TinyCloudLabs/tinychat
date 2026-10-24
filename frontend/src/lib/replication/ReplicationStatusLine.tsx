// Read-only replica status line, shown inside ReplicationSettings. Says whether the local copy is
// ON, OFF, being removed, or its removal is pending, in the few plain strings below. The debug text
// (state, last sync, item count, bytes against the budget, SDK error code such as STORAGE_BUDGET /
// REPLICA_GATED: never paths or contents) is shown only in dev/test builds or with the localStorage
// key `tinychat:replication:debug` = "true"; a production user never sees it by default. While a
// replica is live the line polls the controller; a client without a live replica adds no timers.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { REPLICATION_MAX_BYTES } from "./replicationClient";
import { browserMarkerStore } from "./replicationLocalStore";
import { getReplicationStatus, refreshReplicationStatus, subscribeReplicationStatus, type ReplicationStatus } from "./replicationStatus";

const REFRESH_MS = 15_000;

/** localStorage key that turns the debug status text on in a production build. */
export const REPLICATION_DEBUG_KEY = "tinychat:replication:debug";

/** Debug text is on in dev/test builds, or in any build with the debug key set. Never throws. */
export function replicationDebugEnabled(
  prod: boolean = Boolean(import.meta.env.PROD),
  store: Pick<Storage, "getItem"> | undefined = browserMarkerStore(),
): boolean {
  if (!prod) return true;
  try { return store?.getItem(REPLICATION_DEBUG_KEY) === "true"; } catch { return false; }
}

export interface ReplicationStatusView {
  maxBytes?: number;
  /** A replica is running in this session (the client was built with replication and not stopped). Default true. */
  live?: boolean;
  /** The user's switch is ON. Only read when no replica is live. Default true. */
  optedIn?: boolean;
  /** Show the debug text while a replica is live. Default: replicationDebugEnabled(). */
  debug?: boolean;
}

export function formatReplicationStatus(status: ReplicationStatus, view: ReplicationStatusView = {}): string {
  const maxBytes = view.maxBytes ?? REPLICATION_MAX_BYTES;
  if (status.purging) return "Local copy: removing…";
  if (status.offPurgeCode) return `Local copy: removal failed (${status.offPurgeCode}) · will retry on next load`;
  if (!(view.live ?? true)) return (view.optedIn ?? true) ? "Local copy: on · starts at your next sign-in" : "Local copy: off";
  if (!(view.debug ?? replicationDebugEnabled())) return "Local copy: on";
  const used = `${(status.bytes / (1024 * 1024)).toFixed(1)} of ${Math.round(maxBytes / (1024 * 1024))} MB`;
  const parts = [`state ${status.state}`, `last sync ${status.lastSyncAt ?? "never"}`, `${status.keys} items`, used];
  if (status.errorCode) parts.push(`error ${status.errorCode}`);
  if (status.purgePending) parts.push("erase pending");
  if (status.purgeFailed) parts.push("sign-out erase failed");
  return `Local copy: ${parts.join(" · ")}`;
}

export function ReplicationStatusLine({ tcw, live, optedIn }: { tcw: TinyCloudWeb; live: boolean; optedIn: boolean }) {
  const status = useSyncExternalStore(subscribeReplicationStatus, getReplicationStatus, getReplicationStatus);
  const [debug] = useState(() => replicationDebugEnabled());
  useEffect(() => {
    // The poll only feeds the debug text: no timers for a user who never sees it.
    if (!live || !debug) return undefined;
    void refreshReplicationStatus(tcw);
    const timer = window.setInterval(() => void refreshReplicationStatus(tcw), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, debug, tcw]);
  return <p className="break-words text-xs text-muted-foreground" role="status" data-testid="replication-status">
    {formatReplicationStatus(status, { live, optedIn, debug })}
  </p>;
}
