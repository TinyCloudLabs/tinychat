import { useMemo, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { Button } from "@/components/ui/button";
import { createTranscriberClient } from "@/lib/transcriberApi";

type StepState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "working" }
  | { phase: "done"; removed: number }
  | { phase: "deleting"; removed: number; deleting: number }
  | { phase: "failed" };

/**
 * TC-3136, the step before "Delete OpenKey account". OpenKey owns account deletion and TinyChat gets no
 * signal from it, so the recordings are removed here first: every notetaker recording and transcript this
 * account holds, including the capture provider's copy. A purge that cannot be confirmed yet keeps being
 * retried by the server; this says so instead of claiming it is gone.
 */
export function DeleteRecordingsStep(props: { backendUrl: string; sessionStore: SessionStore }) {
  const client = useMemo(
    () => createTranscriberClient(props.backendUrl, { sessionStore: props.sessionStore }),
    [props.backendUrl, props.sessionStore],
  );
  const [state, setState] = useState<StepState>({ phase: "idle" });

  const run = async () => {
    setState({ phase: "working" });
    const result = await client.removeAll();
    if (result.status === "ok") {
      setState(result.value.deleting > 0
        ? { phase: "deleting", ...result.value }
        : { phase: "done", removed: result.value.removed });
      return;
    }
    // Feature off for this deployment: there are no recordings to delete.
    setState(result.status === "feature-dark" ? { phase: "done", removed: 0 } : { phase: "failed" });
  };

  return (
    <div>
      <p className="text-xs text-muted-foreground">
        Before you delete your account, delete your recordings. This permanently removes every meeting recording
        and transcript, including the copy held by the notetaker service.
      </p>
      {(state.phase === "idle" || state.phase === "failed") && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setState({ phase: "confirm" })}
          className="mt-2 h-auto min-h-[var(--tc-control-height-sm)] max-w-full gap-1.5 whitespace-normal py-1.5 text-left"
        >
          Delete my recordings first
        </Button>
      )}
      {state.phase === "confirm" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void run()} className="text-destructive">
            Yes, delete all my recordings
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setState({ phase: "idle" })}>
            Cancel
          </Button>
        </div>
      )}
      {state.phase === "working" && <p className="mt-2 text-xs text-muted-foreground" role="status">Deleting your recordings…</p>}
      {state.phase === "done" && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {state.removed > 0 ? "Your recordings are deleted." : "You have no recordings to delete."}
        </p>
      )}
      {state.phase === "deleting" && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {state.removed} deleted. {state.deleting} {state.deleting === 1 ? "is" : "are"} still being deleted; we keep
          retrying until each is confirmed gone.
        </p>
      )}
      {state.phase === "failed" && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          We couldn't finish deleting your recordings just now. Some may still be there. Try again in a moment.
        </p>
      )}
    </div>
  );
}
