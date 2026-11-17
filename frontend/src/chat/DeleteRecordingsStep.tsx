import { useMemo, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { Button } from "@/components/ui/button";
import { createTranscriberClient } from "@/lib/transcriberApi";
import { DELETE_FAILED, STEP_INTRO, doneText, pendingText, type Removals } from "./recordingsDeletedCopy";

type StepState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "working" }
  | ({ phase: "done" } & Removals)
  | ({ phase: "deleting" } & Pick<Removals, "shared" | "notDeleted" | "voiceNotes">)
  | { phase: "failed" };

/**
 * TC-3136, the step before "Delete OpenKey account". OpenKey owns account deletion and TinyChat gets no
 * signal from it, so the recordings are removed here first: every notetaker recording and transcript this
 * account holds, including the capture provider's copy. A purge that cannot be confirmed yet keeps being
 * retried by the server; this says so instead of claiming it is gone. TC-3166: the same call deletes the
 * account's voice notes and uploads (private cloud transcription jobs); the server answers 503, so the failure
 * line shows, unless that was confirmed, and an answer without `privateCloudDeleted` is rejected as incomplete.
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
      // `removed` counts the list-only removals too: `listOnly` were shared with this account and `notDeleted`
      // were not attributed to it by the provider; neither was deleted here.
      const { removed, deleting, listOnly, notDeleted, privateCloudDeleted } = result.value;
      const own = removed - listOnly - notDeleted;
      setState(deleting > 0
        ? { phase: "deleting", shared: listOnly, notDeleted, voiceNotes: privateCloudDeleted }
        : { phase: "done", own, shared: listOnly, notDeleted, voiceNotes: privateCloudDeleted });
      return;
    }
    // Neither the meeting transcriber nor private cloud transcription is on for this deployment: there are no
    // recordings to delete, and nothing about voice notes or uploads is said (`voiceNotes: null`).
    setState(result.status === "feature-dark" ? { phase: "done", own: 0, shared: 0, notDeleted: 0, voiceNotes: null } : { phase: "failed" });
  };

  return (
    <div>
      <p className="text-xs text-muted-foreground">{STEP_INTRO}</p>
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
        <p className="mt-2 text-xs text-muted-foreground" role="status">{doneText(state)}</p>
      )}
      {state.phase === "deleting" && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">{pendingText(state)}</p>
      )}
      {state.phase === "failed" && (
        <p className="mt-2 text-xs text-destructive" role="alert">{DELETE_FAILED}</p>
      )}
    </div>
  );
}
