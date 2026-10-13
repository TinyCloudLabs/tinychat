import { isAppleSpeech, type OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
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

/** iOS has its speech built in: nothing to size or download, only assets the OS installs, or a phone or language it cannot do. */
function appleSpeechGuide(model: OnDeviceSttStatus, start: StopAction["run"]): { reason: string; action?: StopAction } {
  switch (model.appleSpeech) {
    case "ready": return { reason: "Ready" };
    case "unsupported": return { reason: FINAL_COPY.speechUnsupported };
    case "locale_unsupported": return { reason: FINAL_COPY.speechLocaleUnsupported };
    case "asset_missing":
      if (model.download.state === "failed") return { reason: FINAL_COPY.speechFailed, action: { label: FINAL_COPY.modelTryAgain, run: start } };
      if (model.download.state === "running") return { reason: FINAL_COPY.speechGetting };
      return { reason: FINAL_COPY.speechNotInstalled, action: { label: FINAL_COPY.speechGet, run: start } };
  }
}

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
    return { reason: "Couldn't download the on-device model", action: get(FINAL_COPY.modelTryAgain) };
  }
  if (isAppleSpeech(model)) return appleSpeechGuide(model, download.start);
  const needed = [primaryOnDeviceModel(model), model.models.find((m) => m.id === "silero-vad")].filter(
    (entry): entry is OnDeviceSttStatus["models"][number] => entry !== null && entry !== undefined,
  );
  const failed = needed.find((entry) => entry.state === "failed");
  if (failed || model.download.state === "failed") {
    return {
      reason: "Couldn't download the on-device model",
      action: get(FINAL_COPY.modelTryAgain),
    };
  }
  if (needed.some((entry) => entry.state === "checking")) {
    return { reason: "Checking the on-device model…" };
  }
  const total = onDeviceDownloadTotalBytes(model);
  const size = total > 0 ? ` (${mb(total)} MB)` : "";
  if (model.download.state === "waiting_for_network") {
    return { reason: `Waiting for Wi-Fi to download the on-device model${size}` };
  }
  if (model.download.state === "low_data_mode") {
    return { reason: `Paused: Low Data Mode is on${size}` };
  }
  const moving = needed.some((entry) => ["queued", "downloading", "verifying"].includes(entry.state));
  if (moving || model.download.state === "running") {
    const done = needed.reduce((sum, entry) => sum + entry.bytes, 0);
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    return { reason: percent === null ? `Downloading on-device model${size}` : `Downloading on-device model · ${percent}%` };
  }
  return {
    reason: `The on-device model isn't downloaded${size}`,
    action: get(FINAL_COPY.modelUnavailable),
  };
}

/** The short label the receipt and a saved note's transcript block put on the guide's first-download control. */
export function modelActionLabel(action: StopAction): string {
  return action.label === FINAL_COPY.modelUnavailable ? "Get model" : action.label;
}

/**
 * One sentence for a note waiting for the model: what transcribing it on this phone needs. The
 * download's size while nothing has started; otherwise the guide's own line (progress, failure, Wi-Fi).
 */
export function waitingForModelSentence(model: OnDeviceSttStatus | null, guide: { reason: string; action?: StopAction }): string {
  if (guide.action?.label !== FINAL_COPY.modelUnavailable) return guide.reason;
  const total = model ? onDeviceDownloadTotalBytes(model) : 0;
  return total > 0 ? `Transcribe on this phone — needs a ${mb(total)} MB download` : "Transcribe on this phone — needs the on-device model";
}
