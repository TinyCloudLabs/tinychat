// Source-specific allow-back confirmation. A successful backend clear precedes owner-space markers.
// Shared by the CSV import result and the Meeting sources manage rows.

import { useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import {
  GRANOLA_CSV_STRINGS as S,
  GRANOLA_LEDGER_SOURCE,
  GRANOLA_RESYNC_CONFIRM,
} from "@/lib/connectors/granolaCsvStrings";
import { createConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import { clearDeletedMeetings, clearGranolaDeletedMeetings } from "@/lib/connectors/connectorStore";
import { runGranolaSpaceWrite } from "@/lib/connectors/granolaSync";

type Step = "idle" | "confirming" | "working" | "done" | "failed";
export const allowBackNeedsBackendLedger = (source: "granola" | "google-meet"): boolean => source === "granola";

interface GranolaAllowBackProps {
  backendUrl: string;
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  source?: "granola" | "fireflies" | "google-meet";
  disabled?: boolean;
  /** Renders the opening control; defaults to a link-style button. */
  className?: string;
  /** Styles the opening control as a host-skin button instead of the default link button. */
  buttonClassName?: string;
  /** Draws the default opening control as an outline button instead of a link. */
  outline?: boolean;
  /** A line under the opening control; hidden while the confirmation is open. */
  note?: string;
  noteClassName?: string;
}

export const GranolaAllowBack: FC<GranolaAllowBackProps> = ({ tcw, backendUrl, sessionStore, source = "granola", disabled = false, className, buttonClassName, outline = false, note, noteClassName }) => {
  const sourceName = source === "google-meet" ? "Google Meet" : source === "fireflies" ? "Fireflies" : "Granola";
  const label = source === "granola" ? S.allowBack : `Allow deleted ${sourceName} meetings back`;
  const heading = source === "granola" ? GRANOLA_RESYNC_CONFIRM.heading : `${label}?`;
  const body = source === "granola" ? GRANOLA_RESYNC_CONFIRM.body
    : `We keep a list of the ${sourceName} meetings you deleted, so a sync doesn’t bring them back. If you clear it, a sync can bring those meetings back. This can’t be undone.`;
  const [step, setStep] = useState<Step>("idle");

  const confirm = async () => {
    setStep("working");
    if (source === "fireflies") {
      const webhooks = createConnectorWebhooksClient(backendUrl, { sessionStore });
      const markers = await webhooks.clearDeleted(source).catch(() => null);
      if (markers?.status !== "ok") { setStep("failed"); return; }
      const ledger = await webhooks.clearPurgeLedger(source).catch(() => null);
      if (ledger?.status !== "ok") { setStep("failed"); return; }
    } else if (allowBackNeedsBackendLedger(source)) {
      const webhooks = createConnectorWebhooksClient(backendUrl, { sessionStore });
      const result = await webhooks.clearPurgeLedger(GRANOLA_LEDGER_SOURCE).catch(() => null);
      if (result?.status !== "ok") { setStep("failed"); return; }
    }
    const cleared = source === "granola"
      ? await runGranolaSpaceWrite(() => clearGranolaDeletedMeetings(tcw)).catch(() => null)
      : await clearDeletedMeetings(tcw, source).catch(() => null);
    setStep(cleared?.ok ? "done" : "failed");
  };

  return (
    <div className={className}>
      {(step === "idle" || step === "failed") && (
        <>
          {buttonClassName
            ? <button type="button" className={buttonClassName} disabled={disabled} onClick={() => setStep("confirming")}>{step === "failed" && source === "fireflies" ? "Try again" : label}</button>
            : <Button type="button" variant={outline ? "outline" : "link"} size="sm" className={outline ? undefined : "h-auto px-0"} disabled={disabled} onClick={() => setStep("confirming")}>
              {step === "failed" && source === "fireflies" ? "Try again" : label}
            </Button>}
          {note && <p className={noteClassName}>{note}</p>}
        </>
      )}
      {(step === "confirming" || step === "working") && (
        <div role="group" aria-label={heading} className="flex flex-col gap-2 rounded-md border border-border bg-background p-3 text-sm">
          <p className="font-semibold">{heading}</p>
          <p className="text-muted-foreground">{body}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={step === "working"} onClick={() => void confirm()}>
              {step === "working" ? S.allowingBack : GRANOLA_RESYNC_CONFIRM.confirmLabel}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={step === "working"} onClick={() => setStep("idle")}>
              {GRANOLA_RESYNC_CONFIRM.cancelLabel}
            </Button>
          </div>
        </div>
      )}
      {step === "done" && <p role="status" className="text-sm text-muted-foreground">{source === "granola" ? S.allowBackDone : source === "fireflies" ? "Cleared. Meetings you deleted can come back if Fireflies reports them." : "Deleted meetings can come back from your next Google Meet sync."}</p>}
      {step === "failed" && <p role="alert" className="text-sm text-destructive">{source === "fireflies" ? "Couldn’t allow deleted Fireflies meetings back. Try again." : S.allowBackFailed}</p>}
    </div>
  );
};
