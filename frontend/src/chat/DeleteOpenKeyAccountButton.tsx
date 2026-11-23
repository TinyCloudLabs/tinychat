import { useMemo, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  runServerCredentialTeardown,
  webhookFailureMessage,
  type WebhookFailure,
} from "@/lib/connectors/connectorLifecycle";
import { clearPurgeLedgersForAccountDeletion } from "@/lib/connectors/accountLedgerClear";
import { GOOGLE_REVOKE_UNCONFIRMED_MESSAGE, disconnectCalendarForAccountDeletion } from "@/lib/connectors/accountCalendarDisconnect";
import {
  createConnectorWebhooksClient,
  type ConnectorWebhooksClient,
} from "@/lib/connectors/webhooksApi";
import { openOpenKeyAccountDeletion } from "@/lib/openOpenKeyAccountDeletion";
import { createTranscriberClient } from "@/lib/transcriberApi";
import { ACCOUNT_FAILED_CONTINUE, ACCOUNT_PENDING_CONTINUE, DELETE_FAILED, NOT_DELETED, SHARED_REMOVED, pendingText } from "./recordingsDeletedCopy";

/** What the owner is told when the saved Fireflies sign-in could not be removed from our server. */
export function accountDeletionTeardownFailure(failure: WebhookFailure): string {
  return `${webhookFailureMessage(failure)} We couldn't confirm your Fireflies sign-in was removed from our server. Try again, or continue to OpenKey and revoke it yourself in your Fireflies account.`;
}

/**
 * What the owner is told when the record of their deleted meetings could not be erased. It says the record may
 * remain: nothing here claims the data is gone.
 */
export function accountDeletionLedgerFailure(failure: WebhookFailure, step: "fence" | "clear"): string {
  const lead = step === "fence"
    ? "We couldn't stop our server from delivering or importing meetings for your account, so we did not erase the record of your deleted meetings. That record may stay on our server."
    : "We couldn't confirm the record of your deleted meetings was erased from our server. It may stay there.";
  return `${webhookFailureMessage(failure)} ${lead} Try again, or continue to OpenKey.`;
}

/** What the owner is told when Calendar autojoin could not be stopped or its Google sign-in removed from our server. */
export function accountDeletionCalendarFailure(failure: WebhookFailure): string {
  return `${webhookFailureMessage(failure)} We couldn't confirm Calendar autojoin was stopped or that your Google sign-in was removed from our server. Try again, or continue and remove TinyChat under connected apps in your Google account.`;
}

type Stage = "calendar" | "recordings" | "credentials" | "ledger";

type State =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "blocked"; message: string; retryable: boolean; stage: Stage; pending?: boolean };

/**
 * "Delete OpenKey account". In order: stops Calendar autojoin and removes its Google sign-in from our server
 * (a recorder it sends would otherwise add a recording the next step has passed), requests the existing
 * recordings purge, removes the Fireflies sign-in, then stops what could still deliver or import for the
 * owner and erases the deleted-meeting record, and finally opens OpenKey. The server steps need the owner's
 * session, which OpenKey's page ends, so they all run before it. Unconfirmed steps are disclosed first; the
 * owner can retry a stage or continue without being told the data was deleted.
 */
export function DeleteOpenKeyAccountButton(props: {
  backendUrl: string;
  sessionStore: SessionStore;
  /** Injectable for tests. */
  webhooks?: ConnectorWebhooksClient;
  openDeletionPage?: () => Promise<void>;
}) {
  const { backendUrl, sessionStore } = props;
  const webhooks = useMemo(
    () => props.webhooks ?? createConnectorWebhooksClient(backendUrl, { sessionStore }),
    [props.webhooks, backendUrl, sessionStore],
  );
  const open = props.openDeletionPage ?? openOpenKeyAccountDeletion;
  const recordings = useMemo(
    () => createTranscriberClient(backendUrl, { sessionStore }),
    [backendUrl, sessionStore],
  );
  const [state, setState] = useState<State>({ phase: "idle" });

  const proceed = async () => {
    setState({ phase: "idle" });
    await open();
  };

  const teardownCredentials = async () => {
    setState({ phase: "working" });
    const outcome = await runServerCredentialTeardown(webhooks, "fireflies");
    if (outcome.status === "failed") {
      setState({ phase: "blocked", message: accountDeletionTeardownFailure(outcome.failure), retryable: true, stage: "credentials" });
      return;
    }
    if (outcome.notice !== undefined) {
      setState({ phase: "blocked", message: outcome.notice, retryable: false, stage: "credentials" });
      return;
    }
    await clearLedgers();
  };

  const clearLedgers = async () => {
    setState({ phase: "working" });
    const outcome = await clearPurgeLedgersForAccountDeletion(webhooks);
    if (outcome.status === "failed") {
      setState({ phase: "blocked", message: accountDeletionLedgerFailure(outcome.failure, outcome.step), retryable: true, stage: "ledger" });
      return;
    }
    await proceed();
  };

  const begin = async () => {
    setState({ phase: "working" });
    const outcome = await disconnectCalendarForAccountDeletion(webhooks);
    if (outcome.status === "failed") {
      setState({ phase: "blocked", message: accountDeletionCalendarFailure(outcome.failure), retryable: true, stage: "calendar" });
      return;
    }
    if (outcome.status === "notice") {
      setState({ phase: "blocked", message: GOOGLE_REVOKE_UNCONFIRMED_MESSAGE, retryable: false, stage: "calendar" });
      return;
    }
    await start();
  };

  const start = async () => {
    setState({ phase: "working" });
    const result = await recordings.removeAll();
    if (result.status !== "ok" && result.status !== "feature-dark") {
      setState({ phase: "blocked", message: `${DELETE_FAILED} ${ACCOUNT_FAILED_CONTINUE}`, retryable: true, stage: "recordings" });
      return;
    }
    if (result.status === "ok") {
      const { deleting, notDeleted, listOnly, privateCloudDeleted } = result.value;
      if (deleting > 0 || notDeleted > 0) {
        const message = deleting > 0
          ? `${pendingText({ shared: listOnly, notDeleted, voiceNotes: privateCloudDeleted })} ${ACCOUNT_PENDING_CONTINUE}`
          : `${NOT_DELETED}${listOnly > 0 ? ` ${SHARED_REMOVED}` : ""}`;
        setState({ phase: "blocked", message, retryable: true, stage: "recordings", pending: deleting > 0 && notDeleted === 0 });
        return;
      }
    }
    await teardownCredentials();
  };

  // "Continue to OpenKey" moves to the next stage without retrying the failed one; "Try again" repeats it.
  const next: Record<Stage, () => Promise<void>> = { calendar: start, recordings: teardownCredentials, credentials: clearLedgers, ledger: proceed };
  const again: Record<Stage, () => Promise<void>> = { calendar: begin, recordings: start, credentials: teardownCredentials, ledger: clearLedgers };

  return (
    <>
      {state.phase === "blocked" ? (
        <div>
          <p className={`mb-2 text-xs ${state.pending ? "text-muted-foreground" : "text-destructive"}`} role="alert">{state.message}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void next[state.stage]()} className="text-destructive">
              Continue to OpenKey
            </Button>
            {state.retryable && (
              <Button variant="ghost" size="sm" onClick={() => void again[state.stage]()}>
                Try again
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void begin()}
          disabled={state.phase === "working"}
          className="h-auto min-h-[var(--tc-control-height-sm)] max-w-full gap-1.5 whitespace-normal py-1.5 text-left text-destructive"
        >
          <Trash2Icon className="size-4" />
          <span>Delete OpenKey account</span>
        </Button>
      )}
    </>
  );
}
