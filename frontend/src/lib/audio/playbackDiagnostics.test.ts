import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PLAYBACK_DIAGNOSTICS_KEY,
  PLAYBACK_DIAGNOSTICS_MAX_ENTRIES,
  __resetPlaybackDiagnosticsForTests,
  clearPlaybackDiagnostics,
  describeAudioSource,
  playbackDiagnosticsCount,
  playbackDiagnosticsEnabled,
  playbackDiagnosticsText,
  recordPlaybackDiagnostic,
  setPlaybackDiagnosticsEnabled,
  watchPlaybackDiagnostics,
  type DiagnosedMedia,
  type DiagnosticsEntry,
} from "./playbackDiagnostics";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

let mono = 0;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  mono = 1000;
  __resetPlaybackDiagnosticsForTests(() => ({ wall: 1_700_000_000_000 + mono, mono }));
});

afterEach(() => {
  __resetPlaybackDiagnosticsForTests();
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function fakeMedia() {
  const handlers = new Map<string, Set<(event: Event) => void>>();
  const media = {
    currentTime: 0, readyState: 4, networkState: 1, playbackRate: 1, paused: true, duration: 120, error: null,
    buffered: { length: 1, start: () => 0, end: () => 120 } as unknown as TimeRanges,
    addEventListener(type: string, handler: (event: Event) => void) {
      (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(handler);
    },
    removeEventListener(type: string, handler: (event: Event) => void) { handlers.get(type)?.delete(handler); },
    fire(type: string) { for (const handler of handlers.get(type) ?? []) handler({ type } as Event); },
    listenerCount() { return [...handlers.values()].reduce((sum, set) => sum + set.size, 0); },
  };
  return media as typeof media & DiagnosedMedia;
}

const entries = (): DiagnosticsEntry[] => playbackDiagnosticsText().split("\n").slice(1).map((line) => JSON.parse(line));

describe("playback diagnostics", () => {
  test("off by default: nothing is attached and nothing is recorded", () => {
    expect(playbackDiagnosticsEnabled()).toBe(false);
    const media = fakeMedia();
    const stop = watchPlaybackDiagnostics(media);
    expect(media.listenerCount()).toBe(0);
    recordPlaybackDiagnostic("source", { source: "blob" });
    expect(playbackDiagnosticsCount()).toBe(0);
    stop();
  });

  test("on: player events carry the element's state, and the switch is remembered", () => {
    setPlaybackDiagnosticsEnabled(true);
    expect(localStorage.getItem(PLAYBACK_DIAGNOSTICS_KEY)).toBe("on");
    const media = fakeMedia();
    const stop = watchPlaybackDiagnostics(media);
    media.paused = false;
    media.fire("waiting");
    const waiting = entries().find((entry) => entry.kind === "media" && entry.event === "waiting")!;
    expect(waiting).toMatchObject({ readyState: 4, playbackRate: 1, paused: false, buffered: [[0, 120]] });
    expect(typeof waiting.t).toBe("number");
    stop();
    expect(media.listenerCount()).toBe(0);
  });

  test("the media clock is compared with the wall clock since playback started", () => {
    setPlaybackDiagnosticsEnabled(true);
    const media = fakeMedia();
    watchPlaybackDiagnostics(media);
    media.paused = false;
    media.fire("playing");
    mono += 1000;
    media.currentTime = 1;
    media.fire("timeupdate");
    mono += 1000;
    media.currentTime = 1.4; // 600 ms of audio missing over this second
    media.fire("timeupdate");
    const clocks = entries().filter((entry) => entry.kind === "clock");
    expect(clocks.map((entry) => entry.driftMs)).toEqual([0, -600]);
    expect(clocks[1]).toMatchObject({ sinceStartMs: 2000, currentTime: 1.4 });
  });

  test("the log keeps the newest entries, exports one JSON object per line, and clears", () => {
    setPlaybackDiagnosticsEnabled(true);
    for (let i = 0; i < PLAYBACK_DIAGNOSTICS_MAX_ENTRIES + 10; i++) recordPlaybackDiagnostic("n", { i });
    expect(playbackDiagnosticsCount()).toBe(PLAYBACK_DIAGNOSTICS_MAX_ENTRIES);
    expect(entries().at(-1)).toMatchObject({ kind: "n", i: PLAYBACK_DIAGNOSTICS_MAX_ENTRIES + 9 });
    expect(JSON.parse(playbackDiagnosticsText({ build: "b" }).split("\n")[0]!)).toMatchObject({ kind: "header", build: "b" });
    clearPlaybackDiagnostics();
    expect(playbackDiagnosticsCount()).toBe(0);
  });

  test("turning it off stops recording", () => {
    setPlaybackDiagnosticsEnabled(true);
    setPlaybackDiagnosticsEnabled(false);
    const count = playbackDiagnosticsCount();
    recordPlaybackDiagnostic("late");
    expect(playbackDiagnosticsCount()).toBe(count);
    expect(localStorage.getItem(PLAYBACK_DIAGNOSTICS_KEY)).toBeNull();
  });

  test("a seek while playing is not logged as drift, and the export header keeps the latest source", () => {
    setPlaybackDiagnosticsEnabled(true);
    recordPlaybackDiagnostic("source", { source: "local_file" });
    const media = fakeMedia();
    watchPlaybackDiagnostics(media);
    media.paused = false;
    media.fire("playing");
    mono += 500;
    media.currentTime = 30;
    media.fire("seeking");
    media.fire("timeupdate");
    media.fire("seeked");
    mono += 1000;
    media.currentTime = 31;
    media.fire("timeupdate");
    expect(entries().filter((entry) => entry.kind === "clock").map((entry) => entry.driftMs)).toEqual([0]);
    for (let i = 0; i < PLAYBACK_DIAGNOSTICS_MAX_ENTRIES; i++) recordPlaybackDiagnostic("n");
    expect(JSON.parse(playbackDiagnosticsText().split("\n")[0]!).latestSource).toMatchObject({ kind: "source", source: "local_file" });
  });

  test("sources are described without their path", () => {
    expect(describeAudioSource(new Blob([new Uint8Array(3)], { type: "audio/mp4" }))).toEqual({ source: "blob", bytes: 3, type: "audio/mp4" });
    expect(describeAudioSource("capacitor://localhost/_capacitor_file_/var/mobile/x/voice-notes/abc.m4a"))
      .toEqual({ source: "local_file", extension: "m4a" });
    expect(describeAudioSource("blob:capacitor://localhost/1234")).toEqual({ source: "blob_url" });
    expect(describeAudioSource(null)).toEqual({ source: "none" });
  });
});
