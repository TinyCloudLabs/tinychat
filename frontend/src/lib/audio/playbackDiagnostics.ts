// Playback diagnostics (TC-2857): an opt-in, on-device log of how a note's audio plays, for a user to export when
// playback sounds choppy. Off by default; turned on from the hidden section in Settings (tap the build line seven
// times). While it is off nothing is observed and nothing is recorded.
//
// Each entry has the wall time `t` (ms since epoch) and the monotonic time `m` (performance.now, ms), so entries from
// the web view and from the native audio session can be lined up. It records:
// - the iOS audio session (category, mode, options, route, sample rate, buffer and output latency), every route change
//   and interruption, thermal state and Low Power Mode (native `AudioDiagnostics` plugin; iOS only);
// - every <audio> event of a note player, with readyState, buffered ranges and playbackRate, and on each timeupdate the
//   media clock against the wall clock since playback (re)started;
// - the source the player was given (blob or file URL, and its size);
// - main-thread blocks of 100 ms or more while a note plays.
// No note content, transcript or file path is recorded.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export const PLAYBACK_DIAGNOSTICS_KEY = "xyz.tinycloud.home:playback-diagnostics";
const LOG_KEY = "xyz.tinycloud.home:playback-diagnostics-log";
export const PLAYBACK_DIAGNOSTICS_MAX_ENTRIES = 5000;
/** A main-thread block shorter than this is not logged. */
export const MAIN_THREAD_BLOCK_MS = 100;
const LAG_TICK_MS = 50;

export interface DiagnosticsEntry {
  t: number;
  m: number;
  kind: string;
  [field: string]: unknown;
}

interface AudioDiagnosticsNative {
  setEnabled(options: { enabled: boolean }): Promise<Record<string, unknown>>;
  snapshot(): Promise<Record<string, unknown>>;
  addListener(event: "event", listener: (event: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<AudioDiagnosticsNative>("AudioDiagnostics");

/** The parts of an <audio> element the player log reads. */
export type DiagnosedMedia = Pick<HTMLMediaElement,
  "currentTime" | "readyState" | "networkState" | "playbackRate" | "paused" | "buffered" | "error" | "duration"
  | "addEventListener" | "removeEventListener">;

let clock = () => ({ wall: Date.now(), mono: performance.now() });
let entries: DiagnosticsEntry[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let nativeListener: Promise<PluginListenerHandle> | null = null;
const listeners = new Set<() => void>();
/** The newest session snapshot and source, repeated in the export header in case the cap dropped them. */
const latest: Record<string, DiagnosticsEntry | undefined> = {};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function log(): DiagnosticsEntry[] {
  if (entries) return entries;
  try {
    const saved = JSON.parse(storage()?.getItem(LOG_KEY) ?? "[]") as unknown;
    entries = Array.isArray(saved) ? (saved as DiagnosticsEntry[]) : [];
  } catch {
    entries = [];
  }
  return entries;
}

function save() {
  persistTimer = undefined;
  try {
    storage()?.setItem(LOG_KEY, JSON.stringify(log()));
  } catch {
    // A full store keeps the log in memory; the export still has it.
  }
}

/** At most every 2 s while entries arrive (a debounce would never fire during playback's 4 Hz clock entries). */
function persist() {
  if (persistTimer === undefined) persistTimer = setTimeout(save, 2000);
}

export function playbackDiagnosticsEnabled(): boolean {
  try {
    return storage()?.getItem(PLAYBACK_DIAGNOSTICS_KEY) === "on";
  } catch {
    return false;
  }
}

/** Follows the entry count and the on/off state (for the Settings section). */
export function subscribePlaybackDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function playbackDiagnosticsCount(): number {
  return log().length;
}

function notify() {
  for (const listener of listeners) listener();
}

/** Appends an entry while diagnostics are on; a no-op otherwise. */
export function recordPlaybackDiagnostic(kind: string, data: Record<string, unknown> = {}): void {
  if (!playbackDiagnosticsEnabled()) return;
  const now = clock();
  const list = log();
  list.push({ t: now.wall, m: Math.round(now.mono * 10) / 10, kind, ...data });
  if (list.length > PLAYBACK_DIAGNOSTICS_MAX_ENTRIES) list.splice(0, list.length - PLAYBACK_DIAGNOSTICS_MAX_ENTRIES);
  if (kind === "audio_session" || kind === "source") latest[kind] = list.at(-1)!;
  persist();
  notify();
}

/** Visibility changes are logged (timers are throttled in the background) and the log is saved before the page hides. */
function onVisibility() {
  recordPlaybackDiagnostic("visibility", { state: document.visibilityState });
  if (document.visibilityState === "hidden") save();
}

function startNative() {
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  if (nativeListener) return;
  if (!Capacitor.isPluginAvailable("AudioDiagnostics")) {
    recordPlaybackDiagnostic("audio_session_unavailable", { platform: Capacitor.getPlatform() });
    return;
  }
  nativeListener = native.addListener("event", (event) => recordPlaybackDiagnostic("audio_session", event));
  native.setEnabled({ enabled: true }).then(
    (snapshot) => recordPlaybackDiagnostic("audio_session", { event: "snapshot", ...snapshot }),
    (error: unknown) => recordPlaybackDiagnostic("audio_session_error", { error: String(error) }),
  );
}

function stopNative() {
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  const handle = nativeListener;
  nativeListener = null;
  if (!handle) return;
  void handle.then((h) => h.remove()).catch(() => undefined);
  void native.setEnabled({ enabled: false }).catch(() => undefined);
}

export function setPlaybackDiagnosticsEnabled(on: boolean): void {
  if (on) {
    storage()?.setItem(PLAYBACK_DIAGNOSTICS_KEY, "on");
    recordPlaybackDiagnostic("diagnostics_on", { userAgent: globalThis.navigator?.userAgent ?? null });
    startNative();
  } else {
    recordPlaybackDiagnostic("diagnostics_off");
    storage()?.removeItem(PLAYBACK_DIAGNOSTICS_KEY);
    stopNative();
    clearInterval(lagTimer);
    lagTimer = undefined;
    playingCount = 0;
    save();
  }
  notify();
}

export function clearPlaybackDiagnostics(): void {
  entries = [];
  for (const key of Object.keys(latest)) delete latest[key];
  clearTimeout(persistTimer);
  persistTimer = undefined;
  storage()?.removeItem(LOG_KEY);
  notify();
}

/** One JSON object per line: a header, then every entry in order. */
export function playbackDiagnosticsText(header: Record<string, unknown> = {}): string {
  const list = log();
  return [JSON.stringify({ kind: "header", entries: list.length, exportedAt: clock().wall, ...header,
    latestAudioSession: latest.audio_session ?? null, latestSource: latest.source ?? null }),
    ...list.map((entry) => JSON.stringify(entry))].join("\n");
}

/** What the player was given, without its path: a blob (size and type), the phone's own file, or another URL. */
export function describeAudioSource(source: Blob | string | null): Record<string, unknown> {
  if (source === null) return { source: "none" };
  if (typeof source !== "string") return { source: "blob", bytes: source.size, type: source.type || null };
  const extension = /\.([a-z0-9]{1,5})(?:$|[?#])/i.exec(source)?.[1]?.toLowerCase() ?? null;
  if (source.includes("/_capacitor_file_/")) return { source: "local_file", extension };
  if (source.startsWith("blob:")) return { source: "blob_url" };
  return { source: "url", scheme: source.split(":", 1)[0], extension };
}

function bufferedRanges(media: DiagnosedMedia): number[][] {
  const ranges: number[][] = [];
  try {
    for (let i = 0; i < media.buffered.length; i++) {
      ranges.push([Math.round(media.buffered.start(i) * 1000) / 1000, Math.round(media.buffered.end(i) * 1000) / 1000]);
    }
  } catch {
    // An element without a source has no ranges.
  }
  return ranges;
}

const MEDIA_EVENTS = ["loadstart", "loadedmetadata", "durationchange", "canplay", "canplaythrough", "play", "playing",
  "pause", "waiting", "stalled", "suspend", "seeking", "seeked", "ratechange", "ended", "emptied", "error"] as const;

let playingCount = 0;
let lagTimer: ReturnType<typeof setInterval> | undefined;
let lastLagTick = 0;

function lagMonitor(playing: boolean) {
  playingCount = Math.max(0, playingCount + (playing ? 1 : -1));
  if (playingCount > 0 && lagTimer === undefined) {
    lastLagTick = clock().mono;
    lagTimer = setInterval(() => {
      const mono = clock().mono;
      const blocked = mono - lastLagTick - LAG_TICK_MS;
      lastLagTick = mono;
      // A hidden page's timers are throttled: that is not a block.
      if (blocked >= MAIN_THREAD_BLOCK_MS && globalThis.document?.visibilityState !== "hidden") {
        recordPlaybackDiagnostic("main_thread_block", { ms: Math.round(blocked) });
      }
    }, LAG_TICK_MS);
  } else if (playingCount === 0) {
    clearInterval(lagTimer);
    lagTimer = undefined;
  }
}

/**
 * Logs one note player's <audio> element while diagnostics are on; returns the stop. When they are off at mount,
 * nothing is attached (a player opened after turning them on is watched).
 */
export function watchPlaybackDiagnostics(media: DiagnosedMedia): () => void {
  if (!playbackDiagnosticsEnabled()) return () => {};
  startNative();
  let anchor: { mono: number; time: number; rate: number } | null = null;
  let playing = false;
  const setPlaying = (next: boolean) => {
    if (next === playing) return;
    playing = next;
    lagMonitor(next);
  };
  const state = () => ({
    currentTime: Math.round(media.currentTime * 1000) / 1000,
    readyState: media.readyState,
    networkState: media.networkState,
    playbackRate: media.playbackRate,
    paused: media.paused,
    duration: Number.isFinite(media.duration) ? Math.round(media.duration * 1000) / 1000 : null,
    buffered: bufferedRanges(media),
  });
  const onEvent = (event: Event) => {
    const type = event.type;
    if (!playbackDiagnosticsEnabled()) return;
    recordPlaybackDiagnostic("media", { event: type, ...state(), ...(type === "error" ? { error: media.error?.code ?? null } : {}) });
    if (type === "playing" || type === "seeked" || type === "ratechange") {
      anchor = media.paused ? null : { mono: clock().mono, time: media.currentTime, rate: media.playbackRate };
    }
    if (type === "playing") {
      setPlaying(true);
      if (nativeListener) void native.snapshot().then((s) => recordPlaybackDiagnostic("audio_session", { event: "on_playing", ...s }), () => undefined);
    }
    if (type === "pause" || type === "ended" || type === "emptied" || type === "error" || type === "waiting" || type === "seeking") {
      if (type !== "waiting" && type !== "seeking") setPlaying(false);
      anchor = null;
    }
  };
  /** The media clock against the wall clock since playback last (re)started: negative drift = audio fell behind. */
  const onTimeUpdate = () => {
    if (!anchor || !playbackDiagnosticsEnabled()) return;
    const elapsedMs = clock().mono - anchor.mono;
    const expected = anchor.time + (elapsedMs / 1000) * anchor.rate;
    recordPlaybackDiagnostic("clock", {
      currentTime: Math.round(media.currentTime * 1000) / 1000,
      sinceStartMs: Math.round(elapsedMs),
      driftMs: Math.round((media.currentTime - expected) * 1000),
      playbackRate: media.playbackRate,
      readyState: media.readyState,
      bufferedEnd: bufferedRanges(media).at(-1)?.[1] ?? null,
    });
  };
  for (const type of MEDIA_EVENTS) media.addEventListener(type, onEvent);
  media.addEventListener("timeupdate", onTimeUpdate);
  recordPlaybackDiagnostic("player_mounted", state());
  return () => {
    for (const type of MEDIA_EVENTS) media.removeEventListener(type, onEvent);
    media.removeEventListener("timeupdate", onTimeUpdate);
    setPlaying(false);
    recordPlaybackDiagnostic("player_unmounted");
  };
}

/** Tests only: a fixed clock and an empty in-memory log. */
export function __resetPlaybackDiagnosticsForTests(next?: () => { wall: number; mono: number }): void {
  clock = next ?? (() => ({ wall: Date.now(), mono: performance.now() }));
  entries = [];
  for (const key of Object.keys(latest)) delete latest[key];
  clearTimeout(persistTimer);
  persistTimer = undefined;
  clearInterval(lagTimer);
  lagTimer = undefined;
  playingCount = 0;
  nativeListener = null;
}
