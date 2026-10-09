import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlugIcon, XIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorConnection, ConnectorDescriptor, ConnectorId } from "@/lib/connectors/types";
import * as connectorStore from "@/lib/connectors/connectorStore";
import { createConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import { createConnectorMeetingsClient } from "@/lib/connectors/meetingsApi";
import { supportsBackgroundNotifications } from "@/chat/backgroundSyncState";
import { BackgroundSyncSection } from "@/chat/BackgroundSyncSection";
import { CalendarAutojoinSection } from "@/chat/CalendarAutojoinSection";
import { ConnectorConnectDialog, ConnectorDisconnectDialog } from "@/chat/ConnectorDialog";
import { FirefliesClient, defaultFirefliesClientOptions } from "@/lib/connectors/firefliesClient";
import { syncFireflies } from "@/lib/connectors/firefliesSync";
import { getConnectorKey, isSecretsUnlocked, unlockSecrets, type SecretsErr } from "@/lib/connectors/connectorSecrets";
import { cn } from "@/lib/utils";
import "./meetingSources.css";

export interface MeetingSourcesDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; tcw: TinyCloudWeb;
  backendUrl: string; sessionStore: SessionStore;
}

export function MeetingSourcesEntry({ onClick, summary = "Fireflies connected · 416 meetings", className }: { onClick: () => void; summary?: string; className?: string }) {
  return <button type="button" onClick={onClick} className={cn("meeting-sources-entry", className)}><span className="meeting-sources-entry-icon"><PlugIcon aria-hidden="true" /></span><span className="meeting-sources-entry-copy"><strong>Meeting sources</strong><span>{summary}</span></span><span aria-hidden="true" className="meeting-sources-entry-arrow">›</span></button>;
}

export function MeetingSourcesDialog({ open, onOpenChange, tcw, backendUrl, sessionStore }: MeetingSourcesDialogProps) {
  const [connections, setConnections] = useState<Partial<Record<ConnectorId, ConnectorConnection | null>>>({});
  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<{ kind: "connect" | "autojoin" | "disconnect"; descriptor: ConnectorDescriptor } | null>(null);
  const [featureDark, setFeatureDark] = useState(false);
  const webhooks = useMemo(() => createConnectorWebhooksClient(backendUrl, { sessionStore }), [backendUrl, sessionStore]);
  const meetings = useMemo(() => createConnectorMeetingsClient(backendUrl, { sessionStore }), [backendUrl, sessionStore]);
  const refresh = useCallback(async (id: ConnectorId) => {
    const res = await connectorStore.getConnection(tcw, id);
    if (!res.ok) { console.error("Meeting source connection read failed", res.error); return; }
    setConnections((old) => ({ ...old, [id]: res.data }));
  }, [tcw]);
  useEffect(() => {
    let active = true;
    void (async () => { for (const d of CONNECTORS) { if (d.status !== "available") continue; const res = await connectorStore.getConnection(tcw, d.id); if (!active) return; if (!res.ok) { console.error("Meeting source connection read failed", res.error); setConnections((old) => ({ ...old, [d.id]: null })); } else setConnections((old) => ({ ...old, [d.id]: res.data })); } })();
    return () => { active = false; };
  }, [tcw, revision]);
  const connectDescriptor = dialog?.kind === "connect" || dialog?.kind === "autojoin" ? dialog.descriptor : null;
  const disconnectDescriptor = dialog?.kind === "disconnect" ? dialog.descriptor : null;
  const syncNow = useCallback(async () => {
    setSyncing(true); setSyncError(null);
    try {
      if (!isSecretsUnlocked(tcw)) { const unlocked = await unlockSecrets<SecretsErr>(tcw); if (!unlocked.ok) throw new Error(unlocked.error?.message ?? "Could not unlock secrets"); }
      const key = await getConnectorKey<SecretsErr>(tcw, CONNECTORS.find((item) => item.id === "fireflies")!);
      if (!key.ok) throw new Error(key.error?.message ?? "Could not read the Fireflies API key");
      const result = await syncFireflies({ client: new FirefliesClient({ apiKey: key.data, ...defaultFirefliesClientOptions() }), store: connectorStore, tcw });
      if (!result.ok) throw new Error(result.error.message);
      await refresh("fireflies");
    } catch (error) { console.error("Fireflies sync failed", error); setSyncError(error instanceof Error ? error.message : "Sync failed"); }
    finally { setSyncing(false); }
  }, [tcw, refresh]);
  const descriptors = [CONNECTORS.find((d) => d.id === "fireflies")!, CONNECTORS.find((d) => d.id === "google-meet")!, CONNECTORS.find((d) => d.id === "granola")!];
  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-modal="true" hideCloseButton className="meeting-sources-dialog">
        <div className="meeting-sources-heading"><span className="meeting-sources-plug"><PlugIcon aria-hidden="true" /></span><div className="meeting-sources-title-copy"><DialogTitle className="meeting-sources-title">Meeting sources</DialogTitle><DialogDescription className="meeting-sources-description">Bring meeting notes into your private space. <HowItWorksLink section="connectors" /></DialogDescription></div><button aria-label="Close" type="button" className="meeting-sources-close" onClick={() => onOpenChange(false)}><XIcon aria-hidden="true" /></button></div>
        <div className="meeting-sources-content">
          {descriptors.map((d) => <MeetingSourceRow key={d.id} descriptor={d} connection={connections[d.id]} expanded={d.id === "fireflies" && expanded} syncing={d.id === "fireflies" && syncing} onSync={() => void syncNow()} onToggle={() => setExpanded((v) => !v)} onConnect={() => setDialog({ kind: "connect", descriptor: d })} onDisconnect={() => setDialog({ kind: "disconnect", descriptor: d })}>
            {d.id === "fireflies" && syncError && <p role="alert" className="meeting-source-error">{syncError}</p>}
            {d.id === "fireflies" && expanded && connections.fireflies?.status === "connected" && supportsBackgroundNotifications(d, connections.fireflies) && <BackgroundSyncSection tcw={tcw} descriptor={d} webhooks={webhooks} meetings={meetings} onIngested={() => void refresh(d.id)} onFeatureDark={setFeatureDark} />}
            {d.id === "google-meet" && <CalendarAutojoinSection backendUrl={backendUrl} sessionStore={sessionStore} revision={revision} onEnable={() => setDialog({ kind: "autojoin", descriptor: d })} />}
          </MeetingSourceRow>)}
        </div>
      </DialogContent>
    </Dialog>
    {connectDescriptor && <ConnectorConnectDialog tcw={tcw} descriptor={connectDescriptor} purpose={dialog?.kind === "autojoin" ? "autojoin" : "browser"} backendUrl={backendUrl} sessionStore={sessionStore} open onOpenChange={(next) => { if (!next) { setDialog(null); setRevision((n) => n + 1); } }} onConnected={() => { setRevision((n) => n + 1); void refresh(connectDescriptor.id); }} />}
    {disconnectDescriptor && <ConnectorDisconnectDialog tcw={tcw} descriptor={disconnectDescriptor} webhooks={webhooks} backendUrl={backendUrl} sessionStore={sessionStore} featureDark={featureDark} itemCount={connections[disconnectDescriptor.id]?.itemCount ?? 0} open onOpenChange={(next) => { if (!next) { setDialog(null); setRevision((n) => n + 1); } }} onDisconnected={() => void refresh(disconnectDescriptor.id)} />}
  </>;
}

function MeetingSourceRow({ descriptor: d, connection, expanded, syncing, onSync, onToggle, onConnect, onDisconnect, children }: { descriptor: ConnectorDescriptor; connection?: ConnectorConnection | null; expanded: boolean; syncing: boolean; onSync: () => void; onToggle: () => void; onConnect: () => void; onDisconnect: () => void; children?: React.ReactNode }) {
  const Icon = d.icon ?? PlugIcon;
  const connected = connection?.status === "connected";
  const last = connection?.lastSyncedAt ? `${Math.max(0, Math.floor((Date.now() - Date.parse(connection.lastSyncedAt)) / 60000))} minutes ago` : "never";
  const status = d.status === "coming-soon" ? null : syncing ? "Syncing…" : connected ? `Connected · synced ${last} · ${connection?.itemCount ?? 0} meetings` : "Not connected";
  return <section className="meeting-source-row"><div className="meeting-source-main"><span className="meeting-source-icon"><Icon aria-hidden="true" /></span><div className="meeting-source-copy"><strong>{d.name}</strong><p>{d.id === "fireflies" ? "Meeting transcripts from Fireflies.ai." : d.id === "google-meet" ? "Google Meet transcripts and Notes by Gemini." : "Notes and transcripts from Granola."}</p>{status && <span className="meeting-source-status"><i data-connected={connected || undefined} data-busy={syncing || undefined} />{status}</span>}</div><div className="meeting-source-actions">{d.status === "coming-soon" ? <span className="meeting-source-soon">COMING SOON</span> : connected && d.id === "fireflies" ? <><Button variant="outline" aria-disabled={syncing} onClick={onSync}>{syncing ? "Syncing…" : "Sync now"}</Button><Button variant="outline" aria-expanded={expanded} onClick={onToggle}>Manage <ChevronDownIcon size={14} /></Button></> : connected ? <Button variant="outline" aria-expanded={expanded} onClick={onToggle}>Manage <ChevronDownIcon size={14} /></Button> : <Button onClick={onConnect}>Connect</Button>}</div></div>{children}{connected && d.id === "fireflies" && expanded && <div className="meeting-source-subrow"><Button variant="outline" onClick={onDisconnect}>Disconnect Fireflies</Button></div>}</section>;
}

export function MeetingSourcesFeature(props: Omit<MeetingSourcesDialogProps, "open" | "onOpenChange"> & { initialOpen?: boolean }) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const [summary, setSummary] = useState("Meeting sources · checking");
  useEffect(() => { let active = true; void connectorStore.getConnection(props.tcw, "fireflies").then((result) => { if (!active) return; if (!result.ok) setSummary("Connection status unavailable"); else setSummary(result.data?.status === "connected" ? `Fireflies connected · ${result.data.itemCount} meetings` : "Connect Fireflies, Google Meet, and more"); }).catch((error: unknown) => { console.error("Meeting sources connection status failed", error); if (active) setSummary("Connection status unavailable"); }); return () => { active = false; }; }, [props.tcw]);
  return <><MeetingSourcesEntry onClick={() => setOpen(true)} summary={summary} /><MeetingSourcesDialog {...props} open={open} onOpenChange={setOpen} /></>;
}
export { meetingSourceActionBusy, meetingSourceStatus } from "./meetingSourceState";
