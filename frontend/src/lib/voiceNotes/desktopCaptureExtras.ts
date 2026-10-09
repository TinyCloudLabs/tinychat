import type { WhisperModel } from "@/lib/localTranscriber";

export type WhisperModelId = WhisperModel;

export interface WhisperModelInfo {
  id: WhisperModelId;
  label: string;
  /** Decimal bytes, as the download size is quoted. */
  sizeBytes: number;
  downloaded: boolean;
  selected: boolean;
}

export interface DownloadProgress {
  id: WhisperModelId;
  /** 0 to 1. */
  fraction: number;
}

/** What the desktop app adds to a recording, behind the Capture ⚙︎ settings. TC-880 implements it. */
export interface DesktopCaptureExtras {
  models: {
    list(): Promise<WhisperModelInfo[]>;
    /** The model Local transcription uses, or null when none is chosen. */
    get(): Promise<WhisperModelId | null>;
    /** Rejects for a model that is not downloaded. */
    select(id: WhisperModelId): Promise<void>;
    /** Resolves once the model is on disk; rejects on failure. Progress arrives through `onProgress`. */
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
