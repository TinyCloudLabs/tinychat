import type {
  DesktopCaptureExtras,
  DownloadProgress,
  WhisperModelId,
  WhisperModelInfo,
} from "../desktopCaptureExtras";
import type { DesktopBridge } from "./desktopVoiceNotes";

const PROGRESS_EVENT = "exo://recorder-model-progress";

/** DesktopCaptureExtras bound to the recorder model and system audio commands. */
export function createTauriDesktopCaptureExtras(bridge: DesktopBridge): DesktopCaptureExtras {
  const subscribe = (callback: (progress: DownloadProgress) => void) =>
    bridge.listen<DownloadProgress>(PROGRESS_EVENT, callback);
  const onProgress = (callback: (progress: DownloadProgress) => void) => {
    let removed = false;
    let unlisten: (() => void) | null = null;
    subscribe(callback).then(
      (stop) => {
        if (removed) stop();
        else unlisten = stop;
      },
      (error: unknown) => console.error("[DesktopCaptureExtras] Could not follow model downloads", error),
    );
    return () => {
      removed = true;
      unlisten?.();
      unlisten = null;
    };
  };

  return {
    models: {
      list: () => bridge.invoke<WhisperModelInfo[]>("recorder_models_list"),
      get: () => bridge.invoke<WhisperModelId | null>("recorder_models_get"),
      select: (id) => bridge.invoke<void>("recorder_models_select", { id }),
      // The native command waits for the file to be on disk and rejects on failure, so its result is the outcome.
      // Progress events are for onProgress only; waiting for one here could hang if it never arrives.
      download: (id) => bridge.invoke<void>("recorder_models_download", { id }),
      onProgress,
    },
    systemAudio: {
      get: () => bridge.invoke<boolean>("recorder_system_audio_get"),
      set: (enabled) => bridge.invoke<void>("recorder_system_audio_set", { enabled }),
    },
    systemAudioConsent: {
      get: () => bridge.invoke<boolean>("recorder_system_audio_consent_get"),
      set: (consented) => bridge.invoke<void>("recorder_system_audio_consent_set", { consented }),
    },
  };
}
