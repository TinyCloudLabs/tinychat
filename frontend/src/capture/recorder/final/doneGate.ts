export interface DoneGate {
  /** The unsaved text whose failed save the user has already been shown; Done for that same text goes through. */
  acknowledged: string | null;
}

/**
 * Done: waits for the note to be saved before the recording stops. If the save fails it stops there and leaves the
 * failure showing (the saver reported it); Done again for the same unsaved text ends the recording anyway (`onUnsaved` logs it).
 */
export async function finishWithNote(
  gate: DoneGate,
  deps: {
    flush(): Promise<void>;
    unsaved(): string | null;
    stop(): void;
    onUnsaved(error: unknown): void;
  },
): Promise<"stopped" | "blocked"> {
  try {
    await deps.flush();
  } catch (error) {
    const unsaved = deps.unsaved() ?? "";
    if (gate.acknowledged !== unsaved) {
      gate.acknowledged = unsaved;
      return "blocked";
    }
    deps.onUnsaved(error);
  }
  deps.stop();
  return "stopped";
}
