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
  autoSaveToSpace: { get(): Promise<boolean>; set(on: boolean): Promise<void> };
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
