import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listInputs,
  nativeVoiceNotesAvailable,
  onInputsChanged,
  selectInput,
  type AudioInput,
  type AudioInputsSnapshot,
} from "@/lib/voiceNotes/nativeVoiceNotes";

export type { AudioInputsSnapshot };

export interface AudioInputsSource {
  list(): Promise<AudioInputsSnapshot>;
  select(id: string | null): Promise<void>;
  subscribe(
    listener: (snapshot: AudioInputsSnapshot) => void,
    onError?: (caught: unknown) => void,
  ): () => void;
}

export const nativeAudioInputs: AudioInputsSource = {
  list: listInputs,
  select: selectInput,
  subscribe: onInputsChanged,
};

/** The shell has no input routing: a capability, not a failure. */
const isUnsupported = (caught: unknown) =>
  typeof caught === "object" &&
  caught !== null &&
  (caught as { code?: unknown }).code === "unsupported";

export const NO_INPUTS: AudioInputsSnapshot = {
  inputs: [],
  selectedId: null,
  activeId: null,
};

/** The input the recording uses: the one capture is on, else the one chosen, else the first. */
export function currentInput(snapshot: AudioInputsSnapshot): AudioInput | null {
  const id = snapshot.activeId ?? snapshot.selectedId;
  return (
    snapshot.inputs.find((input) => input.id === id) ??
    snapshot.inputs[0] ??
    null
  );
}

export interface AudioInputsHandlers {
  onSnapshot(snapshot: AudioInputsSnapshot): void;
  onUnsupported(): void;
  /** `retry` says whether trying the same call again can help (loading, not choosing). */
  onError(message: string, retry: boolean): void;
}

const messageOf = (caught: unknown) =>
  caught instanceof Error ? caught.message : String(caught);

function fail(
  caught: unknown,
  what: string,
  retry: boolean,
  handlers: AudioInputsHandlers,
) {
  if (isUnsupported(caught)) return handlers.onUnsupported();
  console.error(`[Recorder] Could not ${what}`, caught);
  handlers.onError(`Could not ${what}: ${messageOf(caught)}`, retry);
}

/** Loads the list and follows changes; returns the unsubscribe. */
export function watchAudioInputs(
  source: AudioInputsSource,
  handlers: AudioInputsHandlers,
): () => void {
  let live = true;
  source.list().then(
    (next) => live && handlers.onSnapshot(next),
    (caught: unknown) =>
      live && fail(caught, "list the audio inputs", true, handlers),
  );
  // The subscription logs its own failures.
  const unsubscribe = source.subscribe(
    (next) => live && handlers.onSnapshot(next),
    (caught) => {
      if (!live) return;
      if (isUnsupported(caught)) handlers.onUnsupported();
      else
        handlers.onError(
          `Could not follow audio input changes: ${messageOf(caught)}`,
          true,
        );
    },
  );
  return () => {
    live = false;
    unsubscribe();
  };
}

/** Returns whether the choice was taken. */
export async function chooseAudioInput(
  source: AudioInputsSource,
  id: string | null,
  handlers: AudioInputsHandlers,
): Promise<boolean> {
  try {
    await source.select(id);
    return true;
  } catch (caught) {
    fail(caught, "select the audio input", false, handlers);
    return false;
  }
}

export function useAudioInputs(
  source: AudioInputsSource | null = nativeVoiceNotesAvailable()
    ? nativeAudioInputs
    : null,
) {
  const [snapshot, setSnapshot] = useState<AudioInputsSnapshot>(NO_INPUTS);
  const [error, setError] = useState<{
    message: string;
    retry: boolean;
  } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const handlers = useMemo<AudioInputsHandlers>(
    () => ({
      onSnapshot: (next) => {
        setSnapshot(next);
        setError((current) => (current?.retry ? null : current));
      },
      onUnsupported: () => setUnsupported(true),
      onError: (message, retry) => setError({ message, retry }),
    }),
    [],
  );
  useEffect(
    () => (source ? watchAudioInputs(source, handlers) : undefined),
    [source, handlers, attempt],
  );
  const select = useCallback(
    async (id: string | null) => {
      if (source && (await chooseAudioInput(source, id, handlers)))
        setError(null);
    },
    [source, handlers],
  );
  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  return {
    ...snapshot,
    current: currentInput(snapshot),
    select,
    error: error?.message ?? null,
    retry: error?.retry ? retry : null,
    unsupported,
  };
}
