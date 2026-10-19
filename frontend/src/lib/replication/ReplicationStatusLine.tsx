// Read-only replica status line. Renders nothing unless the replication flag is ON, so flag OFF
// adds no DOM and no timers. Shows counters and codes only (state, last sync, error code such as
// STORAGE_BUDGET / STORAGE_FULL, bytes used against the budget): never paths or contents.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { isReplicationEnabled } from "./replicationFlag";
import { REPLICATION_MAX_BYTES } from "./replicationClient";
import { getReplicationStatus, refreshReplicationStatus, subscribeReplicationStatus, type ReplicationStatus } from "./replicationStatus";

const REFRESH_MS = 15_000;

export function formatReplicationStatus(status: ReplicationStatus, maxBytes = REPLICATION_MAX_BYTES): string {
  const used = `${(status.bytes / (1024 * 1024)).toFixed(1)} of ${Math.round(maxBytes / (1024 * 1024))} MB`;
  const parts = [`state ${status.state}`, `last sync ${status.lastSyncAt ?? "never"}`, `${status.keys} items`, used];
  if (status.errorCode) parts.push(`error ${status.errorCode}`);
  if (status.purgePending) parts.push("erase pending");
  if (status.purgeFailed) parts.push("sign-out erase failed");
  return `Local copy: ${parts.join(" · ")}`;
}

export function ReplicationStatusLine({ tcw }: { tcw: TinyCloudWeb }) {
  const [enabled] = useState(() => isReplicationEnabled());
  const status = useSyncExternalStore(subscribeReplicationStatus, getReplicationStatus, getReplicationStatus);
  useEffect(() => {
    if (!enabled) return undefined;
    void refreshReplicationStatus(tcw);
    const timer = window.setInterval(() => void refreshReplicationStatus(tcw), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, tcw]);
  if (!enabled) return null;
  return <p className="text-xs text-muted-foreground" role="status" data-testid="replication-status">
    {formatReplicationStatus(status)}
  </p>;
}
