import type { BatchResponse, TranscriptionEvent, TranscriptionParams } from "@/lib/anarlog/transcription.gen";
import type { WhisperModel } from "@/lib/localTranscriber";
import { leaseWhisperServer, SHARED_WHISPER_SERVER_SCOPE, type WhisperServerLease } from "@/lib/whisperServerLease";
import type { LocalTranscript, NoteSttState, VoiceNoteRecording } from "../nativeVoiceNotes";
import type { WebStore } from "../web/webStore";
import type { DesktopBridge } from "./desktopVoiceNotes";

const MODEL_IDS = new Set<WhisperModel>(["QuantizedTinyEn", "QuantizedTiny", "QuantizedBaseEn", "QuantizedBase",
  "QuantizedSmallEn", "QuantizedSmall", "QuantizedLargeTurbo"]);
type WhisperEvent = TranscriptionEvent;

/** The existing anarlog local-stt and batch-transcription commands, injectable for file-only tests. */
export interface DesktopWhisperBridge {
  serverScope?: object;
  startServer(model: WhisperModel): Promise<string>;
  stopServer(): Promise<void>;
  startTranscription(params: TranscriptionParams): Promise<void>;
  stopTranscription(id: string): Promise<void>;
  onTranscription(cb: (event: WhisperEvent) => void): Promise<() => void>;
}

export async function loadDesktopWhisperBridge(): Promise<DesktopWhisperBridge> {
  const [localStt, transcription] = await Promise.all([
    import("@/lib/anarlog/localStt.gen"), import("@/lib/anarlog/transcription.gen"),
  ]);
  const unwrap = <T>(result: { status: "ok"; data: T } | { status: "error"; error: string }): T => {
    if (result.status === "error") throw new Error(String(result.error));
    return result.data;
  };
  return {
    serverScope: SHARED_WHISPER_SERVER_SCOPE,
    startServer: async (model) => unwrap(await localStt.commands.startServer(model)),
    stopServer: async () => { unwrap(await localStt.commands.stopServer("internal")); },
    startTranscription: async (params) => { unwrap(await transcription.commands.startTranscription(params)); },
    stopTranscription: async (id) => { unwrap(await transcription.commands.stopTranscription(id)); },
    onTranscription: async (cb) => {
      const stop = await transcription.events.transcriptionEvent.listen(({ payload }) => cb(payload));
      return () => stop();
    },
  };
}

export type DesktopWhisperJob = { id: string; state: "queued" | "transcribing" | "done" | "failed";
  error: string | null; progress: number | null };

/** D7b can subscribe to per-note status and call retry(id) after a failure. */
export interface DesktopWhisperQueue {
  snapshot(): ReadonlyMap<string, DesktopWhisperJob>;
  subscribe(listener: () => void): () => void;
  onDone(listener: (id: string) => void): () => void;
  resume(): Promise<void>;
  noteCommitted(recording: VoiceNoteRecording): Promise<void>;
  retry(id: string): Promise<void>;
  modelAvailable(): Promise<void>;
  beforeCapture(): Promise<void>;
  captureEnded(): void;
  dispose(): void;
}

let registered: DesktopWhisperQueue | null = null;
export function getDesktopWhisperQueue(): DesktopWhisperQueue | null { return registered; }
export function registerDesktopWhisperQueue(queue: DesktopWhisperQueue | null): void { registered = queue; }

const stt = (state: NoteSttState["state"], error: string | null = null): NoteSttState => ({
  state, pack: null, engine: "whisper", segmentsDone: 0, windowsDone: 0, error,
});

function transcriptFromResponse(note: VoiceNoteRecording, model: WhisperModel, response: BatchResponse): LocalTranscript {
  const alternative = response.results.channels[0]?.alternatives[0];
  const words = alternative?.words ?? [];
  const text = alternative?.transcript.trim() || words.map((word) => word.punctuated_word ?? word.word).join(" ").trim();
  const segments = text ? [{ start: words.length ? Math.max(0, Math.round(words[0]!.start * 1000)) : 0,
    end: words.length ? Math.max(0, Math.round(words.at(-1)!.end * 1000)) : note.durationMs,
    text, speaker: null }] : [];
  return { version: 1, noteId: note.id, transcriber: "on-device", rev: 1, engine: "whispercpp", model, language: "en",
    outcome: segments.length ? "transcribed" : "no_speech", diarized: false, segments, createdAt: new Date().toISOString() };
}

async function stageId(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
  return `whisper-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createDesktopWhisperQueue(args: {
  store: WebStore; files: DesktopBridge; whisper: DesktopWhisperBridge;
  captureLive: () => boolean;
}): DesktopWhisperQueue {
  const { store, files, whisper, captureLive } = args;
  const jobs = new Map<string, DesktopWhisperJob>();
  const listeners = new Set<() => void>();
  const doneListeners = new Set<(id: string) => void>();
  let active: string | null = null;
  let activeRun: Promise<void> | null = null;
  let transcribing = false;
  let serverLease: WhisperServerLease | null = null;
  let disposed = false;
  let stopping = false;

  const publish = (id: string, state: DesktopWhisperJob["state"], error: string | null = null,
    progress: number | null = null) => {
    jobs.set(id, { id, state, error, progress });
    for (const listener of listeners) {
      try { listener(); } catch (caught) { console.error("[desktopWhisper] Status listener failed", caught); }
    }
  };
  const emitDone = (id: string) => {
    for (const listener of doneListeners) {
      try { listener(id); } catch (error) { console.error("[desktopWhisper] Completion listener failed", error); }
    }
  };
  const mark = async (id: string, state: NoteSttState["state"], error: string | null = null, progress = 0) => {
    await store.updateStt(id, stt(state, error));
    publish(id, state === "running" ? "transcribing" : state === "waiting_for_model" ? "failed"
      : state === "cancelled" ? "queued" : state, error,
      state === "running" ? progress : null);
  };
  const selectedModel = async (): Promise<WhisperModel> => {
    const id = await files.invoke<string | null>("recorder_models_get");
    if (!id || !MODEL_IDS.has(id as WhisperModel)) throw new Error("unavailable: select a downloaded Whisper model in Capture settings");
    const models = await files.invoke<{ id: string; downloaded: boolean }[]>("recorder_models_list");
    if (!models.some((row) => row.id === id && row.downloaded))
      throw new Error("unavailable: the selected Whisper model is not downloaded");
    return id as WhisperModel;
  };
  const audioPath = async (id: string, stagedId: string): Promise<string> => {
    return files.invoke<string>("recorder_whisper_stage_audio", { id, stageId: stagedId });
  };
  const one = async (note: VoiceNoteRecording): Promise<void> => {
    const id = note.id;
    let stagedId: string | null = null;
    try {
      if ((await store.getTranscript({ id })).transcript) {
        await mark(id, "done");
        emitDone(id);
        return;
      }
      const model = await selectedModel();
      await mark(id, "running");
      stagedId = await stageId(id);
      const path = await audioPath(id, stagedId);
      if (disposed || stopping || captureLive()) throw new Error("capture_has_priority");
      const lease = leaseWhisperServer(model, () => whisper.startServer(model), () => whisper.stopServer(),
        whisper.serverScope ?? whisper);
      serverLease = lease;
      const server = await lease.ready;
      if (disposed || stopping || captureLive()) throw new Error("capture_has_priority");
      const response = await new Promise<BatchResponse>((resolve, reject) => {
        let settled = false;
        let stop = () => {};
        let progressUpdates = Promise.resolve();
        const timeoutMs = Math.max(30 * 60_000, Math.ceil(note.durationMs * 6));
        const timer = setTimeout(() => {
          if (!settled) { settled = true; stop(); reject(new Error("Whisper transcription timed out")); }
        }, timeoutMs);
        const finish = (event: WhisperEvent) => {
          if (event.session_id !== id || settled) return;
          if (event.type === "progress") {
            if (event.event.type === "progress") {
              const progress = Math.round(event.event.percentage * 100);
              progressUpdates = progressUpdates.then(() => mark(id, "running", null, progress));
            }
            return;
          }
          if (event.type !== "completed" && event.type !== "failed" && event.type !== "stopped") return;
          settled = true; clearTimeout(timer); stop();
          void progressUpdates.then(() => {
            if (event.type === "completed") resolve(event.response);
            else reject(new Error(event.type === "failed" ? event.error : "capture_has_priority"));
          }).catch(reject);
        };
        void (async () => {
          try {
            stop = await whisper.onTranscription(finish);
            transcribing = true;
            await whisper.startTranscription({ session_id: id, provider: "whispercpp", file_path: path,
              model, base_url: server, api_key: "", languages: ["en"], keywords: [] });
          } catch (error) { if (!settled) { settled = true; clearTimeout(timer); stop(); reject(error); } }
        })();
      });
      if (disposed || stopping || captureLive()) throw new Error("capture_has_priority");
      await store.putTranscript({ id, transcript: transcriptFromResponse(note, model, response) });
      await mark(id, "done");
      emitDone(id);
    } catch (error) {
      if (disposed) return;
      if (stopping || captureLive() || String(error).includes("capture_has_priority")) await mark(id, "queued");
      else await mark(id, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      transcribing = false;
      serverLease?.release();
      serverLease = null;
      if (stagedId) {
        try { await files.invoke("delete_audio_file", { id: stagedId }); }
        catch (error) { console.warn("[desktopWhisper] Could not remove staged audio", error); }
      }
    }
  };
  const drain = async () => {
    if (disposed || activeRun || captureLive() || stopping) return;
    const notes = (await store.listPending()).recordings;
    const next = notes.find((note) => note.options?.transcriber === "on-device"
      && !["done", "failed", "cancelled"].includes(note.stt?.state ?? "queued"));
    if (!next) { serverLease?.release(); return; }
    active = next.id;
    activeRun = one(next).catch((error: unknown) => {
      console.error("[desktopWhisper] Could not update note status", error);
    }).finally(() => {
      active = null; activeRun = null;
      if (!disposed && !captureLive() && !stopping)
        void drain().catch((error: unknown) => console.error("[desktopWhisper] Could not drain queue", error));
    });
  };
  return {
    snapshot: () => new Map(jobs),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onDone(listener) {
      doneListeners.add(listener);
      queueMicrotask(() => {
        if (doneListeners.has(listener)) for (const job of jobs.values()) if (job.state === "done") {
          try { listener(job.id); } catch (error) { console.error("[desktopWhisper] Completion listener failed", error); }
        }
      });
      return () => { doneListeners.delete(listener); };
    },
    async resume() {
      const notes = (await store.listPending()).recordings;
      for (const note of notes) {
        if (note.options?.transcriber !== "on-device") continue;
        if (note.stt?.state === "running") {
          // The Rust task can outlive a WebView reload. Stop that instance before
          // replacing its staged path and starting the durable queued attempt.
          try { await whisper.stopTranscription(note.id); } catch { /* No native task survived. */ }
          await mark(note.id, "queued");
        }
        else publish(note.id, note.stt?.state === "done" ? "done" : note.stt?.state === "failed" ? "failed" : "queued",
          note.stt?.error ?? null);
      }
      // Native tasks from the previous renderer are stopped above. Sweep any
      // sealed or partial stage they left before a new attempt can start.
      await files.invoke("recorder_whisper_cleanup_stages");
      await drain();
    },
    async noteCommitted(note) {
      if (note.options?.transcriber !== "on-device") return;
      await mark(note.id, "queued");
      await drain();
    },
    async retry(id) {
      const note = (await store.listPending()).recordings.find((item) => item.id === id);
      if (!note || note.options?.transcriber !== "on-device") throw new Error("unavailable: this note is not a local transcription");
      if (active === id || note.stt?.state === "running") throw new Error("This note is already being transcribed");
      if (note.stt?.state !== "failed" && note.stt?.state !== "waiting_for_model")
        throw new Error("Only failed local transcriptions can be retried");
      await mark(id, "queued");
      await drain();
    },
    async beforeCapture() {
      stopping = true;
      serverLease?.release();
      if (active && transcribing) {
        try { void whisper.stopTranscription(active).catch(() => { /* A terminal event may already be in flight. */ }); }
        catch { /* A failed cancellation must never fail Record. */ }
      }
      // Neither model loading nor a late native terminal event may block Record.
    },
    async modelAvailable() {
      const notes = (await store.listPending()).recordings;
      for (const note of notes) {
        if (note.options?.transcriber === "on-device" && note.stt?.state === "failed"
          && note.stt.error?.startsWith("unavailable:") && note.stt.error.includes("model")) await mark(note.id, "queued");
      }
      await drain();
    },
    captureEnded() {
      stopping = false;
      void drain().catch((error: unknown) => console.error("[desktopWhisper] Could not drain queue", error));
    },
    dispose() {
      disposed = true;
      stopping = true;
      serverLease?.release();
      if (active && transcribing) {
        try { void whisper.stopTranscription(active).catch(() => {}); } catch { /* WebView teardown continues. */ }
      }
      listeners.clear(); doneListeners.clear();
    },
  };
}
