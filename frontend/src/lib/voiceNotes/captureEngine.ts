import { Capacitor } from "@capacitor/core";
import { installVoiceNotesEngine, nativeVoiceNotesAvailable, VoiceNotes, MIN_ANDROID_SDK_FOR_FILE_UPLOAD, type VoiceNotesPlugin } from "./nativeVoiceNotes";

export type CaptureEngineKind = "native" | "web" | "tauri";

/** What an engine can do beyond the shared recording contract. A call a shell cannot take must not be made. */
export interface CaptureCapabilities {
  /** App shortcuts and notifications that start a recording: consumeShortcutRecord, dismissShortcutRecovery. */
  nativeShortcuts: boolean;
  /** The shell raises the recorder itself (the presentRecorder event). */
  presentRecorder: boolean;
  /** openSettings() reaches the OS or app settings. */
  openSettings: boolean;
  /** status().micDeniedPresentation: the shell holds mic-denied recovery state for the signed-out gate. */
  micDeniedPresentation: boolean;
  /** The recording keeps running when the app is not in front. */
  background: boolean;
  /** On-device speech to text (OnDeviceStt). */
  localTranscription: boolean;
  /** Desktop Whisper on a saved note, after capture stops. Separate from mobile OnDeviceStt. */
  desktopWhisper: boolean;
  /** The local-only home that records while offline or signed out. */
  offlineRecorder: boolean;
  /** The engine can stream its local recording to PTX without a webview copy. */
  nativeFileUpload: boolean;
}

export type CaptureEngine = VoiceNotesPlugin & { capabilities: CaptureCapabilities };
type RegisterableKind = Exclude<CaptureEngineKind, "native">;

const NATIVE_CAPABILITIES: CaptureCapabilities = {
  nativeShortcuts: true,
  presentRecorder: true,
  openSettings: true,
  micDeniedPresentation: true,
  background: true,
  localTranscription: true,
  desktopWhisper: false,
  offlineRecorder: true,
  nativeFileUpload: Capacitor.getPlatform() === "ios",
};

const NO_CAPABILITIES: CaptureCapabilities = {
  nativeShortcuts: false,
  presentRecorder: false,
  openSettings: false,
  micDeniedPresentation: false,
  background: false,
  localTranscription: false,
  desktopWhisper: false,
  offlineRecorder: false,
  nativeFileUpload: false,
};

const factories = new Map<RegisterableKind, () => Promise<CaptureEngine>>();
let installed: { kind: CaptureEngineKind; capabilities: CaptureCapabilities } | null = null;
let installing: Promise<void> | null = null;

/** The web and Tauri engines register themselves; nothing here imports them. */
export function registerCaptureEngine(kind: RegisterableKind, factory: () => Promise<CaptureEngine>): void {
  factories.set(kind, factory);
}

/** Native always; web and Tauri only in a shell that can record, with a registered engine. */
export function captureEngineKind(): CaptureEngineKind | null {
  if (installed) return installed.kind;
  if (nativeVoiceNotesAvailable()) return "native";
  // Inside the desktop app only the Tauri engine records; never fall back to the browser engine.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return factories.has("tauri") ? "tauri" : null;
  if (typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && navigator.mediaDevices && factories.has("web")) return "web";
  return null;
}

/** Whether this shell has a recorder; the gate resolves its capabilities before rendering. */
export function captureEngineAvailable(): boolean {
  return installed !== null || nativeVoiceNotesAvailable();
}

/** Every recording shell resolves its capabilities before rendering the recorder. */
export function captureEngineInstallPending(): boolean {
  const kind = captureEngineKind();
  return kind !== null && installed === null;
}

export function captureCapabilities(): CaptureCapabilities {
  if (installed) return installed.capabilities;
  return nativeVoiceNotesAvailable() ? NATIVE_CAPABILITIES : NO_CAPABILITIES;
}

const capabilityListeners = new Set<() => void>();

/** An engine changes a capability while installed (a Whisper model finished downloading, the selection moved). */
export function subscribeCaptureCapabilities(listener: () => void): () => void {
  capabilityListeners.add(listener);
  return () => { capabilityListeners.delete(listener); };
}

export function notifyCaptureCapabilitiesChanged(): void {
  for (const listener of [...capabilityListeners]) {
    try { listener(); } catch (error) { console.error("[captureEngine] A capability listener failed", error); }
  }
}

/** True when an installed engine has no on-device speech to text; OnDeviceStt must not be touched then. */
export function localTranscriptionUnavailable(): boolean {
  return installed !== null && !installed.capabilities.localTranscription;
}

/** A route can choose on-device when mobile STT or desktop Whisper is ready. */
export function onDeviceTranscriptionAvailable(): boolean {
  const capabilities = captureCapabilities();
  return capabilities.localTranscription || capabilities.desktopWhisper;
}

/** True when an installed engine cannot open settings (a browser); denied-mic recovery is site guidance then. */
export function openSettingsUnavailable(): boolean {
  return installed !== null && !installed.capabilities.openSettings;
}

/** Boot, before the RecorderProvider mounts. Installs once; a failed install rejects (and may be retried). */
export function installCaptureEngine(): Promise<void> {
  if (installed) return Promise.resolve();
  if (installing) return installing;
  const kind = captureEngineKind();
  if (kind === null) return Promise.resolve();
  if (kind === "native") {
    const attempt = (async () => {
      const platform = Capacitor.getPlatform();
      const capabilities = { ...NATIVE_CAPABILITIES, nativeFileUpload: platform === "ios" };
      if (platform === "android") {
        try {
          const status = await VoiceNotes.status();
          capabilities.nativeFileUpload = typeof status.androidSdkInt === "number"
            && status.androidSdkInt >= MIN_ANDROID_SDK_FOR_FILE_UPLOAD;
        } catch (error) {
          console.error("[captureEngine] Could not determine Android file upload availability", error);
        }
      }
      installed = { kind, capabilities };
    })();
    installing = attempt;
    void attempt.finally(() => { installing = null; });
    return attempt;
  }
  const factory = factories.get(kind);
  if (!factory) return Promise.reject(new Error(`No ${kind} capture engine is registered`));
  const attempt = factory().then((engine) => {
    installVoiceNotesEngine(engine);
    installed = { kind, capabilities: engine.capabilities };
  });
  installing = attempt;
  void attempt.then(
    () => { installing = null; },
    () => { installing = null; },
  );
  return attempt;
}

/** Harness and tests: stand in for an installed engine of this kind, with no factory. */
export function __setInstalledEngineForTests(kind: CaptureEngineKind, capabilities: CaptureCapabilities): void {
  installed = { kind, capabilities };
}

/** Tests only: forget registrations and the installed engine. */
export function __resetCaptureEngineForTests(): void {
  factories.clear();
  installed = null;
  installing = null;
}
