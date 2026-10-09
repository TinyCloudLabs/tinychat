import { useCallback, useEffect, useState } from "react";
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

export function useAudioInputs(source: AudioInputsSource | null = nativeVoiceNotesAvailable() ? nativeAudioInputs : null) {
  const [snapshot, setSnapshot] = useState<AudioInputsSnapshot>(NO_INPUTS);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => {
    if (!source) return;
    let live = true;
    source.list().then(
      (next) => live && setSnapshot(next),
      (caught: unknown) => {
        if (!live) return;
        if (isUnsupported(caught)) return setUnsupported(true);
        console.error("[Recorder] Could not list audio inputs", caught);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
    const unsubscribe = source.subscribe((next) => live && setSnapshot(next));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [source]);
  const select = useCallback(
    async (id: string | null) => {
      if (!source) return;
      try {
        await source.select(id);
        setError(null);
      } catch (caught) {
        if (isUnsupported(caught)) return setUnsupported(true);
        console.error("[Recorder] Could not select the audio input", caught);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [source],
  );
  return { ...snapshot, current: currentInput(snapshot), select, error, unsupported };
}
