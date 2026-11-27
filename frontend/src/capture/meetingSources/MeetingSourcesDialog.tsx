// The Meeting sources window (Capture → Connectors, desktop, flag on). This file
// only wires: the rules live in the existing hooks and clients (background sync,
// disconnect, calendar autojoin, source sync), and the markup lives in
// MeetingSourcesView / ManagePanel so the harness renders the same thing.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PlugIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
import { useCalendarLinkSettings } from "@/chat/CalendarLinkSection";
import { calendarLinkingEnabled } from "@/lib/calendarLink/calendarLinkFeature";
import { CALENDAR_LINK_REMOVE_DETAILS_LABEL, GOOGLE_CALENDAR_LINK_CONSENT_COPY } from "@/lib/connectors/consentCopy";
import { secretsAvailable } from "@/lib/openkeyNative";
import { GranolaAllowBack } from "@/chat/GranolaAllowBack";
import { GranolaReconnect, GranolaSummariesNotice } from "@/chat/GranolaConnectionNotices";
import { GRANOLA_CSV_STRINGS } from "@/lib/connectors/granolaCsvStrings";
import { describeGmeetLive, gmeetPressLabel } from "@/chat/GmeetCardStatus";
import { useBackgroundSync } from "@/chat/useBackgroundSync";
import { useGmeetRowStatus } from "@/chat/useGmeetRowStatus";
import * as connectorStore from "@/lib/connectors/connectorStore";
import { GRANOLA_LAST_SYNC_FAILED, granolaKeyExpired, granolaSummariesOnly, granolaSyncErrorMessage } from "@/lib/connectors/granolaStatus";
import { clearGmeetLastRun } from "@/lib/connectors/gmeetLastRun";
import { getGmeetMeetingCount, onGmeetMeetingCount, refreshGmeetMeetingCount } from "@/lib/connectors/gmeetLiveCount";
import { onGmeetNotesSettled } from "@/lib/connectors/gmeetSync";
import { createConnectorMeetingsClient } from "@/lib/connectors/meetingsApi";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorConnection, ConnectorDescriptor, ConnectorId } from "@/lib/connectors/types";
import { createConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import type { DisconnectImportGrants, DisconnectMode } from "@/lib/connectors/connectorLifecycle";
import { createFirefliesImportGrantsTeardown } from "@/lib/connectors/firefliesImportGrantsApi";
import { ConfirmDialog } from "./ConfirmDialog";
import { DISCONNECT_WHILE_SYNCING, DisconnectRow, FirefliesManage } from "./ManagePanel";
import {
  CalendarAutojoinRow,
  CalendarLinkRow,
  DisconnectDataChoice,
  GmeetNotices,
  MeetingSourcesEntry,
  MeetingSourcesWindow,
  SourceRow,
} from "./MeetingSourcesView";
import {
  meetingSourceActionBusy,
  meetingSourceStatus,
  meetingSourcesSummary,
  sourceRowDisplay,
  meetingCount,
  syncedAgo,
} from "./meetingSourceState";
import { autojoinDetail, useCalendarAutojoin } from "./useCalendarAutojoin";
import { useConnectorDisconnect } from "./useConnectorDisconnect";
import { syncProgressLabel, useSourceSync } from "./useSourceSync";

export { meetingSourceActionBusy, meetingSourceStatus };

const DISCONNECT_MESSAGE: Record<DisconnectMode, string> = {
  "keep-data": "Meetings already in your space stay. New ones stop arriving.",
  "delete-data": "Your synced meetings are deleted from your space too. New ones stop arriving.",
};

export const SOURCE_IDS: readonly ConnectorId[] = ["fireflies", "google-meet", "granola"];

const visibleSources = SOURCE_IDS.map((id) => CONNECTORS.find((d) => d.id === id)).filter(
  (d): d is ConnectorDescriptor => d !== undefined && (d.id !== "granola" || d.status === "available"),
);
const sourceSubtitle = new Intl.ListFormat("en-GB").format(visibleSources.map((d) => d.name));
/** The consent dialog's OAuth machine is the Google one; Calendar linking only borrows it. */
const googleSource = CONNECTORS.find((d) => d.id === "google-meet");

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

function connectionOf(read: ConnectionRead | undefined): ConnectorConnection | null {
  return read?.status === "ready" ? read.connection : null;
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
    purpose: "browser" | "autojoin" | "calendar-link";
    startWithKey?: boolean;
  } | null>(null);
  const [granolaConnecting, setGranolaConnecting] = useState(false);
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
  const importGrants = useMemo(
    () => createFirefliesImportGrantsTeardown(tcw, backendUrl, sessionStore),
    [tcw, backendUrl, sessionStore],
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
      for (const { id, status } of visibleSources) {
        if (status !== "available") continue;
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
  // The background Notes reconcile settles after the press that started it (or with no press at all).
  useEffect(() => onGmeetNotesSettled(() => { void refresh("google-meet"); }), [refresh]);
  const gmeetStatus = useGmeetRowStatus(tcw, {
    connected: connectionOf(connections["google-meet"])?.status === "connected",
    revision,
  });
  const autojoin = useCalendarAutojoin({
    backendUrl,
    sessionStore,
    revision,
    enabled: open,
  });

  const autojoinInfo = autojoinDetail(autojoin.status, autojoin.error);
  const disconnectDescriptor = visibleSources.find((d) => d.id === disconnecting) ?? null;
  const requestDisconnect = (id: ConnectorId) => {
    if (sourceSync.syncingId === id) return;
    setDisconnecting(id);
  };

  return (
    <>
      <MeetingSourcesWindow
        open={open}
        onOpenChange={onOpenChange}
        returnFocus={returnFocus ?? (() => null)}
      >
        {visibleSources.map((d) => {
          const read = connections[d.id] ?? { status: "loading" };
          const lookup = read.status;
          const connection = read.status === "ready" ? read.connection : null;
          const connected = connection?.status === "connected";
          const dialogOpenForSource = connectDialog?.descriptor.id === d.id && connectDialog.purpose === "browser";
          const connecting = dialogOpenForSource && (d.id !== "granola" || granolaConnecting);
          const syncing = sourceSync.syncingId === d.id;
          const reconnect = !syncing && granolaKeyExpired(connection);
          const { state, status, error } = sourceRowDisplay({
            comingSoon: d.status === "coming-soon",
            connection,
            syncing,
            connecting,
            syncFailureLabel: d.id === "granola" ? GRANOLA_LAST_SYNC_FAILED : undefined,
            describePersistedSyncError: d.id === "granola" ? granolaSyncErrorMessage : undefined,
            syncError: sourceSync.error?.id === d.id ? sourceSync.error.message : null,
            rowNote: rowNotes[d.id] ?? null,
            // Meet's count is the saved meetings the Library shows, not the figure cached when a sync last settled.
            ...(d.id === "google-meet" ? { itemCount: gmeetStatus.count, lastRun: gmeetStatus.lastRun } : {}),
          });
          const busy = sourceSync.busy?.id === d.id ? sourceSync.busy : null;
          return (
            <SourceRow
              key={d.id}
              id={d.id}
              name={d.name}
              description={d.description}
              Icon={d.icon ?? PlugIcon}
              comingSoon={d.status === "coming-soon"}
              status={status}
              lookup={d.status === "coming-soon" ? "ready" : lookup}
              connected={connected}
              busy={meetingSourceActionBusy(state)}
              syncing={syncing}
              syncLabel={syncProgressLabel(sourceSync.progress)}
              joined={syncing && sourceSync.joined}
              manageOpen={manageOpen[d.id] === true}
              error={error}
              onConnect={() => setConnectDialog({ descriptor: d, purpose: "browser" })}
              onRetryLookup={() => {
                setConnections((old) => ({ ...old, [d.id]: { status: "loading" } }));
                void refresh(d.id);
              }}
              onSync={() => void sourceSync.sync(d)}
              onFullRescan={d.id === "google-meet" ? () => void sourceSync.sync(d, "snapshot") : undefined}
              onStop={sourceSync.stop}
              onToggleManage={() => setManageOpen((old) => ({ ...old, [d.id]: !old[d.id] }))}
              notices={
                d.id === "google-meet" && connected ? (
                  <GmeetNotices
                    liveLine={describeGmeetLive(gmeetStatus.live)}
                    busy={busy && {
                      label: gmeetPressLabel(busy.mode),
                      queued: busy.queued,
                      onWait: sourceSync.wait,
                      onCancel: sourceSync.cancelWait,
                    }}
                    interrupted={syncing ? null : gmeetStatus.interrupted}
                    getLog={gmeetStatus.hasLog ? () => {
                      const log = gmeetStatus.getLog();
                      return log === null ? null : JSON.stringify(log, null, 2);
                    } : null}
                  />
                ) : granolaSummariesOnly(connection) ? <GranolaSummariesNotice className="ms-note" /> : undefined
              }
              manage={
                d.id === "fireflies" ? (
                  <FirefliesManagePanel
                    tcw={tcw}
                    descriptor={d}
                    connection={connection ?? null}
                    webhooks={webhooks}
                    meetings={meetings}
                    importGrants={importGrants}
                    onIngested={() => void refresh(d.id)}
                    onFeatureDark={setFeatureDark}
                    syncing={syncing}
                    onDisconnect={() => requestDisconnect(d.id)}
                  />
                ) : (
                  <>
                    {d.id === "granola" && syncing && connection?.lastSyncedAt && (
                      <div className="ms-opt">
                        <p className="ms-opt-text">
                          Last synced {syncedAgo(connection.lastSyncedAt)} · {meetingCount(connection.itemCount)}.
                        </p>
                      </div>
                    )}
                    {reconnect && (
                      <div className="ms-opt">
                        <div className="ms-opt-copy">
                          <GranolaReconnect tcw={tcw} className="ms-link" disabled={dialogOpenForSource}
                            onReconnect={() => setConnectDialog({ descriptor: d, purpose: "browser", startWithKey: true })} />
                          <p className="ms-opt-text">Paste a new key and sync again.</p>
                        </div>
                      </div>
                    )}
                    {d.id === "granola" && (
                      <div className="ms-opt">
                        <div className="ms-opt-copy">
                          <p className="ms-opt-text">{GRANOLA_CSV_STRINGS.allowBackNote}</p>
                          <GranolaAllowBack backendUrl={backendUrl} sessionStore={sessionStore} />
                        </div>
                      </div>
                    )}
                    <DisconnectRow name={d.name} syncing={syncing} onDisconnect={() => requestDisconnect(d.id)} />
                  </>
                )
              }
              extra={
                d.id === "google-meet" ? (
                  <CalendarAutojoinRow
                    on={autojoin.status?.enabled ?? false}
                    disabled={autojoin.busy || !autojoin.status}
                    scan={autojoinInfo.scan}
                    warning={autojoinInfo.warning}
                    detail={autojoinInfo.detail}
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
        {googleSource && calendarLinkingEnabled() && secretsAvailable() && (
          <CalendarLinkSource
            tcw={tcw}
            backendUrl={backendUrl}
            sessionStore={sessionStore}
            enabled={open}
            onLink={() => setConnectDialog({ descriptor: googleSource, purpose: "calendar-link" })}
          />
        )}
      </MeetingSourcesWindow>

      {disconnectDescriptor && (
        <DisconnectConfirm
          tcw={tcw}
          descriptor={disconnectDescriptor}
          webhooks={webhooks}
          backendUrl={backendUrl}
          sessionStore={sessionStore}
          featureDark={featureDark}
          itemCount={
            disconnectDescriptor.id === "google-meet"
              ? (gmeetStatus.count ?? 0)
              : (connectionOf(connections[disconnectDescriptor.id])?.itemCount ?? 0)
          }
          syncing={sourceSync.syncingId === disconnectDescriptor.id}
          open
          onFinished={(warning) => {
            const id = disconnectDescriptor.id;
            if (id === "google-meet") clearGmeetLastRun(tcw);
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
          onGranolaConnectingChange={setGranolaConnecting}
          startWithKey={connectDialog.startWithKey}
          onImported={() => {
            setRevision((n) => n + 1);
            void refresh(connectDialog.descriptor.id);
          }}
          onOpenChange={(next) => {
            if (!next) {
              setGranolaConnecting(false);
              setConnectDialog(null);
              setRevision((n) => n + 1);
            }
          }}
          onConnected={() => {
            if (connectDialog.descriptor.id === "granola") sourceSync.clearError("granola");
            setRevision((n) => n + 1);
            void refresh(connectDialog.descriptor.id);
          }}
        />
      )}
    </>
  );
}

/**
 * "Link Google Calendar" as its own row under the sources: it needs neither Google Meet connected nor
 * Calendar autojoin on. Unlink asks first, with the choice to also remove the calendar details from notes.
 */
function CalendarLinkSource(props: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  enabled: boolean;
  onLink: () => void;
}) {
  const link = useCalendarLinkSettings(props);
  const [confirming, setConfirming] = useState(false);
  const [removeDetails, setRemoveDetails] = useState(false);
  return (
    <>
      <CalendarLinkRow
        display={link.display}
        onLink={link.link}
        onLinkExisting={link.linkExisting}
        onUnlink={() => {
          setRemoveDetails(false);
          setConfirming(true);
        }}
      />
      <ConfirmDialog
        open={confirming}
        title="Unlink Google Calendar?"
        message={GOOGLE_CALENDAR_LINK_CONSENT_COPY.disconnectNote}
        keepLabel="Keep linked"
        dropLabel="Unlink"
        onKeep={() => setConfirming(false)}
        onDrop={() => {
          setConfirming(false);
          link.unlink(removeDetails);
        }}
        returnFocus={() => document.querySelector<HTMLElement>('[data-source="calendar-link"] .ms-btn1, [data-source="calendar-link"] .ms-btn2')}
        testId="calendar-link-unlink-confirm"
      >
        <label className="ms-confirm-choice">
          <input
            type="checkbox"
            checked={removeDetails}
            onChange={(event) => setRemoveDetails(event.target.checked)}
          />
          <span>{CALENDAR_LINK_REMOVE_DETAILS_LABEL}</span>
        </label>
      </ConfirmDialog>
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
  importGrants,
  syncing,
  onDisconnect,
}: {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  connection: ConnectorConnection | null;
  webhooks: ReturnType<typeof createConnectorWebhooksClient>;
  meetings: ReturnType<typeof createConnectorMeetingsClient>;
  onIngested: () => void;
  onFeatureDark: (dark: boolean) => void;
  importGrants: DisconnectImportGrants;
  syncing: boolean;
  onDisconnect: () => void;
}) {
  const sync = useBackgroundSync({ tcw, descriptor, webhooks, meetings, onIngested, onFeatureDark, importGrants });
  const { state, deps, emit } = sync;
  const [consentOpen, setConsentOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const rotateOpener = useRef<HTMLElement | null>(null);

  if (!supportsBackgroundNotifications(descriptor, connection)) {
    return <DisconnectRow name={descriptor.name} syncing={syncing} onDisconnect={onDisconnect} />;
  }

  return (
    <>
      <FirefliesManage
        connectorName={descriptor.name}
        state={state}
        consentVariant={sync.consentVariant}
        transcriptConsent={sync.transcriptConsent}
        consentOpen={consentOpen}
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
        syncing={syncing}
      />
      <ConfirmDialog
        open={rotateOpen}
        title="Rotate the webhook secret?"
        message="TinyCloud One issues a new address and secret. The old ones stop working right away, so paste the new ones into your Fireflies webhook."
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
  itemCount,
  syncing,
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
  /** Synced meetings held for this source; the delete choice is offered only when there are some. */
  itemCount: number;
  /** A sync this window started is still running: the teardown waits for it to settle. */
  syncing: boolean;
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
    blocked: syncing,
    onDisconnected: noop,
  });
  const [alsoDelete, setAlsoDelete] = useState(false);
  const { done, error, reset } = disconnect;
  const mode: DisconnectMode = alsoDelete ? "delete-data" : "keep-data";
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
      message={DISCONNECT_MESSAGE[mode]}
      keepLabel="Keep connected"
      dropLabel={disconnect.retryLabel ?? (alsoDelete ? "Disconnect and delete" : "Disconnect")}
      busy={disconnect.running}
      dropDisabled={syncing}
      error={syncing ? DISCONNECT_WHILE_SYNCING : disconnect.error}
      onKeep={() => {
        reset();
        setAlsoDelete(false);
        onKeep();
      }}
      onDrop={() => void disconnect.run(mode)}
      returnFocus={returnFocus}
      testId="confirm-disconnect"
    >
      <DisconnectDataChoice
        name={descriptor.name}
        oauth={descriptor.id === "google-meet"}
        itemCount={itemCount}
        checked={alsoDelete}
        disabled={disconnect.running || disconnect.planLocked}
        onChange={setAlsoDelete}
      />
    </ConfirmDialog>
  );
}

export function MeetingSourcesFeature(
  props: Omit<MeetingSourcesDialogProps, "open" | "onOpenChange" | "returnFocus"> & {
    initialOpen?: boolean;
  },
) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const [sources, setSources] = useState<{ id: ConnectorId; name: string; connected: boolean; count: number }[] | "failed" | null>(null);
  const entryRef = useRef<HTMLButtonElement>(null);
  const { tcw } = props;
  // Meet's count is the live count of saved meetings, so the entry follows a running sync.
  const gmeetCount = useSyncExternalStore(onGmeetMeetingCount, () => getGmeetMeetingCount(tcw), () => getGmeetMeetingCount(tcw));
  useEffect(() => {
    let active = true;
    void (async () => {
      const found: { id: ConnectorId; name: string; connected: boolean; count: number }[] = [];
      for (const { id, name, status } of visibleSources) {
        if (status !== "available") continue;
        const result = await connectorStore.getConnection(tcw, id);
        if (!result.ok) {
          console.error("Meeting sources connection status failed", result.error);
          if (active) setSources("failed");
          return;
        }
        const connected = result.data?.status === "connected";
        if (id === "google-meet" && connected) await refreshGmeetMeetingCount(tcw, connectorStore.countMeetings);
        found.push({ id, name, connected, count: result.data?.itemCount ?? 0 });
      }
      if (active) setSources(found);
    })();
    return () => {
      active = false;
    };
  }, [tcw, open]);
  const summary =
    sources === "failed"
      ? { text: "Connection status unavailable", connected: false }
      : sources === null
        ? { text: "Meeting sources", connected: false }
        : {
            text: meetingSourcesSummary(
              sources.map((source) => ({
                name: source.name,
                connected: source.connected,
                count: source.id === "google-meet" ? gmeetCount : source.count,
              })),
            ),
            connected: sources.some((source) => source.connected),
          };
  return (
    <>
      <MeetingSourcesEntry
        buttonRef={entryRef}
        subtitle={sourceSubtitle}
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
