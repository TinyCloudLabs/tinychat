import { useCallback, useEffect, useState } from "react";
import { VoiceNotes, nativeVoiceNotesAvailable, type AudioInput } from "@/lib/voiceNotes/nativeVoiceNotes";

export interface AudioInputsSnapshot {
  inputs: AudioInput[];
  selectedId: string | null;
  activeId: string | null;
}

export interface AudioInputsSource {
  list(): Promise<AudioInputsSnapshot>;
  select(id: string | null): Promise<void>;
  subscribe(listener: (snapshot: AudioInputsSnapshot) => void): () => void;
}

export const nativeAudioInputs: AudioInputsSource = {
  list: () => VoiceNotes.listInputs(),
  select: (id) => VoiceNotes.selectInput({ id }),
  subscribe(listener) {
    const handle = VoiceNotes.addListener("inputs", listener);
    return () => void handle.then((h) => h.remove());
  },
};

export const NO_INPUTS: AudioInputsSnapshot = { inputs: [], selectedId: null, activeId: null };

/** The input the recording uses: the one capture is on, else the one chosen, else the first. */
export function currentInput(snapshot: AudioInputsSnapshot): AudioInput | null {
  const id = snapshot.activeId ?? snapshot.selectedId;
  return snapshot.inputs.find((input) => input.id === id) ?? snapshot.inputs[0] ?? null;
}

export function useAudioInputs(source: AudioInputsSource | null = nativeVoiceNotesAvailable() ? nativeAudioInputs : null) {
  const [snapshot, setSnapshot] = useState<AudioInputsSnapshot>(NO_INPUTS);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!source) return;
    let live = true;
    source.list().then(
      (next) => live && setSnapshot(next),
      (caught: unknown) => live && setError(caught instanceof Error ? caught.message : String(caught)),
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
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [source],
  );
  return { ...snapshot, current: currentInput(snapshot), select, error };
}
