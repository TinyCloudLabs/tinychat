import type { SessionStore } from "@tinyboilerplate/client";
import { logPipeline, logPipelineError } from "@/lib/debugLog";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  AssemblyAiError,
  assemblyAiSentences,
  createHostedAssemblyAiClient,
  pollAssemblyAiTranscript,
} from "../assemblyai";
import { base64ToBytes } from "./voiceNoteAudio";
import { currentAccountGeneration, isAccountWorkAllowed } from "./accountContext";
import { nativeRecordingSource, VoiceNotes, type LocalTranscript, type VoiceNoteRecording, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { readTranscriptCommit, requireVoiceNoteTranscriptCommit } from "./voiceNoteCommits";
import { createVoiceNoteRow, transcriptHash } from "./voiceNoteRows";
import { preserveVoiceNoteTranscriptHistory } from "./voiceNoteTranscriptHistory";
import {
  loadVoiceNoteAudio,
  patchVoiceNoteTranscriptionFailure,
  readVoiceNoteForTranscription,
  saveVoiceNoteTranscript,
  voiceNoteTitle,
} from "./voiceNoteStore";
import type { VoiceNoteTranscriptionStatus, NoteTranscriptionState } from "./voiceNoteTranscription";
import { withHostedUploadQueue } from "../hostedUploadQueue";
import type { CloudClock } from "../privateCloud";

const CONSENT = "exo.voiceNotes.powerfulConsent";
const PENDING = "exo.voiceNotes.powerfulJobs";
type Stored = { uploadId?: string; handle?: string; saved?: boolean; explicitRerun?: boolean; cleanupOnly?: boolean; recording?: VoiceNoteRecording };

function storage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function readJobs(did: string): Record<string, Stored> {
  try {
    const raw = storage()?.getItem(`${PENDING}:${did}`);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Stored> : {};
  } catch { return {}; }
}
function writeJobs(did: string, jobs: Record<string, Stored>): void {
  storage()?.setItem(`${PENDING}:${did}`, JSON.stringify(jobs));
}

/** One account's resumable Powerful lane. Audio parts always come from the local recording when it exists. */
export function createHostedVoiceNoteTrack(tcw: () => TinyCloudWeb, backendUrl: string, sessionStore: SessionStore, did: string,
  services: { client?: ReturnType<typeof createHostedAssemblyAiClient>; native?: VoiceNotesPlugin; clock?: CloudClock;
    readCommit?: typeof readTranscriptCommit; createRow?: typeof createVoiceNoteRow;
    save?: typeof saveVoiceNoteTranscript; readNote?: typeof readVoiceNoteForTranscription;
    loadAudio?: typeof loadVoiceNoteAudio; preserveHistory?: typeof preserveVoiceNoteTranscriptHistory } = {}) {
  const client = services.client ?? createHostedAssemblyAiClient({ backendUrl, sessionStore });
  const native = services.native ?? VoiceNotes;
  const readCommit = services.readCommit ?? readTranscriptCommit;
  const preserveHistory = services.preserveHistory ?? preserveVoiceNoteTranscriptHistory;
  const createRow = services.createRow ?? createVoiceNoteRow;
  const save = services.save ?? saveVoiceNoteTranscript;
  const readNote = services.readNote ?? readVoiceNoteForTranscription;
  const loadAudio = services.loadAudio ?? loadVoiceNoteAudio;
  const jobs = new Map<string, NoteTranscriptionState>();
  const listeners = new Set<() => void>();
  const active = new Set<string>();
  const notify = () => { for (const listener of listeners) listener(); };
  const consented = () => storage()?.getItem(`${CONSENT}:${did}`) === "1";
  const state = (id: string, status: VoiceNoteTranscriptionStatus) => {
    logPipeline(status.kind === "uploading" ? "transcription_audio_upload" : "transcription",
      id, status.kind === "uploading" && status.progress != null ? "progress" : status.kind,
      { engine: "assemblyai", ...(status.kind === "uploading" && status.progress != null
        ? { progressPct: Math.round(status.progress * 100) } : {}) });
    jobs.set(id, { kind: "active", status }); notify();
  };
  const persist = (id: string, patch: Stored | null) => {
    const all = readJobs(did);
    if (patch === null) delete all[id];
    else {
      all[id] = { ...all[id], ...patch };
      if (patch.cleanupOnly) delete all[id]!.explicitRerun;
    }
    writeJobs(did, all);
  };
  const check = async () => {
    const caps = await client.capabilities();
    return caps.hosted;
  };
  const run = async (recording: Pick<VoiceNoteRecording, "id" | "owner" | "source" | "options" | "startedAt" | "sizeBytes" | "mimeType" | "durationMs">
    & { ledger?: VoiceNoteRecording["ledger"] }, explicitRerun = false) => {
    const id = recording.id;
    if (active.has(id) || !consented() || (recording.owner && recording.owner !== did) || recording.source !== "in_app"
      || (!explicitRerun && recording.options?.transcriber !== "assemblyai")) return;
    active.add(id);
    logPipeline("transcription", id, "start", { engine: "assemblyai" });
    const generation = currentAccountGeneration();
    const guard = () => {
      const account = tcw();
      if (currentAccountGeneration() !== generation || account.did !== did || !isAccountWorkAllowed(account))
        throw new Error("The recording account changed. Retry after signing in.");
    };
    let transcriptSaved = false;
    let remoteHandle: string | undefined;
    try {
      guard();
      const account = tcw();
      const currentCommit = await readCommit(account, id);
      const prior = explicitRerun ? requireVoiceNoteTranscriptCommit(currentCommit) : currentCommit;
      const stored = explicitRerun ? {} : readJobs(did)[id] ?? {};
      if (prior && !explicitRerun) {
        transcriptSaved = true;
        if (stored.handle && stored.saved) {
          try { await client.deleteTranscript(stored.handle); persist(id, null); }
          catch (error) { console.warn("[HostedVoiceNotes] Could not delete the saved remote transcript", error); }
        }
        jobs.set(id, { kind: "done", outcome: prior.outcome }); notify(); return;
      }
      if (!prior) await createRow(account, recording as VoiceNoteRecording, voiceNoteTitle(recording.startedAt));
      if (explicitRerun) persist(id, null);
      if (!stored.recording) persist(id, { recording: recording as VoiceNoteRecording, ...(explicitRerun ? { explicitRerun: true } : {}) });
      let source = nativeRecordingSource(recording, native);
      if (!recording.sizeBytes) {
        const space = await loadAudio(account, id);
        if (!space.ok) throw new Error("Could not read this note's audio. Try again.");
        const bytes = base64ToBytes(space.data.base64);
        source = { mimeType: space.data.mimeType, size: bytes.length, readPart: async (offset, length) => bytes.slice(offset, offset + length) };
      }
      const handle = await withHostedUploadQueue(did, async () => {
        let handle = stored.handle;
        if (!handle) {
          const caps = await client.capabilities();
          if (!caps.hosted) throw new AssemblyAiError("failed", "Powerful isn't available right now. Try again later.");
          if (source.size > caps.max_bytes) throw new AssemblyAiError("rejected", "This recording is too large for Powerful (120 MB maximum).");
          const contentType = source.mimeType.split(";")[0].trim().toLowerCase();
          if (!caps.content_types.includes(contentType)) throw new AssemblyAiError("rejected", "Powerful cannot read this recording's format.");
          let uploadId = stored.uploadId;
          let submitting = false;
          if (uploadId) {
            try {
              const remote = await client.uploadState(uploadId);
              if (remote.status === "submitted" && remote.id) handle = remote.id;
              else if (remote.status === "submitting") submitting = true;
              else if (remote.status === "failed") { uploadId = undefined; persist(id, null); }
            } catch (error) {
              if (!(error instanceof AssemblyAiError && (error.kind === "not-found" || error.uploadEnded))) throw error;
              uploadId = undefined;
              persist(id, null);
            }
          }
          if (!handle) {
            if (!uploadId) {
              guard();
              const opId = crypto.randomUUID();
              await native.beginRemoteOp({ id, did, opId, provider: "assemblyai", mode: "hosted", kind: "hosted_create",
                fingerprint: `${source.size}:${source.mimeType}`, startedAt: Date.now() });
              const created = await client.createUpload(source.size, contentType);
              uploadId = created.uploadId;
              persist(id, { uploadId });
              await native.recordRemoteResult({ id, did, opId, result: { outcome: "created", uploadId } });
            }
            if (!submitting) {
              state(id, { kind: "uploading", progress: 0 });
              const partSize = Math.min(caps.part_size, 1024 * 1024);
              for (let offset = 0, index = 0; offset < source.size; offset += partSize, index++) {
                guard();
                const bytes = await source.readPart(offset, Math.min(partSize, source.size - offset));
                await client.putPart(uploadId, index, bytes);
                state(id, { kind: "uploading", progress: Math.min(1, (offset + bytes.length) / source.size) });
              }
              logPipeline("transcription_audio_upload", id, "done", { engine: "assemblyai", bodyBytes: source.size });
            }
            guard();
            const opId = crypto.randomUUID();
            await native.beginRemoteOp({ id, did, opId, provider: "assemblyai", mode: "hosted", kind: "hosted_submit",
              fingerprint: `${source.size}:${source.mimeType}`, startedAt: Date.now() });
            const submitted = await client.createTranscript(uploadId, { speakerLabels: recording.options?.identifySpeakers !== false,
              multichannel: (recording as VoiceNoteRecording & { layout?: string }).layout === "stereo" });
            handle = submitted.id;
            persist(id, { handle });
            await native.recordRemoteResult({ id, did, opId, result: { outcome: "created", jobId: handle } });
          }
        }
        return handle;
      });
      if (!handle) throw new Error("Powerful did not return a transcript. Try again.");
      remoteHandle = handle;
      persist(id, { handle });
      const transcript = await pollAssemblyAiTranscript(client, handle, {
        clock: services.clock,
        durationSeconds: recording.durationMs / 1000,
        guard,
        onStatus: (status) => {
          if (status === "queued") state(id, { kind: "queued", position: null });
          else if (status === "processing") state(id, { kind: "processing", completed: null, total: null });
        },
      });
      guard();
      const stereo = (recording as VoiceNoteRecording & { layout?: string }).layout === "stereo";
      const sentences = assemblyAiSentences(transcript, transcript.utterances?.length ? null : await client.getSentences(handle))
        .map((sentence) => stereo ? { ...sentence, speaker_name: sentence.speaker_name === "Speaker 1" ? "Me"
          : sentence.speaker_name === "Speaker 2" ? "Them" : sentence.speaker_name } : sentence);
      const local = recording.sizeBytes > 0 ? await native.getTranscript({ id }) : { transcript: null };
      const rev = Math.max(local.transcript?.rev ?? 0, prior?.rev ?? 0,
        explicitRerun ? recording.ledger?.transcriptSync.rev ?? 0 : 0) + 1;
      const at = new Date().toISOString();
      const outcome = sentences.length ? "transcribed" : "no_speech";
      const prepared: LocalTranscript = { version: 1, noteId: id, transcriber: "assemblyai", rev,
        engine: "assemblyai", model: transcript.speech_model_used ?? null, language: transcript.language_code ?? null,
        outcome, diarized: recording.options?.identifySpeakers !== false, createdAt: at,
        segments: sentences.map((s) => ({ start: Math.round(s.start_time * 1000), end: Math.round(s.end_time * 1000),
          text: s.text, speaker: s.speaker_name ?? null })) };
      state(id, { kind: "saving" });
      guard();
      if (explicitRerun && prior) await preserveHistory(account, prior);
      if (!explicitRerun && recording.sizeBytes > 0 && (!local.transcript || local.transcript.rev < rev))
        await native.putTranscript({ id, transcript: prepared });
      guard();
      const saved = await save(account, id, { rev, sentences,
        speakers: [...new Set(sentences.map((s) => s.speaker_name).filter((s): s is string => !!s))],
        metadata: { transcription_engine: "assemblyai", transcript_provider: "assemblyai", inference_provider: "assemblyai",
          assemblyai_account: "tinycloud", transcription_outcome: outcome, transcript_text: sentences.map((s) => s.text).join("\n") || null,
          speaker_labels: recording.options?.identifySpeakers !== false ? "diarized" : "single-speaker", transcribed_at: at,
          model: transcript.speech_model_used ?? null, language: transcript.language_code ?? null } }, { generation, did });
      if (!saved.ok) throw new Error("The transcript is ready, but could not be saved to your space. Try again.");
      if (explicitRerun) {
        const committed = await readCommit(account, id);
        if (committed?.rev !== rev || committed.hash !== await transcriptHash(sentences))
          throw new Error("A different transcript revision won this rerun. Try again.");
      }
      transcriptSaved = true;
      if (explicitRerun && recording.sizeBytes > 0 && (!local.transcript || local.transcript.rev < rev)) {
        try { await native.putTranscript({ id, transcript: prepared }); }
        catch (error) { console.warn("[HostedVoiceNotes] Could not mirror the saved transcript on-device", error); }
      }
      persist(id, { saved: true });
      try { await client.deleteTranscript(handle); persist(id, null); }
      catch (error) { console.warn("[HostedVoiceNotes] Could not delete the saved remote transcript", error); }
      jobs.set(id, { kind: "done", outcome });
      logPipeline("transcription", id, "done", { engine: "assemblyai" });
      notify();
    } catch (error) {
      logPipelineError("transcription", error, id);
      if (explicitRerun) {
        const cleanupHandle = remoteHandle ?? readJobs(did)[id]?.handle;
        if (cleanupHandle) {
          try { await client.deleteTranscript(cleanupHandle); persist(id, null); }
          catch (cleanupError) {
            console.warn("[HostedVoiceNotes] Could not delete the failed rerun's remote transcript", cleanupError);
            persist(id, { handle: cleanupHandle, cleanupOnly: true, recording: recording as VoiceNoteRecording });
          }
        } else persist(id, null);
      }
      const current = currentAccountGeneration() === generation && tcw().did === did && isAccountWorkAllowed(tcw());
      const clientForFailure = current ? tcw() : null;
      if (!transcriptSaved && clientForFailure && typeof clientForFailure.sql?.db === "function") {
        const code = error instanceof AssemblyAiError ? error.kind : "transcription_error";
        try { await patchVoiceNoteTranscriptionFailure(clientForFailure, id, code, guard); }
        catch (persistError) { console.warn("[HostedVoiceNotes] Could not persist transcription failure", persistError); }
      }
      if (transcriptSaved) {
        const commit = await readCommit(tcw(), id);
        if (commit) { jobs.set(id, { kind: "done", outcome: commit.outcome }); notify(); return; }
      }
      const message = error instanceof AssemblyAiError ? error.message
        : error instanceof Error && error.message.startsWith("The transcript is ready") ? error.message
        : "Powerful couldn't finish this transcript. Try again.";
      jobs.set(id, { kind: "failed", message, retryable: true, reference: null,
        code: error instanceof AssemblyAiError ? error.kind : "transcription_error" });
      notify();
    } finally { active.delete(id); }
  };
  return {
    check, run, jobs, consented,
    consent() { storage()?.setItem(`${CONSENT}:${did}`, "1"); notify(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async resume() {
      for (const [id, stored] of Object.entries(readJobs(did))) {
        if (stored.explicitRerun) {
          if (stored.handle) {
            try { await client.deleteTranscript(stored.handle); persist(id, null); }
            catch (error) {
              console.warn("[HostedVoiceNotes] Could not delete an interrupted rerun's remote transcript", error);
              persist(id, { handle: stored.handle, cleanupOnly: true });
            }
          } else persist(id, null);
          continue;
        }
        if (stored.cleanupOnly) {
          if (stored.handle) {
            try { await client.deleteTranscript(stored.handle); persist(id, null); }
            catch (error) { console.warn("[HostedVoiceNotes] Could not delete a failed rerun's remote transcript", error); }
          } else persist(id, null);
          continue;
        }
        const recording = (await native.listPending()).recordings.find((r) => r.id === id);
        if (recording ?? stored.recording) void run(recording ?? stored.recording!);
      }
    },
    async runSpaceOnly(id: string, explicitRerun = false) {
      const note = await readNote(tcw(), id);
      if (!note.ok || !note.data || (!explicitRerun && note.data.captureTranscriber !== "assemblyai")) return false;
      const recording = { id, owner: did, source: "in_app", startedAt: Date.now(), sizeBytes: 0,
        mimeType: "audio/mp4", durationMs: Math.round((note.data.durationSeconds ?? 0) * 1000),
        options: { transcriber: "assemblyai", identifySpeakers: true } } as VoiceNoteRecording;
      await run(recording, explicitRerun);
      return true;
    },
  };
}
