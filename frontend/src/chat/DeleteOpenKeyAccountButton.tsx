import { useMemo, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  runServerCredentialTeardown,
  webhookFailureMessage,
  type WebhookFailure,
} from "@/lib/connectors/connectorLifecycle";
import { stopServerAccessForAccountDeletion } from "@/lib/connectors/accountServerStops";
import { retireTranscriptDelegation } from "@/lib/transcriptDelegation";
import {
  CALENDAR_NOT_STOPPED_MESSAGE,
  GOOGLE_CONNECTIONS_LINK_TEXT,
  GOOGLE_CONNECTIONS_URL,
  GOOGLE_REVOKE_UNCONFIRMED_MESSAGE,
  disconnectCalendarForAccountDeletion,
} from "@/lib/connectors/accountCalendarDisconnect";
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

/** What the owner is told when our server could not be confirmed stopped for the account. */
export function accountDeletionStopFailure(failure: WebhookFailure): string {
  return `${webhookFailureMessage(failure)} We couldn't confirm that our server stopped delivering and importing meetings for your account. Try again, or continue to OpenKey.`;
}

/** What the owner is told when this browser could not keep its other open tabs from writing to the space again. */
export const TABS_NOT_STOPPED_MESSAGE = "We couldn't stop this browser's other open tabs from writing to your space. A tab left open could restore access we removed. Close your other tabs, then try again or continue to OpenKey.";

/** What the owner is told when Calendar autojoin could not be stopped or its Google sign-in removed from our server. */
export function accountDeletionCalendarFailure(failure: WebhookFailure): string {
  return `${webhookFailureMessage(failure)} ${CALENDAR_NOT_STOPPED_MESSAGE}`;
}

type Stage = "calendar" | "recordings" | "credentials" | "stops";

type State =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "blocked"; message: string; retryable: boolean; stage: Stage; pending?: boolean };

/**
 * "Delete OpenKey account". In order: stops Calendar autojoin and removes its Google sign-in from our server
 * (a recorder it sends would otherwise add a recording the next step has passed), requests the existing
 * recordings purge, removes the Fireflies sign-in, then stops what could still deliver or import for the
 * owner (and keeps this browser's tabs that hold the same sign-in from writing the transcript grant again) and
 * opens OpenKey. The server steps use the owner's TinyChat sign-in, which is why they run first. Unconfirmed steps
 * are disclosed first; the owner can retry a stage or continue without being told the data was deleted.
 * Nothing here erases the record of deleted meetings or the owner's space.
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
    await stopServer();
  };

  const stopServer = async () => {
    setState({ phase: "working" });
    // First, so no open tab writes the transcript grant again once it is removed. Where the browser cannot hash
    // (a page served over plain http), the stops still run and the owner is told the tabs are not covered.
    let retired = true;
    try { await retireTranscriptDelegation(sessionStore); } catch { retired = false; }
    const outcome = await stopServerAccessForAccountDeletion(webhooks);
    if (outcome.status === "failed") {
      setState({ phase: "blocked", message: accountDeletionStopFailure(outcome.failure), retryable: true, stage: "stops" });
      return;
    }
    if (!retired) {
      setState({ phase: "blocked", message: TABS_NOT_STOPPED_MESSAGE, retryable: true, stage: "stops" });
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
  const next: Record<Stage, () => Promise<void>> = { calendar: start, recordings: teardownCredentials, credentials: stopServer, stops: proceed };
  const again: Record<Stage, () => Promise<void>> = { calendar: begin, recordings: start, credentials: teardownCredentials, stops: stopServer };

  return (
    <>
      {state.phase === "blocked" ? (
        <div>
          <p className={`mb-2 text-xs ${state.pending ? "text-muted-foreground" : "text-destructive"}`} role="alert">
            {state.message}
            {state.stage === "calendar" && (
              <>
                {" "}
                <a href={GOOGLE_CONNECTIONS_URL} target="_blank" rel="noopener noreferrer" className="underline">{GOOGLE_CONNECTIONS_LINK_TEXT}</a>
              </>
            )}
          </p>
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
