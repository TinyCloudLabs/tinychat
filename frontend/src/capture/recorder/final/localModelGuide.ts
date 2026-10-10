import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import {
  onDeviceDownloadTotalBytes,
  primaryOnDeviceModel,
} from "@/lib/voiceNotes/onDeviceSttStore";
import { FINAL_COPY } from "./finalCopy";

export interface StopAction {
  label: string;
  run: () => void;
}

export interface OnDeviceDownload {
  start: () => void;
  /** Why the last attempt to start the download did not start. */
  error: string | null;
}

const mb = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

/**
 * What the Local row says while the on-device model is not ready: where the
 * download stands, and the control that moves it on. With no status there is
 * nothing to act on (a build without the plugin), so only the plain reason.
 */
export function localModelGuide(
  model: OnDeviceSttStatus | null,
  download: OnDeviceDownload | undefined,
): { reason: string; action?: StopAction } {
  if (!model || !download) return { reason: FINAL_COPY.modelUnavailable };
  const get = (label: string): StopAction => ({ label, run: download.start });
  if (download.error) {
    return { reason: download.error, action: get(FINAL_COPY.modelTryAgain) };
  }
  const needed = [primaryOnDeviceModel(model), model.models.find((m) => m.id === "silero-vad")].filter(
    (entry): entry is OnDeviceSttStatus["models"][number] => entry !== null && entry !== undefined,
  );
  const failed = needed.find((entry) => entry.state === "failed");
  if (failed || model.download.state === "failed") {
    const why = failed?.error ?? null;
    return {
      reason: why ? `Couldn't download the model: ${why}` : "Couldn't download the model",
      action: get(FINAL_COPY.modelTryAgain),
    };
  }
  const total = onDeviceDownloadTotalBytes(model);
  const size = total > 0 ? ` (${mb(total)} MB)` : "";
  if (model.download.state === "waiting_for_network") {
    return { reason: `Waiting for Wi-Fi to download the model${size}` };
  }
  if (model.download.state === "low_data_mode") {
    return { reason: `Paused: Low Data Mode is on${size}` };
  }
  const moving = needed.some((entry) => ["queued", "downloading", "verifying"].includes(entry.state));
  if (moving || model.download.state === "running") {
    const done = needed.reduce((sum, entry) => sum + entry.bytes, 0);
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    return { reason: percent === null ? `Downloading the model${size}` : `Downloading the model: ${percent}% of ${mb(total)} MB` };
  }
  return {
    reason: `The on-device model isn't downloaded${size}`,
    action: get(FINAL_COPY.modelUnavailable),
  };
}
