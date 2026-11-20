import type {
  CallNames,
  CallPrompt,
  DesktopCaptureExtras,
  DownloadProgress,
  WhisperModelId,
  WhisperModelInfo,
} from "../desktopCaptureExtras";
import type { DesktopBridge } from "./desktopVoiceNotes";

const PROGRESS_EVENT = "exo://recorder-model-progress";

/**
 * Tauri's own refusals of `command`: the native side does not have it, or does not let this window call it (the
 * wordings `ipc_selftest.rs` checks). A failure the command itself reports is not one of these.
 */
export function commandAbsent(command: string, error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text === `Command ${command} not found` || text === `${command} not allowed. Command not found`
    || text === `Command ${command} not allowed by ACL`
    || (text.includes(command) && (text.includes("not allowed. Permissions associated with this command:") || text.includes("explicitly denied")));
}

/** DesktopCaptureExtras bound to the recorder model, system audio, call names and call prompt commands. */
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

  // Names in the call. A build whose native side lacks these commands refuses the first call. From then on the
  // feature is absent for the session: `callNames` reads as undefined, so the setting stays hidden, recordings
  // save without names, and nothing asks (or warns) again.
  let callNamesAbsent = false;
  const callNamesInvoke = <T>(command: string, args?: Record<string, unknown>) =>
    bridge.invoke<T>(command, args).catch((error: unknown) => {
      if (!callNamesAbsent && commandAbsent(command, error)) {
        callNamesAbsent = true;
        console.info("[DesktopCaptureExtras] This build has no names in the call");
      }
      throw error;
    });
  // Who spoke when. A build with names in the call but without the speaking timeline refuses only this command: from
  // then on it answers null without asking, and the names stay.
  let speakingAbsent = false;
  const readSpeaking = async (id: string): Promise<unknown> => {
    if (speakingAbsent) return null;
    try {
      return await bridge.invoke<unknown>("call_names_speaking_read", { id });
    } catch (error) {
      if (!commandAbsent("call_names_speaking_read", error)) throw error;
      speakingAbsent = true;
      console.info("[DesktopCaptureExtras] This build has no speaking timeline");
      return null;
    }
  };
  const callNames: CallNames = {
    get: () => callNamesInvoke<unknown>("call_names_get"),
    set: (enabled) => callNamesInvoke<void>("call_names_set", { enabled }),
    openSettings: () => callNamesInvoke<void>("call_names_open_settings"),
    read: (id) => callNamesInvoke<unknown>("call_names_read", { id }),
    clear: (id) => callNamesInvoke<void>("call_names_clear", { id }),
    readSpeaking,
  };

  // The call prompt's setting, the same way: a build without its commands drops it for the session.
  let callPromptAbsent = false;
  const callPromptInvoke = <T>(command: string, args?: Record<string, unknown>) =>
    bridge.invoke<T>(command, args).catch((error: unknown) => {
      if (!callPromptAbsent && commandAbsent(command, error)) {
        callPromptAbsent = true;
        console.info("[DesktopCaptureExtras] This build has no call prompt");
      }
      throw error;
    });
  const callPrompt: CallPrompt = {
    get: () => callPromptInvoke<unknown>("call_prompt_get"),
    set: (enabled) => callPromptInvoke<void>("call_prompt_set", { enabled }),
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
    get callNames() {
      return callNamesAbsent ? undefined : callNames;
    },
    get callPrompt() {
      return callPromptAbsent ? undefined : callPrompt;
    },
  };
}
