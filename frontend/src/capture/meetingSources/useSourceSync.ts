// "Sync now" for the Meeting sources window: the same two engines the
// Connectors card runs (`runFirefliesSyncNow`, `runGmeetSyncNow`), the same
// sequence in front of them — secrets available, vault unlocked, the registry
// row's secret read — and the same reload of the connection afterwards, which
// is the source of truth for the count and the "synced" time.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { formatRowError, runFirefliesSyncNow, runGmeetSyncNow } from "@/chat/ConnectorsCard";
import { awaitGmeetSessionSync } from "@/chat/useGmeetSessionSync";
import {
  readConnectorKey,
  isSecretsUnlocked,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
import {
  getGmeetLiveStatus,
  isGmeetNotesSyncInFlight,
  isGmeetSyncInFlight,
  onGmeetLiveStatus,
} from "@/lib/connectors/gmeetSync";
import { readBackgroundDrainGeneration } from "@/chat/useBackgroundDrain";
import type { ConnectorDescriptor, ConnectorId, SyncProgress } from "@/lib/connectors/types";
import { SECRETS_UNAVAILABLE_IN_APP_MESSAGE, secretsAvailable } from "@/lib/openkeyNative";

export const SOURCE_SYNC_FAILED_MESSAGE = "Sync failed. Try again.";
export type DriveMode = "auto" | "snapshot";

/**
 * A press the engine could not take because another Google Meet sync holds it. It is never an error
 * message: the row shows that sync's progress and offers to run the press once it ends.
 *  - `offer`: the user can see the run and chooses to wait (a button).
 *  - `queue`: the run started under the press itself (its own unlock started the session-start sync, or
 *    it claimed the slot while the press read the vault), so the press waits behind it without asking.
 */
export interface SourceSyncBusy { busy: "offer" | "queue" }

type SyncEngineInput = {
  tcw: TinyCloudWeb;
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
  onJoined?: () => void;
  onJoinSettled?: () => void;
  isCurrent?: () => boolean;
};
type SyncOutcome =
  | { ok: true }
  | { ok: false; busy: true }
  | { ok: false; busy?: undefined; message: string; retryAfterMs?: number | null };

export interface SourceSyncDeps {
  secretsAvailable: () => boolean;
  isSecretsUnlocked: (tcw: TinyCloudWeb) => boolean;
  unlockSecrets: typeof unlockSecrets;
  readConnectorKey: typeof readConnectorKey;
  isGmeetSyncInFlight: () => boolean;
  isGmeetNotesSyncInFlight: () => boolean;
  /** Resolves once the session-start run's foreground part has finished (at once when none is running). */
  awaitSessionSync: () => Promise<void>;
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
  readConnectorKey,
  isGmeetSyncInFlight,
  isGmeetNotesSyncInFlight,
  awaitSessionSync: awaitGmeetSessionSync,
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
  /** Account/session validity captured by the mounted controller. */
  isCurrent?: () => boolean;
  /** This press only joined a run another lane owns: its signal and progress are ignored by the engine. */
  onJoined?: () => void;
  onJoinSettled?: () => void;
}
/** One sync attempt. Resolves to the message to show on the row, null when it worked, or `busy`. Never rejects. */
export async function runSourceSync(
  d: ConnectorDescriptor,
  input: SourceSyncRun,
  deps: SourceSyncDeps = DEFAULT_DEPS,
): Promise<string | null | SourceSyncBusy> {
  const { tcw, backendUrl, sessionStore } = input;
  const driveMode = input.driveMode ?? "auto";
  const signal = input.signal ?? new AbortController().signal;
  const onProgress = input.onProgress ?? (() => {});
  try {
    // A Full rescan cannot join a running sync (it would lose its snapshot intent), and Sync now cannot
    // join the background Notes reconcile: the press waits for it instead of failing.
    const cannotJoin = () =>
      d.id === "google-meet" && (driveMode === "snapshot" ? deps.isGmeetSyncInFlight() : deps.isGmeetNotesSyncInFlight());
    if (cannotJoin()) return { busy: "offer" };
    if (!deps.secretsAvailable()) return SECRETS_UNAVAILABLE_IN_APP_MESSAGE;
    if (!deps.isSecretsUnlocked(tcw)) {
      const unlock = await deps.unlockSecrets<SecretsErr>(tcw);
      if (!unlock.ok) return unlock.error?.message ?? "Could not unlock secrets";
      // A successful unlock re-arms the session-start sync, which takes the engine's slot. That run belongs
      // to this press, so wait for its foreground part and queue behind its Notes rather than refuse.
      if (d.id === "google-meet") await deps.awaitSessionSync();
    }
    if (input.isCurrent?.() === false) return null;
    const key = await deps.readConnectorKey<SecretsErr>(tcw, d, { interactive: true });
    if (!key.ok) {
      return (
        key.error?.message ??
        (d.id === "google-meet"
          ? "Could not read the saved Google connection"
          : "Could not read API key")
      );
    }
    if (input.isCurrent?.() === false) return null;
    if (cannotJoin()) return { busy: "queue" };
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
            isCurrent: input.isCurrent,
            onJoined: input.onJoined,
            onJoinSettled: input.onJoinSettled,
          });
    if (outcome.ok) return null;
    if (outcome.busy) return { busy: "queue" };
    return formatRowError(outcome.message, outcome.retryAfterMs ?? null);
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
  /** A press another Google Meet sync refused: offered to wait, or already waiting to start when that sync ends. */
  busy: { id: ConnectorId; mode: DriveMode; queued: boolean } | null;
  /** Accept the offer: start the refused press as soon as nothing is syncing. */
  wait: () => void;
  cancelWait: () => void;
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
  const [busyPress, setBusyPress] = useState<{ descriptor: ConnectorDescriptor; mode: DriveMode; queued: boolean; did: string | undefined } | null>(null);
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const joinedRef = useRef(false);
  const live = useSyncExternalStore(onGmeetLiveStatus, () => getGmeetLiveStatus(tcw), () => getGmeetLiveStatus(tcw));

  const sync = useCallback(
    async (d: ConnectorDescriptor, driveMode: DriveMode = "auto", fromQueue = false) => {
      if (inFlight.current) return;
      const generation = readBackgroundDrainGeneration();
      const isCurrent = () => generation === readBackgroundDrainGeneration();
      inFlight.current = true;
      const controller = new AbortController();
      abort.current = controller;
      setSyncingId(d.id);
      setJoined(false);
      setProgress(null);
      setError(null);
      setBusyPress(null);
      try {
        const message = await runSourceSync(
          d,
          {
            tcw,
            backendUrl,
            sessionStore,
            driveMode,
            signal: controller.signal,
            isCurrent,
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
        if (typeof message === "object" && message !== null) {
          // A press that was already waiting is offered again rather than re-queued: it cannot spin.
          setBusyPress({ descriptor: d, mode: driveMode, queued: message.busy === "queue" && !fromQueue, did: tcw.did });
        } else if (message) setError({ id: d.id, message });
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

  // The accepted offer: once nothing is running for this account, start the press that was refused.
  const waiting = busyPress !== null && busyPress.queued && busyPress.did === tcw.did ? busyPress : null;
  useEffect(() => {
    if (waiting === null || live.running) return;
    setBusyPress(null);
    void sync(waiting.descriptor, waiting.mode, true);
  }, [waiting, live.running, sync]);

  const stop = useCallback(() => {
    if (!joinedRef.current) abort.current?.abort();
  }, []);

  const wait = useCallback(() => setBusyPress((press) => (press === null ? null : { ...press, queued: true })), []);
  const cancelWait = useCallback(() => setBusyPress(null), []);

  return {
    syncingId,
    joined,
    progress,
    error,
    busy: busyPress !== null && busyPress.did === tcw.did
      ? { id: busyPress.descriptor.id, mode: busyPress.mode, queued: busyPress.queued }
      : null,
    wait,
    cancelWait,
    sync,
    stop,
  };
}
