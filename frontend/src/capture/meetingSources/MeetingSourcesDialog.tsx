// The Meeting sources window (Capture → Connectors, desktop, flag on). This file
// only wires: the rules live in the existing hooks and clients (background sync,
// disconnect, calendar autojoin, source sync), and the markup lives in
// MeetingSourcesView / ManagePanel so the harness renders the same thing.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlugIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HISTORICAL_RESYNC_CONFIRM_COPY,
  cancelHistoricalResync,
  confirmHistoricalResync,
  disableBackgroundSync,
  dismissReveal,
  enableBackgroundSync,
  requestHistoricalResync,
  rotateCredentials,
  supportsBackgroundNotifications,
} from "@/chat/backgroundSyncState";
import { ConnectorConnectDialog } from "@/chat/ConnectorDialog";
import { useBackgroundSync } from "@/chat/useBackgroundSync";
import * as connectorStore from "@/lib/connectors/connectorStore";
import { createConnectorMeetingsClient } from "@/lib/connectors/meetingsApi";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorConnection, ConnectorDescriptor, ConnectorId } from "@/lib/connectors/types";
import { createConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import { ConfirmDialog } from "./ConfirmDialog";
import { DisconnectRow, FirefliesManage } from "./ManagePanel";
import {
  CalendarAutojoinRow,
  MeetingSourcesEntry,
  MeetingSourcesWindow,
  SourceRow,
} from "./MeetingSourcesView";
import {
  meetingSourceActionBusy,
  meetingSourceStatus,
  meetingSourcesSummary,
  syncedAgo,
  type MeetingSourceState,
} from "./meetingSourceState";
import { autojoinDetail, useCalendarAutojoin } from "./useCalendarAutojoin";
import { useConnectorDisconnect } from "./useConnectorDisconnect";
import { useSourceSync } from "./useSourceSync";

export { meetingSourceActionBusy, meetingSourceStatus };

const SOURCE_IDS: readonly ConnectorId[] = ["fireflies", "google-meet", "granola"];
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  fireflies: "Meeting transcripts from Fireflies.ai.",
  "google-meet": "Google Meet transcripts and Notes by Gemini.",
  granola: "Notes and transcripts from Granola.",
};

/** A source with no entry yet has not been read. Failed is not "not connected". */
type ConnectionRead =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; connection: ConnectorConnection | null };
type Connections = Partial<Record<ConnectorId, ConnectionRead>>;

export interface MeetingSourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** The Capture entry that opened this window; focus goes back there on close. */
  returnFocus?: () => HTMLElement | null;
}

function copyToClipboard(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => {});
}

function rowButton(id: ConnectorId, selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-source="${id}"] ${selector}`);
}

export function MeetingSourcesDialog({
  open,
  onOpenChange,
  tcw,
  backendUrl,
  sessionStore,
  returnFocus,
}: MeetingSourcesDialogProps) {
  const [connections, setConnections] = useState<Connections>({});
  const [revision, setRevision] = useState(0);
  const [manageOpen, setManageOpen] = useState<Partial<Record<ConnectorId, boolean>>>({});
  const [connectDialog, setConnectDialog] = useState<{
    descriptor: ConnectorDescriptor;
    purpose: "browser" | "autojoin";
  } | null>(null);
  const [disconnecting, setDisconnecting] = useState<ConnectorId | null>(null);
  const [rowNotes, setRowNotes] = useState<Partial<Record<ConnectorId, string>>>({});
  const [featureDark, setFeatureDark] = useState(false);

  const webhooks = useMemo(
    () => createConnectorWebhooksClient(backendUrl, { sessionStore }),
    [backendUrl, sessionStore],
  );
  const meetings = useMemo(
    () => createConnectorMeetingsClient(backendUrl, { sessionStore }),
    [backendUrl, sessionStore],
  );

  const readConnection = useCallback(
    async (id: ConnectorId): Promise<ConnectionRead> => {
      const res = await connectorStore.getConnection(tcw, id);
      if (!res.ok) {
        console.error("Meeting source connection read failed", res.error);
        return { status: "failed" };
      }
      return { status: "ready", connection: res.data };
    },
    [tcw],
  );

  const refresh = useCallback(
    async (id: ConnectorId) => {
      const next = await readConnection(id);
      setConnections((old) => ({ ...old, [id]: next }));
    },
    [readConnection],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      for (const id of SOURCE_IDS) {
        const d = CONNECTORS.find((item) => item.id === id);
        if (!d || d.status !== "available") continue;
        const next = await readConnection(id);
        if (!active) return;
        setConnections((old) => ({ ...old, [id]: next }));
      }
    })();
    return () => {
      active = false;
    };
  }, [readConnection, revision, open]);

  const sourceSync = useSourceSync({ tcw, backendUrl, sessionStore, onSettled: refresh });
  const descriptors = SOURCE_IDS.map((id) => CONNECTORS.find((d) => d.id === id)).filter(
    (d): d is ConnectorDescriptor => d !== undefined,
  );
  const autojoin = useCalendarAutojoin({
    backendUrl,
    sessionStore,
    revision,
    enabled: open,
  });

  const autojoinInfo = autojoinDetail(autojoin.status, autojoin.error);
  const disconnectDescriptor = descriptors.find((d) => d.id === disconnecting) ?? null;

  return (
    <>
      <MeetingSourcesWindow
        open={open}
        onOpenChange={onOpenChange}
        returnFocus={returnFocus ?? (() => null)}
      >
        {descriptors.map((d) => {
          const read = connections[d.id] ?? { status: "loading" };
          const lookup = read.status;
          const connection = read.status === "ready" ? read.connection : null;
          const connected = connection?.status === "connected";
          const connecting = connectDialog?.descriptor.id === d.id && connectDialog.purpose === "browser";
          const syncing = sourceSync.syncingId === d.id;
          const state: MeetingSourceState = syncing
            ? "syncing"
            : connecting
              ? "connecting"
              : connected
                ? "connected"
                : "disconnected";
          const status =
            d.status === "coming-soon"
              ? null
              : meetingSourceStatus(state, syncedAgo(connection?.lastSyncedAt), connection?.itemCount ?? 0);
          const syncFailure = sourceSync.error?.id === d.id ? sourceSync.error.message : null;
          return (
            <SourceRow
              key={d.id}
              id={d.id}
              name={d.name}
              description={DESCRIPTIONS[d.id] ?? ""}
              Icon={d.icon ?? PlugIcon}
              comingSoon={d.status === "coming-soon"}
              status={status}
              lookup={d.status === "coming-soon" ? "ready" : lookup}
              connected={connected}
              busy={meetingSourceActionBusy(state)}
              syncing={syncing}
              manageOpen={manageOpen[d.id] === true}
              error={syncFailure ?? rowNotes[d.id] ?? null}
              onConnect={() => setConnectDialog({ descriptor: d, purpose: "browser" })}
              onRetryLookup={() => {
                setConnections((old) => ({ ...old, [d.id]: { status: "loading" } }));
                void refresh(d.id);
              }}
              onSync={() => void sourceSync.sync(d)}
              onToggleManage={() => setManageOpen((old) => ({ ...old, [d.id]: !old[d.id] }))}
              manage={
                d.id === "fireflies" ? (
                  <FirefliesManagePanel
                    tcw={tcw}
                    descriptor={d}
                    connection={connection ?? null}
                    webhooks={webhooks}
                    meetings={meetings}
                    onIngested={() => void refresh(d.id)}
                    onFeatureDark={setFeatureDark}
                    onDisconnect={() => setDisconnecting(d.id)}
                  />
                ) : (
                  <DisconnectRow name={d.name} onDisconnect={() => setDisconnecting(d.id)} />
                )
              }
              extra={
                d.id === "google-meet" ? (
                  <CalendarAutojoinRow
                    on={autojoin.status?.enabled ?? false}
                    disabled={autojoin.busy || !autojoin.status}
                    scan={autojoinInfo.scan}
                    warning={autojoinInfo.warning}
                    onToggle={() =>
                      autojoin.status?.enabled
                        ? autojoin.disable()
                        : setConnectDialog({ descriptor: d, purpose: "autojoin" })
                    }
                  />
                ) : undefined
              }
            />
          );
        })}
      </MeetingSourcesWindow>

      {disconnectDescriptor && (
        <DisconnectConfirm
          tcw={tcw}
          descriptor={disconnectDescriptor}
          webhooks={webhooks}
          backendUrl={backendUrl}
          sessionStore={sessionStore}
          featureDark={featureDark}
          open
          onFinished={(warning) => {
            const id = disconnectDescriptor.id;
            setManageOpen((old) => ({ ...old, [id]: false }));
            setRowNotes((old) => {
              const next = { ...old };
              if (warning) next[id] = warning;
              else delete next[id];
              return next;
            });
            setRevision((n) => n + 1);
            void refresh(id).then(() => setDisconnecting(null));
          }}
          onKeep={() => setDisconnecting(null)}
          returnFocus={() =>
            rowButton(disconnectDescriptor.id, ".ms-btn1") ??
            rowButton(disconnectDescriptor.id, "[aria-expanded]")
          }
        />
      )}

      {connectDialog && (
        <ConnectorConnectDialog
          tcw={tcw}
          descriptor={connectDialog.descriptor}
          purpose={connectDialog.purpose}
          backendUrl={backendUrl}
          sessionStore={sessionStore}
          open
          onOpenChange={(next) => {
            if (!next) {
              setConnectDialog(null);
              setRevision((n) => n + 1);
            }
          }}
          onConnected={() => {
            setRevision((n) => n + 1);
            void refresh(connectDialog.descriptor.id);
          }}
        />
      )}
    </>
  );
}

function FirefliesManagePanel({
  tcw,
  descriptor,
  connection,
  webhooks,
  meetings,
  onIngested,
  onFeatureDark,
  onDisconnect,
}: {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  connection: ConnectorConnection | null;
  webhooks: ReturnType<typeof createConnectorWebhooksClient>;
  meetings: ReturnType<typeof createConnectorMeetingsClient>;
  onIngested: () => void;
  onFeatureDark: (dark: boolean) => void;
  onDisconnect: () => void;
}) {
  const sync = useBackgroundSync({ tcw, descriptor, webhooks, meetings, onIngested, onFeatureDark });
  const { state, deps, emit } = sync;
  const [consentOpen, setConsentOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const rotateOpener = useRef<HTMLElement | null>(null);

  if (!supportsBackgroundNotifications(descriptor, connection)) {
    return <DisconnectRow name={descriptor.name} onDisconnect={onDisconnect} />;
  }

  return (
    <>
      <FirefliesManage
        connectorName={descriptor.name}
        state={state}
        consentVariant={sync.consentVariant}
        ingestConsentChecked={sync.ingestConsentChecked}
        consentOpen={consentOpen}
        onIngestConsentChange={sync.setIngestConsentChecked}
        onToggleInstant={() => {
          if (state.phase === "enabled") void disableBackgroundSync(deps, emit);
          else setConsentOpen((was) => !was);
        }}
        onConfirmEnable={() => {
          setConsentOpen(false);
          void enableBackgroundSync(deps, emit);
        }}
        onCancelEnable={() => setConsentOpen(false)}
        onRotate={() => {
          rotateOpener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setRotateOpen(true);
        }}
        onDismissReveal={() => emit(dismissReveal)}
        onCopy={copyToClipboard}
        onSync={() => void sync.runSync()}
        onRetry={sync.retry}
        onBringBack={() => emit(requestHistoricalResync)}
        onDisconnect={onDisconnect}
      />
      <ConfirmDialog
        open={rotateOpen}
        title="Rotate the webhook secret?"
        message="Exo issues a new address and secret. The old ones stop working right away, so paste the new ones into your Fireflies webhook."
        keepLabel="Keep the current one"
        dropLabel="Rotate"
        busy={rotating}
        onKeep={() => setRotateOpen(false)}
        onDrop={() => {
          setRotating(true);
          void rotateCredentials(deps, emit).finally(() => {
            setRotating(false);
            setRotateOpen(false);
          });
        }}
        returnFocus={() =>
          document.querySelector<HTMLElement>("[data-reveal-done]") ?? rotateOpener.current
        }
        testId="confirm-rotate"
      />
      <ConfirmDialog
        open={state.resyncConfirming}
        title={HISTORICAL_RESYNC_CONFIRM_COPY.heading}
        message={HISTORICAL_RESYNC_CONFIRM_COPY.body}
        keepLabel={HISTORICAL_RESYNC_CONFIRM_COPY.cancelLabel}
        dropLabel={HISTORICAL_RESYNC_CONFIRM_COPY.confirmLabel}
        busy={state.busy === "clearing-ledger"}
        error={state.notice?.tone === "error" ? state.notice.message : null}
        onKeep={() => emit(cancelHistoricalResync)}
        onDrop={() => void confirmHistoricalResync(deps, emit)}
        testId="confirm-bring-back"
      />
    </>
  );
}

function DisconnectConfirm({
  tcw,
  descriptor,
  webhooks,
  backendUrl,
  sessionStore,
  featureDark,
  open,
  onFinished,
  onKeep,
  returnFocus,
}: {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  webhooks: ReturnType<typeof createConnectorWebhooksClient>;
  backendUrl: string;
  sessionStore: SessionStore;
  featureDark: boolean;
  open: boolean;
  /** The teardown finished. A warning is an upstream revoke that did not go through. */
  onFinished: (warning: string | null) => void;
  onKeep: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const noop = useCallback(() => {}, []);
  const disconnect = useConnectorDisconnect({
    tcw,
    descriptor,
    webhooks,
    backendUrl,
    sessionStore,
    featureDark,
    onDisconnected: noop,
  });
  const { done, error, reset } = disconnect;
  const finished = useRef(false);
  useEffect(() => {
    if (!done || finished.current) return;
    finished.current = true;
    onFinished(error);
    reset();
  }, [done, error, onFinished, reset]);
  return (
    <ConfirmDialog
      open={open}
      title={`Disconnect ${descriptor.name}?`}
      message="Meetings already in your space stay. New ones stop arriving."
      keepLabel="Keep connected"
      dropLabel={disconnect.retryLabel ?? "Disconnect"}
      busy={disconnect.running}
      error={disconnect.error}
      onKeep={() => {
        reset();
        onKeep();
      }}
      onDrop={() => void disconnect.run()}
      returnFocus={returnFocus}
      testId="confirm-disconnect"
    />
  );
}

export function MeetingSourcesFeature(
  props: Omit<MeetingSourcesDialogProps, "open" | "onOpenChange" | "returnFocus"> & {
    initialOpen?: boolean;
  },
) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const [summary, setSummary] = useState<{ text: string; connected: boolean }>({
    text: "Meeting sources",
    connected: false,
  });
  const entryRef = useRef<HTMLButtonElement>(null);
  const { tcw } = props;
  useEffect(() => {
    let active = true;
    void (async () => {
      const found: { name: string; connected: boolean; count: number }[] = [];
      for (const id of SOURCE_IDS) {
        const d = CONNECTORS.find((item) => item.id === id);
        if (!d || d.status !== "available") continue;
        const result = await connectorStore.getConnection(tcw, id);
        if (!result.ok) {
          console.error("Meeting sources connection status failed", result.error);
          if (active) setSummary({ text: "Connection status unavailable", connected: false });
          return;
        }
        found.push({
          name: d.name,
          connected: result.data?.status === "connected",
          count: result.data?.itemCount ?? 0,
        });
      }
      if (active) {
        setSummary({
          text: meetingSourcesSummary(found),
          connected: found.some((source) => source.connected),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [tcw, open]);
  return (
    <>
      <MeetingSourcesEntry
        buttonRef={entryRef}
        summary={summary.text}
        connected={summary.connected}
        onClick={() => setOpen(true)}
      />
      <MeetingSourcesDialog
        {...props}
        open={open}
        onOpenChange={setOpen}
        returnFocus={() => entryRef.current}
      />
    </>
  );
}
