import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect, useState } from "react";
import { PlugIcon, XIcon } from "lucide-react";

import { ConnectorsCard } from "@/chat/ConnectorsCard";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { cn } from "@/lib/utils";
import * as connectorStore from "@/lib/connectors/connectorStore";
import "./meetingSources.css";

export interface MeetingSourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
}

/** Shared opener surface for Capture and Connectors. */
export function MeetingSourcesEntry({
  onClick,
  summary = "Fireflies connected · 416 meetings",
  className,
}: { onClick: () => void; summary?: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("meeting-sources-entry", className)}>
      <span className="meeting-sources-entry-icon"><PlugIcon aria-hidden="true" /></span>
      <span className="meeting-sources-entry-copy"><strong>Meeting sources</strong><span>{summary}</span></span>
      <span className="meeting-sources-entry-arrow" aria-hidden="true">›</span>
    </button>
  );
}

/** One accessible, focus-managed modal shared by both desktop entry points. */
export function MeetingSourcesDialog({
  open,
  onOpenChange,
  tcw,
  backendUrl,
  sessionStore,
}: MeetingSourcesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-modal="true" hideCloseButton className="meeting-sources-dialog">
        <div className="meeting-sources-heading">
          <span className="meeting-sources-plug"><PlugIcon aria-hidden="true" /></span>
          <div className="meeting-sources-title-copy">
            <DialogTitle className="meeting-sources-title">Meeting sources</DialogTitle>
            <DialogDescription className="meeting-sources-description">
              Bring meeting notes into your private space. <HowItWorksLink section="connectors" />
            </DialogDescription>
          </div>
          <button aria-label="Close" type="button" className="meeting-sources-close" onClick={() => onOpenChange(false)}>
            <XIcon aria-hidden="true" />
          </button>
        </div>
        <div className="meeting-sources-content">
          <ConnectorsCard tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} title="" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MeetingSourcesFeature(props: Omit<MeetingSourcesDialogProps, "open" | "onOpenChange"> & { initialOpen?: boolean }) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const [summary, setSummary] = useState("Meeting sources · checking");
  useEffect(() => {
    let active = true;
    void connectorStore.getConnection(props.tcw, "fireflies").then((result) => {
      if (!active) return;
      if (!result.ok) {
        setSummary("Connection status unavailable");
        return;
      }
      const connection = result.data;
      setSummary(connection?.status === "connected"
        ? `Fireflies connected · ${connection.itemCount} meetings`
        : "Connect Fireflies, Google Meet, and more");
    }).catch((error: unknown) => {
      console.error("Meeting sources connection status failed", error);
      if (active) setSummary("Connection status unavailable");
    });
    return () => { active = false; };
  }, [props.tcw]);
  return <>
    <MeetingSourcesEntry onClick={() => setOpen(true)} summary={summary} />
    <MeetingSourcesDialog {...props} open={open} onOpenChange={setOpen} />
  </>;
}

export { meetingSourceActionBusy, meetingSourceStatus } from "./meetingSourceState";
