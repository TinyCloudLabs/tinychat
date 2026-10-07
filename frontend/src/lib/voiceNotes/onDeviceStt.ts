import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NoteSttState } from "./nativeVoiceNotes";

export type SttModelId = "parakeet-tdt-0.6b-v3-int8" | "parakeet-tdt-110m-en-int8" | "silero-vad" | "diarization";
export interface OnDeviceSttStatus {
  models: { id: SttModelId; state: "absent" | "queued" | "downloading" | "verifying" | "ready" | "failed";
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

export let OnDeviceStt = registerPlugin<OnDeviceSttPlugin>("OnDeviceStt");

export function __setOnDeviceSttForTests(plugin: OnDeviceSttPlugin): void {
  OnDeviceStt = plugin;
}
