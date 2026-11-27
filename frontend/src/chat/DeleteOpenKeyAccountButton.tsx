import { useMemo, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE,
  runServerCredentialTeardown,
  webhookFailureMessage,
  type WebhookFailure,
} from "@/lib/connectors/connectorLifecycle";
import {
  createConnectorWebhooksClient,
  type ConnectorWebhooksClient,
} from "@/lib/connectors/webhooksApi";
import {
  createFirefliesImportGrantsClient,
  createFirefliesImportGrantsTeardown,
  removeFirefliesImportForAccountDeletion,
} from "@/lib/connectors/firefliesImportGrantsApi";
import { openOpenKeyAccountDeletion } from "@/lib/openOpenKeyAccountDeletion";
import { createTranscriberClient } from "@/lib/transcriberApi";
import { ACCOUNT_FAILED_CONTINUE, ACCOUNT_PENDING_CONTINUE, DELETE_FAILED, NOT_DELETED, SHARED_REMOVED, pendingText } from "./recordingsDeletedCopy";

/** What the owner is told when the saved Fireflies sign-in could not be removed from our server. */
export function accountDeletionTeardownFailure(failure: WebhookFailure): string {
  return `${webhookFailureMessage(failure)} We couldn't confirm your Fireflies sign-in was removed from our server. Try again, or continue to OpenKey and revoke it yourself in your Fireflies account.`;
}

/** What the owner is told when our server's permission to import Fireflies meetings could not be removed. */
export function accountDeletionGrantFailure(failure: WebhookFailure): string {
  return `${webhookFailureMessage(failure)} We couldn't confirm our server dropped its permission to import your Fireflies meetings. Try again, or continue to OpenKey; the permission ends on its own within 7 days.`;
}

type State =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "blocked"; message: string; retryable: boolean; stage: "recordings" | "credentials" | "deleted"; pending?: boolean };

/**
 * "Delete OpenKey account". Requests the existing recordings purge before removing the Fireflies
 * sign-in and opening OpenKey. Unconfirmed recordings or credential cleanup is disclosed first;
 * the owner can retry that stage or continue without being told the data was deleted.
 */
export function DeleteOpenKeyAccountButton(props: {
  backendUrl: string;
  sessionStore: SessionStore;
  /** Injectable for tests. */
  webhooks?: ConnectorWebhooksClient;
  /** The owner's TinyCloud client, to revoke the import permissions at the node. */
  tcw?: Pick<TinyCloudWeb, "revokeDelegation">;
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
  // The import permissions are taken from the server and revoked at the node before OpenKey opens. Without the owner's
  // TinyCloud client only the server's copy can be removed.
  const importGrants = useMemo(
    () => createFirefliesImportGrantsClient(backendUrl, { sessionStore }),
    [backendUrl, sessionStore],
  );
  const importTeardown = useMemo(
    () => (props.tcw ? createFirefliesImportGrantsTeardown(props.tcw, backendUrl, sessionStore) : undefined),
    [props.tcw, backendUrl, sessionStore],
  );
  const [state, setState] = useState<State>({ phase: "idle" });

  const proceed = async () => {
    setState({ phase: "working" });
    const cleared = await webhooks.clearDeleted("fireflies");
    if (cleared.status !== "ok") {
      setState({ phase: "blocked", message: "Couldn't clear your deleted Fireflies meeting list. Try again.", retryable: true, stage: "deleted" });
      return;
    }
    await open();
  };

  const teardownCredentials = async () => {
    setState({ phase: "working" });
    // Both removals always run: a failed import-permission removal must not leave the saved Fireflies sign-in on our server.
    const grants = await removeFirefliesImportForAccountDeletion(importGrants, importTeardown);
    const outcome = await runServerCredentialTeardown(webhooks, "fireflies");
    if (grants.status === "failed" || outcome.status === "failed") {
      const message = [
        grants.status === "failed" ? accountDeletionGrantFailure(grants.failure) : undefined,
        outcome.status === "failed" ? accountDeletionTeardownFailure(outcome.failure) : outcome.notice,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      setState({ phase: "blocked", message, retryable: true, stage: "credentials" });
      return;
    }
    const notice = [outcome.notice, grants.unconfirmed ? IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE : undefined]
      .filter((part): part is string => part !== undefined)
      .join(" ");
    if (notice !== "") {
      setState({ phase: "blocked", message: notice, retryable: false, stage: "credentials" });
      return;
    }
    await proceed();
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

  return (
    <>
      {state.phase === "blocked" ? (
        <div>
          <p className={`mb-2 text-xs ${state.pending ? "text-muted-foreground" : "text-destructive"}`} role="alert">{state.message}</p>
          <div className="flex flex-wrap items-center gap-2">
            {state.stage !== "deleted" && (
              <Button variant="outline" size="sm" onClick={() => void (state.stage === "recordings" ? teardownCredentials() : proceed())} className="text-destructive">
                Continue to OpenKey
              </Button>
            )}
            {state.retryable && (
              <Button variant="ghost" size="sm" onClick={() => void (state.stage === "recordings" ? start() : state.stage === "credentials" ? teardownCredentials() : proceed())}>
                Try again
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void start()}
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
