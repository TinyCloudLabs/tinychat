import type { WhisperModel } from "@/lib/localTranscriber";

export type WhisperModelId = WhisperModel;

export interface WhisperModelInfo {
  id: WhisperModelId;
  label: string;
  /** Decimal bytes, as the download size is quoted. */
  sizeBytes: number;
  /** On disk and ready to select. */
  downloaded: boolean;
  selected: boolean;
  /** A download of this model is in flight right now, whoever started it. Never true together with `downloaded`. */
  downloading: boolean;
  /** 0 to 1 while `downloading`; null when it is not downloading, or the first byte has not arrived. */
  progress: number | null;
}

export type DownloadStatus = "downloading" | "done" | "error";

/**
 * One event per progress tick and one terminal event ("done" or "error") per download, for every model, including
 * downloads this popover did not start. A terminal event is the signal to re-read `models.list()`.
 */
export interface DownloadProgress {
  id: WhisperModelId;
  /** 0 to 1. */
  fraction: number;
  status: DownloadStatus;
  /** Why it failed; set with status "error". */
  error?: string;
}

/** What the desktop app adds to a recording, behind the Capture ⚙︎ settings. TC-880 implements it. */
export interface DesktopCaptureExtras {
  models: {
    list(): Promise<WhisperModelInfo[]>;
    /** The model Local transcription uses, or null when none is chosen. */
    get(): Promise<WhisperModelId | null>;
    /** Rejects for a model that is not downloaded. */
    select(id: WhisperModelId): Promise<void>;
    /**
     * Resolves only once the model is on disk (after its terminal "done" event) and rejects on "error". Progress
     * arrives through `onProgress`.
     *
     * TC-880: Tauri's `downloadModel` command resolves when the download task *starts*, not when it ends. Do not
     * return its promise from here: wait for the terminal `downloadProgressPayload` event (completed or failed),
     * emit the matching "done" / "error" `DownloadProgress`, and only then resolve or reject. `list()` must report
     * `downloading` / `progress` from `isModelDownloading` so a popover opened mid-download shows it.
     */
    download(id: WhisperModelId): Promise<void>;
    onProgress(cb: (progress: DownloadProgress) => void): () => void;
  };
  systemAudio: { get(): Promise<boolean>; set(on: boolean): Promise<void> };
  systemAudioConsent: { get(): Promise<boolean>; set(consented: boolean): Promise<void> };
  /**
   * Names in the call: reading the names of the people in a call from the meeting app's own window while a recording
   * of both sides runs. A setting of this Mac, off until the user turns it on. Absent where the app cannot do it,
   * and from the moment a build without it has refused a call: read the member each time, do not keep it.
   */
  callNames?: CallNames;
}

/** Whether macOS lets the app read other apps' windows (Accessibility); "unsupported" off macOS. */
export type CallNamesPermission = "granted" | "missing" | "unsupported";

export interface CallNamesState {
  enabled: boolean;
  permission: CallNamesPermission;
}

/** `answer` as the setting's state; null for anything but `{ enabled: boolean, permission: "granted" | "missing" | "unsupported" }`. */
export function readCallNamesState(answer: unknown): CallNamesState | null {
  if (answer === null || typeof answer !== "object") return null;
  const { enabled, permission } = answer as { enabled?: unknown; permission?: unknown };
  if (typeof enabled !== "boolean") return null;
  return permission === "granted" || permission === "missing" || permission === "unsupported" ? { enabled, permission } : null;
}

export interface CallNames {
  /** The setting as the app answers it: a `CallNamesState`, to be checked with `readCallNamesState` before use. */
  get(): Promise<unknown>;
  /** Turning it on also has macOS ask for the permission when it is missing. */
  set(enabled: boolean): Promise<void>;
  /** Opens Privacy & Security > Accessibility in System Settings. */
  openSettings(): Promise<void>;
  /**
   * The people read during the recording `id` (the recording's id, not its row's), as the app stored them: the
   * `call_participants` object, or null when there are none. Validate it before use.
   */
  read(id: string): Promise<unknown>;
  /** Forgets what was read during the recording `id`, once its row holds it. */
  clear(id: string): Promise<void>;
}

let registered: DesktopCaptureExtras | null = null;

/** The desktop app's implementation, or null where nothing has registered one (web, phone, a build without it). */
export function getDesktopCaptureExtras(): DesktopCaptureExtras | null {
  return registered;
}

export function registerDesktopCaptureExtras(
  extras: DesktopCaptureExtras | null,
): void {
  registered = extras;
}
