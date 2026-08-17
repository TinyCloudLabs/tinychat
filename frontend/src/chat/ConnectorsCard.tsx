// Connectors settings card — spec §9. Registry-driven rows; loads connection
// state on mount via connectorStore.getConnection (SQL only — never touches
// tcw.secrets on mount so a fresh settings-page open cannot trigger the wallet
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
import { syncFireflies } from "@/lib/connectors/firefliesSync";
import { GmeetClient } from "@/lib/connectors/gmeetClient";
import {
  isGmeetSyncInFlight,
  syncGoogleMeet,
  type GmeetSyncProgress,
  type GmeetSyncStore,
} from "@/lib/connectors/gmeetSync";
import {
  getConnectorKey,
  isSecretsUnlocked,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
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
import { SectionCard } from "./SettingsPage";

interface ConnectorsCardProps {
  tcw: TinyCloudWeb;
  /** Passed down from SettingsPage — the card constructs no globals of its own. */
  backendUrl: string;
  sessionStore: SessionStore;
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
}

const DEFAULT_ROW_STATE: RowState = {
  loaded: false,
  connection: null,
  syncing: false,
  joinedBackgroundSync: false,
  progress: null,
  actionError: null,
  actionRetryAfterMs: null,
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
  | { ok: false; message: string; retryAfterMs: number | null };

/** The real store for the Meet engine, assembled explicitly so a signature
 *  drift in connectorStore fails at compile time rather than at the first sync. */
const GMEET_STORE: GmeetSyncStore = {
  getConnection: connectorStore.getConnection,
  putTranscriptBody: connectorStore.putTranscriptBody,
  upsertMeeting: connectorStore.upsertMeeting,
  updateSyncState: connectorStore.updateSyncState,
  countMeetings: connectorStore.countMeetings,
};

/** Meet's progress vocabulary → the row's. Counts only; no titles, no text. */
function gmeetRowProgress(p: GmeetSyncProgress): SyncProgress {
  return {
    phase: p.type === "status" ? "listing" : "storing",
    done: p.current,
    total: p.total,
  };
}

async function runFirefliesSyncNow(opts: {
  tcw: TinyCloudWeb;
  apiKey: string;
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
}): Promise<RowSyncOutcome> {
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
  });
  if (res.ok) return { ok: true };
  return { ok: false, message: res.error.message, retryAfterMs: res.error.retryAfterMs ?? null };
}

/**
 * "Sync now" for Google Meet.
 *
 * The refresh token rides one authenticated request to the backend proxy and is
 * never logged or re-persisted; the access token lives in the client for this
 * run only. `syncGoogleMeet`'s module-level single-flight is shared with the
 * session-start lane, so a button press while that run is in flight JOINS it
 * rather than racing it over the same upserts.
 */
async function runGmeetSyncNow(opts: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  refreshToken: string;
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
}): Promise<RowSyncOutcome> {
  const { tcw, backendUrl, sessionStore, refreshToken, signal } = opts;
  const mint = () =>
    mintGmeetAccessToken({ backendUrl, sessionStore, refreshToken, signal });
  const accessToken = await mint();
  if (!accessToken) {
    // Every mint failure — signed out, a dark route, a revoked grant — resolves
    // to null rather than a message, so this is the one string the card owns.
    return {
      ok: false,
      message: "Couldn't reach Google with your saved connection. Try reconnecting Google Meet.",
      retryAfterMs: null,
    };
  }
  const client = new GmeetClient({
    accessToken,
    // One 401 re-mints through the same proxy — the refresh token never leaves
    // this scope, and the new access token stays in the client.
    refreshAccessToken: mint,
    signal,
  });
  const res = await syncGoogleMeet({
    client,
    store: GMEET_STORE,
    tcw,
    onProgress: (p) => opts.onProgress(gmeetRowProgress(p)),
    signal,
  });
  if (res.ok) return { ok: true };
  return { ok: false, message: res.error.message, retryAfterMs: res.error.retryAfterMs ?? null };
}

export function ConnectorsCard({
  tcw,
  backendUrl,
  sessionStore,
}: ConnectorsCardProps) {
  const [rows, setRows] = useState<RowStateMap>(INITIAL_ROW_STATE_MAP);
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
  // a time — the card is a settings list, not a multi-dialog dashboard.
  const [dialog, setDialog] = useState<
    { kind: "connect" | "disconnect"; id: ConnectorId } | null
  >(null);
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

  const handleSyncNow = useCallback(
    async (d: ConnectorDescriptor) => {
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
      patchRow(d.id, {
        syncing: true,
        joinedBackgroundSync: false,
        progress: null,
        actionError: null,
        actionRetryAfterMs: null,
      });
      if (!isSecretsUnlocked(tcw)) {
        const unlock = await unlockSecrets<SecretsErr>(tcw);
        if (!unlock.ok) {
          patchRow(d.id, {
            syncing: false,
            actionError: unlock.error?.message ?? "Could not unlock secrets",
          });
          return;
        }
      }
      // The registry row names the secret — API key for Fireflies, refresh
      // token for Google Meet. This file spells neither, which is what lets the
      // flip commit change what is read without touching here.
      const keyRes = await getConnectorKey<SecretsErr>(tcw, d);
      if (!keyRes.ok) {
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
      const onProgress = (p: SyncProgress) => patchRow(d.id, { progress: p });
      const syncRes =
        engine === "gmeet"
          ? await runGmeetSyncNow({
              tcw,
              backendUrl,
              sessionStore,
              // Memory only, for this run: never logged, never re-persisted.
              refreshToken: keyRes.data,
              signal: ac.signal,
              onProgress,
            })
          : await runFirefliesSyncNow({
              tcw,
              apiKey: keyRes.data,
              signal: ac.signal,
              onProgress,
            });
      if (syncAbortRefs.current[d.id] === ac) {
        delete syncAbortRefs.current[d.id];
      }
      // Reload connection state either way — updateSyncState ran inside the
      // engine and is the source of truth for itemCount / lastSyncedAt.
      const connRes = await connectorStore.getConnection(tcw, d.id);
      const conn = connRes.ok ? connRes.data : null;
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
    },
    [tcw, patchRow, backendUrl, sessionStore],
  );

  const handleStopSync = useCallback((id: ConnectorId) => {
    syncAbortRefs.current[id]?.abort();
  }, []);

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
    <SectionCard icon={PlugZapIcon} title="Connectors">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Connect external sources. Synced data is stored in your space.
        </p>
        <ul className="flex flex-col gap-2">
          {CONNECTORS.map((d) => (
            <li key={d.id}>
              <ConnectorRow
                descriptor={d}
                state={rows[d.id]}
                onConnect={() => handleConnect(d)}
                onSyncNow={() => handleSyncNow(d)}
                onStopSync={() => handleStopSync(d.id)}
                onDisconnect={() => handleDisconnect(d)}
              >
                {supportsBackgroundNotifications(d, rows[d.id].connection) && (
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
      </div>
      {dialogDescriptor && dialog?.kind === "connect" && (
        <ConnectorConnectDialog
          tcw={tcw}
          descriptor={dialogDescriptor}
          backendUrl={backendUrl}
          sessionStore={sessionStore}
          open
          onOpenChange={(next) => {
            if (!next) setDialog(null);
          }}
          onConnected={() => {
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
          itemCount={rows[dialogDescriptor.id].connection?.itemCount ?? 0}
          open
          onOpenChange={(next) => {
            if (!next) setDialog(null);
          }}
          onDisconnected={() => {
            void refreshRow(dialogDescriptor.id);
          }}
        />
      )}
    </SectionCard>
  );
}

// ── Row ────────────────────────────────────────────────────────────────

const ConnectorRow: FC<{
  descriptor: ConnectorDescriptor;
  state: RowState;
  onConnect: () => void;
  onSyncNow: () => void;
  onStopSync: () => void;
  onDisconnect: () => void;
  /** The optional background-notifications surface, when this row offers one. */
  children?: React.ReactNode;
}> = ({
  descriptor: d,
  state,
  onConnect,
  onSyncNow,
  onStopSync,
  onDisconnect,
  children,
}) => {
  const comingSoon = d.status === "coming-soon";
  const connected = state.connection?.status === "connected";
  const containerCls =
    "flex flex-col gap-2 rounded-md border border-border bg-background p-3" +
    (comingSoon ? " opacity-60" : "");
  // role="group" + aria-label carries the "coming soon" status to screen
  // readers; aria-disabled on a plain <div> has no semantic effect.
  const groupProps = comingSoon
    ? { role: "group" as const, "aria-label": `${d.name} — coming soon` }
    : {};
  const Icon = d.icon ?? PlugIcon;

  return (
    <div className={containerCls} {...groupProps}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Icon
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{d.name}</span>
              {comingSoon && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Coming soon
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{d.description}</p>
          </div>
        </div>
        {!comingSoon && (
          <div className="flex shrink-0 items-center gap-2">
            {/* Withhold the action area until the persisted connection row has
                loaded — avoids flashing "Connect" for an already-connected
                connector before the SQL query resolves. */}
            {!state.loaded && (
              <div
                aria-hidden
                className="h-8 w-24 animate-pulse rounded-md bg-muted/50"
              />
            )}
            {state.loaded && !connected && (
              <Button
                size="sm"
                onClick={onConnect}
                aria-label={`Connect ${d.name}`}
              >
                Connect
              </Button>
            )}
            {state.loaded && connected && (
              <>
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
        <ConnectedStatusLine connection={state.connection} />
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
        state.connection?.lastSyncStatus === "error" &&
        state.connection.lastSyncError && (
          <p role="alert" className="text-xs text-destructive">
            {state.connection.lastSyncError}
          </p>
        )}
      {children}
    </div>
  );
};

const ConnectedStatusLine: FC<{ connection: ConnectorConnection }> = ({
  connection,
}) => {
  const count = connection.itemCount;
  const meetings = `${count} meeting${count === 1 ? "" : "s"}`;
  if (!connection.lastSyncedAt) {
    return (
      <p className="text-xs text-muted-foreground">
        Not synced yet · {meetings}
      </p>
    );
  }
  const { relative, absolute } = formatRelativeTime(connection.lastSyncedAt);
  return (
    <p className="text-xs text-muted-foreground" title={absolute}>
      Last synced {relative} · {meetings}
    </p>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────

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

function formatRowError(msg: string, retryAfterMs: number | null): string {
  if (retryAfterMs && retryAfterMs > 0) {
    return `${msg} — try again in ${formatRetryIn(retryAfterMs)}`;
  }
  return msg;
}
