import { describe, expect, test } from "bun:test";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks } from "../web/webStore";
import { openDesktopVoiceNotes, type DesktopBridge } from "./desktopVoiceNotes";

const HOUR = 60 * 60 * 1000;

/** The smallest native recorder the adapter needs to start, extend and discard a recording. */
class LimitBridge implements DesktopBridge {
  calls: { command: string; args: Record<string, unknown> }[] = [];
  current: string | null = null;
  limit = 3 * HOUR;
  now = 1_000_000;
  rejectSetMaxDuration: string | null = null;

  status() {
    return { state: this.current ? "recording" : "idle", reason: null, id: this.current, startedAt: this.current ? this.now : null,
      elapsedMs: 0, audioMs: 0, channels: 1, pausedMs: 0, maxDurationMs: this.limit, intent: this.current ? "recording" : "stopped",
      availability: "available", at: this.now, elapsedAt: this.now, spans: [] };
  }
  async listen<T>(_event: string, _callback: (payload: T) => void): Promise<() => void> { return () => {}; }
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ command, args });
    let result: unknown;
    switch (command) {
      case "recorder_models_get": result = null; break;
      case "recorder_models_list": result = []; break;
      case "recorder_recover": result = { journal: null, stopped: [], quarantined: [] }; break;
      case "recorder_stopped_list": result = []; break;
      case "recorder_failed_list": result = []; break;
      case "recorder_status": result = this.status(); break;
      case "recorder_list_inputs": result = { inputs: [{ id: "mic-1", name: "Fixture microphone", kind: "built_in" }],
        selectedId: null, activeId: "mic-1", selectedMissing: null }; break;
      case "recorder_start": this.current = String(args.id); this.limit = Number(args.maxDurationMs); result = this.status(); break;
      case "recorder_set_max_duration":
        if (this.rejectSetMaxDuration) throw this.rejectSetMaxDuration;
        this.limit = Number(args.maxDurationMs); result = this.status(); break;
      case "recorder_discard_durable":
        this.current = null; this.limit = 3 * HOUR;
        result = { result: "retired", status: this.status() }; break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    return result as T;
  }
  sent(command: string) { return this.calls.filter((call) => call.command === command).map((call) => call.args); }
}

function rig(bridge: LimitBridge) {
  return openDesktopVoiceNotes({ bridge, now: () => bridge.now, newId: () => "note-1",
    storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null, now: () => bridge.now } });
}

describe("desktop recorder adapter: the eight-hour safety cap and setMaxDuration", () => {
  test("start sends an 8 h request as is, clamps 9 h to 8 h, and defaults to 3 h", async () => {
    for (const [requested, sent] of [[8 * HOUR, 8 * HOUR], [9 * HOUR, 8 * HOUR], [undefined, 3 * HOUR], [5, 1000]] as const) {
      const bridge = new LimitBridge();
      const engine = await rig(bridge);
      const started = await engine.plugin.start(requested === undefined ? undefined : { maxDurationMs: requested });
      expect(started.maxDurationMs).toBe(sent);
      expect(bridge.sent("recorder_start")).toEqual([{ id: "note-1", maxDurationMs: sent }]);
      engine.dispose();
    }
  });

  test("setMaxDuration sends recorder_set_max_duration with the clamped value and resolves with the limit in force", async () => {
    const bridge = new LimitBridge();
    const engine = await rig(bridge);
    await engine.plugin.start();
    expect(await engine.plugin.setMaxDuration!({ maxDurationMs: 4 * HOUR })).toEqual({ maxDurationMs: 4 * HOUR });
    expect(await engine.plugin.setMaxDuration!({ maxDurationMs: 99 * HOUR })).toEqual({ maxDurationMs: 8 * HOUR });
    expect(await engine.plugin.setMaxDuration!({ maxDurationMs: 5 })).toEqual({ maxDurationMs: 1000 });
    expect(bridge.sent("recorder_set_max_duration")).toEqual([
      { maxDurationMs: 4 * HOUR }, { maxDurationMs: 8 * HOUR }, { maxDurationMs: 1000 },
    ]);
    expect(await engine.plugin.status()).toMatchObject({ maxDurationMs: 1000 });
    engine.dispose();
  });

  test("setMaxDuration while idle rejects no_recording without calling the recorder", async () => {
    const bridge = new LimitBridge();
    const engine = await rig(bridge);
    await expect(engine.plugin.setMaxDuration!({ maxDurationMs: 4 * HOUR })).rejects.toMatchObject({ code: "no_recording" });
    expect(bridge.sent("recorder_set_max_duration")).toEqual([]);
    engine.dispose();
  });

  test("a native rejection leaves the session's limit alone", async () => {
    const bridge = new LimitBridge();
    const engine = await rig(bridge);
    await engine.plugin.start({ maxDurationMs: 2 * HOUR });
    bridge.rejectSetMaxDuration = "recorder_busy";
    await expect(engine.plugin.setMaxDuration!({ maxDurationMs: 4 * HOUR })).rejects.toBe("recorder_busy");
    expect(await engine.plugin.status()).toMatchObject({ maxDurationMs: 2 * HOUR });
    engine.dispose();
  });
});
