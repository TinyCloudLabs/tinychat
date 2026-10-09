// A scripted DesktopCaptureExtras for tests and the harness. The app never registers it: it is for TC-880's
// absence, not a stand-in for it.
import { LOCAL_WHISPER_MODELS } from "@/lib/localTranscriber";
import type {
  DesktopCaptureExtras,
  DownloadProgress,
  WhisperModelId,
  WhisperModelInfo,
} from "./desktopCaptureExtras";

export interface FakeDesktopCaptureExtrasOptions {
  downloaded?: readonly WhisperModelId[];
  selected?: WhisperModelId | null;
  /** Downloads already in flight, started elsewhere, with their progress (null: no byte yet). */
  downloading?: Partial<Record<WhisperModelId, number | null>>;
  systemAudio?: boolean;
  autoSaveToSpace?: boolean;
}

export type FakeCall =
  | "models.list"
  | "models.get"
  | "models.select"
  | "models.download"
  | "systemAudio.get"
  | "systemAudio.set"
  | "autoSaveToSpace.get"
  | "autoSaveToSpace.set";

export interface FakeDesktopCaptureExtras {
  extras: DesktopCaptureExtras;
  /** Every call made, in order, as `name` or `name:argument`. */
  calls: string[];
  /** Makes the next call of that name reject with this message. */
  failNext(call: FakeCall, message: string): void;
  /** Starts a download that nothing here asked for (another window, the app itself): `list()` reports it. */
  startExternalDownload(id: WhisperModelId, fraction?: number | null): void;
  /** Sends a progress event, as the app's downloader would. */
  emitProgress(id: WhisperModelId, fraction: number): void;
  /** Ends an in-flight download successfully: the model is on disk, "done" is emitted, then `download` resolves. */
  finishDownload(id: WhisperModelId): void;
  /** Ends an in-flight download with an error: "error" is emitted, then `download` rejects. */
  failDownload(id: WhisperModelId, message: string): void;
}

export function createFakeDesktopCaptureExtras(
  options: FakeDesktopCaptureExtrasOptions = {},
): FakeDesktopCaptureExtras {
  const downloaded = new Set<WhisperModelId>(options.downloaded ?? []);
  let selected: WhisperModelId | null = options.selected ?? null;
  let systemAudio = options.systemAudio ?? false;
  let autoSaveToSpace = options.autoSaveToSpace ?? true;
  const calls: string[] = [];
  const failures = new Map<FakeCall, string>();
  const listeners = new Set<(progress: DownloadProgress) => void>();
  // In-flight downloads and their progress; `downloads` holds the promise of those `download()` started.
  const inFlight = new Map<WhisperModelId, number | null>(
    Object.entries(options.downloading ?? {}) as [
      WhisperModelId,
      number | null,
    ][],
  );
  const downloads = new Map<
    WhisperModelId,
    { resolve(): void; reject(error: Error): void }
  >();
  const emit = (progress: DownloadProgress) => {
    for (const listener of [...listeners]) listener(progress);
  };

  const enter = (call: FakeCall, argument?: string | boolean) => {
    calls.push(argument === undefined ? call : `${call}:${String(argument)}`);
    const message = failures.get(call);
    if (message === undefined) return;
    failures.delete(call);
    throw new Error(message);
  };

  const info = (): WhisperModelInfo[] =>
    LOCAL_WHISPER_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      sizeBytes: model.approxSizeMb * 1_000_000,
      downloaded: downloaded.has(model.id),
      selected: model.id === selected,
      downloading: inFlight.has(model.id),
      progress: inFlight.get(model.id) ?? null,
    }));

  const extras: DesktopCaptureExtras = {
    models: {
      async list() {
        enter("models.list");
        return info();
      },
      async get() {
        enter("models.get");
        return selected;
      },
      async select(id) {
        enter("models.select", id);
        if (!downloaded.has(id))
          throw new Error(`${id} is not downloaded`);
        selected = id;
      },
      download(id) {
        return new Promise<void>((resolve, reject) => {
          try {
            enter("models.download", id);
          } catch (caught) {
            reject(caught);
            return;
          }
          inFlight.set(id, null);
          downloads.set(id, { resolve, reject });
        });
      },
      onProgress(cb) {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    },
    systemAudio: {
      async get() {
        enter("systemAudio.get");
        return systemAudio;
      },
      async set(on) {
        enter("systemAudio.set", on);
        systemAudio = on;
      },
    },
    autoSaveToSpace: {
      async get() {
        enter("autoSaveToSpace.get");
        return autoSaveToSpace;
      },
      async set(on) {
        enter("autoSaveToSpace.set", on);
        autoSaveToSpace = on;
      },
    },
  };

  const settle = (id: WhisperModelId) => {
    if (!inFlight.has(id)) throw new Error(`No download in flight for ${id}`);
    const fraction = inFlight.get(id) ?? 0;
    inFlight.delete(id);
    const pending = downloads.get(id);
    downloads.delete(id);
    return { fraction, pending };
  };

  return {
    extras,
    calls,
    failNext: (call, message) => void failures.set(call, message),
    startExternalDownload: (id, fraction = null) => {
      if (inFlight.has(id)) throw new Error(`${id} is already downloading`);
      inFlight.set(id, fraction);
    },
    emitProgress: (id, fraction) => {
      if (!inFlight.has(id)) throw new Error(`No download in flight for ${id}`);
      inFlight.set(id, fraction);
      emit({ id, fraction, status: "downloading" });
    },
    finishDownload: (id) => {
      const { pending } = settle(id);
      downloaded.add(id);
      emit({ id, fraction: 1, status: "done" });
      pending?.resolve();
    },
    failDownload: (id, message) => {
      const { fraction, pending } = settle(id);
      emit({ id, fraction, status: "error", error: message });
      pending?.reject(new Error(message));
    },
  };
}
