import { afterEach, describe, expect, test } from "bun:test";
import { spyOn } from "bun:test";
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
    bridge.replies.set("recorder_system_audio_consent_get", () => false);
    bridge.replies.set("recorder_system_audio_consent_set", () => null);
    const { models, systemAudio, systemAudioConsent } = createTauriDesktopCaptureExtras(bridge);

    expect(await models.list()).toEqual(rows);
    expect(await models.get()).toBe("QuantizedBase");
    await models.select("QuantizedBase");
    expect(await systemAudio.get()).toBe(true);
    await systemAudio.set(false);
    expect(await systemAudioConsent.get()).toBe(false);
    await systemAudioConsent.set(true);
    expect(bridge.log).toEqual([
      "recorder_models_list",
      "recorder_models_get",
      'recorder_models_select:{"id":"QuantizedBase"}',
      "recorder_system_audio_get",
      'recorder_system_audio_set:{"enabled":false}',
      "recorder_system_audio_consent_get",
      'recorder_system_audio_consent_set:{"consented":true}',
    ]);
  });

  test("select rejects for a model that is not downloaded", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_select", () => { throw new Error("model_not_downloaded"); });
    const { models } = createTauriDesktopCaptureExtras(bridge);
    await expect(models.select("QuantizedSmall")).rejects.toThrow("model_not_downloaded");
  });

  test("binds names in the call to its five commands", async () => {
    const bridge = new Bridge();
    const people = { v: 1, source: "call_window", app: "zoom", truncated: false, people: [{ id: "p1", name: "Alex" }] };
    bridge.replies.set("call_names_get", () => ({ enabled: true, permission: "missing" }));
    bridge.replies.set("call_names_set", () => null);
    bridge.replies.set("call_names_open_settings", () => null);
    bridge.replies.set("call_names_read", ({ id }) => (id === "rec-1" ? people : null));
    bridge.replies.set("call_names_clear", () => null);
    const callNames = createTauriDesktopCaptureExtras(bridge).callNames!;

    expect(await callNames.get()).toEqual({ enabled: true, permission: "missing" });
    await callNames.set(true);
    await callNames.openSettings();
    expect(await callNames.read("rec-1")).toEqual(people);
    expect(await callNames.read("rec-2")).toBeNull();
    await callNames.clear("rec-1");
    expect(bridge.log).toEqual([
      "call_names_get",
      'call_names_set:{"enabled":true}',
      "call_names_open_settings",
      'call_names_read:{"id":"rec-1"}',
      'call_names_read:{"id":"rec-2"}',
      'call_names_clear:{"id":"rec-1"}',
    ]);
  });

  test("a native side without names in the call refuses once; from then on the feature is absent for the session", async () => {
    // Tauri's own wordings for a command the native side does not have, or does not let this window call.
    for (const refusal of ["Command call_names_get not found", "call_names_get not allowed. Command not found",
      "Command call_names_get not allowed by ACL", "call_names_get not allowed. Permissions associated with this command: none"]) {
      const bridge = new Bridge();
      bridge.replies.set("call_names_get", () => { throw refusal; });
      const extras = createTauriDesktopCaptureExtras(bridge);
      const info = spyOn(console, "info").mockImplementation(() => {});
      try {
        await expect(extras.callNames!.get()).rejects.toBe(refusal);
        expect(info).toHaveBeenCalledTimes(1);
      } finally { info.mockRestore(); }
      expect(extras.callNames).toBeUndefined();
      // The rest of the extras are as they were.
      bridge.replies.set("recorder_system_audio_get", () => true);
      expect(await extras.systemAudio.get()).toBe(true);
    }
  });

  test("a failure the command itself reports keeps the feature", async () => {
    const bridge = new Bridge();
    bridge.replies.set("call_names_read", () => { throw new Error("names file not found"); });
    bridge.replies.set("call_names_get", () => { throw "reader busy"; });
    const extras = createTauriDesktopCaptureExtras(bridge);
    await expect(extras.callNames!.read("rec-1")).rejects.toThrow("names file not found");
    await expect(extras.callNames!.get()).rejects.toBe("reader busy");
    expect(extras.callNames).toBeDefined();
  });

  test("a failed read rejects instead of answering with a default", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_system_audio_get", () => { throw new Error("settings_unreadable"); });
    const { systemAudio } = createTauriDesktopCaptureExtras(bridge);
    await expect(systemAudio.get()).rejects.toThrow("settings_unreadable");
  });

  test("download resolves when the native command resolves, with or without a terminal event", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => null);
    const { models } = createTauriDesktopCaptureExtras(bridge);
    // No event is ever delivered: the command's success already means the file is on disk.
    await models.download("QuantizedBase");
    expect(bridge.log).toEqual(['recorder_models_download:{"id":"QuantizedBase"}']);
    expect(bridge.listeners()).toBe(0);
  });

  test("a done event that arrives before the command returns neither blocks nor is overwritten by a snapshot", async () => {
    const bridge = new Bridge();
    let snapshotCalls = 0;
    bridge.replies.set("recorder_models_progress", () => {
      snapshotCalls += 1;
      return [{ id: "QuantizedBase", fraction: 0.4, status: "downloading" }];
    });
    bridge.replies.set("recorder_models_download", () => {
      bridge.emit({ id: "QuantizedBase", fraction: 1, status: "done" });
      return null;
    });
    const { models } = createTauriDesktopCaptureExtras(bridge);
    await models.download("QuantizedBase");
    expect(snapshotCalls).toBe(0);
  });

  test("a rejected command rejects the download with its error", async () => {
    const bridge = new Bridge();
    bridge.replies.set("recorder_models_download", () => { throw new Error("model_download_cancelled"); });
    const { models } = createTauriDesktopCaptureExtras(bridge);
    await expect(models.download("QuantizedBase")).rejects.toThrow("model_download_cancelled");
    expect(bridge.listeners()).toBe(0);
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
