// Read-only replica status line, shown inside ReplicationSettings. Says whether the local copy is
// ON, OFF, being removed, or its removal is pending. While a replica is live it polls the
// controller and shows counters and codes only (state, last sync, error code such as STORAGE_BUDGET
// / STORAGE_FULL, bytes used against the budget): never paths or contents. A client without a
// live replica adds no timers.
import { useEffect, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { REPLICATION_MAX_BYTES } from "./replicationClient";
import { getReplicationStatus, refreshReplicationStatus, subscribeReplicationStatus, type ReplicationStatus } from "./replicationStatus";

const REFRESH_MS = 15_000;

export interface ReplicationStatusView {
  maxBytes?: number;
  /** A replica is running in this session (the client was built with replication and not stopped). Default true. */
  live?: boolean;
  /** The user's switch is ON. Only read when no replica is live. Default true. */
  optedIn?: boolean;
}

export function formatReplicationStatus(status: ReplicationStatus, view: ReplicationStatusView = {}): string {
  const maxBytes = view.maxBytes ?? REPLICATION_MAX_BYTES;
  if (status.purging) return "Local copy: removing…";
  if (status.offPurgeCode) return `Local copy: removal failed (${status.offPurgeCode}) · will retry on next load`;
  if (!(view.live ?? true)) return (view.optedIn ?? true) ? "Local copy: on · starts at your next sign-in" : "Local copy: off";
  const used = `${(status.bytes / (1024 * 1024)).toFixed(1)} of ${Math.round(maxBytes / (1024 * 1024))} MB`;
  const parts = [`state ${status.state}`, `last sync ${status.lastSyncAt ?? "never"}`, `${status.keys} items`, used];
  if (status.errorCode) parts.push(`error ${status.errorCode}`);
  if (status.purgePending) parts.push("erase pending");
  if (status.purgeFailed) parts.push("sign-out erase failed");
  return `Local copy: ${parts.join(" · ")}`;
}

export function ReplicationStatusLine({ tcw, live, optedIn }: { tcw: TinyCloudWeb; live: boolean; optedIn: boolean }) {
  const status = useSyncExternalStore(subscribeReplicationStatus, getReplicationStatus, getReplicationStatus);
  useEffect(() => {
    if (!live) return undefined;
    void refreshReplicationStatus(tcw);
    const timer = window.setInterval(() => void refreshReplicationStatus(tcw), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, tcw]);
  return <p className="text-xs text-muted-foreground" role="status" data-testid="replication-status">
    {formatReplicationStatus(status, { live, optedIn })}
  </p>;
}
