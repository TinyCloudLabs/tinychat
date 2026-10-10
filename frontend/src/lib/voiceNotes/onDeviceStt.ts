import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NoteSttState } from "./nativeVoiceNotes";

export type SttModelId = "parakeet-tdt-0.6b-v3-int8" | "parakeet-tdt-110m-en-int8" | "silero-vad" | "diarization";
export interface OnDeviceSttStatus {
  models: { id: SttModelId; state: "absent" | "queued" | "downloading" | "verifying" | "checking" | "ready" | "failed";
    bytes: number; totalBytes: number; error: string | null }[];
  pack: "full" | "small"; autoDownload: boolean;
  download: { policy: "wifi" | "cellular_approved"; state: "idle" | "running" | "waiting_for_network" | "low_data_mode" | "failed" };
  engine: "parakeet" | "apple-speech" | "none";
  appleSpeech: "unsupported" | "locale_unsupported" | "asset_missing" | "ready";
  queue: { id: string; state: NoteSttState["state"]; percent: number | null; error: string | null }[];
}
export interface OnDeviceSttPlugin {
  status(): Promise<OnDeviceSttStatus>;
  setAutoDownload(options: { enabled: boolean }): Promise<void>;
  downloadNow(options: { allowCellular: boolean }): Promise<void>;
  cancelDownload(): Promise<void>;
  deleteModels(): Promise<void>;
  enqueue(options: { id: string }): Promise<void>;
  cancel(options: { id: string }): Promise<void>;
  addListener(event: "status", listener: (status: OnDeviceSttStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: "progress", listener: (event: { id: string; percent: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "transcribed" | "failed", listener: (event: { id: string; outcome?: "transcribed" | "no_speech"; code?: string; message?: string }) => void): Promise<PluginListenerHandle>;
}

/** The model id this phone's RAM tier uses (plan §2.9: full ≥ 6 GB RAM, else small) — the same
 * mapping `ModelManifest.primaryModel`/`primaryModel(physicalMemoryBytes:)` use natively. */
function primaryModelId(status: OnDeviceSttStatus): SttModelId {
  return status.pack === "full" ? "parakeet-tdt-0.6b-v3-int8" : "parakeet-tdt-110m-en-int8";
}

/**
 * True only when native would actually transcribe a note on this phone right now: mirrors
 * `TranscriptionQueue.pump()`'s own gate exactly (Android `TranscriptionQueue.kt`, iOS
 * `TranscriptionQueue.swift`), both of which require `store.isReady(modelId)` for this device's
 * RAM-tier pack *and* `store.isReady(SILERO_VAD)` before a note ever leaves `waiting_for_model`.
 * Neither platform's decode path currently has a wired apple-speech branch (`engine` is only ever
 * `"parakeet"` or `"none"` today), but the check is included for when that path exists.
 */
export function isOnDeviceReady(status: OnDeviceSttStatus): boolean {
  if (status.engine === "apple-speech") return status.appleSpeech === "ready";
  if (status.engine !== "parakeet") return false;
  const primaryId = primaryModelId(status);
  const modelReady = status.models.find((model) => model.id === primaryId)?.state === "ready";
  const vadReady = status.models.find((model) => model.id === "silero-vad")?.state === "ready";
  return modelReady && vadReady;
}

export let OnDeviceStt = registerPlugin<OnDeviceSttPlugin>("OnDeviceStt");

export function __setOnDeviceSttForTests(plugin: OnDeviceSttPlugin): void {
  OnDeviceStt = plugin;
}
