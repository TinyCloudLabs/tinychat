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
  subscribe(listener: (snapshot: AudioInputsSnapshot) => void): () => void;
}

export const nativeAudioInputs: AudioInputsSource = {
  list: listInputs,
  select: selectInput,
  subscribe: onInputsChanged,
};

/** The shell has no input routing: a capability, not a failure. */
const isUnsupported = (caught: unknown) => typeof caught === "object" && caught !== null && (caught as { code?: unknown }).code === "unsupported";

export const NO_INPUTS: AudioInputsSnapshot = { inputs: [], selectedId: null, activeId: null };

/** The input the recording uses: the one capture is on, else the one chosen, else the first. */
export function currentInput(snapshot: AudioInputsSnapshot): AudioInput | null {
  const id = snapshot.activeId ?? snapshot.selectedId;
  return snapshot.inputs.find((input) => input.id === id) ?? snapshot.inputs[0] ?? null;
}

export interface AudioInputsHandlers {
  onSnapshot(snapshot: AudioInputsSnapshot): void;
  onUnsupported(): void;
  onError(message: string): void;
}

function fail(caught: unknown, what: string, handlers: AudioInputsHandlers) {
  if (isUnsupported(caught)) return handlers.onUnsupported();
  console.error(`[Recorder] Could not ${what}`, caught);
  handlers.onError(caught instanceof Error ? caught.message : String(caught));
}

/** Loads the list and follows changes; returns the unsubscribe. */
export function watchAudioInputs(source: AudioInputsSource, handlers: AudioInputsHandlers): () => void {
  let live = true;
  source.list().then(
    (next) => live && handlers.onSnapshot(next),
    (caught: unknown) => live && fail(caught, "list audio inputs", handlers),
  );
  const unsubscribe = source.subscribe((next) => live && handlers.onSnapshot(next));
  return () => {
    live = false;
    unsubscribe();
  };
}

/** Returns whether the choice was taken. */
export async function chooseAudioInput(source: AudioInputsSource, id: string | null, handlers: AudioInputsHandlers): Promise<boolean> {
  try {
    await source.select(id);
    return true;
  } catch (caught) {
    fail(caught, "select the audio input", handlers);
    return false;
  }
}

export function useAudioInputs(source: AudioInputsSource | null = nativeVoiceNotesAvailable() ? nativeAudioInputs : null) {
  const [snapshot, setSnapshot] = useState<AudioInputsSnapshot>(NO_INPUTS);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const handlers = useMemo<AudioInputsHandlers>(() => ({ onSnapshot: setSnapshot, onUnsupported: () => setUnsupported(true), onError: setError }), []);
  useEffect(() => (source ? watchAudioInputs(source, handlers) : undefined), [source, handlers]);
  const select = useCallback(
    async (id: string | null) => {
      if (source && (await chooseAudioInput(source, id, handlers))) setError(null);
    },
    [source, handlers],
  );
  return { ...snapshot, current: currentInput(snapshot), select, error, unsupported };
}
