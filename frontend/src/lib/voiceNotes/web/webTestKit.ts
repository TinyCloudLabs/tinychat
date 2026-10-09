// Test doubles for the web engine: IndexedDB (testing/idb.ts), getUserMedia, MediaRecorder
// and AudioContext. Test-only; nothing imports this file outside *.test.ts.

import { newIdbEnv } from "./testing/idb";
import type { CaptureEnv } from "./webCapture";
import type { LevelMeterEnv } from "./webLevels";
import { createWebVoiceNotes, type WebVoiceNotes } from "./webVoiceNotes";
import { memoryLocks, openWebStore, type WebStore, type WebStoreOptions } from "./webStore";
import type { IdbEnv } from "./idb";
import type { AudioBlobStore } from "./audioBlobStore";

export class FakeClock {
  t = 1_000_000;
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

class FakeTrack {
  readyState: "live" | "ended" = "live";
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  constructor(readonly deviceId: string, readonly label: string) {}
  getSettings() { return { deviceId: this.deviceId }; }
  stop() { this.readyState = "ended"; }
  /** The OS ended the track (device unplugged, permission revoked). */
  endByOs() { this.readyState = "ended"; this.onended?.(); }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class FakeSource {
  connected = new Set<unknown>();
  constructor(readonly stream: FakeStream) {}
  connect(node: unknown) { this.connected.add(node); }
  disconnect() { this.connected.clear(); }
}

export class FakeMediaRecorder {
  static supported = new Set<string>(["audio/webm;codecs=opus", "audio/mp4"]);
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) { return FakeMediaRecorder.supported.has(type); }
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  timeslice: number | undefined;
  /** Bytes the encoder has produced but not delivered yet. */
  pending: number[] = [];
  /** What requestData() does: deliver at once, hold the slice until releaseRequestedData(), or never deliver it. */
  requestDataMode: "immediate" | "deferred" | "never" = "immediate";
  private parked = 0;
  constructor(readonly stream: unknown, options: { mimeType: string }) {
    this.mimeType = options.mimeType;
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number) { this.state = "recording"; this.timeslice = timeslice; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  requestData() {
    if (this.requestDataMode === "immediate") this.deliver();
    else if (this.requestDataMode === "deferred") this.parked++;
  }
  /** The browser finally fires the oldest dataavailable that requestData() asked for. */
  releaseRequestedData() {
    if (this.parked === 0) return;
    this.parked--;
    this.deliver();
  }
  stop() {
    this.deliver();
    this.state = "inactive";
    this.onstop?.();
  }
  /** Encoder output between slices. */
  encode(bytes: number[]) { if (this.state === "recording") this.pending.push(...bytes); }
  /** The timeslice timer fires. */
  deliver() {
    const data = new Blob([new Uint8Array(this.pending)]);
    this.pending = [];
    this.ondataavailable?.({ data });
  }
}

class FakeAnalyser {
  fftSize = 2048;
  samples = new Float32Array(1024);
  getFloatTimeDomainData(out: Float32Array) { out.set(this.samples.subarray(0, out.length)); }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "running" | "suspended" | "closed" = "running";
  sources: FakeSource[] = [];
  analyser = new FakeAnalyser();
  destination = { stream: new FakeStream([]), disconnect() {} };
  constructor() { FakeAudioContext.instances.push(this); }
  createMediaStreamSource(stream: FakeStream) { const source = new FakeSource(stream); this.sources.push(source); return source; }
  createMediaStreamDestination() { return this.destination; }
  createAnalyser() { return this.analyser; }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
}

export interface FakeMic {
  devices: { deviceId: string; label: string }[];
  /** getUserMedia calls, in order (constraints as given). */
  calls: unknown[];
  streams: FakeStream[];
  denied: boolean;
  /** Device ids that reject with NotFoundError. */
  missing: Set<string>;
  permissionState: "granted" | "denied" | "prompt";
  tracks(): FakeTrack[];
  liveTracks(): FakeTrack[];
}

export function createFakeEnv(clock: FakeClock): { env: CaptureEnv; mic: FakeMic; recorder(): FakeMediaRecorder; context(): FakeAudioContext;
  timers: { tick(): void; count(): number }; deviceChange(): void } {
  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  const mic: FakeMic = {
    devices: [{ deviceId: "default", label: "Default - Built-in Microphone" }, { deviceId: "usb-1", label: "USB Microphone" }],
    calls: [], streams: [], denied: false, missing: new Set(), permissionState: "granted",
    tracks: () => mic.streams.flatMap((s) => s.tracks),
    liveTracks: () => mic.tracks().filter((t) => t.readyState === "live"),
  };
  const deviceChangeListeners = new Set<() => void>();
  const intervals = new Map<number, () => void>();
  let nextTimer = 1;
  const levelEnv: LevelMeterEnv = {
    now: () => clock.now(),
    setInterval: (handler) => { const id = nextTimer++; intervals.set(id, handler); return id; },
    clearInterval: (handle) => { intervals.delete(handle as number); },
  };
  const env: CaptureEnv = {
    mediaDevices: {
      async getUserMedia(constraints?: MediaStreamConstraints) {
        mic.calls.push(constraints);
        if (mic.denied) throw new DOMException("denied", "NotAllowedError");
        const audio = constraints?.audio;
        const exact = typeof audio === "object" ? ((audio.deviceId as ConstrainDOMStringParameters | undefined)?.exact as string | undefined) : undefined;
        const id = exact ?? "default";
        if (mic.missing.has(id) || !mic.devices.some((d) => d.deviceId === id)) throw new DOMException("gone", exact ? "OverconstrainedError" : "NotFoundError");
        const device = mic.devices.find((d) => d.deviceId === id)!;
        const stream = new FakeStream([new FakeTrack(device.deviceId, device.label)]);
        mic.streams.push(stream);
        return stream as unknown as MediaStream;
      },
      async enumerateDevices() {
        return mic.devices.map((d) => ({ ...d, kind: "audioinput", groupId: "" }) as MediaDeviceInfo);
      },
      addEventListener: ((_: string, listener: () => void) => { deviceChangeListeners.add(listener); }) as MediaDevices["addEventListener"],
      removeEventListener: ((_: string, listener: () => void) => { deviceChangeListeners.delete(listener); }) as MediaDevices["removeEventListener"],
    } as CaptureEnv["mediaDevices"],
    MediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
    AudioContext: FakeAudioContext as unknown as typeof AudioContext,
    permissions: { async query() { return { state: mic.permissionState } as PermissionStatus; } },
    now: clock.now,
    levelEnv,
    flushTimeoutMs: 50,
  };
  return {
    env, mic,
    recorder: () => FakeMediaRecorder.instances.at(-1)!,
    context: () => FakeAudioContext.instances.at(-1)!,
    timers: { tick: () => { for (const handler of [...intervals.values()]) handler(); }, count: () => intervals.size },
    deviceChange: () => { for (const listener of [...deviceChangeListeners]) listener(); },
  };
}

export interface Rig {
  clock: FakeClock;
  idb: IdbEnv;
  locks: ReturnType<typeof memoryLocks>;
  fake: ReturnType<typeof createFakeEnv>;
  store: WebStore;
  engine: WebVoiceNotes;
  /** Encoder output followed by the timeslice firing; the chunk counts once its write commits. */
  chunk(bytes: number[], ms?: number): Promise<void>;
  settle(): Promise<void>;
  /** A new tab on the same database: its own store, engine and fake browser; every lock of the old tab is gone. */
  reopen(options?: RigOptions): Promise<Rig>;
}

export type RigOptions = Omit<Partial<WebStoreOptions>, "locks" | "env"> & { idb?: IdbEnv; clock?: FakeClock; locks?: ReturnType<typeof memoryLocks> };

export async function createRig(options: RigOptions = {}): Promise<Rig> {
  const clock = options.clock ?? new FakeClock();
  const idb = options.idb ?? newIdbEnv();
  const locks = options.locks ?? memoryLocks();
  const fake = createFakeEnv(clock);
  const { idb: _i, clock: _c, locks: _l, ...storeOptions } = options;
  const store = await openWebStore({ env: idb, locks, now: clock.now, decodeCheck: null, ...storeOptions });
  let counter = 0;
  const engine = createWebVoiceNotes({ store, captureEnv: () => fake.env, now: clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` });
  const rig: Rig = {
    clock, idb, locks, fake, store, engine,
    async chunk(bytes, ms = 1000) {
      fake.recorder().encode(bytes);
      clock.advance(ms);
      fake.recorder().deliver();
      await rig.settle();
    },
    async settle() { for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); },
    async reopen(next = {}) {
      locks.releaseAll();
      return createRig({ idb, clock, locks, ...next });
    },
  };
  return rig;
}

/**
 * A blob store that cannot join the journal's transaction (like the file-backed one TC-880 supplies).
 * Its bytes outlive any webStore on top of it, as files outlive a tab.
 */
export function memoryAudioBlobs() {
  const files = new Map<string, { chunks: Uint8Array[]; finalized: boolean }>();
  const sizeOf = (id: string) => (files.get(id)?.chunks ?? []).reduce((total, chunk) => total + chunk.byteLength, 0);
  const create = (): AudioBlobStore => ({
    async append(id, chunk) {
      const file = files.get(id) ?? { chunks: [], finalized: false };
      if (file.finalized) throw new Error(`Recording ${id} is sealed.`);
      file.chunks.push(chunk.slice());
      files.set(id, file);
      return sizeOf(id);
    },
    async size(id) { return sizeOf(id); },
    async read(id, offset, length) {
      const all = new Uint8Array(sizeOf(id));
      let at = 0;
      for (const chunk of files.get(id)?.chunks ?? []) { all.set(chunk, at); at += chunk.byteLength; }
      return all.slice(offset, Math.min(all.byteLength, offset + length));
    },
    async finalize(id) {
      const file = files.get(id) ?? { chunks: [], finalized: false };
      file.finalized = true;
      files.set(id, file);
      return sizeOf(id);
    },
    async delete(id) { files.delete(id); },
  });
  return { files, create, sizeOf };
}

/** Wraps bun:test's `test` with a timeout that survives a loaded machine; IndexedDB round-trips are slow there. */
export const SLOW_TEST_MS = 60_000;
export const slowTest = (register: (name: string, fn: () => Promise<void>, timeout: number) => void) =>
  (name: string, fn: () => unknown | Promise<unknown>, timeout = SLOW_TEST_MS) => register(name, fn as () => Promise<void>, timeout);
