// A subscribable snapshot of `OnDeviceStt.status()` (useSyncExternalStore-friendly), the same
// pattern as `pendingStore` in recorderSaves.ts. Used by the recorder's transcription route
// control and by the Settings "Voice notes" card, so both show the same model state live.
import { localTranscriptionUnavailable } from "./captureEngine";
import { OnDeviceStt, type OnDeviceSttStatus } from "./onDeviceStt";

const EMPTY_STATUS: OnDeviceSttStatus = {
  models: [],
  pack: "full",
  autoDownload: false,
  download: { policy: "wifi", state: "idle" },
  engine: "none",
  appleSpeech: "unsupported",
  queue: [],
};

let snapshot: OnDeviceSttStatus = EMPTY_STATUS;
const listeners = new Set<() => void>();
let started = false;

function publish(status: OnDeviceSttStatus): void {
  snapshot = status;
  for (const listener of listeners) listener();
}

// An engine without on-device speech never reaches OnDeviceStt; the store stays on its empty snapshot.
function start(): void {
  if (started || localTranscriptionUnavailable()) return;
  started = true;
  // A harness or test that never swaps in a fake OnDeviceStt (it has no availability gate like
  // `nativeVoiceNotesAvailable()`) can throw synchronously from Capacitor's plugin proxy; this
  // view then just keeps showing the empty snapshot.
  try {
    OnDeviceStt.status().then(publish).catch((err: unknown) => console.warn("[OnDeviceStt] status() failed", err));
    OnDeviceStt.addListener("status", publish).catch((err: unknown) => console.warn("[OnDeviceStt] addListener failed", err));
  } catch (err) {
    console.warn("[OnDeviceStt] not available", err);
  }
}

export const onDeviceSttStore = {
  snapshot(): OnDeviceSttStatus {
    start();
    return snapshot;
  },
  subscribe(listener: () => void): () => void {
    start();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  refresh(): Promise<void> {
    if (localTranscriptionUnavailable()) return Promise.resolve();
    return OnDeviceStt.status().then(publish);
  },
};

/** The primary model this phone's RAM tier uses (plan §2.9: full ≥ 6 GB RAM, else small). */
export function primaryOnDeviceModel(status: OnDeviceSttStatus): OnDeviceSttStatus["models"][number] | null {
  const id = status.pack === "full" ? "parakeet-tdt-0.6b-v3-int8" : "parakeet-tdt-110m-en-int8";
  return status.models.find((model) => model.id === id) ?? null;
}

/** Bytes for the primary model plus Silero VAD (what "Download" actually fetches). */
export function onDeviceDownloadTotalBytes(status: OnDeviceSttStatus): number {
  const primary = primaryOnDeviceModel(status);
  const vad = status.models.find((model) => model.id === "silero-vad");
  return (primary?.totalBytes ?? 0) + (vad?.totalBytes ?? 0);
}

/** One line describing the primary model's state, for the recorder and Settings. */
export function onDeviceModelLine(status: OnDeviceSttStatus): { text: string; percent: number | null } {
  const primary = primaryOnDeviceModel(status);
  const totalMb = Math.round(onDeviceDownloadTotalBytes(status) / (1024 * 1024));
  if (!primary || primary.state === "absent") return { text: `Not downloaded (${totalMb} MB)`, percent: null };
  if (primary.state === "failed") return { text: primary.error ? `Couldn't download: ${primary.error}` : "Couldn't download the model", percent: null };
  if (primary.state === "ready") return { text: "Ready", percent: null };
  if (status.download.state === "waiting_for_network") return { text: "Waiting for Wi-Fi…", percent: null };
  const totalBytes = onDeviceDownloadTotalBytes(status);
  const percent = totalBytes > 0 ? Math.min(100, Math.round((primary.bytes / totalBytes) * 100)) : null;
  return { text: `Downloading… ${totalMb} MB`, percent };
}

/** Starts the model download (Wi-Fi only). The reason it could not start, or null once it has; the model's own failures arrive through the status. */
export async function downloadOnDeviceModel(): Promise<string | null> {
  try {
    await OnDeviceStt.downloadNow({ allowCellular: false });
    return null;
  } catch (caught) {
    console.error("[OnDeviceStt] downloadNow failed", caught);
    return `Could not start the download: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
}

/** Starts transcribing a note on this phone again. The reason it could not, or null. */
export async function retryOnDeviceNote(id: string): Promise<string | null> {
  try {
    await OnDeviceStt.enqueue({ id });
    return null;
  } catch (caught) {
    console.error("[OnDeviceStt] enqueue failed", id, caught);
    return `Could not retry: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
}
