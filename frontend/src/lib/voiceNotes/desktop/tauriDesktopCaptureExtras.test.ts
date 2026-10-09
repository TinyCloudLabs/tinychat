import { afterEach, describe, expect, test } from "bun:test";
import { getDesktopCaptureExtras, registerDesktopCaptureExtras, type DownloadProgress } from "../desktopCaptureExtras";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks } from "../web/webStore";
import { installDesktopEngine, type DesktopBridge } from "./desktopVoiceNotes";
import { createTauriDesktopCaptureExtras } from "./tauriDesktopCaptureExtras";

const EVENT = "exo://recorder-model-progress";
type Handler = (payload: never) => void;

class Bridge implements DesktopBridge {
  log: string[] = [];
  handlers = new Map<string, Set<Handler>>();
  replies = new Map<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>();
  async listen<T>(event: string, callback: (payload: T) => void) {
    this.log.push(`listen:${event}`);
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(callback as Handler);
    this.handlers.set(event, set);
    return () => {
      this.log.push(`unlisten:${event}`);
      set.delete(callback as Handler);
    };
  }
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    this.log.push(Object.keys(args).length ? `${command}:${JSON.stringify(args)}` : command);
    const reply = this.replies.get(command);
    if (!reply) throw new Error(`Unexpected command ${command}`);
    return (await reply(args)) as T;
  }
  emit(progress: DownloadProgress) {
    for (const handler of this.handlers.get(EVENT) ?? []) handler(progress as never);
  }
  listeners() {
    return this.handlers.get(EVENT)?.size ?? 0;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const pending = (promise: Promise<unknown>) => {
  const state = { settled: false, error: null as unknown };
  promise.then(
    () => { state.settled = true; },
    (error: unknown) => { state.settled = true; state.error = error; },
  );
  return state;
};

afterEach(() => registerDesktopCaptureExtras(null));

describe("Tauri DesktopCaptureExtras", () => {
  test("binds each call to its TC-880 command", async () => {
    const bridge = new Bridge();
    const rows = [{ id: "QuantizedLargeTurbo", label: "Whisper Large Turbo", sizeBytes: 874_000_000, downloaded: false,
      selected: false, downloading: true, progress: 0.4 }];
    bridge.replies.set("recorder_models_list", () => rows);
    bridge.replies.set("recorder_models_get", () => "QuantizedBase");
    bridge.replies.set("recorder_models_select", () => null);
    bridge.replies.set("recorder_system_audio_get", () => true);
    bridge.replies.set("recorder_system_audio_set", () => null);
    bridge.replies.set("recorder_auto_save_to_space_get", () => false);
    bridge.replies.set("recorder_auto_save_to_space_set", () => null);
    const { models, systemAudio, autoSaveToSpace } = createTauriDesktopCaptureExtras(bridge);

    expect(await models.list()).toEqual(rows);
    expect(await models.get()).toBe("QuantizedBase");
    await models.select("QuantizedBase");
    expect(await systemAudio.get()).toBe(true);
    await systemAudio.set(false);
    expect(await autoSaveToSpace.get()).toBe(false);
    await autoSaveToSpace.set(true);
    expect(bridge.log).toEqual([
      "recorder_models_list",
      "recorder_models_get",
      'recorder_models_select:{"id":"QuantizedBase"}',
      "recorder_system_audio_get",
      'recorder_system_audio_set:{"enabled":false}',
      "recorder_auto_save_to_space_get",
      'recorder_auto_save_to_space_set:{"enabled":true}',
    ]);
  });

  test("select rejects for a model that is not downloaded", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_select", () => { throw new Error("model_not_downloaded"); });
    const { models } = createTauriDesktopCaptureExtras(bridge);
    await expect(models.select("QuantizedSmall")).rejects.toThrow("model_not_downloaded");
  });

  test("a failed read rejects instead of answering with a default", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_system_audio_get", () => { throw new Error("settings_unreadable"); });
    const { systemAudio } = createTauriDesktopCaptureExtras(bridge);
    await expect(systemAudio.get()).rejects.toThrow("settings_unreadable");
  });

  test("download listens before it invokes and resolves only on the terminal done event", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => null);
    bridge.replies.set("recorder_models_progress", () => []);
    const { models } = createTauriDesktopCaptureExtras(bridge);
    const state = pending(models.download("QuantizedBase"));
    await tick();
    expect(bridge.log.slice(0, 2)).toEqual([`listen:${EVENT}`, 'recorder_models_download:{"id":"QuantizedBase"}']);
    // The command has returned, but no terminal event: still downloading.
    expect(state.settled).toBe(false);
    bridge.emit({ id: "QuantizedBase", fraction: 0.5, status: "downloading" });
    await tick();
    expect(state.settled).toBe(false);
    bridge.emit({ id: "QuantizedBase", fraction: 1, status: "done" });
    await tick();
    expect(state.settled).toBe(true);
    expect(state.error).toBeNull();
    expect(bridge.listeners()).toBe(0);
  });

  test("a terminal event for another model does not end the download", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => null);
    bridge.replies.set("recorder_models_progress", () => []);
    const { models } = createTauriDesktopCaptureExtras(bridge);
    const state = pending(models.download("QuantizedBase"));
    await tick();
    bridge.emit({ id: "QuantizedTiny", fraction: 1, status: "done" });
    await tick();
    expect(state.settled).toBe(false);
    bridge.emit({ id: "QuantizedBase", fraction: 1, status: "done" });
    await tick();
    expect(state.settled).toBe(true);
  });

  test("an error event rejects with its message", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => null);
    bridge.replies.set("recorder_models_progress", () => []);
    const { models } = createTauriDesktopCaptureExtras(bridge);
    const state = pending(models.download("QuantizedBase"));
    await tick();
    bridge.emit({ id: "QuantizedBase", fraction: 0.3, status: "error", error: "disk full" });
    await tick();
    expect(state.settled).toBe(true);
    expect(String(state.error)).toContain("disk full");
    expect(bridge.listeners()).toBe(0);
  });

  test("a rejected command rejects the download and stops listening", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => { throw new Error("unsupported_model"); });
    const { models } = createTauriDesktopCaptureExtras(bridge);
    await expect(models.download("QuantizedBase")).rejects.toThrow("unsupported_model");
    expect(bridge.listeners()).toBe(0);
  });

  test("a terminal event emitted before the command returns settles it without waiting again", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => {
      bridge.emit({ id: "QuantizedBase", fraction: 1, status: "done" });
      return null;
    });
    const { models } = createTauriDesktopCaptureExtras(bridge);
    await models.download("QuantizedBase");
    expect(bridge.log).not.toContain("recorder_models_progress");
  });

  test("a terminal result the event stream missed is read from the native snapshot", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => null);
    bridge.replies.set("recorder_models_progress", () => [
      { id: "QuantizedBase", fraction: 1, status: "done" },
    ]);
    const { models } = createTauriDesktopCaptureExtras(bridge);
    await models.download("QuantizedBase");

    bridge.replies.set("recorder_models_progress", () => [
      { id: "QuantizedBase", fraction: 0.2, status: "error", error: "model_download_cancelled" },
    ]);
    await expect(models.download("QuantizedBase")).rejects.toThrow("model_download_cancelled");
  });

  test("onProgress forwards every event and stops when removed, even before the listener attached", async () => {
    const bridge = new Bridge();
    const { models } = createTauriDesktopCaptureExtras(bridge);
    const seen: DownloadProgress[] = [];
    const stop = models.onProgress((progress) => seen.push(progress));
    await tick();
    bridge.emit({ id: "QuantizedTiny", fraction: 0.1, status: "downloading" });
    bridge.emit({ id: "QuantizedTiny", fraction: 1, status: "done" });
    expect(seen.map((progress) => progress.status)).toEqual(["downloading", "done"]);
    stop();
    expect(bridge.listeners()).toBe(0);

    const early = models.onProgress(() => undefined);
    early();
    await tick();
    expect(bridge.listeners()).toBe(0);
  });
});

describe("the Tauri engine registers the extras", () => {
  test("installing the engine registers them on the same bridge; none exist before", async () => {
    expect(getDesktopCaptureExtras()).toBeNull();
    const bridge = new Bridge();
    bridge.replies.set("recorder_status", () => ({
      state: "idle", reason: null, id: null, startedAt: null, elapsedMs: 0, audioMs: 0, pausedMs: 0,
      maxDurationMs: 10_000, intent: "stopped", availability: "available", at: 1, elapsedAt: 1, spans: [],
    }));
    bridge.replies.set("recorder_recover", () => ({ journal: null, quarantined: [] }));
    bridge.replies.set("recorder_failed_list", () => []);
    bridge.replies.set("recorder_models_get", () => "QuantizedLargeTurbo");
    await installDesktopEngine(bridge, {
      env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null,
    });
    const extras = getDesktopCaptureExtras();
    expect(extras).not.toBeNull();
    expect(await extras!.models.get()).toBe("QuantizedLargeTurbo");
  });
});
