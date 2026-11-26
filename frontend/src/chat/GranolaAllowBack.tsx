// "Allow deleted meetings back" for Granola: asks first, then clears Granola's list of
// deleted meetings. Shared by the CSV import result and the Granola manage row.

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
import { clearGranolaDeletedMeetings } from "@/lib/connectors/connectorStore";
import { runGranolaSpaceWrite } from "@/lib/connectors/granolaSync";

type Step = "idle" | "confirming" | "working" | "done" | "failed";

interface GranolaAllowBackProps {
  backendUrl: string;
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
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

export const GranolaAllowBack: FC<GranolaAllowBackProps> = ({ tcw, backendUrl, sessionStore, disabled = false, className, buttonClassName, outline = false, note, noteClassName }) => {
  const [step, setStep] = useState<Step>("idle");

  const confirm = async () => {
    setStep("working");
    const webhooks = createConnectorWebhooksClient(backendUrl, { sessionStore });
    const result = await webhooks.clearPurgeLedger(GRANOLA_LEDGER_SOURCE).catch(() => null);
    if (result?.status !== "ok") { setStep("failed"); return; }
    const cleared = await runGranolaSpaceWrite(() => clearGranolaDeletedMeetings(tcw)).catch(() => null);
    setStep(cleared?.ok ? "done" : "failed");
  };

  return (
    <div className={className}>
      {(step === "idle" || step === "failed") && (
        <>
          {buttonClassName
            ? <button type="button" className={buttonClassName} disabled={disabled} onClick={() => setStep("confirming")}>{S.allowBack}</button>
            : <Button type="button" variant={outline ? "outline" : "link"} size="sm" className={outline ? undefined : "h-auto px-0"} disabled={disabled} onClick={() => setStep("confirming")}>
              {S.allowBack}
            </Button>}
          {note && <p className={noteClassName}>{note}</p>}
        </>
      )}
      {(step === "confirming" || step === "working") && (
        <div role="group" aria-label={GRANOLA_RESYNC_CONFIRM.heading} className="flex flex-col gap-2 rounded-md border border-border bg-background p-3 text-sm">
          <p className="font-semibold">{GRANOLA_RESYNC_CONFIRM.heading}</p>
          <p className="text-muted-foreground">{GRANOLA_RESYNC_CONFIRM.body}</p>
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
      {step === "done" && <p role="status" className="text-sm text-muted-foreground">{S.allowBackDone}</p>}
      {step === "failed" && <p role="alert" className="text-sm text-destructive">{S.allowBackFailed}</p>}
    </div>
  );
};
