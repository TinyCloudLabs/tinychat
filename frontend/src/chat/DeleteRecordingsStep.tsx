import { useMemo, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { Button } from "@/components/ui/button";
import { createTranscriberClient } from "@/lib/transcriberApi";
import { doneLines, sharedRemovedLine } from "./recordingsDeletedCopy";

type StepState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "working" }
  | { phase: "done"; own: number; shared: number }
  | { phase: "deleting"; own: number; shared: number; deleting: number }
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
      // `removed` counts list-only removals too; `listOnly` is the part that was never ours to delete.
      const { removed, deleting, listOnly } = result.value;
      const own = removed - listOnly;
      setState(deleting > 0 ? { phase: "deleting", own, shared: listOnly, deleting } : { phase: "done", own, shared: listOnly });
      return;
    }
    // Feature off for this deployment: there are no recordings to delete.
    setState(result.status === "feature-dark" ? { phase: "done", own: 0, shared: 0 } : { phase: "failed" });
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
        <div className="mt-2 space-y-1 text-xs text-muted-foreground" role="status">
          {doneLines(state.own, state.shared).map((line) => <p key={line}>{line}</p>)}
        </div>
      )}
      {state.phase === "deleting" && (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground" role="status">
          <p>
            {state.own > 0 ? `${state.own} deleted. ` : ""}{state.deleting} {state.deleting === 1 ? "is" : "are"} still being deleted; we keep
            retrying until each is confirmed gone.
          </p>
          {state.shared > 0 && <p>{sharedRemovedLine(state.shared)}</p>}
        </div>
      )}
      {state.phase === "failed" && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          We couldn't finish deleting your recordings just now. Some may still be there. Try again in a moment.
        </p>
      )}
    </div>
  );
}
