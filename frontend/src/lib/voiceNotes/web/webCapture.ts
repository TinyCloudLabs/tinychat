// Microphone capture for the web engine: getUserMedia + MediaRecorder, with the
// level meter on the same stream.
//
// Container continuity. A MediaRecorder cannot outlive its tracks, and pausing
// must stop the tracks (the browser's mic indicator goes off). Recording straight
// from the mic would therefore need one MediaRecorder, and so one container, per
// segment: concatenated WebM/MP4 files are not one playable file. Instead the mic
// feeds a MediaStreamAudioDestinationNode and the ONE MediaRecorder records that
// node's stream. Pause flushes the recorder, pauses it and stops the mic tracks;
// resume re-acquires the same device and reconnects it to the node. The recorder
// never sees a track end, so every chunk belongs to one container: one playable file.
//
// Releasing the mic never waits on the recorder. The last slice is requested first, the
// tracks are stopped at once, and only then does pause wait (at most flushTimeoutMs) for
// that slice; a stalled recorder is reported through onFlushStalled, not hidden.

import { failure } from "./idb";
import { startLevelMeter, type LevelMeter, type LevelMeterEnv, type LevelSample } from "./webLevels";
import type { AudioInput } from "../nativeVoiceNotes";

export const TIMESLICE_MS = 1000;
export const FLUSH_TIMEOUT_MS = 2000;
export const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4"] as const;

export interface CaptureEnv {
  mediaDevices: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">;
  MediaRecorder: typeof MediaRecorder;
  AudioContext: typeof AudioContext;
  permissions: Pick<Permissions, "query"> | null;
  now(): number;
  levelEnv?: LevelMeterEnv;
  /** How long a pause waits for the recorder's last slice. Default FLUSH_TIMEOUT_MS. */
  flushTimeoutMs?: number;
}

export function browserCaptureEnv(): CaptureEnv {
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  const Context = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!mediaDevices?.getUserMedia || !Recorder || !Context) {
    throw failure("unsupported", "This browser cannot record audio.");
  }
  return { mediaDevices, MediaRecorder: Recorder, AudioContext: Context, permissions: navigator.permissions ?? null,
    now: () => Date.now() };
}

export function pickRecorderMimeType(Recorder: Pick<typeof MediaRecorder, "isTypeSupported">): string | null {
  return PREFERRED_MIME_TYPES.find((type) => Recorder.isTypeSupported(type)) ?? null;
}

export const UNSUPPORTED_FORMAT_MESSAGE = "This browser cannot record audio in a format Exo can save. Try Chrome, Edge, Firefox or Safari.";

export type InputLoss = { reason: "permission_revoked" | "mic_unavailable"; detail?: string };

export interface CaptureCallbacks {
  /** One recorder slice; `durationMs` is the recorded time since the previous slice (0 while paused). */
  onChunk(chunk: { blob: Blob; durationMs: number }): void;
  onLevel(sample: LevelSample): void;
  /** The mic tracks ended on their own (device unplugged, permission revoked). Capture is already held. */
  onInputLost(loss: InputLoss): void;
  onMute(muted: boolean): void;
  onRecorderError(error: unknown): void;
  /** The recorder did not deliver its last slice in time; the mic is already released and the capture held. */
  onFlushStalled(): void;
}

export interface WebCapture {
  readonly mimeType: string;
  /** Prompts for the mic if needed, then records. Rejects with the browser's DOMException. */
  start(deviceId: string | null): Promise<AudioInput>;
  /** Stops the mic tracks at once, then delivers the last slice to onChunk (bounded) and pauses the recorder. */
  pause(): Promise<void>;
  /** Re-acquires the mic (the device used so far unless `deviceId` says otherwise) and continues the same recording. */
  resume(deviceId?: string | null): Promise<AudioInput>;
  /** Moves the running recording to another device; the old one stays live if the new one cannot be opened. */
  switchInput(deviceId: string | null): Promise<AudioInput>;
  /** Flushes the last slice, then stops, closes the graph and resolves when the final slice was delivered. */
  stop(): Promise<void>;
  /** Tears everything down without delivering anything further. */
  abort(): void;
  readonly activeInput: AudioInput | null;
}

const kindOf = (label: string): AudioInput["kind"] =>
  /bluetooth|airpods|hands-?free/i.test(label) ? "bluetooth"
    : /usb/i.test(label) ? "usb"
    : /built-?in|internal|macbook|default/i.test(label) ? "built_in"
    : "other";

export function audioInputFromTrack(track: MediaStreamTrack): AudioInput {
  const settings = track.getSettings();
  return { id: settings.deviceId ?? "default", name: track.label || "Microphone", kind: kindOf(track.label) };
}

export function createWebCapture(env: CaptureEnv, callbacks: CaptureCallbacks): WebCapture {
  const mimeType = pickRecorderMimeType(env.MediaRecorder);
  if (!mimeType) throw failure("unsupported_format", UNSUPPORTED_FORMAT_MESSAGE);

  let context: AudioContext | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let analyser: AnalyserNode | null = null;
  let recorder: MediaRecorder | null = null;
  let meter: LevelMeter | null = null;
  let current: { stream: MediaStream; source: MediaStreamAudioSourceNode; input: AudioInput } | null = null;
  let boundary: number | null = null;
  let flushWaiter: (() => void) | null = null;
  let delivering = true;
  let deviceId: string | null = null;

  const releaseInput = () => {
    const input = current;
    current = null;
    if (!input) return;
    input.source.disconnect();
    for (const track of input.stream.getTracks()) {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
      track.stop();
    }
  };

  const classifyLoss = async (): Promise<InputLoss> => {
    if (env.permissions) {
      const status = await env.permissions.query({ name: "microphone" as PermissionName });
      if (status.state === "denied") return { reason: "permission_revoked" };
    }
    return { reason: "mic_unavailable" };
  };

  const connect = async (id: string | null): Promise<AudioInput> => {
    const stream = await env.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      throw failure("mic_unavailable", "The microphone returned no audio track.");
    }
    releaseInput();
    const source = context!.createMediaStreamSource(stream);
    source.connect(analyser!);
    source.connect(destination!);
    const input = audioInputFromTrack(track);
    const mine = { stream, source, input };
    track.onended = () => {
      if (current !== mine) return;
      void (async () => {
        const loss = await classifyLoss();
        if (current !== mine) return;
        await holdInput();
        callbacks.onInputLost(loss);
      })().catch((error: unknown) => callbacks.onRecorderError(error));
    };
    track.onmute = () => { if (current === mine) callbacks.onMute(true); };
    track.onunmute = () => { if (current === mine) callbacks.onMute(false); };
    current = mine;
    deviceId = input.id;
    return input;
  };

  /** Resolves true when the recorder delivered the requested slice, false when it did not within the bound. */
  const flush = () => new Promise<boolean>((resolve) => {
    if (!recorder || recorder.state !== "recording") return resolve(true);
    const timer = setTimeout(() => {
      if (flushWaiter === delivered) flushWaiter = null;
      resolve(false);
    }, env.flushTimeoutMs ?? FLUSH_TIMEOUT_MS);
    const delivered = () => { clearTimeout(timer); resolve(true); };
    flushWaiter = delivered;
    recorder.requestData();
  });

  const holdInput = async () => {
    meter?.stop();
    meter = null;
    callbacks.onLevel({ level: 0, peak: 0, active: false });
    const flushed = flush();
    releaseInput();
    if (!(await flushed)) callbacks.onFlushStalled();
    if (recorder?.state === "recording") recorder.pause();
    boundary = null;
  };

  const startMeter = () => {
    meter?.stop();
    meter = startLevelMeter(analyser!, (sample) => callbacks.onLevel(sample), env.levelEnv);
  };

  const teardown = () => {
    meter?.stop();
    meter = null;
    releaseInput();
    destination?.disconnect();
    void context?.close();
    context = destination = analyser = null;
  };

  return {
    mimeType,
    get activeInput() { return current?.input ?? null; },

    async start(id) {
      context = new env.AudioContext();
      destination = context.createMediaStreamDestination();
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      let input: AudioInput;
      try {
        input = await connect(id);
        if (context.state === "suspended") await context.resume();
      } catch (error) {
        teardown();
        throw error;
      }
      recorder = new env.MediaRecorder(destination.stream, { mimeType });
      recorder.ondataavailable = (event: BlobEvent) => {
        const at = env.now();
        const durationMs = boundary === null ? 0 : Math.max(0, at - boundary);
        if (boundary !== null) boundary = at;
        if (delivering && event.data.size > 0) callbacks.onChunk({ blob: event.data, durationMs });
        const waiter = flushWaiter;
        flushWaiter = null;
        waiter?.();
      };
      recorder.onerror = (event: Event) => callbacks.onRecorderError((event as ErrorEvent).error ?? event);
      recorder.start(TIMESLICE_MS);
      boundary = env.now();
      startMeter();
      return input;
    },

    async pause() {
      await holdInput();
    },

    async resume(id) {
      if (!recorder || !context) throw failure("not_recording");
      const input = await connect(id === undefined ? deviceId : id);
      if (context.state === "suspended") await context.resume();
      if (recorder.state === "paused") recorder.resume();
      boundary = env.now();
      startMeter();
      return input;
    },

    async switchInput(id) {
      if (!context) throw failure("not_recording");
      return connect(id);
    },

    async stop() {
      const active = recorder;
      meter?.stop();
      meter = null;
      if (active && active.state !== "inactive") {
        await new Promise<void>((resolve) => { active.onstop = () => resolve(); active.stop(); });
      }
      recorder = null;
      teardown();
    },

    abort() {
      delivering = false;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      recorder = null;
      teardown();
    },
  };
}
