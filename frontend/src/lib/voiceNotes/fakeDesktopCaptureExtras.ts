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
  /** Sends a progress event, as the app's downloader would. */
  emitProgress(id: WhisperModelId, fraction: number): void;
  /** Ends an in-flight `download` successfully; the model is then on disk. */
  finishDownload(id: WhisperModelId): void;
  /** Ends an in-flight `download` with an error. */
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
  const downloads = new Map<
    WhisperModelId,
    { resolve(): void; reject(error: Error): void }
  >();

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
    const pending = downloads.get(id);
    if (!pending) throw new Error(`No download in flight for ${id}`);
    downloads.delete(id);
    return pending;
  };

  return {
    extras,
    calls,
    failNext: (call, message) => void failures.set(call, message),
    emitProgress: (id, fraction) => {
      for (const listener of [...listeners]) listener({ id, fraction });
    },
    finishDownload: (id) => {
      const pending = settle(id);
      downloaded.add(id);
      pending.resolve();
    },
    failDownload: (id, message) => settle(id).reject(new Error(message)),
  };
}
