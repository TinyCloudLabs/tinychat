// Upload audio: transcribe a file the user picked — on the web, the desktop
// and mobile alike — and save it as an `exo-upload` meeting (contract C7),
// with the original audio stored in the user's TinyCloud space (C6).
//
// Two engines. Private (default): TinyCloud Private Transcription, through
// the TinyChat backend relay (privateCloud.ts). AssemblyAI (opt-in,
// assemblyai.ts): under TinyCloud's account through Exo's server (the
// default), or straight from this device with the user's own key. A job
// keeps the account it started with.
//
// One upload runs at a time. Its job (engine, remote job id, meeting id, file
// metadata) is kept in localStorage, so a reload resumes polling and saving.
// The File itself cannot survive a reload: an upload that had not reached the
// engine yet must be picked again, and audio storage that had not finished is
// recorded as not stored.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  AudioStoreQuotaError,
  audioBaseKey,
  blobPartSource,
  deleteAudio,
  getAudioManifest,
  putAudio,
} from "./audio/audioStore";
import {
  AssemblyAiError,
  assemblyAiSentences,
  pollAssemblyAiTranscript,
  type AssemblyAiClient,
  type AssemblyAiKeyMode,
  type AssemblyAiTranscript,
} from "./assemblyai";
import type { NormalizedMeeting } from "./connectors/connectorStore";
import type { FirefliesSentence } from "./connectors/firefliesClient";
import { NO_SPEECH_MESSAGE, type LocalTranscriptSaver, type PreparedLocalTranscript } from "./localTranscriber";
import { accountStorageKey } from "./voiceNotes/voiceNoteTranscription";
import {
  createCloudJobPoller,
  privateCloudMessage,
  PrivateCloudError,
  ptxUploadUrl,
  putFileToPtx,
  REAL_CLOCK,
  sha256Hex,
  UPLOAD_CHANNEL_LABELS,
  type CloudClock,
  type CloudJobProgress,
  type PrivateCloudApi,
  type PrivateCloudCreateBody,
  type PrivateCloudCreated,
  type PrivateCloudTranscript,
} from "./privateCloud";

/** `connector_meeting.source` for uploaded files; registered in EXPLORER_MEETING_SOURCES and SUPPORTED_MEETING_SOURCES. */
export const UPLOAD_MEETING_SOURCE = "exo-upload";
export const UPLOAD_MEETING_SOURCE_LABEL = "Uploaded audio";

export type UploadEngine = "private-cloud" | "assemblyai";

export const UPLOAD_ENGINE_LABELS: Readonly<Record<UploadEngine, string>> = {
  "private-cloud": "Private",
  assemblyai: "AssemblyAI",
};

export const UPLOAD_ENGINE_STORAGE_KEY = "exo.transcriber.uploadEngine";
export const UPLOAD_PENDING_STORAGE_KEY = "exo.transcriber.uploadPending";

/** The default engine new uploads start on (Settings → Transcription). Private unless changed. */
export function readDefaultUploadEngine(): UploadEngine {
  try {
    return globalThis.localStorage?.getItem(UPLOAD_ENGINE_STORAGE_KEY) === "assemblyai" ? "assemblyai" : "private-cloud";
  } catch {
    return "private-cloud";
  }
}

export function writeDefaultUploadEngine(engine: UploadEngine): void {
  try {
    globalThis.localStorage?.setItem(UPLOAD_ENGINE_STORAGE_KEY, engine);
  } catch {
    // Best-effort preference.
  }
}

// ── File types (C1) ────────────────────────────────────────────────────

/** Extension → the canonical `content_type` PTX and the relay accept. */
const PRIVATE_CLOUD_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  m4b: "audio/mp4",
  webm: "audio/webm",
  flac: "audio/flac",
};

/** Browser-reported types that name a C1 type differently. */
const PRIVATE_CLOUD_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/opus": "audio/ogg",
  "video/webm": "audio/webm",
  "audio/x-flac": "audio/flac",
};

export const PRIVATE_CLOUD_ACCEPT = Object.keys(PRIVATE_CLOUD_CONTENT_TYPES).map((ext) => `.${ext}`).join(",");

/** AssemblyAI transcodes most audio and video containers itself. */
export const UPLOAD_ACCEPT = `audio/*,video/*,${PRIVATE_CLOUD_ACCEPT},.aac,.aif,.aiff,.amr,.wma,.mov,.mkv,.m4v,.3gp`;

/** The C1 content type for a file, or null when private cloud transcription can't take it. */
export function privateCloudContentType(file: { name: string; type: string }): string | null {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() : "";
  const byExt = PRIVATE_CLOUD_CONTENT_TYPES[ext];
  if (byExt !== undefined) return byExt;
  const type = file.type.toLowerCase().split(";")[0]!.trim();
  if (Object.values(PRIVATE_CLOUD_CONTENT_TYPES).includes(type)) return type;
  return PRIVATE_CLOUD_TYPE_ALIASES[type] ?? null;
}

/** What the stored audio and the meeting row record as the file's type. */
function storedContentType(file: { name: string; type: string }): string {
  return privateCloudContentType(file) ?? (file.type || "application/octet-stream");
}

// ── Pending job (reload) ───────────────────────────────────────────────

/**
 * The file's own time, or `now` when it has none worth showing: Android's
 * document picker hands the WebView files whose lastModified reads as
 * 1601-01-01 (or 0), and a meeting dated then would sort to the bottom.
 */
export function plausibleFileTime(lastModified: number, now: number): number {
  return Number.isFinite(lastModified) && lastModified >= Date.UTC(1990, 0, 1) && lastModified <= now + 86_400_000 ? lastModified : now;
}

export interface UploadFileMeta {
  name: string;
  type: string;
  size: number;
  lastModified: number;
}

export interface PendingUpload {
  engine: UploadEngine;
  /** The meeting's `source_id`, row id and audio key; stable across retries. */
  meetingId: string;
  /** Private cloud create Idempotency-Key: the same key re-joins the same job. */
  attemptId: string;
  /** PTX transcription id or AssemblyAI transcript id, once the job exists. */
  jobId: string | null;
  diarize: boolean;
  file: UploadFileMeta;
  /** The signed-in DID that started it: another account never resumes it. */
  owner: string;
  /** Set once the meeting is saved: only deleting the remote job is left. */
  saved: boolean;
  /** Discard requested: resume only cleanup, never transcription or saving. */
  discarding?: boolean;
  /** AssemblyAI: the sent file's reference (upload URL, or TinyCloud's upload id) until its transcript exists. */
  uploadRef?: string;
  /** AssemblyAI only: whose account the job runs under. Resume and delete use exactly this account, never the other. */
  assemblyAiMode?: AssemblyAiKeyMode;
  /** What the saved meeting records about its audio, so a resumed saved job reports it truthfully. */
  audio?: AudioOutcome;
}

export interface PendingUploadStore {
  read(): PendingUpload | null;
  write(job: PendingUpload): void;
  clear(): void;
}

/** This browser's stored upload for one account (keyed by DID, like voice notes' jobs), so another account never overwrites or resumes it. */
export function localStoragePendingUploadStore(accountDid: string): PendingUploadStore {
  const key = accountStorageKey(UPLOAD_PENDING_STORAGE_KEY, accountDid);
  return {
  read() {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      if (!v || typeof v !== "object") return null;
      const p = v as Partial<PendingUpload>;
      const f = p.file;
      if (
        (p.engine !== "private-cloud" && p.engine !== "assemblyai") ||
        typeof p.meetingId !== "string" ||
        typeof p.attemptId !== "string" ||
        typeof p.owner !== "string" ||
        !f ||
        typeof f.name !== "string" ||
        typeof f.size !== "number"
      ) {
        return null;
      }
      return {
        engine: p.engine,
        meetingId: p.meetingId,
        attemptId: p.attemptId,
        jobId: typeof p.jobId === "string" ? p.jobId : null,
        diarize: p.diarize === true,
        file: {
          name: f.name,
          type: typeof f.type === "string" ? f.type : "",
          size: f.size,
          lastModified: typeof f.lastModified === "number" ? f.lastModified : Date.now(),
        },
        owner: p.owner,
        saved: p.saved === true,
        ...(p.discarding === true ? { discarding: true } : {}),
        ...(typeof p.uploadRef === "string" ? { uploadRef: p.uploadRef } : {}),
        // A record from before key modes existed was made with the user's own key.
        ...(p.engine === "assemblyai" ? { assemblyAiMode: p.assemblyAiMode === "hosted" ? ("hosted" as const) : ("own" as const) } : {}),
        ...(p.audio && typeof p.audio === "object" && typeof p.audio.stored === "boolean"
          ? { audio: p.audio.stored ? { stored: true as const } : { stored: false as const, reason: p.audio.reason === "quota" ? ("quota" as const) : ("failed" as const) } }
          : {}),
      };
    } catch {
      return null;
    }
  },
  write(job) {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(job));
    } catch {
      // Best-effort: without it a reload cannot resume this upload.
    }
  },
  clear() {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // Nothing to clear.
    }
  },
  };
}

// ── One tab at a time ──────────────────────────────────────────────────

/** Holds this tab's claim on the account's stored upload until released; null when another tab holds it. */
export type UploadTabLock = (accountDid: string) => Promise<(() => void) | null>;

/** Web Locks, one per account: one tab runs its stored upload; the lock goes with the tab when it closes. */
export const webUploadLock: UploadTabLock = async (accountDid) => {
  const locks = globalThis.navigator?.locks;
  if (locks === undefined) return () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = await new Promise<boolean>((resolve) => {
    void locks.request(`exo-upload:${accountDid}`, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock === null ? undefined : held;
    });
  });
  return acquired ? release : null;
};

// ── Normalization → meeting (C7) ───────────────────────────────────────

export type SpeakerLabels = "diarized" | "channels" | "none";

/** An engine's finished transcript, in the stored sentence shape. */
export interface UploadTranscript {
  sentences: FirefliesSentence[];
  diarized: boolean;
  speakerLabels: SpeakerLabels;
  durationSecs: number | null;
  language: string | null;
  model: string | null;
}

export type AudioOutcome = { stored: true } | { stored: false; reason: "quota" | "failed" };

/**
 * PTX segments as sentences in time order. Diarized: each turn carries its
 * speaker's name ("Speaker 1"); otherwise a channel's name when there are two
 * channels, and no speaker for a single (mixed) channel.
 */
export function privateCloudUploadTranscript(t: PrivateCloudTranscript): UploadTranscript {
  const speakers = t.speakers ?? [];
  const diarized = t.diarized === true;
  const speakerLabels: SpeakerLabels = diarized ? "diarized" : speakers.length > 1 ? "channels" : "none";
  const nameOf = (seg: PrivateCloudTranscript["segments"][number]): string | null => {
    if (speakerLabels === "none") return null;
    const speaker = speakers.find((s) => s.id === seg.speaker_id) ?? speakers.find((s) => s.channel === seg.channel);
    return speaker?.name ?? `Speaker ${seg.channel + 1}`;
  };
  const sentences = t.segments
    .map((seg) => ({ seg, text: seg.text.trim() }))
    .filter(({ seg, text }) => text.length > 0 && Number.isFinite(seg.start) && Number.isFinite(seg.end))
    .sort((a, b) => a.seg.start - b.seg.start || a.seg.channel - b.seg.channel)
    .map(({ seg, text }, index) => ({ index, speaker_name: nameOf(seg), text, start_time: seg.start, end_time: seg.end }));
  const lastEnd = sentences.reduce((end, s) => Math.max(end, s.end_time), 0);
  const duration = t.duration_seconds ?? (lastEnd > 0 ? lastEnd : null);
  return {
    sentences,
    diarized,
    speakerLabels,
    durationSecs: duration !== null ? Math.round(duration) : null,
    language: t.language ?? null,
    model: t.model ?? null,
  };
}

/** The finished meeting row and transcript body for an upload. Throws when there is no speech. */
export function prepareUploadMeeting(
  pending: Pick<PendingUpload, "engine" | "meetingId" | "file" | "assemblyAiMode">,
  transcript: UploadTranscript,
  audio: AudioOutcome,
): PreparedLocalTranscript {
  if (transcript.sentences.length === 0) throw new Error(NO_SPEECH_MESSAGE);
  const { file } = pending;
  const speakerNames = [...new Set(transcript.sentences.map((s) => s.speaker_name).filter((n): n is string => n !== null))];
  const privateCloud = pending.engine === "private-cloud";
  const title = file.name.includes(".") ? file.name.slice(0, file.name.lastIndexOf(".")) : file.name;
  const meeting: NormalizedMeeting = {
    id: pending.meetingId,
    source: UPLOAD_MEETING_SOURCE,
    sourceId: pending.meetingId,
    title: title.trim() || file.name,
    startedAt: new Date(file.lastModified).toISOString(),
    durationSecs: transcript.durationSecs,
    organizerEmail: null,
    participants: speakerNames.map((name) => ({ name, email: null })),
    summaryOverview: null,
    summaryActionItems: null,
    keywords: null,
    meetingType: null,
    metadata: {
      capture: "upload",
      file_name: file.name,
      content_type: storedContentType(file),
      byte_size: file.size,
      transcription_engine: pending.engine,
      transcript_provider: privateCloud ? "tinycloud-private-transcription" : "assemblyai",
      inference_provider: privateCloud ? "tinfoil" : "assemblyai",
      ...(privateCloud ? {} : { assemblyai_account: pending.assemblyAiMode === "hosted" ? "tinycloud" : "own" }),
      model: transcript.model,
      language: transcript.language,
      diarized: transcript.diarized,
      speaker_labels: transcript.speakerLabels,
      audio: { base: audioBaseKey(UPLOAD_MEETING_SOURCE, pending.meetingId), ...audio },
      transcript_text: transcript.sentences.map((s) => s.text).join("\n"),
    },
  };
  return { meeting, sentences: transcript.sentences };
}

// ── Running an upload ──────────────────────────────────────────────────

/** `elsewhere`: another tab or window of this browser is running the stored upload. */
export type UploadStage = "preparing" | "uploading" | "queued" | "transcribing" | "saving" | "saved" | "failed" | "elsewhere";

export type AudioStage = "storing" | "stored" | "quota" | "failed" | "not-stored";

export interface UploadState {
  engine: UploadEngine;
  fileName: string;
  stage: UploadStage;
  /** Percent of the file sent to the engine while uploading. */
  uploadPct: number | null;
  /** Queue position / progress while the engine works, already worded. */
  detail: string | null;
  audio: { stage: AudioStage; pct: number | null };
  /** Set when stage is "failed". `retry`: whether Retry can continue without the file being picked again. */
  error: { message: string; reference: string | null; retry: boolean } | null;
  savedTitle: string | null;
  /** Remote cleanup remains, after saving or discarding the upload. */
  cleanupPending: boolean;
}

export interface UploadDeps {
  tcw: TinyCloudWeb;
  /**
   * Null when the Private engine is unavailable (no PTX origin, or the account may not use it).
   * `create` is `createPrivateCloudJob` bound to the backend and session.
   */
  privateCloud: {
    api: PrivateCloudApi;
    origin: string;
    create: (request: { attemptId: string; correlationId: string; body: PrivateCloudCreateBody }) => Promise<PrivateCloudCreated>;
  } | null;
  save: LocalTranscriptSaver;
  pending?: PendingUploadStore;
  clock?: CloudClock;
  /**
   * The AssemblyAI client for one account: TinyCloud's through Exo's server (`hosted`, C10), or the
   * user's own key from the vault (`own`, C8/C9; unlocks it when needed, rejects when no key is saved).
   */
  assemblyAiClient: (mode: AssemblyAiKeyMode) => Promise<AssemblyAiClient>;
  audio?: { put: typeof putAudio; manifest: typeof getAudioManifest; remove: typeof deleteAudio };
  putFile?: typeof putFileToPtx;
  hash?: typeof sha256Hex;
  /** Defaults to Web Locks. */
  lock?: UploadTabLock;
}

export interface UploadInput {
  file: File;
  engine: UploadEngine;
  diarize: boolean;
  /** AssemblyAI: whose account (Settings → Transcription). */
  assemblyAiMode?: AssemblyAiKeyMode;
}

/** PTX codes after which the job may still be usable: Retry re-joins it (same Idempotency-Key). */
const KEEP_JOB_CODES: Readonly<Record<string, true>> = {
  upload_outcome_unknown: true,
  upload_interrupted: true,
  offline: true,
  request_timeout: true,
  service_unavailable: true,
  service_busy: true,
  service_paused: true,
  http_5xx: true,
  upstream_bad_response: true,
  unauthenticated: true,
};

/** Failures no Retry can fix: the file itself, or the account's limit. */
const FINAL_CODES: Readonly<Record<string, true>> = {
  recording_too_large: true,
  recording_too_long: true,
  unsupported_recording: true,
  unsupported_media_type: true,
  invalid_audio: true,
  no_speech: true,
  quota_exceeded: true,
  feature_unavailable: true,
  diarization_unavailable: true,
};

/** The upload never reached the engine and the File is gone (a reload): only picking it again helps. */
class NeedsFileError extends Error {}

interface Failure {
  message: string;
  reference: string | null;
  /** Retry cannot help. */
  final: boolean;
  /** The remote job may still finish, so Retry continues it rather than starting over. */
  keepJob: boolean;
}

function failureOf(err: unknown): Failure {
  if (err instanceof PrivateCloudError) {
    return {
      message:
        err.code === "active_transcription_exists"
          ? "Another private cloud transcription for your account hasn't finished yet (it expires within 2 hours). Try again later, or use AssemblyAI."
          : privateCloudMessage(err),
      reference: err.correlationId ?? err.transcriptionId,
      final: FINAL_CODES[err.code] === true,
      keepJob: KEEP_JOB_CODES[err.code] === true,
    };
  }
  if (err instanceof AssemblyAiError) {
    return {
      message: err.message,
      reference: null,
      final: err.kind === "invalid-key" || err.kind === "rejected",
      keepJob: err.kind === "network" || err.kind === "rate-limited",
    };
  }
  const message = err instanceof Error && err.message ? err.message : "Transcription failed.";
  // A failed save, a locked vault, anything unexpected: the remote job is kept, so Retry finishes it.
  return { message, reference: null, final: err instanceof NeedsFileError || message === NO_SPEECH_MESSAGE, keepJob: true };
}

function privateCloudDetail(p: CloudJobProgress): string {
  if (p.stage === "queued") {
    return p.queuePosition !== null && p.queuePosition > 0 ? `Waiting in the queue (position ${p.queuePosition})…` : "Waiting in the queue…";
  }
  return p.regionsTotal !== null && p.regionsTotal > 0 ? `Transcribing… ${p.regionsCompleted ?? 0} of ${p.regionsTotal} parts` : "Transcribing…";
}

export interface UploadRunner {
  /** The current (or last) upload, or null. */
  snapshot(): UploadState | null;
  subscribe(cb: () => void): () => void;
  /** Starts an upload. Ignored while one is running; refused while another tab holds the stored one. */
  start(deps: UploadDeps, input: UploadInput): void;
  /** Picks up this account's stored job (after a reload), unless another tab is running it. */
  resume(deps: UploadDeps): void;
  /** Continues a failed upload, retries deleting a saved one's remote copy, or checks again on one running elsewhere. */
  retry(deps: UploadDeps): void;
  /** Forgets the upload: deletes its remote job, and the audio stored for a meeting that was never saved. */
  dismiss(deps: UploadDeps): Promise<void>;
  /** Sign-out: stops this tab's work on the upload and forgets it here. The stored job stays for its owner. */
  reset(): void;
}

export function createUploadRunner(): UploadRunner {
  let state: UploadState | null = null;
  let running = false;
  /** The picked file while this page has it; a reload loses it. */
  let file: File | null = null;
  /** The file reached the engine (PUT accepted, or the job no longer awaited it). */
  let sent = false;
  let current: PendingUpload | null = null;
  /** Storing the original audio for `current`; started once per attempt. */
  let audioTask: Promise<AudioOutcome> | null = null;
  let audioAbort: AbortController | null = null;
  /** This tab's claim on the stored upload, while it owns it. */
  let releaseLock: (() => void) | null = null;
  /** Bumped by reset(): a run from before it no longer touches this runner. */
  let epoch = 0;
  /** Aborts the running attempt's network work (uploads, polling); reset() fires it. */
  let runAbort: AbortController | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const cb of listeners) cb();
  };
  const set = (patch: Partial<UploadState>) => {
    if (state === null) return;
    state = { ...state, ...patch };
    notify();
  };
  const audioOf = (deps: UploadDeps) => deps.audio ?? { put: putAudio, manifest: getAudioManifest, remove: deleteAudio };
  const pendingOf = (deps: UploadDeps) => deps.pending ?? localStoragePendingUploadStore(deps.tcw.did);
  const persist = (deps: UploadDeps, job: PendingUpload): PendingUpload => {
    current = job;
    pendingOf(deps).write(job);
    return job;
  };
  const unlock = () => {
    releaseLock?.();
    releaseLock = null;
  };
  const claim = async (deps: UploadDeps): Promise<boolean> => {
    if (releaseLock !== null) return true;
    const release = await (deps.lock ?? webUploadLock)(deps.tcw.did);
    if (release === null) return false;
    releaseLock = release;
    return true;
  };
  const forget = (deps: UploadDeps) => {
    pendingOf(deps).clear();
    current = null;
    file = null;
    sent = false;
    audioTask = null;
    audioAbort = null;
    unlock();
  };
  /** Stops storing audio and waits for the store to settle, so no part is written after this. */
  const stopAudio = async () => {
    audioAbort?.abort();
    const task = audioTask;
    audioTask = null;
    audioAbort = null;
    if (task !== null) await task;
  };
  const showElsewhere = (job: Pick<PendingUpload, "engine" | "file"> | null, fallback?: UploadInput) => {
    state = {
      engine: job?.engine ?? fallback?.engine ?? "private-cloud",
      fileName: job?.file.name ?? fallback?.file.name ?? "",
      stage: "elsewhere",
      uploadPct: null,
      detail: null,
      audio: { stage: "not-stored", pct: null },
      error: null,
      savedTitle: null,
      cleanupPending: false,
    };
    notify();
  };

  /**
   * One attempt of run(). Once reset() moves on (sign-out), everything it does
   * is a no-op for this runner: its writes go nowhere and its network work is
   * aborted, so a late answer can never land in the next account's upload.
   */
  interface Run {
    gen: number;
    signal: AbortSignal;
    /** The file as of this attempt; a later start() never changes it. */
    file: File | null;
  }
  const live = (r: Run) => r.gen === epoch && !r.signal.aborted;
  const runSet = (r: Run, patch: Partial<UploadState>) => {
    if (live(r)) set(patch);
  };
  const runPersist = (r: Run, deps: UploadDeps, job: PendingUpload): PendingUpload => (live(r) ? persist(deps, job) : job);
  /** Between steps: a superseded attempt makes no further request (run() drops its error). */
  const stillLive = (r: Run) => {
    if (!live(r)) throw new Error("This upload was stopped");
  };

  /** Stores the original audio beside the transcript. Never fails the upload: the outcome is recorded instead. */
  const storeAudio = (deps: UploadDeps, job: PendingUpload, r: Run): Promise<AudioOutcome> => {
    if (!live(r)) return Promise.resolve({ stored: false, reason: "failed" });
    const audio = audioOf(deps);
    const base = audioBaseKey(UPLOAD_MEETING_SOURCE, job.meetingId);
    const file = r.file;
    if (file === null) {
      // After a reload only an upload that completed counts: its manifest is written last.
      // Parts of one the reload cut short are removed rather than left without a manifest.
      const notStored = async (): Promise<AudioOutcome> => {
        runSet(r, { audio: { stage: "not-stored", pct: null } });
        await audio.remove(deps.tcw.kv, base).catch((err: unknown) => console.error("Removing partly stored audio failed", err));
        return { stored: false, reason: "failed" };
      };
      return audio.manifest(deps.tcw.kv, base).then((manifest): AudioOutcome | Promise<AudioOutcome> => {
        if (manifest === null) return notStored();
        runSet(r, { audio: { stage: "stored", pct: null } });
        return { stored: true };
      }, notStored);
    }
    const controller = new AbortController();
    audioAbort = controller;
    r.signal.addEventListener("abort", () => controller.abort(), { once: true });
    runSet(r, { audio: { stage: "storing", pct: 0 } });
    return audio
      .put(deps.tcw.kv, base, blobPartSource(file), {
        fileName: file.name,
        mimeType: storedContentType(file),
        signal: controller.signal,
        onProgress: (stored, total) => runSet(r, { audio: { stage: "storing", pct: total > 0 ? Math.round((stored / total) * 100) : null } }),
      })
      .then(
        (): AudioOutcome => {
          runSet(r, { audio: { stage: "stored", pct: 100 } });
          return { stored: true };
        },
        (err: unknown): AudioOutcome => {
          if (controller.signal.aborted) {
            runSet(r, { audio: { stage: "not-stored", pct: null } });
            return { stored: false, reason: "failed" };
          }
          const quota = err instanceof AudioStoreQuotaError;
          if (!quota) console.error("Storing the uploaded audio failed; the transcript is saved without it", err);
          runSet(r, { audio: { stage: quota ? "quota" : "failed", pct: null } });
          return { stored: false, reason: quota ? "quota" : "failed" };
        },
      );
  };

  async function transcribePrivate(deps: UploadDeps, job: PendingUpload, r: Run): Promise<UploadTranscript> {
    const pc = deps.privateCloud;
    if (pc === null) throw new PrivateCloudError("feature_unavailable", "Private cloud transcription is not available");
    const file = r.file;
    if (file !== null && !(sent && job.jobId !== null)) {
      // Create the job — or re-join it: the same Idempotency-Key and body return the same job,
      // with a fresh upload grant while it still awaits the file.
      const upload = file;
      const contentType = privateCloudContentType(upload);
      if (contentType === null) throw new PrivateCloudError("unsupported_media_type", "Unsupported file type");
      runSet(r, { stage: "preparing", uploadPct: null, detail: null });
      const sha256 = await (deps.hash ?? sha256Hex)(upload);
      stillLive(r);
      // The upload labels mark it as Upload audio's job for every client of the account
      // (privateCloudJobClient), so Local recording and voice notes never adopt it.
      const correlationId = crypto.randomUUID();
      const created = await pc.create({
        attemptId: job.attemptId,
        correlationId,
        body: {
          content_type: contentType,
          byte_size: upload.size,
          sha256,
          channel_mode: "mixed",
          channel_labels: [...UPLOAD_CHANNEL_LABELS],
          ...(job.diarize ? { diarize: true } : {}),
        },
      });
      stillLive(r);
      job = runPersist(r, deps, { ...job, jobId: created.id });
      // Stored once the job exists, so a create that fails stores nothing.
      if (live(r)) audioTask ??= storeAudio(deps, job, r);
      if (created.upload !== null) {
        runSet(r, { stage: "uploading", uploadPct: 0 });
        try {
          await (deps.putFile ?? putFileToPtx)({
            url: ptxUploadUrl(pc.origin, created.upload.path),
            capability: created.upload.capability,
            file: upload,
            contentType,
            correlationId,
            signal: r.signal,
            onProgress: (done, total) => runSet(r, { uploadPct: total > 0 ? Math.round((done / total) * 100) : null }),
          });
        } catch (err) {
          throw err instanceof PrivateCloudError && err.transcriptionId === null
            ? new PrivateCloudError(err.code, err.message, { correlationId: err.correlationId, transcriptionId: created.id })
            : err;
        }
      }
      if (live(r)) sent = true;
    } else if (job.jobId === null) {
      throw new NeedsFileError("The upload didn't reach private cloud transcription before the page closed. Choose the file again.");
    }
    if (live(r)) audioTask ??= storeAudio(deps, job, r);
    runSet(r, { stage: "queued", uploadPct: null, detail: null });
    const poller = createCloudJobPoller(pc.api, {
      clock: deps.clock,
      connectionLost: () =>
        new PrivateCloudError("offline", "Lost contact with private cloud transcription for 10 minutes. The job may still be running; Retry keeps waiting."),
    });
    let transcript: PrivateCloudTranscript;
    try {
      transcript = await poller.pollTranscript(job.jobId!, (p) =>
        runSet(r, { stage: p.stage === "queued" ? "queued" : "transcribing", detail: privateCloudDetail(p) }),
        r.signal,
      );
    } catch (err) {
      if (err instanceof PrivateCloudError && err.code === "upload_interrupted" && file === null) {
        throw new NeedsFileError("The upload didn't finish before the page closed. Choose the file again.");
      }
      if (err instanceof PrivateCloudError && err.code === "upload_interrupted" && live(r)) sent = false;
      throw err;
    }
    return privateCloudUploadTranscript(transcript);
  }

  async function transcribeAssemblyAi(deps: UploadDeps, job: PendingUpload, client: AssemblyAiClient, r: Run): Promise<UploadTranscript> {
    if (job.jobId === null) {
      let uploadRef = job.uploadRef ?? null;
      if (uploadRef === null) {
        const file = r.file;
        if (file === null) throw new NeedsFileError("The upload didn't reach AssemblyAI before the page closed. Choose the file again.");
        runSet(r, { stage: "uploading", uploadPct: 0, detail: null });
        uploadRef = await client.upload(file, {
          signal: r.signal,
          contentType: storedContentType(file),
          onProgress: (done, total) => runSet(r, { uploadPct: total > 0 ? Math.round((done / total) * 100) : null }),
        });
        stillLive(r);
        // Kept before the transcript is requested: a reload while the file is still being sent on
        // re-joins that submission instead of losing the file.
        job = runPersist(r, deps, { ...job, uploadRef });
      }
      runSet(r, { stage: "queued", uploadPct: null, detail: "Sending the file to AssemblyAI…" });
      let created: AssemblyAiTranscript;
      try {
        created = await client.createTranscript(uploadRef, { speakerLabels: job.diarize, signal: r.signal });
      } catch (err) {
        // Hosted references survive all ambiguous failures, including rate limits and session expiry.
        const ended = err instanceof AssemblyAiError && err.uploadEnded;
        if (job.assemblyAiMode === "hosted" ? ended : !(err instanceof AssemblyAiError && err.kind === "network")) {
          runPersist(r, deps, { ...job, uploadRef: undefined });
        }
        throw err;
      }
      stillLive(r);
      job = runPersist(r, deps, { ...job, jobId: created.id, uploadRef: undefined });
    }
    runSet(r, { stage: "queued", uploadPct: null, detail: "Queued at AssemblyAI…" });
    const done = await pollAssemblyAiTranscript(client, job.jobId!, {
      clock: deps.clock,
      signal: r.signal,
      onStatus: (s) =>
        runSet(r, { stage: s === "queued" ? "queued" : "transcribing", detail: s === "queued" ? "Queued at AssemblyAI…" : "Transcribing at AssemblyAI…" }),
    });
    const diarized = job.diarize && (done.utterances?.length ?? 0) > 0;
    return {
      // Without speaker labels, AssemblyAI's own sentence split keeps timestamps.
      sentences: assemblyAiSentences(done, diarized ? null : await client.getSentences(done.id)),
      diarized,
      speakerLabels: diarized ? "diarized" : "none",
      durationSecs: typeof done.audio_duration === "number" ? Math.round(done.audio_duration) : null,
      language: done.language_code ?? null,
      model: done.speech_model_used ?? null,
    };
  }

  /** Deletes the remote job (at AssemblyAI, with its uploaded audio), retrying briefly. */
  async function deleteRemote(deps: UploadDeps, job: PendingUpload, client: AssemblyAiClient | null, signal?: AbortSignal): Promise<void> {
    let jobId = job.jobId;
    const hostedUpload = job.engine === "assemblyai" && job.assemblyAiMode === "hosted" && job.uploadRef !== undefined;
    if (jobId === null && !hostedUpload) return;
    const sleep = (deps.clock ?? REAL_CLOCK).sleep;
    for (let attempt = 0; ; attempt++) {
      try {
        if (job.engine === "assemblyai") {
          const remote = client ?? (await deps.assemblyAiClient(job.assemblyAiMode ?? "own"));
          if (jobId !== null) await remote.deleteTranscript(jobId);
          else {
            if (!remote.deleteUpload) throw new Error("Hosted upload cleanup is unavailable. Retry deleting after reloading.");
            await remote.deleteUpload(job.uploadRef!, {
              signal,
              onSubmitted: (id) => {
                jobId = id;
                if (!signal?.aborted && current?.owner === job.owner && current.attemptId === job.attemptId) {
                  persist(deps, { ...current, jobId: id, uploadRef: undefined });
                }
              },
            });
          }
        } else {
          if (deps.privateCloud === null) throw new PrivateCloudError("feature_unavailable", "Private cloud transcription is not available");
          await deps.privateCloud.api.remove(jobId!);
        }
        return;
      } catch (err) {
        // A rejected key or an expired session won't change by asking again.
        if (signal?.aborted || attempt >= 2 || (err instanceof AssemblyAiError && (err.kind === "invalid-key" || err.kind === "rejected"))) throw err;
        await sleep(2_000 * (attempt + 1));
      }
    }
  }

  async function run(deps: UploadDeps, job: PendingUpload): Promise<void> {
    const controller = new AbortController();
    runAbort = controller;
    const r: Run = { gen: epoch, signal: controller.signal, file };
    running = true;
    let client: AssemblyAiClient | null = null;
    try {
      // The key first: unlocking the vault never overlaps the audio's storage calls.
      if (job.engine === "assemblyai" && !job.discarding) client = await deps.assemblyAiClient(job.assemblyAiMode ?? "own");
      stillLive(r);
      if (job.discarding) {
        set({ stage: "saving", cleanupPending: true, error: null, detail: "Deleting the remote copy…" });
        await stopAudio();
        stillLive(r);
        await deleteRemote(deps, job, client, r.signal);
        stillLive(r);
        if (!job.saved) await audioOf(deps).remove(deps.tcw.kv, audioBaseKey(UPLOAD_MEETING_SOURCE, job.meetingId));
        stillLive(r);
        forget(deps);
        state = null;
        notify();
        return;
      }
      if (!job.saved) {
        if (client !== null && live(r)) audioTask ??= storeAudio(deps, job, r);
        const transcript = client === null ? await transcribePrivate(deps, job, r) : await transcribeAssemblyAi(deps, job, client, r);
        if (!live(r)) return;
        job = current!;
        set({ stage: "saving", uploadPct: null, detail: null });
        audioTask ??= storeAudio(deps, job, r);
        const audio = await audioTask;
        if (!live(r)) return;
        let prepared: PreparedLocalTranscript;
        try {
          prepared = prepareUploadMeeting(job, transcript, audio);
        } catch (err) {
          // Nothing to save: release the remote job and the stored audio rather than keep either.
          await deleteRemote(deps, job, client).catch((e: unknown) => console.error("Deleting the remote job failed", e));
          await audioOf(deps)
            .remove(deps.tcw.kv, audioBaseKey(UPLOAD_MEETING_SOURCE, job.meetingId))
            .catch((e: unknown) => console.error("Deleting the stored audio failed", e));
          if (live(r)) forget(deps);
          throw err;
        }
        const saved = await deps.save(prepared);
        if (!saved.ok) throw new Error(`Couldn't save the transcript to your TinyCloud space: ${saved.error.message}`);
        // Signed out meanwhile: nothing more is written for this account from this tab.
        if (!live(r)) return;
        job = persist(deps, { ...job, saved: true, audio });
        set({ savedTitle: prepared.meeting.title });
      }
      try {
        await deleteRemote(deps, job, client);
      } catch (err) {
        console.error("Deleting the remote transcript failed; it is retried on the next visit", err);
        // Say why when asking again can't help on its own (a rejected key, an expired session).
        const reason = err instanceof AssemblyAiError && (err.kind === "invalid-key" || err.kind === "rejected") ? err.message : null;
        runSet(r, {
          stage: "saved",
          cleanupPending: true,
          error: reason === null ? null : { message: reason, reference: null, retry: true },
          detail: null,
        });
        return;
      }
      if (!live(r)) return;
      forget(deps);
      set({ stage: "saved", cleanupPending: false, error: null, detail: null });
    } catch (err) {
      if (!live(r)) return;
      if (job.discarding) {
        set({ stage: "failed", cleanupPending: true, detail: null, error: { message: "Deleting the remote copy didn't finish. Retry deleting to finish discarding this upload.", reference: null, retry: true } });
        return;
      }
      const failure = failureOf(err);
      // Nothing will be saved from this file: stop storing its audio (Discard removes what was stored).
      if (failure.final) audioAbort?.abort();
      const failed = current;
      const resumableHosted = failed?.assemblyAiMode === "hosted" && failed.uploadRef !== undefined;
      let retry = failed !== null && (!failure.final || resumableHosted);
      if (retry && failed !== null && !failure.keepJob && !failed.saved) {
        // This job is over: Retry starts a new one, which needs the file.
        if (file === null) retry = false;
        else if (failed.jobId !== null) {
          void deleteRemote(deps, failed, client).catch((e: unknown) => console.error("Deleting the failed job failed", e));
          persist(deps, { ...failed, attemptId: crypto.randomUUID(), jobId: null, uploadRef: undefined });
          sent = false;
        }
      }
      if (retry && current !== null && current.jobId === null && current.uploadRef === undefined && file === null) retry = false;
      set({ stage: "failed", uploadPct: null, detail: null, error: { message: failure.message, reference: failure.reference, retry } });
    } finally {
      if (r.gen === epoch) {
        running = false;
        if (runAbort === controller) runAbort = null;
      }
    }
  }

  const show = (job: PendingUpload) => {
    state = {
      engine: job.engine,
      fileName: job.file.name,
      stage: job.saved ? "saving" : "preparing",
      uploadPct: null,
      detail: null,
      audio: {
        // Unsaved: nothing is shown until storing actually starts (storeAudio says so).
        stage: job.saved && job.audio !== undefined ? (job.audio.stored ? "stored" : job.audio.reason) : "not-stored",
        pct: null,
      },
      error: null,
      savedTitle: null,
      cleanupPending: false,
    };
    notify();
  };

  const resume = (deps: UploadDeps) => {
    if (running || (state !== null && state.stage !== "elsewhere")) return;
    const owned = (job: PendingUpload | null): job is PendingUpload => job !== null && job.owner === deps.tcw.did;
    if (!owned(pendingOf(deps).read())) {
      if (state !== null) {
        state = null;
        notify();
      }
      return;
    }
    running = true;
    const gen = epoch;
    void (async () => {
      const claimed = await claim(deps);
      if (gen !== epoch) {
        if (claimed) unlock();
        return;
      }
      // Read again under the lock: the tab that held it may have finished the job.
      const job = pendingOf(deps).read();
      if (!claimed || !owned(job)) {
        running = false;
        if (!claimed) showElsewhere(job);
        else {
          unlock();
          state = null;
          notify();
        }
        return;
      }
      current = job;
      file = null;
      sent = job.jobId !== null;
      audioTask = null;
      audioAbort = null;
      show(job);
      void run(deps, job);
    })();
  };

  const reset = () => {
    epoch++;
    runAbort?.abort();
    runAbort = null;
    audioAbort?.abort();
    audioAbort = null;
    audioTask = null;
    unlock();
    state = null;
    running = false;
    file = null;
    current = null;
    sent = false;
    notify();
  };

  return {
    snapshot: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    start(deps, input) {
      if (running) return;
      running = true;
      const gen = epoch;
      void (async () => {
        await stopAudio();
        const claimed = await claim(deps);
        if (gen !== epoch) {
          if (claimed) unlock();
          return;
        }
        if (!claimed) {
          // Another tab owns the stored upload; writing a new one would take it from under it.
          running = false;
          showElsewhere(pendingOf(deps).read(), input);
          return;
        }
        file = input.file;
        sent = false;
        audioTask = null;
        const job = persist(deps, {
          engine: input.engine,
          meetingId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          jobId: null,
          diarize: input.diarize,
          ...(input.engine === "assemblyai" ? { assemblyAiMode: input.assemblyAiMode ?? "hosted" } : {}),
          file: { name: input.file.name, type: input.file.type, size: input.file.size, lastModified: plausibleFileTime(input.file.lastModified, Date.now()) },
          owner: deps.tcw.did,
          saved: false,
        });
        show(job);
        void run(deps, job);
      })();
    },

    resume,

    retry(deps) {
      if (state?.stage === "elsewhere") {
        resume(deps);
        return;
      }
      if (running || current === null || state === null || current.owner !== deps.tcw.did) return;
      // A failed audio store is tried again while the file is here; a stored or quota outcome stands.
      if (file !== null && state.audio.stage === "failed") audioTask = null;
      set({ stage: current.saved ? "saving" : "preparing", error: null, detail: null });
      void run(deps, current);
    },

    async dismiss(deps) {
      if (running || state?.stage === "elsewhere") return;
      const job = current;
      if (job === null) {
        // This tab owns no job (it finished, or another tab runs the stored one): only the view clears.
        unlock();
        state = null;
        notify();
        return;
      }
      if (job.owner !== deps.tcw.did) {
        // Another account's upload: never touch its job or space with this account's credentials.
        reset();
        return;
      }
      const discarding = persist(deps, { ...job, discarding: true });
      set({ stage: "saving", cleanupPending: true, error: null, detail: "Deleting the remote copy…" });
      await run(deps, discarding);
    },

    reset,
  };
}

/** The app's one upload: it outlives the view, so switching tabs or pages never interrupts it. */
export const uploadRunner: UploadRunner = createUploadRunner();
