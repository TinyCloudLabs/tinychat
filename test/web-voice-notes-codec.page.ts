// Page side of web-voice-notes-codec.e2e.test.ts: the real web engine (real MediaRecorder, real
// IndexedDB, real Web Locks, real decodeAudioData) behind a few functions the test calls.
import { base64ToBytes } from "../frontend/src/lib/voiceNotes/voiceNoteAudio";
import { createWebVoiceNotes } from "../frontend/src/lib/voiceNotes/web/webVoiceNotes";
import { openWebStore } from "../frontend/src/lib/voiceNotes/web/webStore";

const tracks: MediaStreamTrack[] = [];
const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
if (getUserMedia) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await getUserMedia(constraints);
    tracks.push(...stream.getTracks());
    return stream;
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function engineOn(dbName: string) {
  const store = await openWebStore({ dbName });
  const engine = createWebVoiceNotes({ store });
  return { store, engine, plugin: engine.plugin };
}

async function readNote(plugin: ReturnType<typeof createWebVoiceNotes>["plugin"], id: string): Promise<Uint8Array> {
  const parts: number[] = [];
  for (let offset = 0;;) {
    const chunk = await plugin.readAudioChunk({ id, offset, length: 1 << 20 });
    parts.push(...base64ToBytes(chunk.base64));
    offset += chunk.bytesRead;
    if (chunk.eof) return Uint8Array.from(parts);
  }
}

async function decode(bytes: Uint8Array): Promise<{ ok: true; durationMs: number } | { ok: false; error: string }> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(bytes.slice().buffer);
    return { ok: true, durationMs: Math.round(buffer.duration * 1000) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await context.close();
  }
}

function count(bytes: Uint8Array, pattern: number[]) {
  let found = 0;
  for (let i = 0; i + pattern.length <= bytes.length; i++) if (pattern.every((b, j) => bytes[i + j] === b)) found++;
  return found;
}

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const FTYP = [0x66, 0x74, 0x79, 0x70];

const api = {
  /** What this browser can do; the test skips what it cannot. */
  async probe() {
    const result = {
      mediaRecorder: typeof MediaRecorder !== "undefined",
      webm: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus"),
      mp4: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/mp4"),
      audioContext: typeof AudioContext !== "undefined",
      getUserMedia: "untried" as string,
    };
    try {
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        wait(5000).then(() => { throw new Error("getUserMedia did not answer within 5 s (no prompt can be answered here)"); }),
      ]);
      for (const track of stream.getTracks()) track.stop();
      result.getUserMedia = "ok";
    } catch (error) {
      result.getUserMedia = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    tracks.length = 0;
    return result;
  },

  liveTracks: () => tracks.filter((track) => track.readyState === "live").length,

  /** Record, pause, resume and stop through the real engine, then decode what was stored. */
  async recordPauseResume(dbName: string, segmentMs: number, pauseMs: number) {
    const { plugin } = await engineOn(dbName);
    await plugin.start();
    await wait(segmentMs);
    await plugin.pause();
    const liveWhilePaused = api.liveTracks();
    const pausedStatus = await plugin.status();
    await wait(pauseMs);
    await plugin.resume();
    await wait(segmentMs);
    const note = await plugin.stop();
    const bytes = await readNote(plugin, note.id);
    return {
      note: { mimeType: note.mimeType, sizeBytes: note.sizeBytes, durationMs: note.durationMs, pausedMs: note.pausedMs },
      storedBytes: bytes.length,
      ebmlHeaders: count(bytes, EBML),
      ftypBoxes: count(bytes, FTYP),
      liveWhilePaused,
      pausedState: pausedStatus.state,
      liveAfterStop: api.liveTracks(),
      decoded: await decode(bytes),
    };
  },

  /** Start recording and return once at least `audioMs` is durable; the test then kills this page. */
  async recordUntil(dbName: string, audioMs: number) {
    const { plugin } = await engineOn(dbName);
    const { id } = await plugin.start();
    for (let i = 0; i < 100; i++) {
      const status = await plugin.status();
      if (status.audioMs >= audioMs) return { id, audioMs: status.audioMs };
      await wait(100);
    }
    throw new Error("The recorder never reached the requested audio length.");
  },

  /** A session whose bytes are not media at all, as a corrupted disk would leave it. */
  async seedGarbage(dbName: string, mimeType: string) {
    const { store } = await engineOn(dbName);
    const id = crypto.randomUUID();
    await store.beginSession({
      id, startedAt: Date.now(), source: "in_app", owner: null, transitionGen: 0,
      options: { transcriber: "on-device", identifySpeakers: false }, mimeType, input: null, maxDurationMs: 60_000,
    });
    await store.appendChunk(id, crypto.getRandomValues(new Uint8Array(4096)), { audioMs: 1000, firstAudioAt: Date.now() });
    return { id };
  },

  /** Boot-time recovery in a fresh page; recovered prefixes are decoded here. */
  async recover(dbName: string) {
    const { engine, plugin, store } = await engineOn(dbName);
    const result = await engine.recoverInterrupted();
    const recovered = [];
    for (const note of result.recovered) {
      const bytes = await readNote(plugin, note.id);
      recovered.push({
        id: note.id, mimeType: note.mimeType, sizeBytes: note.sizeBytes, durationMs: note.durationMs,
        ebmlHeaders: count(bytes, EBML), ftypBoxes: count(bytes, FTYP), decoded: await decode(bytes),
      });
    }
    return { recovered, failed: result.failed, quarantine: (await store.listQuarantine()).items };
  },
};

export type CodecApi = typeof api;

(window as unknown as { codec: CodecApi }).codec = api;
