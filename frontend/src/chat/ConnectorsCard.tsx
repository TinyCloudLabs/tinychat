// Connectors settings card — spec §9. Registry-driven rows; loads connection
// state on mount via connectorStore.getConnection (SQL only — never touches
// tcw.secrets on mount so a fresh settings-page open cannot trigger the wallet
// unlock popup). Sync now runs the real sync engine with a real FirefliesClient
// keyed via connectorSecrets after an interactive unlock. Connect + Disconnect
// flows are handed off to ConnectorDialog (spec §9): a Radix Dialog wraps the
// key entry → validate → save → initial sync stepper, and a Radix AlertDialog
// wraps the disconnect confirm with an "also delete N meetings" checkbox.

import { useCallback, useEffect, useRef, useState, type FC } from "react";
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
import {
  getConnectorKey,
  isSecretsUnlocked,
  unlockSecrets,
  type SecretsErr,
} from "@/lib/connectors/connectorSecrets";
import {
  ConnectorConnectDialog,
  ConnectorDisconnectDialog,
} from "./ConnectorDialog";
import { SectionCard } from "./SettingsPage";

interface ConnectorsCardProps {
  tcw: TinyCloudWeb;
}

interface RowState {
  loaded: boolean;
  connection: ConnectorConnection | null;
  syncing: boolean;
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

export function ConnectorsCard({ tcw }: ConnectorsCardProps) {
  const [rows, setRows] = useState<RowStateMap>(INITIAL_ROW_STATE_MAP);
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
      // v1 only wires the Fireflies engine. A future descriptor moving from
      // coming-soon → available without its own dispatch entry would silently
      // fetch its data with the Fireflies client + saved key — surface an
      // explicit not-implemented error instead.
      if (d.id !== "fireflies") {
        patchRow(d.id, {
          syncing: false,
          actionError: "Sync not yet implemented for this connector.",
        });
        return;
      }
      patchRow(d.id, {
        syncing: true,
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
      const keyRes = await getConnectorKey<SecretsErr>(tcw, d);
      if (!keyRes.ok) {
        patchRow(d.id, {
          syncing: false,
          actionError: keyRes.error?.message ?? "Could not read API key",
        });
        return;
      }
      const ac = new AbortController();
      syncAbortRefs.current[d.id] = ac;
      const client = new FirefliesClient({
        apiKey: keyRes.data,
        ...defaultFirefliesClientOptions(),
      });
      const syncRes = await syncFireflies({
        client,
        store: connectorStore,
        tcw,
        onProgress: (p) => patchRow(d.id, { progress: p }),
        signal: ac.signal,
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
          progress: null,
          connection: conn,
          actionError: syncRes.error.message,
          actionRetryAfterMs: syncRes.error.retryAfterMs ?? null,
        });
        return;
      }
      patchRow(d.id, {
        syncing: false,
        progress: null,
        connection: conn,
        actionError: null,
        actionRetryAfterMs: null,
      });
    },
    [tcw, patchRow],
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
              />
            </li>
          ))}
        </ul>
      </div>
      {dialogDescriptor && dialog?.kind === "connect" && (
        <ConnectorConnectDialog
          tcw={tcw}
          descriptor={dialogDescriptor}
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
}> = ({ descriptor: d, state, onConnect, onSyncNow, onStopSync, onDisconnect }) => {
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onStopSync}
                    aria-label={`Stop syncing ${d.name}`}
                  >
                    Stop
                  </Button>
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
