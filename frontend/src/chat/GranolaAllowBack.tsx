// "Allow deleted meetings back" for Granola: asks first, then clears Granola's list of
// deleted meetings. Shared by the CSV import result and the Granola manage row.

import { useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
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
import { scheduledSpace } from "@/lib/spaceQueue";

type Step = "idle" | "confirming" | "working" | "done" | "failed";

interface GranolaAllowBackProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  disabled?: boolean;
  /** Renders the opening control; defaults to a link-style button. */
  className?: string;
}

export const GranolaAllowBack: FC<GranolaAllowBackProps> = ({ tcw, backendUrl, sessionStore, disabled = false, className }) => {
  const scope = useMemo(() => ({
    space: scheduledSpace(tcw), ownerDid: tcw.did ?? null, spaceId: tcw.spaceId ?? null,
  }), [tcw, tcw.did, tcw.spaceId, backendUrl, sessionStore]);
  const current = useRef<typeof scope | null>(scope);
  current.current = scope;
  useEffect(() => {
    current.current = scope;
    return () => { if (current.current === scope) current.current = null; };
  }, [scope]);
  const [state, setState] = useState<{ scope: typeof scope; step: Step }>({ scope, step: "idle" });
  const step = state.scope === scope ? state.step : "idle";
  const setStep = (next: Step) => setState({ scope, step: next });

  const confirm = async () => {
    const token = sessionStore.getToken();
    const active = () => current.current === scope
      && (scope.space.did ?? null) === scope.ownerDid
      && (scope.space.spaceId ?? null) === scope.spaceId
      && sessionStore.getToken() === token;
    setStep("working");
    const cleared = await runGranolaSpaceWrite(async () => {
      if (!token || !active()) return false;
      const webhooks = createConnectorWebhooksClient(backendUrl, { sessionStore });
      const result = await webhooks.clearPurgeLedger(GRANOLA_LEDGER_SOURCE);
      if (result.status !== "ok" || !active()) return false;
      return (await clearGranolaDeletedMeetings(scope.space)).ok;
    }).catch(() => false);
    if (current.current === scope) setStep(cleared ? "done" : "failed");
  };

  return (
    <div className={className}>
      {(step === "idle" || step === "failed") && (
        <Button type="button" variant="link" size="sm" className="h-auto px-0" disabled={disabled} onClick={() => setStep("confirming")}>
          {S.allowBack}
        </Button>
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
