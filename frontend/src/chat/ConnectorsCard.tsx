// Connectors card — spec §9. Registry-driven rows; loads connection
// state on mount via connectorStore.getConnection (SQL only — never touches
// tcw.secrets on mount so opening Connectors cannot trigger the wallet
// unlock popup). Sync now runs the real sync engine for the row, keyed via
// connectorSecrets after an interactive unlock — ONE ENGINE PER CONNECTOR,
// dispatched from the registry id (see `handleSyncNow`), never a shared
// default. Connect + Disconnect flows are handed off to ConnectorDialog
// (spec §9): a Radix Dialog wraps the key entry → validate → save → initial
// sync stepper, and a Radix AlertDialog wraps the disconnect confirm with an
// "also delete N meetings" checkbox.

import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Loader2Icon, PlugIcon, PlugZapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CONNECTORS } from "@/lib/connectors/registry";
import type {
  ConnectorConnection,
  ConnectorDescriptor,
  ConnectorId,
  SyncProgress,
} from "@/lib/connectors/types";
import * as connectorStore from "@/lib/connectors/connectorStore";
import {
  defaultFirefliesClientOptions,
  FirefliesClient,
} from "@/lib/connectors/firefliesClient";
import { isFirefliesSyncInFlight, syncFireflies } from "@/lib/connectors/firefliesSync";
import { readBackgroundDrainGeneration } from "./useBackgroundDrain";
import { isFirefliesStale } from "@/lib/connectors/firefliesFreshness";
import { GmeetClient } from "@/lib/connectors/gmeetClient";
import {
  GMEET_NOTES_BUSY_MESSAGE,
  isGmeetNotesSyncInFlight,
  isGmeetSyncInFlight,
  onGmeetNotesSettled,
  type GmeetLiveStatus,
  syncGoogleMeet,
  type GmeetSyncDiagnostics,
  type GmeetSyncClient,
  type GmeetSyncProgress,
  type GmeetSyncStore,
} from "@/lib/connectors/gmeetSync";
import type { GmeetSyncLog } from "@/lib/connectors/gmeetSyncLog";
import {
  CopyGmeetSyncLogButton,
  GmeetBusyOffer,
  GmeetLiveLine,
  type GmeetPressMode,
} from "./GmeetCardStatus";
import { awaitGmeetSessionSync } from "./useGmeetSessionSync";
import { useGmeetRowStatus } from "./useGmeetRowStatus";
import { getConnectorKey, isConnectorKeysReady, isOpenKeyUserDecline, migrationDeclinedMessage, readOrMigrateConnectorKey } from "@/lib/connectors/namedConnectorSecrets";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isSecretsUnlocked, unlockSecrets, type SecretsErr } from "@/lib/connectors/connectorSecrets";
import {
  createConnectorWebhooksClient,
  type ConnectorWebhooksClient,
} from "@/lib/connectors/webhooksApi";
import {
  createConnectorMeetingsClient,
  type ConnectorMeetingsClient,
} from "@/lib/connectors/meetingsApi";
import {
  ConnectorConnectDialog,
  ConnectorDisconnectDialog,
} from "./ConnectorDialog";
import { BackgroundSyncSection } from "./BackgroundSyncSection";
import { supportsBackgroundNotifications } from "./backgroundSyncState";
import { GMEET_CONNECTOR_ID, mintGmeetAccessToken } from "./useGmeetSessionSync";
import { CalendarAutojoinSection } from "./CalendarAutojoinSection";
import { SectionCard } from "@/components/ui/section-card";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { secretsAvailable, SECRETS_UNAVAILABLE_IN_APP_MESSAGE } from "@/lib/openkeyNative";
import { pendingSameTabReturn } from "@/lib/connectors/googleOAuthSameTab";

interface ConnectorsCardProps {
  tcw: TinyCloudWeb;
  /** Passed down from ConnectorsPage — the card constructs no globals of its own. */
  backendUrl: string;
  sessionStore: SessionStore;
  /** Lets the first-class page name this group without repeating its own title. */
  title?: string;
}

interface RowState {
  loaded: boolean;
  connection: ConnectorConnection | null;
  syncing: boolean;
  /**
   * This press JOINED a run started elsewhere (the session-start lane), rather
   * than starting one. `syncGoogleMeet` is single-flight, and only the FIRST
   * caller's `onProgress` and `signal` are honoured — so for a joined run this
   * row's Stop would abort nothing and its progress would never move. The row
   * says "syncing in the background" and offers no Stop instead of rendering a
   * dead button.
   */
  joinedBackgroundSync: boolean;
  progress: SyncProgress | null;
  // In-session error surface. Persists across renders until the next action;
  // separate from `connection.lastSyncError` because retryAfterMs is not
  // persisted (see the store — only the message string round-trips).
  actionError: string | null;
  actionRetryAfterMs: number | null;
  /**
   * A press (Sync now / Full rescan) that a running Google Meet sync refused. The row shows
   * that sync's live progress and offers to wait; `queuedSync` is the accepted offer, run once
   * the other sync finishes.
   */
  busyOffer: GmeetPressMode | null;
  queuedSync: GmeetPressMode | null;
}

const DEFAULT_ROW_STATE: RowState = {
  loaded: false,
  connection: null,
  syncing: false,
  joinedBackgroundSync: false,
  progress: null,
  actionError: null,
  actionRetryAfterMs: null,
  busyOffer: null,
  queuedSync: null,
};

type RowStateMap = Record<ConnectorId, RowState>;

const INITIAL_ROW_STATE_MAP: RowStateMap = {
  fireflies: DEFAULT_ROW_STATE,
  granola: DEFAULT_ROW_STATE,
  "google-meet": DEFAULT_ROW_STATE,
};

// ── Sync-now engines ───────────────────────────────────────────────────
//
// Note that being an INITIAL_ROW_STATE_MAP key forces nothing: `granola` is one
// too and has no engine. The dispatch in `handleSyncNow` plus the registry's
// `status` are the forcing functions, and the not-implemented branch is what a
// row without an engine lands on.

type RowSyncEngine = "fireflies" | "gmeet";

/** The two engines' results, flattened to what the row actually renders. */
type RowSyncOutcome =
  | { ok: true }
  /** Another Google Meet sync holds the engine: the press waits for it instead of failing. */
  | { ok: false; busy: true }
  | { ok: false; busy?: undefined; message: string; retryAfterMs: number | null };

/** The real store for the Meet engine, assembled explicitly so a signature
 *  drift in connectorStore fails at compile time rather than at the first sync. */
const GMEET_STORE: GmeetSyncStore = {
  getConnection: connectorStore.getConnection,
  putTranscriptBody: connectorStore.putTranscriptBody,
  upsertMeeting: connectorStore.upsertMeeting,
  updateSyncState: connectorStore.updateSyncState,
  countMeetings: connectorStore.countMeetings,
  getDriveCursor: connectorStore.getDriveCursor,
  putDriveCursor: connectorStore.putDriveCursor,
  findGmeetNotesAssociation: connectorStore.findGmeetNotesAssociation,
  attachGmeetNotes: connectorStore.attachGmeetNotes,
  removeGmeetNotes: connectorStore.removeGmeetNotes,
  loadGmeetNotesIndex: connectorStore.loadGmeetNotesIndex,
  getDriveProgress: connectorStore.getDriveProgress,
  putDriveProgress: connectorStore.putDriveProgress,
};

/** Meet's progress vocabulary → the row's. Counts only; no titles, no text. */
function gmeetRowProgress(p: GmeetSyncProgress): SyncProgress {
  return {
    phase: p.type === "status" ? "listing" : "storing",
    done: p.current,
    total: p.total,
  };
}

export async function runFirefliesSyncNow(opts: {
  tcw: TinyCloudWeb;
  apiKey: string;
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
  isCurrent?: () => boolean;
  onJoined?: () => void;
  onJoinSettled?: () => void;
}): Promise<RowSyncOutcome> {
  try {
    const client = new FirefliesClient({
      apiKey: opts.apiKey,
      ...defaultFirefliesClientOptions(),
    });
    const res = await syncFireflies({
      client,
      store: connectorStore,
      tcw: opts.tcw,
      onProgress: opts.onProgress,
      signal: opts.signal,
      isCurrent: opts.isCurrent,
      manualRequest: true,
      onJoined: opts.onJoined,
      onJoinSettled: opts.onJoinSettled,
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: res.error.message, retryAfterMs: res.error.retryAfterMs ?? null };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "Fireflies sync failed",
      retryAfterMs: null,
    };
  }
}

/**
 * "Sync now" for Google Meet.
 *
 * The refresh token rides one authenticated request to the backend proxy and is
 * never logged or re-persisted; the access token lives in the client for this
 * run only. `syncGoogleMeet`'s module-level single-flight is shared with the
 * session-start lane, so a button press while that run is in flight JOINS it
 * rather than racing it over the same upserts.
 *
 * The press returns once the Meet records are saved and the connection is written. The Notes
 * reconcile (Full rescan keeps its snapshot listing) continues in the background under its own
 * budget, with checkpoints, exactly as after connecting: a slow node must not turn a press into a
 * 60 s foreground limit that needs another press to continue.
 */
export async function runGmeetSyncNow(opts: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  refreshToken: string;
  driveMode?: "auto" | "snapshot";
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
  onDiagnostics?: (diagnostics: GmeetSyncDiagnostics) => void;
  /** Test seams: the real store, transport and client are used when omitted. */
  deps?: {
    store?: GmeetSyncStore;
    fetchImpl?: typeof fetch;
    createClient?: (accessToken: string, refreshAccessToken: () => Promise<string | null>, signal: AbortSignal) => GmeetSyncClient;
    mintRetryDelayMs?: number;
  };
}): Promise<RowSyncOutcome> {
  const { tcw, backendUrl, sessionStore, refreshToken, signal, deps } = opts;
  const mint = (mintSignal: AbortSignal) =>
    mintGmeetAccessToken({
      backendUrl, sessionStore, refreshToken, signal: mintSignal,
      fetchImpl: deps?.fetchImpl, retryDelayMs: deps?.mintRetryDelayMs,
    });
  const accessToken = await mint(signal);
  // Token mint is the final await before engine dispatch. Re-check here so a
  // session-start run that claimed the shared slot during vault/key/token work
  // cannot make Full rescan join it and silently lose snapshot intent.
  if (gmeetPressRefused(opts.driveMode)) return { ok: false, busy: true };
  if (!accessToken) {
    // Every mint failure — signed out, a dark route, a revoked grant — resolves
    // to null rather than a message, so this is the one string the card owns.
    return {
      ok: false,
      message: "Couldn't reach Google with your saved connection. Try reconnecting Google Meet.",
      retryAfterMs: null,
    };
  }
  // The Notes reconcile outlives this press, so the client it runs on must not be cut by the press's
  // abort (Stop) once the engine has handed the Notes off. Until then Stop still reaches the client.
  const clientAbort = new AbortController();
  let notesHandedOff = false;
  const forwardAbort = () => { if (!notesHandedOff) clientAbort.abort(); };
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) clientAbort.abort();
  // One 401 re-mints through the same proxy — the refresh token never leaves
  // this scope, and the new access token stays in the client.
  const refreshAccessToken = () => mint(clientAbort.signal);
  const client = deps?.createClient
    ? deps.createClient(accessToken, refreshAccessToken, clientAbort.signal)
    : new GmeetClient({ accessToken, refreshAccessToken, signal: clientAbort.signal });
  try {
    const res = await syncGoogleMeet({
      client,
      store: deps?.store ?? GMEET_STORE,
      tcw,
      driveMode: opts.driveMode,
      deferNotes: true,
      onProgress: (p) => opts.onProgress(gmeetRowProgress(p)),
      onDiagnostics: opts.onDiagnostics,
      signal,
    });
    notesHandedOff = res.ok && res.data.notesDeferred === true;
    if (res.ok) return { ok: true };
    if (res.error.message === GMEET_NOTES_BUSY_MESSAGE) return { ok: false, busy: true };
    return { ok: false, message: res.error.message, retryAfterMs: res.error.retryAfterMs ?? null };
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
}

/**
 * A press the engine cannot take now: a Full rescan cannot join a running sync (it would lose its
 * snapshot intent) and Sync now cannot join the background Notes reconcile.
 */
function gmeetPressRefused(driveMode: "auto" | "snapshot" | undefined): boolean {
  return driveMode === "snapshot" ? isGmeetSyncInFlight() : isGmeetNotesSyncInFlight();
}

export function ConnectorsCard({
  tcw,
  backendUrl,
  sessionStore,
  title = "Connectors",
}: ConnectorsCardProps) {
  const [rows, setRows] = useState<RowStateMap>(INITIAL_ROW_STATE_MAP);
  const [autojoinRevision, setAutojoinRevision] = useState(0);
  const [gmeetDiagnostics, setGmeetDiagnostics] = useState<GmeetSyncDiagnostics | null>(null);
  const [migrationDescriptor, setMigrationDescriptor] = useState<ConnectorDescriptor | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  // What the engine is doing right now, including runs this card did not start (the
  // session-start lane, the connect dialog's background Notes).
  const gmeetStatus = useGmeetRowStatus(tcw, { connected: rows[GMEET_CONNECTOR_ID].connection?.status === "connected" });
  const live = gmeetStatus.live;
  // The companion router's mount-time verdict, established ONCE by the
  // background-notifications section's `GET /config` probe. The teardown needs
  // it to tell a dark deployment from a 404 that means something else — see
  // `connectorLifecycle.DisconnectDeps.featureDark`. `false` until the probe
  // answers: unknown is not dark.
  const [featureDark, setFeatureDark] = useState(false);
  // One typed companion client for the card. Constructing it performs no I/O —
  // the background-notifications section is what decides whether to call it.
  const webhooks: ConnectorWebhooksClient = useMemo(
    () => createConnectorWebhooksClient(backendUrl, { sessionStore }),
    [backendUrl, sessionStore],
  );
  // The second typed companion client — the cohort-gated meetings READ
  // surface — from the same two props. Constructing it performs no I/O
  // either: the background-notifications section owns the one mount-time
  // probe that decides which consent text its off state shows (F011).
  const meetings: ConnectorMeetingsClient = useMemo(
    () => createConnectorMeetingsClient(backendUrl, { sessionStore }),
    [backendUrl, sessionStore],
  );
  // Which connector (if any) currently owns a modal. Only one can be open at
  // a time — the card is a source list, not a multi-dialog dashboard.
  const [dialog, setDialog] = useState<
    { kind: "connect" | "disconnect" | "autojoin"; id: ConnectorId } | null
  >(() => {
    const returned = pendingSameTabReturn();
    return returned ? { kind: returned.purpose, id: GMEET_CONNECTOR_ID } : null;
  });
  // Per-connector abort handles for in-flight card syncs so the Stop button
  // can cancel the loop between items. Kept out of state — flipping the ref
  // must not re-render, and swapping controllers between runs is fine.
  const syncAbortRefs = useRef<Partial<Record<ConnectorId, AbortController>>>({});

  const patchRow = useCallback(
    (id: ConnectorId, patch: Partial<RowState>) => {
      setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    },
    [],
  );

  const refreshRow = useCallback(
    async (id: ConnectorId) => {
      const res = await connectorStore.getConnection(tcw, id);
      if (!res.ok) {
        patchRow(id, { actionError: res.error.message });
        return;
      }
      patchRow(id, { loaded: true, connection: res.data, actionError: null });
    },
    [tcw, patchRow],
  );

  // Load persisted connection state for every AVAILABLE connector on mount.
  // Sequential — TinyCloud drops concurrent responses on the same space.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const d of CONNECTORS) {
        if (d.status !== "available") continue;
        const res = await connectorStore.getConnection(tcw, d.id);
        if (cancelled) return;
        if (!res.ok) {
          patchRow(d.id, {
            loaded: true,
            connection: null,
            actionError: res.error.message,
          });
          continue;
        }
        patchRow(d.id, { loaded: true, connection: res.data });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tcw, patchRow]);
  useEffect(() => {
    const onConnectorStateUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ connectorId?: ConnectorId }>).detail;
      if (detail?.connectorId === "fireflies") void refreshRow("fireflies");
    };
    window.addEventListener("tinychat:connector-state-updated", onConnectorStateUpdated);
    return () => {
      window.removeEventListener("tinychat:connector-state-updated", onConnectorStateUpdated);
    };
  }, [refreshRow]);

  // A dialog that finished with `deferNotes` can already be closed when the
  // Notes reconcile settles. The engine has rewritten the row by then (ok,
  // partial or error with its saved message), so re-reading it is enough.
  useEffect(() => onGmeetNotesSettled(() => { void refreshRow(GMEET_CONNECTOR_ID); }), [refreshRow]);

  const handleSyncNow = useCallback(
    async (d: ConnectorDescriptor, driveMode: "auto" | "snapshot" = "auto") => {
      const generation = readBackgroundDrainGeneration();
      // ENGINE DISPATCH — by registry id, and exhaustively. There is no shared
      // default here on purpose: a descriptor moving coming-soon → available
      // WITHOUT its own entry below would otherwise be fetched with the
      // Fireflies client and the Fireflies key. Google Meet has its own entry
      // (it reads a refresh token, mints an access token through the backend
      // proxy and runs `syncGoogleMeet`) and never touches FirefliesClient;
      // anything else still gets the explicit not-implemented error.
      const engine: RowSyncEngine | null =
        d.id === "fireflies" ? "fireflies" : d.id === GMEET_CONNECTOR_ID ? "gmeet" : null;
      if (engine === null) {
        patchRow(d.id, {
          syncing: false,
          actionError: "Sync not yet implemented for this connector.",
        });
        return;
      }
      // A sync is running that this press cannot join (a Full rescan must not lose its snapshot
      // intent; Sync now cannot join a background Notes reconcile): show its progress and offer
      // to wait rather than a bare error.
      if (d.id === GMEET_CONNECTOR_ID && isGmeetSyncInFlight() && (driveMode === "snapshot" || isGmeetNotesSyncInFlight())) {
        patchRow(d.id, {
          syncing: false,
          joinedBackgroundSync: false,
          progress: null,
          actionError: null,
          actionRetryAfterMs: null,
          busyOffer: driveMode,
          queuedSync: null,
        });
        return;
      }
      if (!secretsAvailable()) {
        patchRow(d.id, {
          syncing: false,
          actionError: SECRETS_UNAVAILABLE_IN_APP_MESSAGE,
        });
        return;
      }
      patchRow(d.id, {
        syncing: true,
        joinedBackgroundSync: false,
        progress: null,
        actionError: null,
        actionRetryAfterMs: null,
        busyOffer: null,
        queuedSync: null,
      });
      try {
      if (!isConnectorKeysReady(tcw) && !isSecretsUnlocked(tcw)) {
        const unlock = await unlockSecrets<SecretsErr>(tcw);
        if (!unlock.ok) {
          patchRow(d.id, {
            syncing: false,
            actionError: unlock.error?.message ?? "Could not unlock secrets",
          });
          return;
        }
        // The unlock re-arms the session-start sync, which takes the engine's slot. That run is this
        // press's own: wait for its foreground part, then queue behind its Notes (below) rather than refuse.
        if (engine === "gmeet") await awaitGmeetSessionSync();
      }
      // The registry row names the secret — API key for Fireflies, refresh
      // token for Google Meet. This file spells neither, which is what lets the
      // flip commit change what is read without touching here.
      const keyRes = await getConnectorKey<SecretsErr>(tcw, d);
      if (!keyRes.ok) {
        if (keyRes.error?.code === "CONNECTOR_MIGRATION_REQUIRED") {
          setMigrationError(null);
          setMigrationDescriptor(d);
        }
        patchRow(d.id, {
          syncing: false,
          actionError:
            keyRes.error?.message ??
            (engine === "gmeet"
              ? "Could not read the saved Google connection"
              : "Could not read API key"),
        });
        return;
      }
      if (engine === "gmeet" && gmeetPressRefused(driveMode)) {
        patchRow(d.id, { syncing: false, progress: null, busyOffer: driveMode, queuedSync: driveMode });
        return;
      }
      if (engine === "gmeet") setGmeetDiagnostics(null);
      const ac = new AbortController();
      syncAbortRefs.current[d.id] = ac;
      // Asked at the last moment before the call, because that is when the
      // answer is true: the Meet engine's single-flight slot is shared with the
      // session-start lane, so a press landing while that run walks a 30-day
      // backfill JOINS it. The joined caller's signal and onProgress are both
      // ignored by the engine, which is exactly what the row must not pretend.
      if (engine === "gmeet" && isGmeetSyncInFlight()) {
        patchRow(d.id, { joinedBackgroundSync: true });
      }
      if (engine === "fireflies" && isFirefliesSyncInFlight()) {
        patchRow(d.id, { joinedBackgroundSync: true });
      }
      const onProgress = (p: SyncProgress) => patchRow(d.id, { progress: p });
      const syncRes =
        engine === "gmeet"
          ? await runGmeetSyncNow({
              tcw,
              backendUrl,
              sessionStore,
              // Memory only, for this run: never logged, never re-persisted.
              refreshToken: keyRes.data,
              driveMode,
              signal: ac.signal,
              onProgress,
              onDiagnostics: import.meta.env.DEV ? setGmeetDiagnostics : undefined,
            })
          : await runFirefliesSyncNow({
              tcw,
              apiKey: keyRes.data,
              signal: ac.signal,
              onProgress,
              isCurrent: () => generation === readBackgroundDrainGeneration(),
              onJoined: () => patchRow(d.id, { joinedBackgroundSync: true }),
              onJoinSettled: () => patchRow(d.id, { joinedBackgroundSync: false }),
            });
      if (syncAbortRefs.current[d.id] === ac) {
        delete syncAbortRefs.current[d.id];
      }
      // Reload connection state either way — updateSyncState ran inside the
      // engine and is the source of truth for itemCount / lastSyncedAt.
      const connRes = await connectorStore.getConnection(tcw, d.id);
      const conn = connRes.ok ? connRes.data : null;
      if (!syncRes.ok && syncRes.busy) {
        patchRow(d.id, {
          syncing: false,
          joinedBackgroundSync: false,
          progress: null,
          connection: conn,
          actionError: null,
          actionRetryAfterMs: null,
          busyOffer: driveMode,
          queuedSync: driveMode,
        });
        return;
      }
      if (!syncRes.ok) {
        patchRow(d.id, {
          syncing: false,
          joinedBackgroundSync: false,
          progress: null,
          connection: conn,
          actionError: syncRes.message,
          actionRetryAfterMs: syncRes.retryAfterMs,
        });
        return;
      }
      patchRow(d.id, {
        syncing: false,
        joinedBackgroundSync: false,
        progress: null,
        connection: conn,
        actionError: null,
        actionRetryAfterMs: null,
      });
      } catch (cause) {
        patchRow(d.id, {
          actionError: cause instanceof Error ? cause.message : "Sync failed. Try again.",
        });
      } finally {
        if (syncAbortRefs.current[d.id]) delete syncAbortRefs.current[d.id];
        patchRow(d.id, { syncing: false, joinedBackgroundSync: false, progress: null });
      }
    },
    [tcw, patchRow, backendUrl, sessionStore],
  );

  const handleStopSync = useCallback((id: ConnectorId) => {
    syncAbortRefs.current[id]?.abort();
  }, []);

  const migrateConnector = useCallback(async () => {
    const descriptor = migrationDescriptor;
    if (!descriptor || migrationBusy || !tcw.did) return;
    setMigrationBusy(true);
    setMigrationError(null);
    let prepared: { signIn(): Promise<TinyCloudWeb>; cleanup(): void } | null = null;
    try {
      // Lazy chunk: the legacy OpenKey client loads only when a user moves a key.
      const { prepareLegacyConnectorRead } = await import("@/lib/connectors/connectorMigration");
      prepared = await prepareLegacyConnectorRead({
        ownerDid: tcw.did, connectorName: descriptor.name, backendUrl, tinycloudHosts: tcw.hosts,
        openkeyHost: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so",
      });
      const legacy = prepared;
      const result = await readOrMigrateConnectorKey(tcw, descriptor, () => legacy.signIn());
      if (!result.ok) {
        setMigrationError(result.error.message);
        return;
      }
      setMigrationDescriptor(null);
      void handleSyncNow(descriptor);
    } catch (caught) {
      setMigrationError(isOpenKeyUserDecline(caught) ? migrationDeclinedMessage(descriptor)
        : caught instanceof Error ? caught.message : "The approval didn't finish. Try again.");
    } finally {
      prepared?.cleanup();
      setMigrationBusy(false);
    }
  }, [migrationDescriptor, migrationBusy, tcw, backendUrl, handleSyncNow]);

  const gmeetQueued = rows[GMEET_CONNECTOR_ID].queuedSync;
  // The accepted offer to wait: once nothing is running, start the press that was refused.
  useEffect(() => {
    if (gmeetQueued === null || live.running) return;
    patchRow(GMEET_CONNECTOR_ID, { queuedSync: null, busyOffer: null });
    const descriptor = CONNECTORS.find((c) => c.id === GMEET_CONNECTOR_ID);
    if (descriptor) void handleSyncNow(descriptor, gmeetQueued);
  }, [gmeetQueued, live.running, patchRow, handleSyncNow]);

  const handleDisconnect = useCallback(
    (d: ConnectorDescriptor) => {
      patchRow(d.id, { actionError: null, actionRetryAfterMs: null });
      setDialog({ kind: "disconnect", id: d.id });
    },
    [patchRow],
  );

  const handleConnect = useCallback(
    (d: ConnectorDescriptor) => {
      patchRow(d.id, { actionError: null, actionRetryAfterMs: null });
      setDialog({ kind: "connect", id: d.id });
    },
    [patchRow],
  );

  const dialogDescriptor = dialog
    ? CONNECTORS.find((c) => c.id === dialog.id) ?? null
    : null;

  return (
    <SectionCard icon={PlugZapIcon} title={title}>
      <div className="flex flex-col gap-3">
        {/* One group: the rows share the card, divided by hairlines. */}
        <ul className="-mx-4 -mb-4 divide-y divide-border border-t border-border">
          {CONNECTORS.map((d) => (
            <li key={d.id} className="px-4">
              <ConnectorRow
                descriptor={d}
                state={rows[d.id]}
                onConnect={() => handleConnect(d)}
                onSyncNow={() => handleSyncNow(d)}
                onFullRescan={() => handleSyncNow(d, "snapshot")}
                onStopSync={() => handleStopSync(d.id)}
                onDisconnect={() => handleDisconnect(d)}
                gmeet={d.id === GMEET_CONNECTOR_ID ? {
                  live,
                  count: gmeetStatus.count,
                  interrupted: gmeetStatus.interrupted,
                  hasLog: gmeetStatus.hasLog,
                  getLog: gmeetStatus.getLog,
                  onWait: () => patchRow(d.id, { queuedSync: rows[d.id].busyOffer }),
                  onCancelWait: () => patchRow(d.id, { queuedSync: null, busyOffer: null }),
                } : undefined}
              >
                {d.id === GMEET_CONNECTOR_ID && d.status === "available" && (
                  <CalendarAutojoinSection backendUrl={backendUrl} sessionStore={sessionStore} revision={autojoinRevision}
                    onEnable={() => setDialog({ kind: "autojoin", id: d.id })} />
                )}
                {supportsBackgroundNotifications(d, rows[d.id].connection) && secretsAvailable() && (
                  <BackgroundSyncSection
                    tcw={tcw}
                    descriptor={d}
                    webhooks={webhooks}
                    meetings={meetings}
                    // A processing run writes meetings, so the row's stored
                    // count is stale until it is re-read.
                    onIngested={() => void refreshRow(d.id)}
                    onFeatureDark={setFeatureDark}
                  />
                )}
              </ConnectorRow>
            </li>
          ))}
        </ul>
        {import.meta.env.DEV && gmeetDiagnostics && (
          <pre
            data-testid="gmeet-count-only-diagnostics"
            className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground"
          >
            {JSON.stringify(gmeetDiagnostics, null, 2)}
          </pre>
        )}
      </div>
      {dialogDescriptor && (dialog?.kind === "connect" || dialog?.kind === "autojoin") && (
        <ConnectorConnectDialog
          tcw={tcw}
          descriptor={dialogDescriptor}
          purpose={dialog?.kind === "autojoin" ? "autojoin" : "browser"}
          backendUrl={backendUrl}
          sessionStore={sessionStore}
          open
          onOpenChange={(next) => {
            if (!next) { setDialog(null); setAutojoinRevision((n) => n + 1); }
          }}
          onConnected={() => {
            setAutojoinRevision((n) => n + 1);
            void refreshRow(dialogDescriptor.id);
          }}
        />
      )}
      {dialogDescriptor && dialog?.kind === "disconnect" && (
        <ConnectorDisconnectDialog
          tcw={tcw}
          descriptor={dialogDescriptor}
          webhooks={webhooks}
          backendUrl={backendUrl}
          sessionStore={sessionStore}
          featureDark={featureDark}
          itemCount={dialogDescriptor.id === GMEET_CONNECTOR_ID ? (gmeetStatus.count ?? 0) : (rows[dialogDescriptor.id].connection?.itemCount ?? 0)}
          open
          onOpenChange={(next) => {
            if (!next) { setDialog(null); setAutojoinRevision((n) => n + 1); }
          }}
          onDisconnected={() => {
            void refreshRow(dialogDescriptor.id);
          }}
        />
      )}
      <AlertDialog open={migrationDescriptor !== null} onOpenChange={(open) => {
        if (!open && !migrationBusy) setMigrationDescriptor(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move your saved {migrationDescriptor?.name} key</AlertDialogTitle>
            <AlertDialogDescription>
              {`Approve once in OpenKey so Exo can read your saved ${migrationDescriptor?.name} key and store it under its own key. Your old copy stays, and nothing changes until the new copy checks out.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {migrationError && <p role="alert" className="text-sm text-destructive">{migrationError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrationBusy} onClick={() => {
              if (migrationDescriptor) patchRow(migrationDescriptor.id, { actionError: migrationDeclinedMessage(migrationDescriptor) });
            }}>Later</AlertDialogCancel>
            <Button type="button" disabled={migrationBusy} onClick={() => void migrateConnector()}>
              {migrationBusy ? "Moving your key…" : "Continue"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

// ── Row ────────────────────────────────────────────────────────────────

interface GmeetRowExtras {
  live: GmeetLiveStatus;
  /** Saved meetings (what the Library shows); null until read. The row's stored count is never shown for Meet. */
  count: number | null;
  interrupted: string | null;
  hasLog: boolean;
  getLog: () => GmeetSyncLog | null;
  onWait: () => void;
  onCancelWait: () => void;
}

const ConnectorRow: FC<{
  descriptor: ConnectorDescriptor;
  state: RowState;
  onConnect: () => void;
  onSyncNow: () => void;
  onFullRescan?: () => void;
  onStopSync: () => void;
  onDisconnect: () => void;
  /** Google Meet's live status, wait offer and sync log; absent for every other row. */
  gmeet?: GmeetRowExtras;
  /** The optional background-notifications surface, when this row offers one. */
  children?: React.ReactNode;
}> = ({
  descriptor: d,
  state,
  onConnect,
  onSyncNow,
  onFullRescan,
  onStopSync,
  onDisconnect,
  gmeet,
  children,
}) => {
  const comingSoon = d.status === "coming-soon";
  const connected = state.connection?.status === "connected";
  // A coming-soon row dims only its icon and its status dot; its text keeps
  // full contrast (a dimmed row put muted text under 4.5:1).
  const containerCls = "flex flex-col gap-2 py-3";
  const status = rowStatus(comingSoon, state, d.id);
  // role="group" + aria-label carries the "coming soon" status to screen
  // readers; aria-disabled on a plain <div> has no semantic effect.
  const groupProps = comingSoon
    ? { role: "group" as const, "aria-label": `${d.name} — coming soon` }
    : {};
  const Icon = d.icon ?? PlugIcon;

  return (
    <div className={containerCls} data-testid="connector-row" {...groupProps}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-[1_1_12rem] items-start gap-2">
          <Icon
            className={`mt-0.5 size-4 shrink-0 text-muted-foreground${comingSoon ? " opacity-50" : ""}`}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <span className="[overflow-wrap:anywhere] text-sm font-medium text-foreground">{d.name}</span>
            <p className="mt-0.5 [overflow-wrap:anywhere] text-xs text-muted-foreground">{d.description}</p>
            {status && (
              <StatusDot
                tone={status.tone}
                data-row-status={status.label}
                className={`mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]${comingSoon ? " [&>[data-tone]]:opacity-50" : ""}`}
              >
                {status.label}
              </StatusDot>
            )}
          </div>
        </div>
        {!comingSoon && (
          <div className="flex shrink-0 items-center justify-end gap-2">
            {/* Withhold the action area until the persisted connection row has
                loaded — avoids flashing "Connect" for an already-connected
                connector before the SQL query resolves. */}
            {!state.loaded && (
              <div
                aria-hidden
                className="h-8 w-24 animate-pulse rounded-md bg-muted/50"
              />
            )}
            {state.loaded && !secretsAvailable() && (
              <p className="max-w-52 text-right text-xs text-muted-foreground">
                {SECRETS_UNAVAILABLE_IN_APP_MESSAGE}
              </p>
            )}
            {state.loaded && !connected && secretsAvailable() && (
              <Button
                size="sm"
                onClick={onConnect}
                aria-label={`Connect ${d.name}`}
              >
                Connect
              </Button>
            )}
            {state.loaded && connected && secretsAvailable() && (
              <>
                {d.id === GMEET_CONNECTOR_ID && onFullRescan && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onFullRescan}
                    disabled={state.syncing}
                  >
                    Full rescan
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={onSyncNow}
                  disabled={state.syncing}
                  aria-label={`Sync ${d.name} now`}
                  className="gap-1.5"
                >
                  {state.syncing && (
                    <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                  )}
                  <span>{syncButtonLabel(state)}</span>
                </Button>
                {state.syncing ? (
                  // No Stop for a run this press only JOINED: the engine honours
                  // the first caller's signal alone, so the button would abort
                  // nothing. The status line below says where the run came from.
                  state.joinedBackgroundSync ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onStopSync}
                      aria-label={`Stop syncing ${d.name}`}
                    >
                      Stop
                    </Button>
                  )
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onDisconnect}
                    aria-label={`Disconnect ${d.name}`}
                  >
                    Disconnect
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {!comingSoon && connected && state.connection && (
        <ConnectedStatusLine
          connection={state.connection}
          count={gmeet ? gmeet.count : state.connection.itemCount}
          stale={d.id === "fireflies" && isFirefliesStale(state.connection.lastSyncedAt)}
        />
      )}
      {!comingSoon && gmeet && connected && (
        <>
          {state.busyOffer !== null ? (
            <GmeetBusyOffer
              mode={state.busyOffer}
              status={gmeet.live}
              queued={state.queuedSync !== null}
              onWait={gmeet.onWait}
              onCancel={gmeet.onCancelWait}
            />
          ) : !state.syncing ? (
            <GmeetLiveLine status={gmeet.live} />
          ) : null}
          {gmeet.interrupted !== null && state.busyOffer === null && !state.syncing && (
            <p className="text-xs text-muted-foreground" role="status" data-testid="gmeet-interrupted">{gmeet.interrupted}</p>
          )}
          {gmeet.hasLog && <CopyGmeetSyncLogButton getLog={gmeet.getLog} />}
        </>
      )}
      {!comingSoon && state.syncing && state.joinedBackgroundSync && (
        <p className="text-xs text-muted-foreground">
          A sync that started when you opened TinyChat is still running — this one
          joined it rather than starting a second pass over the same meetings. It
          finishes on its own; progress isn’t shown for the run that owns it.
        </p>
      )}
      {/* Reliable SR announcement of sync progress — the button's own label
          change is not universally announced. Same pattern ImportDialog uses. */}
      {!comingSoon && state.syncing && (
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {syncAnnouncement(d.name, state)}
        </span>
      )}
      {!comingSoon && state.actionError && (
        <p role="alert" className="text-xs text-destructive">
          {formatRowError(state.actionError, state.actionRetryAfterMs)}
        </p>
      )}
      {!comingSoon &&
        !state.actionError &&
        connected &&
        (state.connection?.lastSyncStatus === "error" || state.connection?.lastSyncStatus === "partial") &&
        state.connection.lastSyncError && (
          <p role="alert" className="text-xs text-destructive">
            {state.connection.lastSyncError}
          </p>
        )}
      {children}
    </div>
  );
};

const ConnectedStatusLine: FC<{ connection: ConnectorConnection; count: number | null; stale: boolean }> = ({
  connection,
  count,
  stale,
}) => {
  const meetings = count === null ? null : `${count} meeting${count === 1 ? "" : "s"}`;
  if (!connection.lastSyncedAt) {
    return (
      <p className="text-xs text-muted-foreground">
        {meetings === null ? "Not synced yet" : `Not synced yet · ${meetings}`}
      </p>
    );
  }
  const { relative, absolute } = formatRelativeTime(connection.lastSyncedAt);
  return (
    <p className="text-xs text-muted-foreground" title={absolute}>
      {stale ? `Stale since ${absolute}` : `Last synced ${relative}`}{meetings === null ? "" : ` · ${meetings}`}
    </p>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * The row's status, as a dot plus text. Nothing until the persisted connection
 * has loaded (the action area shows a placeholder then).
 */
function rowStatus(comingSoon: boolean, state: RowState, connectorId: ConnectorId): { tone: StatusTone; label: string } | null {
  if (comingSoon) return { tone: "neutral", label: "Coming soon" };
  if (!state.loaded) return null;
  if (state.connection?.status !== "connected") return { tone: "neutral", label: "Not connected" };
  if (state.connection.lastSyncStatus === "error") return { tone: "destructive", label: "Last sync failed" };
  if (state.connection.lastSyncStatus === "partial") return { tone: "warning", label: "Last sync incomplete" };
  if (connectorId === "fireflies" && state.connection.lastSyncedAt
    && isFirefliesStale(state.connection.lastSyncedAt)) {
    return { tone: "warning", label: "Stale" };
  }
  return { tone: "primary", label: "Connected" };
}

function syncButtonLabel(state: RowState): string {
  if (!state.syncing) return "Sync now";
  const p = state.progress;
  if (p && typeof p.total === "number" && p.total > 0) {
    return `Syncing ${p.done}/${p.total}…`;
  }
  return "Syncing…";
}

function syncAnnouncement(name: string, state: RowState): string {
  if (state.joinedBackgroundSync) return `Syncing ${name} in the background.`;
  const p = state.progress;
  if (p && typeof p.total === "number" && p.total > 0) {
    return `Syncing ${name} ${p.done} of ${p.total} meetings.`;
  }
  return `Syncing ${name}.`;
}

function formatRelativeTime(iso: string): { relative: string; absolute: string } {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { relative: iso, absolute: iso };
  const absolute = new Date(t).toLocaleString();
  const diffSec = Math.round((Date.now() - t) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return { relative: rtf.format(-diffSec, "second"), absolute };
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60)
    return { relative: rtf.format(-diffMin, "minute"), absolute };
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24)
    return { relative: rtf.format(-diffHr, "hour"), absolute };
  const diffDay = Math.round(diffHr / 24);
  return { relative: rtf.format(-diffDay, "day"), absolute };
}

function formatRetryIn(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s}s`;
  }
  const min = Math.max(1, Math.round(ms / 60_000));
  return `${min} min`;
}

export function formatRowError(msg: string, retryAfterMs: number | null): string {
  if (retryAfterMs && retryAfterMs > 0) {
    return `${msg} — try again in ${formatRetryIn(retryAfterMs)}`;
  }
  return msg;
}
