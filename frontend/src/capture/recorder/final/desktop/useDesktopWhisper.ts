import { useEffect, useState } from "react";
import { captureCapabilities, subscribeCaptureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { getDesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { FINAL_COPY } from "../finalCopy";

/** What the Local stop needs of the Mac's Whisper: whether a downloaded model is selected, and its name. */
export interface DesktopWhisperState {
  ready: boolean;
  /** The selected model's label ("Whisper Large Turbo"); null until it is read, or when none is selected. */
  modelLabel: string | null;
}

export const NO_DESKTOP_WHISPER: DesktopWhisperState = { ready: false, modelLabel: null };

/** The model's name without the leading "Whisper ", for copy that already says Whisper. */
export function whisperModelName(label: string): string {
  return label.replace(/^Whisper\s+/, "");
}

export const localDesktopCaption = (modelLabel: string | null): string =>
  modelLabel
    ? `Whisper ${whisperModelName(modelLabel)} on this Mac, after you stop.`
    : FINAL_COPY.modes.localDesktopCaption;

export const LOCAL_DESKTOP_NO_MODEL_EXPLANATION =
  "Whisper transcribes on this Mac after you stop, and nothing leaves the machine. Get a model in ⚙︎ Settings.";

export const localDesktopExplanation = (modelLabel: string | null): string =>
  modelLabel
    ? FINAL_COPY.modes.localDesktopExplanation(whisperModelName(modelLabel))
    : LOCAL_DESKTOP_NO_MODEL_EXPLANATION;

async function readSelectedLabel(): Promise<string | null> {
  const extras = getDesktopCaptureExtras();
  if (!extras) return null;
  const selected = await extras.models.get();
  if (!selected) return null;
  return (await extras.models.list()).find((model) => model.id === selected && model.downloaded)?.label ?? null;
}

/**
 * The Mac's Whisper, live: the engine's `desktopWhisper` capability decides `ready`, and the extras name the model.
 * It re-reads when the engine reports a capability change (a selection) and when any model download ends.
 */
export function useDesktopWhisper(enabled: boolean): DesktopWhisperState {
  const [state, setState] = useState<DesktopWhisperState>(() =>
    enabled ? { ready: captureCapabilities().desktopWhisper, modelLabel: null } : NO_DESKTOP_WHISPER);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let latest = 0;
    const read = () => {
      const ready = captureCapabilities().desktopWhisper;
      const call = ++latest;
      const settle = (modelLabel: string | null) => {
        if (live && call === latest) setState((s) => (s.ready === ready && s.modelLabel === modelLabel ? s : { ready, modelLabel }));
      };
      if (!ready) return settle(null);
      readSelectedLabel().then(settle, (caught: unknown) => {
        console.error("[Recorder] Could not read the selected Whisper model", caught);
        settle(null);
      });
    };
    read();
    const stopCapabilities = subscribeCaptureCapabilities(read);
    const stopProgress = getDesktopCaptureExtras()?.models.onProgress((progress) => {
      if (progress.status !== "downloading") read();
    });
    return () => {
      live = false;
      stopCapabilities();
      stopProgress?.();
    };
  }, [enabled]);
  return enabled ? state : NO_DESKTOP_WHISPER;
}
