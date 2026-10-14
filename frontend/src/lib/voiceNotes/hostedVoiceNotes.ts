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
import { readTranscriptCommit } from "./voiceNoteCommits";
import { createVoiceNoteRow } from "./voiceNoteRows";
import { loadVoiceNoteAudio, patchVoiceNoteTranscriptionFailure, readVoiceNoteForTranscription, saveVoiceNoteTranscript, voiceNoteTitle } from "./voiceNoteStore";
import type { VoiceNoteTranscriptionStatus, NoteTranscriptionState } from "./voiceNoteTranscription";
import { withHostedUploadQueue } from "../hostedUploadQueue";
import type { CloudClock } from "../privateCloud";

const CONSENT = "exo.voiceNotes.powerfulConsent";
const PENDING = "exo.voiceNotes.powerfulJobs";
const CLAIM_TAKEOVER_MS = 5 * 60_000;
type Stored = { uploadId?: string; handle?: string; saved?: boolean; recording?: VoiceNoteRecording };
type Claim = { version: 1; status: "active" | "failed" | "submitted"; token: string; claimedAt?: number; uploadId?: string; handle?: string };
const claimKey = (id: string) => `exo/voiceNotes/hostedJobs/${encodeURIComponent(id)}`;
const precondition = (error: { code?: string; message?: string }) => /PRECONDITION|412/i.test(`${error.code} ${error.message}`);

async function readClaim(account: TinyCloudWeb, id: string): Promise<{ claim: Claim; etag: string } | null> {
  const result = await account.kv.get(claimKey(id));
  if (!result.ok) {
    if (result.error.code === "KV_NOT_FOUND") return null;
    throw new Error(`Could not read the Powerful job claim: ${result.error.message}`);
  }
  const response = result.data as { data?: unknown; headers?: { etag?: string } };
  const raw = response?.data;
  const claim = typeof raw === "string" ? JSON.parse(raw) as Claim : raw as Claim;
  if (claim?.version !== 1 || !["active", "failed", "submitted"].includes(claim.status)
    || typeof claim.token !== "string" || typeof response?.headers?.etag !== "string")
    throw new Error("The Powerful job claim could not be verified.");
  if (claim.status === "submitted" && !claim.handle) throw new Error("The Powerful job claim has no transcript handle.");
  return { claim, etag: response.headers.etag };
}

async function writeClaim(account: TinyCloudWeb, id: string, claim: Claim, etag?: string): Promise<boolean> {
  const result = await account.kv.put(claimKey(id), JSON.stringify(claim),
    etag ? { ifMatch: etag, contentType: "application/json" } : { ifNoneMatch: "*", contentType: "application/json" });
  if (result.ok) return true;
  if (precondition(result.error)) return false;
  throw new Error(`Could not save the Powerful job claim: ${result.error.message}`);
}

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
    loadAudio?: typeof loadVoiceNoteAudio; reconciliationDelayMs?: number } = {}) {
  const client = services.client ?? createHostedAssemblyAiClient({ backendUrl, sessionStore });
  const native = services.native ?? VoiceNotes;
  const readCommit = services.readCommit ?? readTranscriptCommit;
  const createRow = services.createRow ?? createVoiceNoteRow;
  const save = services.save ?? saveVoiceNoteTranscript;
  const readNote = services.readNote ?? readVoiceNoteForTranscription;
  const loadAudio = services.loadAudio ?? loadVoiceNoteAudio;
  const jobs = new Map<string, NoteTranscriptionState>();
  const listeners = new Set<() => void>();
  const active = new Set<string>();
  const reconciliationChecks = new Map<string, ReturnType<typeof setTimeout>>();
  const notify = () => { for (const listener of listeners) listener(); };
  const watchReconciliation = (id: string, generation: number) => {
    if (reconciliationChecks.has(id)) return;
    const check = async () => {
      reconciliationChecks.delete(id);
      if (currentAccountGeneration() !== generation || tcw().did !== did) return;
      try {
        const job = await client.lookupJob(id);
        if (job.status === "submitted" && job.id) {
          jobs.set(id, { kind: "failed", message: "Exo reconciled the earlier attempt. Try again.", retryable: true, reference: null, code: "reconciled" });
          notify();
          return;
        }
      } catch { /* A read failure does not authorize another paid submission. */ }
      watchReconciliation(id, generation);
    };
    const timer = setTimeout(() => { void check(); }, services.reconciliationDelayMs ?? 30_000);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    reconciliationChecks.set(id, timer);
  };
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
    else all[id] = { ...all[id], ...patch };
    writeJobs(did, all);
  };
  const check = async () => {
    const caps = await client.capabilities();
    return caps.hosted;
  };
  /**
   * A hosted job's remote ops stay non-done until its transcript is durable, because their uploads read local
   * bytes (hasLocalWorkInProgress keeps the audio while any op is non-done). Call once the transcript is committed.
   * Best effort: a failure leaves the note pinned, which is safe; the next run that finds the commit retries it.
   */
  const markHostedRemoteDone = async (id: string): Promise<void> => {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const note = (await native.listPending()).recordings.find((candidate) => candidate.id === id);
        const remote = note?.ledger?.remote ?? [];
        if (!note || !remote.some((op) => op.mode === "hosted" && op.stage !== "done")) return;
        try {
          await native.updateLedger({ id, did, rev: note.rev ?? 0,
            patch: { remote: remote.map((op) => op.mode === "hosted" ? { ...op, stage: "done" as const } : op) } });
          return;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
          if (code !== "rev_conflict" || attempt >= 2) throw error;
        }
      }
    } catch (error) {
      console.warn("[HostedVoiceNotes] Could not mark the remote job done; its audio stays on this device", error);
    }
  };
  const run = async (recording: Pick<VoiceNoteRecording, "id" | "owner" | "source" | "options" | "startedAt" | "sizeBytes" | "mimeType" | "durationMs" | "channels">) => {
    const id = recording.id;
    if (active.has(id) || jobs.get(id)?.kind === "done" || !consented() || (recording.owner && recording.owner !== did) || recording.source !== "in_app" || recording.options?.transcriber !== "assemblyai") return;
    const pendingCheck = reconciliationChecks.get(id);
    if (pendingCheck) { clearTimeout(pendingCheck); reconciliationChecks.delete(id); }
    active.add(id);
    logPipeline("transcription", id, "start", { engine: "assemblyai" });
    const generation = currentAccountGeneration();
    const guard = () => {
      const account = tcw();
      if (currentAccountGeneration() !== generation || account.did !== did || !isAccountWorkAllowed(account))
        throw new Error("The recording account changed. Retry after signing in.");
    };
    let transcriptSaved = false;
    try {
      guard();
      const account = tcw();
      const stored = readJobs(did)[id] ?? {};
      // The durable commit is checked before any provider upload, including
      // a fresh trigger after an earlier job cleared its local resume entry.
      const prior = await readCommit(account, id);
      if (prior) transcriptSaved = true;
      if (prior && !stored.handle) { await markHostedRemoteDone(id); jobs.set(id, { kind: "done", outcome: prior.outcome }); notify(); return; }
      if (prior && stored.handle && stored.saved) {
        try { await client.deleteTranscript(stored.handle); persist(id, null); }
        catch (error) { console.warn("[HostedVoiceNotes] Could not delete the saved remote transcript", error); }
        await markHostedRemoteDone(id);
        jobs.set(id, { kind: "done", outcome: prior.outcome }); notify(); return;
      }
      if (!prior) await createRow(account, recording as VoiceNoteRecording, voiceNoteTitle(recording.startedAt));
      // The committed row's layout wins for space-only audio; a local recording knows its own.
      const noteRow = await readNote(account, id);
      const rowChannels = noteRow.ok && noteRow.data && (noteRow.data.channels === 1 || noteRow.data.channels === 2)
        ? noteRow.data.channels : undefined;
      const channels = recording.sizeBytes > 0 ? recording.channels ?? rowChannels ?? 1 : rowChannels ?? recording.channels ?? 1;
      if (!stored.recording) persist(id, { recording: recording as VoiceNoteRecording });
      // Eviction keeps sizeBytes while removing the file, so a positive size can't prove local bytes exist.
      // Read the file's current size and use the verified space copy whenever it doesn't match.
      const localSize = recording.sizeBytes > 0 ? (await native.localAudioSize({ id })).size : 0;
      let source = nativeRecordingSource(recording, native);
      if (!recording.sizeBytes || localSize !== recording.sizeBytes) {
        const space = await loadAudio(account, id);
        if (!space.ok) throw new Error("Could not read this note's audio. Try again.");
        const bytes = base64ToBytes(space.data.base64);
        source = { mimeType: space.data.mimeType, size: bytes.length, readPart: async (offset, length) => bytes.slice(offset, offset + length) };
      }
      const handle = await withHostedUploadQueue(did, async () => {
        guard();
        // Both the local resume entry and the space commit may have changed while
        // this invocation waited for the account's upload lane.
        const latest = readJobs(did)[id] ?? {};
        const committed = await readCommit(account, id);
        if (committed) {
          transcriptSaved = true;
          await markHostedRemoteDone(id);
          jobs.set(id, { kind: "done", outcome: committed.outcome }); notify();
          return null;
        }
        let existing = await readClaim(account, id);
        const token = crypto.randomUUID();
        let reconciled: Awaited<ReturnType<typeof client.lookupJob>> | null = null;
        const reconcile = async () => {
          const job = await client.lookupJob(id);
          if (job.status === "needs_reconciliation" || job.status === "unresolved")
            throw new AssemblyAiError("needs-reconciliation", "Powerful couldn't confirm an earlier attempt. Exo is checking with AssemblyAI.");
          if (job.status === "deleted")
            throw new AssemblyAiError("rejected", "This note's earlier transcript was deleted. Contact support before retrying.");
          reconciled = job;
          return job;
        };
        if (!existing) {
          if (!await writeClaim(account, id, { version: 1, status: "active", token, claimedAt: Date.now(),
            uploadId: latest.uploadId, handle: latest.handle })) existing = await readClaim(account, id);
        } else if (existing.claim.status === "failed" || (existing.claim.status === "active"
          && Date.now() - (existing.claim.claimedAt ?? 0) >= CLAIM_TAKEOVER_MS)) {
          const job = await reconcile();
          const next: Claim = { ...existing.claim, status: job.status === "submitted" ? "submitted" : "active",
            token, claimedAt: Date.now(), uploadId: job.upload_id ?? existing.claim.uploadId,
            handle: job.id ?? existing.claim.handle };
          if (await writeClaim(account, id, next, existing.etag))
            existing = { claim: next, etag: existing.etag };
          else existing = await readClaim(account, id);
        }
        // A live owner retains the claim until submission. A submitted handle is
        // safe to poll from any instance; no caller may submit it a second time.
        if (existing?.claim.status === "active" && existing.claim.token !== token) return null;
        if (existing?.claim.status === "failed") return null;
        let claim: Claim = existing?.claim ?? { version: 1, status: "active", token, claimedAt: Date.now(),
          uploadId: latest.uploadId, handle: latest.handle };
        let handle = claim.handle ?? latest.handle;
        if (existing?.claim.status === "submitted") return handle ?? null;
        const advance = async (patch: Partial<Claim>) => {
          const current = await readClaim(account, id);
          if (!current || current.claim.token !== token || !await writeClaim(account, id, { ...current.claim, ...patch }, current.etag))
            throw new Error("The Powerful job claim changed. Retry after the other job finishes.");
          claim = { ...current.claim, ...patch };
        };
        const heartbeat = setInterval(() => {
          if (claim.status !== "active") return;
          void (async () => {
            const current = await readClaim(account, id);
            if (current?.claim.token === token) await writeClaim(account, id, { ...current.claim, claimedAt: Date.now() }, current.etag);
          })().catch((error) => console.warn("[HostedVoiceNotes] Could not renew job claim", error));
        }, 60_000);
        try {
          if (handle && claim.status !== "submitted") await advance({ handle, status: "submitted" });
          if (!handle) {
            const caps = await client.capabilities();
            if (!caps.hosted) throw new AssemblyAiError("failed", "Powerful isn't available right now. Try again later.");
            if (source.size > caps.max_bytes) throw new AssemblyAiError("rejected", "This recording is too large for Powerful (120 MB maximum).");
            const contentType = source.mimeType.split(";")[0].trim().toLowerCase();
            if (!caps.content_types.includes(contentType)) throw new AssemblyAiError("rejected", "Powerful cannot read this recording's format.");
            const remoteJob = reconciled ?? await reconcile();
            let uploadId = remoteJob.upload_id ?? claim.uploadId ?? latest.uploadId;
            let submitting = false;
            if (remoteJob.status === "submitted" && remoteJob.id) {
              handle = remoteJob.id;
              await advance({ handle, uploadId, status: "submitted" });
            } else if (remoteJob.status === "submitting") submitting = true;
            if (uploadId && !handle) {
              try {
                const remote = await client.uploadState(uploadId);
                if (remote.status === "submitted" && remote.id) {
                  handle = remote.id;
                  await advance({ handle, status: "submitted" });
                }
                else if (remote.status === "submitting") submitting = true;
                else if (remote.status === "failed") { uploadId = undefined; persist(id, null); await advance({ uploadId: undefined }); }
              } catch (error) {
                if (!(error instanceof AssemblyAiError && (error.kind === "not-found" || error.uploadEnded))) throw error;
                uploadId = undefined;
                persist(id, null);
                await advance({ uploadId: undefined });
              }
            }
            if (!handle) {
              if (!uploadId) {
                guard();
                const opId = crypto.randomUUID();
                await native.beginRemoteOp({ id, did, opId, provider: "assemblyai", mode: "hosted", kind: "hosted_create",
                  fingerprint: `${source.size}:${source.mimeType}`, startedAt: Date.now() });
                const created = await client.createUpload(source.size, contentType, id);
                uploadId = created.uploadId;
                persist(id, { uploadId });
                await advance({ uploadId });
                await native.recordRemoteResult({ id, did, opId, result: { outcome: "created", uploadId } });
                if (created.status === "submitted" && created.id) {
                  handle = created.id;
                  await advance({ handle, status: "submitted" });
                } else if (created.status === "submitting") submitting = true;
              }
              if (!submitting && !handle) {
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
              if (!handle) {
                guard();
                const opId = crypto.randomUUID();
                await native.beginRemoteOp({ id, did, opId, provider: "assemblyai", mode: "hosted", kind: "hosted_submit",
                  fingerprint: `${source.size}:${source.mimeType}`, startedAt: Date.now() });
                const submitted = await client.createTranscript(uploadId, { speakerLabels: channels === 2 || recording.options?.identifySpeakers !== false,
                  multichannel: channels === 2, sourceId: id });
                handle = submitted.id;
                persist(id, { handle });
                await advance({ handle, status: "submitted" });
                await native.recordRemoteResult({ id, did, opId, result: { outcome: "created", jobId: handle } });
              }
            }
          }
          return handle;
        } catch (error) {
          // Keep a submitted handle immutable. A failed upload can be claimed
          // again with a conditional write and resumed from its upload ID.
          if (claim.status === "active") {
            for (let attempt = 0; attempt < 3; attempt++) {
              try { await advance({ status: "failed" }); break; }
              catch (claimError) { if (attempt === 2) console.warn("[HostedVoiceNotes] Could not release failed job claim", claimError); }
            }
          }
          throw error;
        } finally { clearInterval(heartbeat); }
      });
      if (!handle) return;
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
      const stereo = channels === 2;
      const sentences = assemblyAiSentences(transcript, await client.getSentences(handle), { stereo })
        .map((sentence) => stereo && sentence.channel !== undefined ? { ...sentence,
          speaker_name: sentence.channel === 0 ? "Me" : "Them" } : sentence);
      const local = recording.sizeBytes > 0 ? await native.getTranscript({ id }) : { transcript: null };
      const commit = await readCommit(account, id);
      const rev = Math.max(local.transcript?.rev ?? 0, commit?.rev ?? 0) + 1;
      const at = new Date().toISOString();
      const outcome = sentences.length ? "transcribed" : "no_speech";
      const prepared: LocalTranscript = { version: 2, noteId: id, transcriber: "assemblyai", rev,
        engine: "assemblyai", model: transcript.speech_model_used ?? null, language: transcript.language_code ?? null,
        outcome, diarized: stereo || recording.options?.identifySpeakers !== false, createdAt: at,
        segments: sentences.map((s) => ({ start: Math.round(s.start_time * 1000), end: Math.round(s.end_time * 1000),
          text: s.text, speaker: s.speaker_name ?? null,
          ...(s.speaker_id === undefined ? {} : { speakerId: s.speaker_id }),
          ...(s.channel === undefined ? {} : { channel: s.channel }),
          ...(s.timing === undefined ? {} : { timing: s.timing }) })) };
      state(id, { kind: "saving" });
      if (recording.sizeBytes > 0 && (!local.transcript || local.transcript.rev < rev)) await native.putTranscript({ id, transcript: prepared });
      guard();
      const saved = await save(account, id, { rev, sentences,
        speakers: [...new Set(sentences.map((s) => s.speaker_name).filter((s): s is string => !!s))],
        metadata: { transcription_engine: "assemblyai", transcript_provider: "assemblyai", inference_provider: "assemblyai",
          assemblyai_account: "tinycloud", transcription_outcome: outcome, transcript_text: sentences.map((s) => s.text).join("\n") || null,
          speaker_labels: stereo ? "channels" : recording.options?.identifySpeakers !== false ? "diarized" : "single-speaker", transcribed_at: at,
          model: transcript.speech_model_used ?? null, language: transcript.language_code ?? null } }, { generation, did });
      if (!saved.ok) throw new Error("The transcript is ready, but could not be saved to your space. Try again.");
      transcriptSaved = true;
      persist(id, { saved: true });
      try { await client.deleteTranscript(handle); persist(id, null); }
      catch (error) { console.warn("[HostedVoiceNotes] Could not delete the saved remote transcript", error); }
      await markHostedRemoteDone(id);
      jobs.set(id, { kind: "done", outcome });
      logPipeline("transcription", id, "done", { engine: "assemblyai" });
      notify();
    } catch (error) {
      logPipelineError("transcription", error, id);
      const current = currentAccountGeneration() === generation && tcw().did === did && isAccountWorkAllowed(tcw());
      const clientForFailure = current ? tcw() : null;
      if (!transcriptSaved && clientForFailure && typeof clientForFailure.sql?.db === "function") {
        const code = error instanceof AssemblyAiError ? error.kind : "transcription_error";
        try { await patchVoiceNoteTranscriptionFailure(clientForFailure, id, code, guard); }
        catch (persistError) { console.warn("[HostedVoiceNotes] Could not persist transcription failure", persistError); }
      }
      if (transcriptSaved) {
        const commit = await readCommit(tcw(), id);
        if (commit) { await markHostedRemoteDone(id); jobs.set(id, { kind: "done", outcome: commit.outcome }); notify(); return; }
      }
      const message = error instanceof AssemblyAiError ? error.message
        : error instanceof Error && error.message.startsWith("The transcript is ready") ? error.message
        : "Powerful couldn't finish this transcript. Try again.";
      jobs.set(id, { kind: "failed", message, retryable: !(error instanceof AssemblyAiError && error.kind === "needs-reconciliation"), reference: null,
        code: error instanceof AssemblyAiError ? error.kind : "transcription_error" });
      notify();
      if (error instanceof AssemblyAiError && error.kind === "needs-reconciliation") watchReconciliation(id, generation);
    } finally { active.delete(id); }
  };
  return {
    check, run, jobs, consented,
    consent() { storage()?.setItem(`${CONSENT}:${did}`, "1"); notify(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async resume() {
      for (const [id, stored] of Object.entries(readJobs(did))) {
        const recording = (await native.listPending()).recordings.find((r) => r.id === id);
        if (recording ?? stored.recording) void run(recording ?? stored.recording!);
      }
    },
    async runSpaceOnly(id: string) {
      const note = await readNote(tcw(), id);
      if (!note.ok || !note.data || note.data.captureTranscriber !== "assemblyai") return false;
      const recording = { id, owner: did, source: "in_app", startedAt: Date.now(), sizeBytes: 0,
        mimeType: "audio/mp4", durationMs: Math.round((note.data.durationSeconds ?? 0) * 1000),
        channels: note.data.channels, options: { transcriber: "assemblyai", identifySpeakers: true } } as VoiceNoteRecording;
      await run(recording);
      return true;
    },
  };
}
