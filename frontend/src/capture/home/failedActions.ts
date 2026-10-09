// Try again and Delete on a recording that could not be recovered (TC-868 in
// the UI). `runFailedAction` sorts a native call's outcome; `useFailedActions`
// holds the sheet's busy / confirm / error state for one recording.
import { useState, useSyncExternalStore } from "react";

import {
  deleteQuarantined,
  discardFailedRecording,
  retryRecovery,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { rejectionCode } from "@/lib/voiceNotes/quarantine";
import { HOME_COPY } from "./homeCopy";

export type ActionOutcome =
  | { status: "ok" }
  /** `not_failed_recording`: native no longer holds it as failed. */
  | { status: "gone" }
  /** The shell has no such action yet (iOS before T11). */
  | { status: "unimplemented" }
  | { status: "error"; caught: unknown };

export async function runFailedAction(
  call: () => Promise<void>,
): Promise<ActionOutcome> {
  try {
    await call();
    return { status: "ok" };
  } catch (caught) {
    const code = rejectionCode(caught);
    if (code === "not_failed_recording") return { status: "gone" };
    if (code === "unimplemented") return { status: "unimplemented" };
    return { status: "error", caught };
  }
}

// Once a shell says "unimplemented" the buttons stay hidden for the session.
let unavailable = false;
const listeners = new Set<() => void>();

function markUnavailable(): void {
  if (unavailable) return;
  unavailable = true;
  for (const listener of [...listeners]) listener();
}

/** Tests only. */
export function __resetFailedActionsForTests(): void {
  unavailable = false;
  for (const listener of [...listeners]) listener();
}

export function useFailedActionsAvailable(): boolean {
  return !useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => unavailable,
    () => false,
  );
}

export type RecoverableKind = "recoveryFailed" | "quarantined";

export interface FailedActionsState {
  busy: "retry" | "delete" | null;
  confirming: boolean;
  error: string | null;
}

export const IDLE_ACTIONS: FailedActionsState = {
  busy: null,
  confirming: false,
  error: null,
};

/** The native call behind each button: a quarantined session is deleted from the quarantine, a recoveryFailed one is discarded. */
export function actionCall(
  action: "retry" | "delete",
  kind: RecoverableKind,
  id: string,
): () => Promise<void> {
  if (action === "retry") return () => retryRecovery(id);
  return () =>
    kind === "quarantined" ? deleteQuarantined(id) : discardFailedRecording(id);
}

export interface ActionEffects {
  update(patch: Partial<FailedActionsState>): void;
  /** Re-reads the quarantine. */
  refresh(): void;
  /** The recording is deleted, or native no longer holds it as failed. */
  onGone(id: string): void;
  /** The shell has no such action: hide the buttons. */
  onUnavailable(): void;
}

/**
 * One press of Try again or Delete: busy while the call runs, then settled by
 * what came back. A success leaves Try again to the recorder's own events (it
 * clears the issue when the recovery lands) and ends a Delete.
 */
export async function performFailedAction(
  action: "retry" | "delete",
  kind: RecoverableKind,
  id: string,
  effects: ActionEffects,
): Promise<void> {
  effects.update({ busy: action, error: null, confirming: false });
  const outcome = await runFailedAction(actionCall(action, kind, id));
  switch (outcome.status) {
    case "ok":
      if (action === "delete") effects.onGone(id);
      effects.refresh();
      effects.update({ busy: null });
      return;
    case "gone":
      effects.onGone(id);
      effects.refresh();
      effects.update({ busy: null });
      return;
    case "unimplemented":
      effects.onUnavailable();
      effects.update({ busy: null });
      return;
    case "error":
      console.error(`[VoiceNotes] ${action} failed for ${id}`, outcome.caught);
      effects.refresh();
      effects.update({
        busy: null,
        error:
          action === "retry" ? HOME_COPY.tryAgainFailed : HOME_COPY.deleteFailed,
      });
      return;
  }
}

export interface FailedActions extends FailedActionsState {
  tryAgain(): void;
  askDelete(): void;
  keep(): void;
  confirmDelete(): void;
}

/**
 * The state for the sheet on recording `id` (null: no sheet). It starts over
 * for another recording. `refresh` re-reads the quarantine; `onGone` is told
 * when native says the recording is deleted or no longer failed, so the rows
 * stop showing it.
 */
export function useFailedActions(options: {
  id: string | null;
  kind: RecoverableKind | null;
  refresh(): void;
  onGone(id: string): void;
}): FailedActions {
  const { id, kind, refresh, onGone } = options;
  const [held, setHeld] = useState<{ id: string | null } & FailedActionsState>({
    id,
    ...IDLE_ACTIONS,
  });
  const state = held.id === id ? held : { id, ...IDLE_ACTIONS };
  const update = (patch: Partial<FailedActionsState>) =>
    setHeld((current) => ({
      ...(current.id === id ? current : { id, ...IDLE_ACTIONS }),
      ...patch,
    }));
  const run = (action: "retry" | "delete") => {
    if (id === null || kind === null || state.busy !== null) return;
    void performFailedAction(action, kind, id, {
      update,
      refresh,
      onGone,
      onUnavailable: markUnavailable,
    });
  };
  return {
    ...state,
    tryAgain: () => run("retry"),
    askDelete: () => {
      if (state.busy === null) update({ confirming: true, error: null });
    },
    keep: () => update({ confirming: false }),
    confirmDelete: () => run("delete"),
  };
}
