// A subscribable snapshot of `OnDeviceStt.status()` (useSyncExternalStore-friendly), the same
// pattern as `pendingStore` in recorderSaves.ts. Used by the recorder's transcription route
// control and by the Settings "Voice notes" card, so both show the same model state live.
import { localTranscriptionUnavailable } from "./captureEngine";
import { isOnDeviceReady, OnDeviceStt, type OnDeviceSttStatus } from "./onDeviceStt";

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
let downloadInFlight: Promise<string | null> | null = null;
let downloadError: string | null = null;
// Android moves between downloading and waiting for Wi-Fi without publishing a status, so a pending download is re-read.
let downloadPollMs = 2000;
let downloadPoll: ReturnType<typeof setInterval> | null = null;
let downloadGeneration = 0;
// Set once Local was chosen or recorded on: the download then follows the status until the model is ready.
let modelWanted = false;

export function __setDownloadPollMsForTests(ms: number): void {
  downloadPollMs = ms;
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function publish(status: OnDeviceSttStatus): void {
  snapshot = status;
  notifyListeners();
  if (isOnDeviceReady(status)) modelWanted = false;
  // A note already waiting for the model (queued before a relaunch, or recorded on Local mid-download) restarts the download.
  if (modelWanted || status.queue.some((job) => job.state === "waiting_for_model")) ensureOnDeviceModel();
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
  /** Why the last attempt to start or finish the download failed; null once a download is running or done. */
  downloadError(): string | null {
    return downloadError;
  },
};

export function __resetOnDeviceSttStoreForTests(): void {
  snapshot = EMPTY_STATUS;
  downloadInFlight = null;
  downloadError = null;
  downloadGeneration += 1;
  modelWanted = false;
  if (downloadPoll) clearInterval(downloadPoll);
  downloadPoll = null;
}

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
  if (primary.state === "checking") return { text: "Checking the downloaded model…", percent: null };
  if (status.download.state === "waiting_for_network") return { text: "Waiting for Wi-Fi…", percent: null };
  const totalBytes = onDeviceDownloadTotalBytes(status);
  const percent = totalBytes > 0 ? Math.min(100, Math.round((primary.bytes / totalBytes) * 100)) : null;
  return { text: `Downloading… ${totalMb} MB`, percent };
}

/**
 * Starts the model download (Wi-Fi only) and resolves when it ends: the reason it failed, or null once the model is
 * on the phone. A download already running in this process is joined, never started twice. The model's own states
 * arrive through the status.
 */
export function downloadOnDeviceModel(): Promise<string | null> {
  if (downloadInFlight) return downloadInFlight;
  downloadError = null;
  const poll = downloadPoll = setInterval(() => {
    onDeviceSttStore.refresh().catch((caught: unknown) => console.warn("[OnDeviceStt] status() failed while downloading", caught));
  }, downloadPollMs);
  const generation = downloadGeneration;
  const run = finishDownload().then((error) => {
    clearInterval(poll);
    if (generation !== downloadGeneration) return error;
    if (downloadPoll === poll) downloadPoll = null;
    downloadInFlight = null;
    downloadError = error;
    notifyListeners();
    return error;
  });
  downloadInFlight = run;
  notifyListeners();
  return run;
}

async function finishDownload(): Promise<string | null> {
  try {
    await OnDeviceStt.downloadNow({ allowCellular: false });
    await onDeviceSttStore.refresh();
  } catch (caught) {
    console.error("[OnDeviceStt] downloadNow failed", caught);
    await onDeviceSttStore.refresh().catch((refreshCaught: unknown) => console.warn("[OnDeviceStt] status() failed after a failed download", refreshCaught));
    return `Couldn't download the on-device model: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  if (isOnDeviceReady(snapshot)) return null;
  console.error("[OnDeviceStt] The download finished but the model is not ready", snapshot);
  return "Couldn't download the on-device model: it finished downloading but is not ready";
}

/**
 * Makes sure the on-device model is on its way, without anyone asking for a "Get model" step: a no-op once it is
 * ready or already moving. A download that failed is left showing its error (no silent retry loop) unless `retry`
 * says the user just asked again. Unknown status (not read yet) does nothing yet; the status that arrives tries again.
 * Only a Local choice, a recording on Local or a note waiting for the model may call this: a preference write that
 * merely keeps or restores Local is not a request.
 */
export function ensureOnDeviceModel({ retry = false }: { retry?: boolean } = {}): void {
  if (localTranscriptionUnavailable()) return;
  modelWanted = true;
  start();
  if (downloadInFlight) return;
  const status = snapshot;
  if (status.models.length === 0 || isOnDeviceReady(status)) return;
  const needed = [primaryOnDeviceModel(status), status.models.find((model) => model.id === "silero-vad")];
  if (needed.some((model) => model && ["queued", "downloading", "verifying", "checking"].includes(model.state))) return;
  if (["running", "waiting_for_network", "low_data_mode"].includes(status.download.state)) return;
  if (!retry && (downloadError !== null || status.download.state === "failed" || needed.some((model) => model?.state === "failed"))) return;
  void downloadOnDeviceModel();
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

/** Stops transcribing a note on this phone. The reason it could not, or null. */
export async function cancelOnDeviceNote(id: string): Promise<string | null> {
  try {
    await OnDeviceStt.cancel({ id });
    return null;
  } catch (caught) {
    console.error("[OnDeviceStt] cancel failed", id, caught);
    return `Could not stop the on-device transcription: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
}
