import type {
  DesktopCaptureExtras,
  DownloadProgress,
  WhisperModelId,
  WhisperModelInfo,
} from "../desktopCaptureExtras";
import type { DesktopBridge } from "./desktopVoiceNotes";

const PROGRESS_EVENT = "exo://recorder-model-progress";

const isTerminal = (progress: DownloadProgress) => progress.status !== "downloading";

function failed(progress: DownloadProgress): Error {
  return new Error(progress.error ?? `The ${progress.id} download failed`);
}

/** DesktopCaptureExtras bound to TC-880's `recorder_models_*`, `recorder_system_audio_*` and `recorder_auto_save_to_space_*` commands. */
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
      async download(id) {
        // Subscribe before invoking: the terminal event can arrive before the command returns.
        let terminal: DownloadProgress | null = null;
        let settle: (() => void) | null = null;
        const ended = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const unlisten = await subscribe((progress) => {
          if (progress.id !== id || !isTerminal(progress)) return;
          terminal = progress;
          settle?.();
        });
        try {
          await bridge.invoke<void>("recorder_models_download", { id });
          if (!terminal) {
            // The command returns once the file is on disk; the event may still be in flight, or may have
            // been emitted before the listener attached. The native snapshot keeps the terminal entry.
            const snapshot = await bridge.invoke<DownloadProgress[]>("recorder_models_progress");
            terminal = snapshot.find((progress) => progress.id === id && isTerminal(progress)) ?? null;
          }
          if (!terminal) await ended;
          const result = terminal as DownloadProgress | null;
          if (!result) throw new Error(`The ${id} download ended without a result`);
          if (result.status === "error") throw failed(result);
        } finally {
          unlisten();
        }
      },
      onProgress,
    },
    systemAudio: {
      get: () => bridge.invoke<boolean>("recorder_system_audio_get"),
      set: (enabled) => bridge.invoke<void>("recorder_system_audio_set", { enabled }),
    },
    autoSaveToSpace: {
      get: () => bridge.invoke<boolean>("recorder_auto_save_to_space_get"),
      set: (enabled) => bridge.invoke<void>("recorder_auto_save_to_space_set", { enabled }),
    },
  };
}
