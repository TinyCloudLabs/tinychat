// What a Google Meet row shows that the engine knows but the stored connection row does not: the run
// in flight, the live count of saved meetings, an interrupted Notes sync, and whether a sync log exists.
// Shared by every surface that renders the row (the Meeting sources window, the Connectors card), so
// they cannot disagree.
//
// Everything here is read for ONE account (`tcw.did`): the engine's live status and the count are keyed by
// DID, the checkpoint is read through this account's `tcw`, and a result that finishes after the account
// changed is dropped (TC-1376).
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import * as connectorStore from "@/lib/connectors/connectorStore";
import { describeGmeetInterrupted, readGmeetInterrupted } from "@/lib/connectors/gmeetInterrupted";
import { getGmeetLastRun, onGmeetLastRun, type GmeetLastRun } from "@/lib/connectors/gmeetLastRun";
import { getGmeetMeetingCount, onGmeetMeetingCount, refreshGmeetMeetingCount } from "@/lib/connectors/gmeetLiveCount";
import { getGmeetLiveStatus, onGmeetLiveStatus, type GmeetLiveStatus } from "@/lib/connectors/gmeetSync";
import type { GmeetSyncLog } from "@/lib/connectors/gmeetSyncLog";
import { loadGmeetSyncLog } from "@/lib/connectors/gmeetSyncLogStore";
import { resolveBuildInfo } from "@/lib/buildInfo";
import { appPlatform } from "@/lib/platform";

export interface GmeetRowStatus {
  live: GmeetLiveStatus;
  /** Saved Google Meet meetings (the rows the Library shows); null until the first read. */
  count: number | null;
  /** How the latest run of this page load ended and when: what the status line shows over the stored row. */
  lastRun: GmeetLastRun | null;
  /** "A Notes sync was interrupted at x/26. Sync now resumes it." while no run is live, else null. */
  interrupted: string | null;
  hasLog: boolean;
  getLog: () => GmeetSyncLog | null;
}

export function useGmeetRowStatus(
  tcw: TinyCloudWeb,
  options: {
    /** The Meet connection exists: only then is there anything to count or to resume. */
    connected: boolean;
    /** Bump to re-read the count and the checkpoint (a connect or disconnect just finished). */
    revision?: number;
  },
): GmeetRowStatus {
  const { connected, revision = 0 } = options;
  const live = useSyncExternalStore(onGmeetLiveStatus, () => getGmeetLiveStatus(tcw), () => getGmeetLiveStatus(tcw));
  const count = useSyncExternalStore(onGmeetMeetingCount, () => getGmeetMeetingCount(tcw), () => getGmeetMeetingCount(tcw));
  const lastRun = useSyncExternalStore(onGmeetLastRun, () => getGmeetLastRun(tcw), () => getGmeetLastRun(tcw));
  const [buildLabel, setBuildLabel] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<{ did: string | undefined; text: string | null } | null>(null);
  const running = live.running;

  useEffect(() => {
    let cancelled = false;
    resolveBuildInfo(appPlatform()).then(
      (label) => { if (!cancelled) setBuildLabel(label); },
      () => {},
    );
    return () => { cancelled = true; };
  }, []);

  // The count the Library shows, read on mount and whenever the connection is (re)established.
  useEffect(() => {
    if (!connected) return;
    void refreshGmeetMeetingCount(tcw, connectorStore.countMeetings);
  }, [tcw, connected, revision]);

  // A checkpoint with no run behind it is a run a reload cut short. Read again whenever a run ends.
  useEffect(() => {
    if (!connected || running) return;
    let cancelled = false;
    void readGmeetInterrupted(tcw, connectorStore.getDriveProgress).then(
      (interrupted) => {
        if (!cancelled) setCheckpoint({ did: tcw.did, text: interrupted === null ? null : describeGmeetInterrupted(interrupted) });
      },
      () => { if (!cancelled) setCheckpoint(null); },
    );
    return () => { cancelled = true; };
  }, [tcw, connected, running, revision]);

  const hasLog = useMemo(
    // `running` and `count` are the change signals: a log is stored at a run's start and at each checkpoint.
    () => loadGmeetSyncLog(tcw) !== null,
    [tcw, running, count],
  );

  return {
    live,
    count,
    lastRun,
    interrupted: !running && checkpoint !== null && checkpoint.did === tcw.did ? checkpoint.text : null,
    hasLog,
    getLog: () => loadGmeetSyncLog(tcw, buildLabel),
  };
}
