import type { BatchResponse, TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import type { WhisperModel } from "@/lib/localTranscriber";
import { leaseWhisperServer, SHARED_WHISPER_SERVER_SCOPE, type WhisperServerLease } from "@/lib/whisperServerLease";
import type { NoteSttState, VoiceNoteRecording } from "../nativeVoiceNotes";
import type { WebStore } from "../web/webStore";
import type { DesktopBridge } from "./desktopVoiceNotes";
import { whisperLocalTranscript } from "./whisperTranscript";

const MODEL_IDS = new Set<WhisperModel>(["QuantizedTinyEn", "QuantizedTiny", "QuantizedBaseEn", "QuantizedBase",
  "QuantizedSmallEn", "QuantizedSmall", "QuantizedLargeTurbo"]);
type WhisperEvent = TranscriptionEvent;

/** Local STT commands and Exo's session-id-only recorder transcription command. */
export interface DesktopWhisperBridge {
  serverScope?: object;
  startServer(model: WhisperModel): Promise<string>;
  stopServer(): Promise<void>;
  startTranscription(params: { id: string; stageId: string; model: WhisperModel }): Promise<void>;
  stopTranscription(id: string): Promise<void>;
  onTranscription(cb: (event: WhisperEvent) => void): Promise<() => void>;
}

export async function loadDesktopWhisperBridge(): Promise<DesktopWhisperBridge> {
  const [localStt, transcription, { invoke }] = await Promise.all([
    import("@/lib/anarlog/localStt.gen"), import("@/lib/anarlog/transcription.gen"),
    import("@tauri-apps/api/core"),
  ]);
  const unwrap = <T>(result: { status: "ok"; data: T } | { status: "error"; error: string }): T => {
    if (result.status === "error") throw new Error(String(result.error));
    return result.data;
  };
  return {
    serverScope: SHARED_WHISPER_SERVER_SCOPE,
    startServer: async (model) => unwrap(await localStt.commands.startServer(model)),
    stopServer: async () => { unwrap(await localStt.commands.stopServer("internal")); },
    startTranscription: async (params) => { await invoke("recorder_whisper_start", params); },
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
let queueReads = 0;
export function getDesktopWhisperQueue(): DesktopWhisperQueue | null { queueReads += 1; return registered; }
/** How many times the queue has been looked up; tests prove the classic paths never do. */
export const __desktopWhisperQueueReadsForTests = () => queueReads;
export function registerDesktopWhisperQueue(queue: DesktopWhisperQueue | null): void { registered = queue; }

const stt = (state: NoteSttState["state"], error: string | null = null): NoteSttState => ({
  state, pack: null, engine: "whisper", segmentsDone: 0, windowsDone: 0, error,
});

const WHISPER_REJECTION_HELP: Record<string, string> = {
  unsafe_sessions_folder: "The sessions folder is unsafe. Check the vault sessions folder for unexpected entries before retrying.",
  session_exists: "A recording session already exists. Resolve the conflicting session before retrying.",
  recording_unavailable: "The recording audio is unavailable. Check that the note audio still exists, then retry.",
  recording_busy: "The recording is still being saved. Wait for it to finish, then retry.",
  server_unavailable: "The Whisper server is unavailable. Restart local transcription and retry.",
};

function whisperFailure(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const detail = typeof message === "string" ? message.trim() : "";
    if (typeof code === "string" && code) {
      const help = Object.hasOwn(WHISPER_REJECTION_HELP, code) ? WHISPER_REJECTION_HELP[code] : undefined;
      return help ? `${code}: ${help}${detail ? ` Details: ${detail}` : ""}`
        : `${code}: ${detail || "Whisper transcription failed"}`;
    }
    if (detail) return detail;
  }
  return "Whisper transcription failed";
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
  const stageAudio = async (id: string, stagedId: string): Promise<void> => {
    await files.invoke<void>("recorder_whisper_stage_audio", { id, stageId: stagedId });
  };
  const one = async (note: VoiceNoteRecording): Promise<void> => {
    const id = note.id;
    let stagedId: string | null = null;
    try {
      const existing = (await store.getTranscript({ id })).transcript;
      if (existing?.noteId === id && (existing.outcome === "no_speech" || existing.segments.some((segment) => segment.text.trim()))) {
        await mark(id, "done");
        emitDone(id);
        return;
      }
      const model = await selectedModel();
      await mark(id, "running");
      stagedId = await stageId(id);
      await stageAudio(id, stagedId);
      if (disposed || stopping || captureLive()) throw new Error("capture_has_priority");
      const lease = leaseWhisperServer(model, () => whisper.startServer(model), () => whisper.stopServer(),
        whisper.serverScope ?? whisper);
      serverLease = lease;
      await lease.ready;
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
            await whisper.startTranscription({ id, stageId: stagedId!, model });
          } catch (error) { if (!settled) { settled = true; clearTimeout(timer); stop(); reject(error); } }
        })();
      });
      if (disposed || stopping || captureLive()) throw new Error("capture_has_priority");
      const transcript = whisperLocalTranscript(note, model, response);
      await store.putTranscript({ id, transcript });
      const persisted = (await store.getTranscript({ id })).transcript;
      if (!persisted || persisted.noteId !== id || persisted.outcome !== transcript.outcome
        || persisted.rev !== transcript.rev || (persisted.outcome === "transcribed" && !persisted.segments.some((segment) => segment.text.trim()))) {
        throw new Error("The local transcript could not be verified after saving");
      }
      await mark(id, "done");
      emitDone(id);
    } catch (error) {
      if (disposed) return;
      const message = whisperFailure(error);
      if (stopping || captureLive() || message.includes("capture_has_priority")) await mark(id, "queued");
      else await mark(id, "failed", message);
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
        else if (note.stt?.state === "done") {
          const transcript = await store.getTranscript({ id: note.id }).then((result) => result.transcript, () => null);
          if (transcript?.noteId === note.id && (transcript.outcome === "no_speech" || transcript.segments.some((segment) => segment.text.trim())))
            publish(note.id, "done");
          else await mark(note.id, "failed", "The local transcript is missing. Retry transcription.");
        }
        else publish(note.id, note.stt?.state === "failed" ? "failed" : "queued",
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
