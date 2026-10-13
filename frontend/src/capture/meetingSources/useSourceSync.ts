// "Sync now" for the Meeting sources window: the same two engines the
// Connectors card runs (`runFirefliesSyncNow`, `runGmeetSyncNow`), the same
// sequence in front of them — secrets available, vault unlocked, the registry
// row's secret read — and the same reload of the connection afterwards, which
// is the source of truth for the count and the "synced" time.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useCallback, useRef, useState } from "react";

import { formatRowError, runFirefliesSyncNow, runGmeetSyncNow } from "@/chat/ConnectorsCard";
import {
  getConnectorKey,
  isSecretsUnlocked,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
import { isGmeetSyncInFlight } from "@/lib/connectors/gmeetSync";
import type { ConnectorDescriptor, ConnectorId, SyncProgress } from "@/lib/connectors/types";
import { SECRETS_UNAVAILABLE_IN_APP_MESSAGE, secretsAvailable } from "@/lib/openkeyNative";

export const SOURCE_SYNC_FAILED_MESSAGE = "Sync failed. Try again.";
export const FULL_RESCAN_BUSY_MESSAGE =
  "Another Google Meet sync is already running. Try Full rescan again when it finishes.";

export type DriveMode = "auto" | "snapshot";

type SyncEngineInput = {
  tcw: TinyCloudWeb;
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
  onJoined?: () => void;
  onJoinSettled?: () => void;
};
type SyncOutcome = { ok: true } | { ok: false; message: string; retryAfterMs?: number | null };

export interface SourceSyncDeps {
  secretsAvailable: () => boolean;
  isSecretsUnlocked: (tcw: TinyCloudWeb) => boolean;
  unlockSecrets: typeof unlockSecrets;
  getConnectorKey: typeof getConnectorKey;
  isGmeetSyncInFlight: () => boolean;
  runGmeetSyncNow: (
    input: SyncEngineInput & {
      backendUrl: string;
      sessionStore: SessionStore;
      refreshToken: string;
      driveMode: DriveMode;
    },
  ) => Promise<SyncOutcome>;
  runFirefliesSyncNow: (input: SyncEngineInput & { apiKey: string }) => Promise<SyncOutcome>;
}

const DEFAULT_DEPS: SourceSyncDeps = {
  secretsAvailable,
  isSecretsUnlocked,
  unlockSecrets,
  getConnectorKey,
  isGmeetSyncInFlight,
  runGmeetSyncNow,
  runFirefliesSyncNow,
};

export interface SourceSyncRun {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** Full rescan asks Google Meet for a fresh listing instead of the saved Drive cursor. */
  driveMode?: DriveMode;
  /** Aborted by Stop. The run still settles (and writes its final state) before it resolves. */
  signal?: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  /** This press only joined a run another lane owns: its signal and progress are ignored by the engine. */
  onJoined?: () => void;
  onJoinSettled?: () => void;
}

/** One sync attempt. Resolves to the message to show on the row, or null when it worked. Never rejects. */
export async function runSourceSync(
  d: ConnectorDescriptor,
  input: SourceSyncRun,
  deps: SourceSyncDeps = DEFAULT_DEPS,
): Promise<string | null> {
  const { tcw, backendUrl, sessionStore } = input;
  const driveMode = input.driveMode ?? "auto";
  const signal = input.signal ?? new AbortController().signal;
  const onProgress = input.onProgress ?? (() => {});
  try {
    if (d.id === "google-meet" && driveMode === "snapshot" && deps.isGmeetSyncInFlight()) {
      return FULL_RESCAN_BUSY_MESSAGE;
    }
    if (!deps.secretsAvailable()) return SECRETS_UNAVAILABLE_IN_APP_MESSAGE;
    if (!deps.isSecretsUnlocked(tcw)) {
      const unlock = await deps.unlockSecrets<SecretsErr>(tcw);
      if (!unlock.ok) return unlock.error?.message ?? "Could not unlock secrets";
    }
    const key = await deps.getConnectorKey<SecretsErr>(tcw, d);
    if (!key.ok) {
      return (
        key.error?.message ??
        (d.id === "google-meet"
          ? "Could not read the saved Google connection"
          : "Could not read API key")
      );
    }
    if (d.id === "google-meet" && deps.isGmeetSyncInFlight()) input.onJoined?.();
    const outcome =
      d.id === "google-meet"
        ? await deps.runGmeetSyncNow({
            tcw,
            backendUrl,
            sessionStore,
            refreshToken: key.data,
            driveMode,
            signal,
            onProgress,
          })
        : await deps.runFirefliesSyncNow({
            tcw,
            apiKey: key.data,
            signal,
            onProgress,
            onJoined: input.onJoined,
            onJoinSettled: input.onJoinSettled,
          });
    return outcome.ok ? null : formatRowError(outcome.message, outcome.retryAfterMs ?? null);
  } catch (cause) {
    console.error(`Meeting source sync failed for ${d.id}`, cause);
    return SOURCE_SYNC_FAILED_MESSAGE;
  }
}

/** "Syncing 3/12…" once the engine reports a total, "Syncing…" before. */
export function syncProgressLabel(progress: SyncProgress | null): string {
  if (progress && typeof progress.total === "number" && progress.total > 0) {
    return `Syncing ${progress.done}/${progress.total}…`;
  }
  return "Syncing…";
}

export interface SourceSyncController {
  /** The connector currently syncing, if any. */
  syncingId: ConnectorId | null;
  /** The running sync only joined one another lane owns, so Stop would abort nothing. */
  joined: boolean;
  progress: SyncProgress | null;
  error: { id: ConnectorId; message: string } | null;
  sync: (descriptor: ConnectorDescriptor, driveMode?: DriveMode) => Promise<void>;
  /** Aborts the sync this controller started. It stays `syncingId` until the engine has settled. */
  stop: () => void;
}

export function useSourceSync(input: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** Called after every attempt with the reloaded connection's id. */
  onSettled: (id: ConnectorId) => void;
  deps?: SourceSyncDeps;
}): SourceSyncController {
  const { tcw, backendUrl, sessionStore, onSettled, deps } = input;
  const [syncingId, setSyncingId] = useState<ConnectorId | null>(null);
  const [joined, setJoined] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<SourceSyncController["error"]>(null);
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const joinedRef = useRef(false);

  const sync = useCallback(
    async (d: ConnectorDescriptor, driveMode: DriveMode = "auto") => {
      if (inFlight.current) return;
      inFlight.current = true;
      const controller = new AbortController();
      abort.current = controller;
      setSyncingId(d.id);
      setJoined(false);
      setProgress(null);
      setError(null);
      try {
        const message = await runSourceSync(
          d,
          {
            tcw,
            backendUrl,
            sessionStore,
            driveMode,
            signal: controller.signal,
            onProgress: setProgress,
            onJoined: () => {
              joinedRef.current = true;
              setJoined(true);
            },
            onJoinSettled: () => {
              joinedRef.current = false;
              setJoined(false);
            },
          },
          deps,
        );
        if (message) setError({ id: d.id, message });
      } finally {
        abort.current = null;
        inFlight.current = false;
        setSyncingId(null);
        joinedRef.current = false;
        setJoined(false);
        setProgress(null);
        onSettled(d.id);
      }
    },
    [tcw, backendUrl, sessionStore, onSettled, deps],
  );

  const stop = useCallback(() => {
    if (!joinedRef.current) abort.current?.abort();
  }, []);

  return { syncingId, joined, progress, error, sync, stop };
}
