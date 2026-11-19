import { useMemo, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  runServerCredentialTeardown,
  webhookFailureMessage,
  type WebhookFailure,
} from "@/lib/connectors/connectorLifecycle";
import {
  createConnectorWebhooksClient,
  type ConnectorWebhooksClient,
} from "@/lib/connectors/webhooksApi";
import { openOpenKeyAccountDeletion } from "@/lib/openOpenKeyAccountDeletion";

/** What the owner is told when the saved Fireflies sign-in could not be removed from our server. */
export function accountDeletionTeardownFailure(failure: WebhookFailure): string {
  return `${webhookFailureMessage(failure)} We couldn't confirm your Fireflies sign-in was removed from our server. Try again, or continue to OpenKey and revoke it yourself in your Fireflies account.`;
}

type State =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "blocked"; message: string; retryable: boolean };

/**
 * "Delete OpenKey account". First removes the Fireflies sign-in our server may hold (the same gated
 * teardown the disconnect runs: nothing happens for an owner with none), then opens OpenKey's deletion
 * page. A clean-up that did not finish never blocks the deletion: the owner is told what was left and
 * can continue to OpenKey anyway.
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
  const [state, setState] = useState<State>({ phase: "idle" });

  const proceed = async () => {
    setState({ phase: "idle" });
    await open();
  };

  const start = async () => {
    setState({ phase: "working" });
    const outcome = await runServerCredentialTeardown(webhooks, "fireflies");
    if (outcome.status === "failed") {
      setState({ phase: "blocked", message: accountDeletionTeardownFailure(outcome.failure), retryable: true });
      return;
    }
    if (outcome.notice !== undefined) {
      setState({ phase: "blocked", message: outcome.notice, retryable: false });
      return;
    }
    await proceed();
  };

  return (
    <>
      {state.phase === "blocked" ? (
        <div>
          <p className="mb-2 text-xs text-destructive" role="alert">{state.message}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void proceed()} className="text-destructive">
              Continue to OpenKey
            </Button>
            {state.retryable && (
              <Button variant="ghost" size="sm" onClick={() => void start()}>
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
