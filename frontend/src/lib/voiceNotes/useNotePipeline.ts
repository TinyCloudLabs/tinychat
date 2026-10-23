import { logPipelineError } from "@/lib/debugLog";
// Fills `NotePipelineInput` (notePipeline.ts) from the live stores and runs the one action its blocker offers.
// `buildNotePipelineInput` is pure: it takes the stores' snapshots as plain facts, so a test composes fake stores
// and asserts what the selector says. The hooks only gather the facts (`useSyncExternalStore` over each store).
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { recoveryFailedKey, withQuarantine, type HomeIssue } from "@/capture/home/captureIssues";
import { useSoftHome } from "@/capture/home/softHome";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { privateRefusal, privateAudioSourceFromMetadata, type PrivateAudioSource, type VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { privateRefusalCopy } from "@/capture/recorder/privateInstead";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { deviceName } from "./notePipelineCopy";
import { localTranscriptionUnavailable } from "./captureEngine";
import { getDesktopWhisperQueue, type DesktopWhisperJob } from "./desktop/desktopWhisper";
import { resolveVoiceNoteRows, SpaceLaneQueueWaitTimeout, spaceLaneSnapshot, subscribeSpaceLane } from "./voiceNoteRows";
import { legacyTranscriptMetadata, readTranscriptCommits } from "./voiceNoteCommits";
import {
  VoiceNotes,
  nativeVoiceNotesAvailable,
  type NoteLedger,
  type NoteSttState,
  type TranscriberId,
  type VoiceNoteRecording,
} from "./nativeVoiceNotes";
import {
  notePipeline,
  type NotePipeline,
  type NotePipelineInput,
  type PipelineActionKind,
  type PipelineCaptureIssue,
  type PipelineDevice,
  type PipelineModelState,
  type PipelineNotesSync,
  type PipelineOnDevice,
  type PipelineRoute,
  type StepKey,
} from "./notePipeline";
import { isAppleSpeech, OnDeviceStt, type OnDeviceSttStatus } from "./onDeviceStt";
import { onDeviceQueuePlace, type OnDeviceQueuePlace } from "./onDeviceQueue";
import { downloadOnDeviceModel, onDeviceSttStore, retryOnDeviceNote } from "./onDeviceSttStore";
import {
  onDeviceTranscriptSyncState,
  recordOnDeviceTranscript,
  subscribeOnDeviceTranscriptSync,
  syncOnDeviceTranscript,
  type OnDeviceTranscriptSyncState,
} from "./onDeviceTranscriber";
import { useQuarantinedRecordings } from "./quarantine";
import { loadNote } from "./recordingNotes";
import { captureAccountContext, isAccountWorkAllowed, subscribeAccountWork } from "./accountContext";
import { VOICE_NOTE_READ_TIMEOUT_MESSAGE, VoiceNoteSaveTimeout, withVoiceNoteReadDeadline } from "./saveDeadline";
import { pendingStore, type PendingNote } from "./recorderSaves";
import { openManageStorage } from "@/lib/openManageStorage";
import {
  recordingNoteSyncError,
  recordingNoteSyncSkip,
  recordingNoteSyncedAt,
  recordingNoteSyncing,
  subscribeRecordingNoteSync,
  syncRecordingNote,
  voiceNoteMarkdownKvKey,
  voiceNoteTranscriptState,
  type NoteSyncSkipReason,
  type VoiceNoteTranscriptState,
} from "./voiceNoteStore";
import type { NoteTranscriptionState } from "./voiceNoteTranscription";
// --- Facts: the stores' answers, as plain data ----------------------------------------------------------------

/**
 * What the phone's own ledger says about a note (`VoiceNotes.listPending`): its committed route, its on-device job,
 * and the ledger's record of the transcript reaching the space (`transcriptSync`, with the outcome it covers).
 */
export interface NativeNote {
  recording?: VoiceNoteRecording;
  transcriber: TranscriberId | null;
  stt: NoteSttState | null;
  audio?: NoteLedger["audio"] | null;
  transcriptSync: NoteLedger["transcriptSync"] | null;
  transcriptOutcome: "transcribed" | "no_speech" | null;
}

export function nativeNoteOf(recording: VoiceNoteRecording): NativeNote {
  return {
    recording,
    transcriber: (recording.options?.transcriber as TranscriberId | undefined) ?? null,
    stt: recording.stt ?? null,
    audio: recording.ledger?.audio ?? null,
    transcriptSync: recording.ledger?.transcriptSync ?? null,
    transcriptOutcome: recording.ledger?.transcript.outcome ?? null,
  };
}

/** The local Markdown of a note (`loadNote`): the revision, and whether there is anything written (text or moments). */
export interface LocalNoteFacts {
  editedAt: string;
  hasContent: boolean;
}

export interface NotePipelineFacts {
  id: string;
  device: PipelineDevice;
  online: boolean;
  /** The note is a row in the space. */
  saved: boolean;
  /** The row's metadata as the library read it (`transcription_outcome`, `note_kv_key`, `note_edited_at`); null before it is read. */
  rowMetadata: Record<string, unknown> | null;
  localNote: LocalNoteFacts | null;
  /** Reading the local Markdown failed: the error. The note's text, and so its notes step, is unknown. */
  localNoteError?: string | null;
  /** Null: the phone has no ledger entry for the note, or this build has no phone ledger. */
  native: NativeNote | null;
  /** Reading the phone's ledger, following its jobs, or reading the space row failed: the error. The route and transcript are unknown. */
  readError?: string | null;
  /** `readError`: the list of parked recordings could not be read (its own error; "" when only the fact that it failed is known). */
  capture: { finalizing: boolean; issue: HomeIssue | null; readError?: string | null };
  pending: PendingNote | null;
  lane: ReturnType<typeof spaceLaneSnapshot>;
  /** Null when this build has no on-device speech. */
  onDeviceStatus: OnDeviceSttStatus | null;
  desktopJob?: DesktopWhisperJob | null;
  transcriptSync: OnDeviceTranscriptSyncState | null;
  /** The space row (read by the hook, behind the write lane) has not answered yet: `rowMetadata` is null for want of an answer, not for want of a row. */
  spaceReading?: boolean;
  /** With `spaceReading`: uploads are ahead of the read in the write lane. */
  spaceAfterUploads?: boolean;
  /** This note's private-cloud job (`transcriber.snapshot().jobs`). */
  cloudJob: NoteTranscriptionState | null;
  /** The account's private-cloud check has not answered: a saved note gets its job (or its blocked or held one) once it does. */
  cloudChecking?: boolean;
  /**
   * `attempting`: this revision of the note has not had its automatic sync attempt settle yet (the hook runs one when a saved
   * note with text has nothing syncing it, see `useAutoNoteSync`). Until it settles the notes step is "syncing", not a blocker.
   */
  noteSync: { syncing: boolean; failed: boolean; skip: NoteSyncSkipReason | null; syncedAt: string | null; attempting: boolean };
}

// --- Route -----------------------------------------------------------------------------------------------------

/**
 * Where this note's transcript comes from. What is transcribing it wins, because the note's Transcribe action can run a
 * provider other than the committed one: a live on-device job, then a private-cloud job, then an on-device attempt that
 * finished (its failure or cancel is what the note shows until a cloud job takes over). With none, the note's committed mode
 * (`options.transcriber` in the phone's ledger) decides. Desktop Whisper has its own queue and the space row records
 * the committed choice; neither requires Capacitor's phone ledger.
 */
// `waiting_for_model` is written for every committed mode at creation; only a real attempt writes these.
const ATTEMPT_STATES: ReadonlySet<NoteSttState["state"]> = new Set(["queued", "running", "done", "failed", "cancelled"]);

export function pipelineRoute(native: NativeNote | null, hasCloudJob: boolean, queue: OnDeviceQueuePlace | null = null): PipelineRoute {
  if (queue !== null && queue.position !== null) return "on-device";
  if (hasCloudJob) return "private-cloud";
  // The queue entry is gone once an attempt ends; the ledger keeps the attempt.
  if (queue !== null || (native?.stt != null && ATTEMPT_STATES.has(native.stt.state))) return "on-device";
  switch (native?.transcriber ?? null) {
    case "off": return "off";
    case "on-device": return "on-device";
    case "private-cloud":
    case "assemblyai": return "private-cloud";
    case null: return native?.stt != null ? "on-device" : "off";
  }
}

function desktopCommittedLocal(metadata: Record<string, unknown> | null): boolean {
  const capture = metadata?.capture;
  if (capture === null || typeof capture !== "object") return false;
  const options = (capture as { options?: unknown }).options;
  return options !== null && typeof options === "object" &&
    (options as { transcriber?: unknown }).transcriber === "on-device";
}

function providerFromMetadata(metadata: Record<string, unknown> | null): "private" | "powerful" | "unknown" {
  const capture = metadata?.capture;
  const options = capture && typeof capture === "object" ? (capture as { options?: unknown }).options : null;
  const committed = options && typeof options === "object" ? (options as { transcriber?: unknown }).transcriber : null;
  if (committed === "assemblyai" || metadata?.transcription_engine === "assemblyai") return "powerful";
  if (committed === "private-cloud" || metadata?.transcription_engine === "private-cloud") return "private";
  return "unknown";
}

// --- Decision (b): the model ----------------------------------------------------------------------------------

const MODEL_PROGRESS: readonly PipelineModelState[] = ["absent", "queued", "downloading", "verifying", "checking", "ready"];

/**
 * DECISION (b): primary model and VAD readiness combine into ONE model input, "worst of the two".
 * On-device transcription needs both the RAM tier's Parakeet model and Silero VAD, and one "Get the model" action
 * fetches both (`onDeviceDownloadTotalBytes`), so the stepper has a single model. Its state is the least-ready of
 * the two (failed beats everything, then absent, queued, downloading, verifying, checking; only both ready is ready),
 * its bytes and total are the sums (so the percent is of the whole download), and its error is the failed one's.
 * `models` empty means the status has not loaded, so the model is unknown (null) and nothing is claimed. iOS has no models at all (its built-in speech reports through `PipelineOnDevice.appleSpeech`), so it is null there too. A list with
 * a primary model but no VAD entry is judged on the primary alone: the status is the only authority on what exists.
 */
export function combinedModel(status: OnDeviceSttStatus): PipelineOnDevice["model"] {
  const primaryId = status.pack === "full" ? "parakeet-tdt-0.6b-v3-int8" : "parakeet-tdt-110m-en-int8";
  const needed = status.models.filter((model) => model.id === primaryId || model.id === "silero-vad");
  if (needed.length === 0) return null;
  const failed = needed.find((model) => model.state === "failed");
  const state: PipelineModelState = failed
    ? "failed"
    : needed.reduce<PipelineModelState>(
        (least, model) => (MODEL_PROGRESS.indexOf(model.state) < MODEL_PROGRESS.indexOf(least) ? model.state : least),
        "ready",
      );
  return {
    state,
    bytes: needed.reduce((sum, model) => sum + model.bytes, 0),
    totalBytes: needed.reduce((sum, model) => sum + model.totalBytes, 0),
    error: failed?.error ?? null,
  };
}

// --- Decision (a): notes "synced" -----------------------------------------------------------------------------

/**
 * DECISION (a): the notes step is "synced" only on POSITIVE evidence, never on the absence of an error. Evidence is
 * either of:
 *   1. the space row's note pointer matches this device's revision: `note_kv_key` is this note's key and
 *      `note_edited_at` equals the local note's `editedAt` (the same test `syncRecordingNote` makes), or
 *   2. the last `syncRecordingNote` for this note succeeded for exactly the revision that is local now
 *      (`recordingNoteSyncedAt` equals `editedAt`), which covers the moment before the row is read again.
 * A note with nothing written locally, whose row carries a note pointer (written on another device), has nothing to
 * send and is synced by the row alone. Without evidence the answer is a running sync, a failed sync, a skip, or
 * "idle" (an automatic attempt for this revision has settled and nothing has synced it); the notes step turns "idle" into
 * a blocker with a "Try again" that runs `syncRecordingNote`. Before that first attempt settles the state is "syncing". An edit after the last
 * sync changes `editedAt`, so it correctly stops being synced.
 */
export function notesSyncState(facts: Pick<NotePipelineFacts, "id" | "saved" | "rowMetadata" | "localNote" | "noteSync">): PipelineNotesSync {
  const { id, rowMetadata, localNote, noteSync } = facts;
  const rowKey = typeof rowMetadata?.note_kv_key === "string" ? rowMetadata.note_kv_key : null;
  const rowEditedAt = typeof rowMetadata?.note_edited_at === "string" ? rowMetadata.note_edited_at : null;
  if (localNote === null) return rowKey !== null ? { state: "synced" } : { state: "skipped", reason: "no-note" };
  const rowMatches = rowKey === voiceNoteMarkdownKvKey(id) && rowEditedAt === localNote.editedAt;
  if (rowMatches || noteSync.syncedAt === localNote.editedAt) return { state: "synced" };
  if (noteSync.syncing) return { state: "syncing" };
  if (noteSync.failed) return { state: "failed" };
  if (noteSync.skip !== null) return { state: "skipped", reason: noteSync.skip };
  if (noteSync.attempting) return { state: "syncing" };
  return { state: "idle" };
}

// --- The input --------------------------------------------------------------------------------------------------

const CAPTURE_ISSUE: Record<HomeIssue["kind"], PipelineCaptureIssue> = {
  finalization_timed_out: "finalization_timed_out",
  recoveryFailed: "recoveryFailed",
  quarantined: "quarantined",
  write_failed: "write_failed",
  partial_audio: "partial_audio",
};

function onDeviceInput(facts: NotePipelineFacts): PipelineOnDevice | null {
  const status = facts.onDeviceStatus;
  if (status === null) return facts.desktopJob ? {
    stt: { state: facts.desktopJob.state === "transcribing" ? "running" : facts.desktopJob.state, error: facts.desktopJob.error },
    queue: { position: facts.desktopJob.position ?? (facts.desktopJob.state === "queued" ? 1 : null), inLine: facts.desktopJob.inLine ?? 1, percent: facts.desktopJob.progress },
    model: null, download: "idle", sync: facts.transcriptSync,
  } : null;
  const place = onDeviceQueuePlace(status, facts.id);
  // The live queue entry is the newest word on the job; the ledger read is what is left after a restart.
  const stt = place !== null ? { state: place.entry.state, error: place.entry.error } : facts.native?.stt != null ? { state: facts.native.stt.state, error: facts.native.stt.error } : null;
  return {
    stt,
    queue: place === null ? null : { position: place.position, inLine: place.inLine, percent: place.percent },
    model: combinedModel(status),
    download: status.download.state,
    ...(isAppleSpeech(status) ? { appleSpeech: status.appleSpeech } : {}),
    sync: facts.transcriptSync,
  };
}

function projectedTranscriptState(metadata: Record<string, unknown>): VoiceNoteTranscriptState["status"] {
  const terminal = (value: unknown): "transcribed" | "no_speech" | null =>
    value === "transcribed" || value === "no_speech" ? value : null;
  const committed = terminal(metadata.transcript_commit_outcome);
  if (committed !== null) return committed;
  const legacy = terminal(metadata.legacy_transcript_outcome);
  if (legacy !== null) return legacy;
  if (typeof metadata.transcript_text === "string" && metadata.transcript_text.trim().length > 0) return "transcribed";
  return voiceNoteTranscriptState(metadata).status;
}

export function buildNotePipelineInput(facts: NotePipelineFacts): NotePipelineInput {
  const desktopLocal = facts.device === "mac" && (facts.desktopJob != null || desktopCommittedLocal(facts.rowMetadata));
  const queue = facts.onDeviceStatus === null ? null : onDeviceQueuePlace(facts.onDeviceStatus, facts.id);
  const route = desktopLocal ? "on-device" : pipelineRoute(facts.native, facts.cloudJob !== null, queue);
  const liveTranscriptWork = facts.cloudJob?.kind === "active"
    || (queue !== null && queue.position !== null)
    || facts.native?.stt?.state === "queued"
    || facts.native?.stt?.state === "running"
    || facts.desktopJob?.state === "queued"
    || facts.desktopJob?.state === "transcribing";
  const rowState = facts.rowMetadata === null ? "none" : projectedTranscriptState(facts.rowMetadata);
  const persistedState = facts.saved && !liveTranscriptWork
    && (rowState === "pending" || rowState === "failed" || rowState === "skipped") ? rowState : undefined;
  const errorCode = rowState === "failed" && typeof facts.rowMetadata?.transcription_error_code === "string"
    ? facts.rowMetadata.transcription_error_code
    : undefined;
  const rowOutcome = rowState === "transcribed" || rowState === "no_speech" ? rowState : "none";
  // The ledger's own record that the transcript reached the space is durable evidence too (a receipt has no library row read).
  const ledgerOutcome = facts.native?.transcriptSync?.state === "saved" ? facts.native.transcriptOutcome ?? "none" : "none";
  const outcome = rowOutcome !== "none" ? rowOutcome : ledgerOutcome;
  const localNoteError = facts.localNoteError ?? null;
  const hasNotesOrMoments = localNoteError !== null || facts.localNote?.hasContent === true || typeof facts.rowMetadata?.note_kv_key === "string";
  const transcriptProvider = facts.native?.transcriber === "assemblyai" ? "powerful" : facts.native?.transcriber === "private-cloud" ? "private" : providerFromMetadata(facts.rowMetadata);
  return {
    device: facts.device,
    route,
    transcriptProvider,
    hasNotesOrMoments,
    online: facts.online,
    audioUploadIntent: (facts.native?.recording?.options as { uploadAudio?: boolean } | undefined)?.uploadAudio ?? true,
    capture: {
      finalizing: facts.capture.finalizing,
      issue: facts.capture.issue === null ? null : CAPTURE_ISSUE[facts.capture.issue.kind],
      readError: facts.capture.readError ?? null,
    },
    space: {
      saved: facts.saved,
      localOnly: facts.rowMetadata?.audio_stored === 0 ||
        (facts.rowMetadata?.audio as { stored?: unknown } | undefined)?.stored === false,
      pending: facts.pending === null ? null : {
        ...(facts.pending.upload ? { upload: facts.pending.upload } : {}),
        ...(facts.pending.failed ? { failed: facts.pending.failed } : {}),
        ...(facts.pending.held ? { held: facts.pending.held } : {}),
        ...("retryAt" in facts.pending && typeof facts.pending.retryAt === "number" ? { retryAt: facts.pending.retryAt } : {}),
        ...(facts.pending.waitingBehind !== undefined ? { waitingBehind: facts.pending.waitingBehind } : {}),
      },
      lane: facts.lane,
    },
    transcript: {
      inSpace: outcome === "none" ? null : outcome,
      ...(persistedState === undefined ? {} : { persistedState }),
      ...(errorCode === undefined ? {} : { errorCode }),
      onDevice: route === "on-device" ? onDeviceInput(facts) : null,
      cloud: route === "private-cloud" ? facts.cloudJob : null,
      // Jobs are written the moment a saved note is handed over, after the check: no job and no check pending is no hand-over.
      ...(route === "private-cloud" && facts.cloudJob === null && facts.saved && facts.cloudChecking !== true && facts.spaceReading !== true ? { cloudIdle: true as const } : {}),
      // Positive evidence only: the ledger's local audio is ready. Anything else (absent, unknown, not ready) makes no local-copy claim.
      ...(facts.native?.recording?.ledger?.localAudio?.state === "ready" ? { localAudioReady: true as const } : {}),
      readError: facts.readError ?? null,
      ...(facts.spaceReading === true ? { spaceReading: true, ...(facts.spaceAfterUploads === true ? { afterUploads: true } : {}) } : {}),
    },
    notes: localNoteError !== null ? { state: "unreadable", cause: localNoteError } : notesSyncState(facts),
  };
}

// --- Actions ----------------------------------------------------------------------------------------------------

/** What the transcript step's "Try again" means right now: write the transcript again, fetch the model, or transcribe again. */
export function transcriptRetryTarget(input: NotePipelineInput): "reread" | "private-cloud" | "record" | "sync" | "model" | "note" {
  if (input.transcript.readError != null && input.transcript.inSpace === null) return "reread";
  if (input.route === "private-cloud") return "private-cloud";
  const od = input.transcript.onDevice;
  if (od?.sync?.state === "unrecorded") return "record";
  if (od?.sync?.state === "failed" || (od?.sync === null && od.stt?.state === "done")) return "sync";
  if (od !== null && (od.stt === null || od.stt.state === "waiting_for_model")) return "model";
  return "note";
}

export interface PipelineActionEnv {
  id: string;
  tcw: TinyCloudWeb | null;
  pipeline: NotePipeline;
  input: NotePipelineInput;
  native: NativeNote | null;
  transcription: VoiceNoteTranscriptionProps | undefined;
  /** The transcription props as they are now, after an action ran (`transcription` is as they were when it began). */
  latestTranscription: () => VoiceNoteTranscriptionProps | undefined;
  /** The saved note's duration and recorded source, used to re-run Private admission on Retry. */
  durationSecs?: number | null;
  privateAudioSource?: PrivateAudioSource;
  /** The existing Save now / recovery trigger (`recorder.retryPending`); its promise is awaited. */
  saveNow: () => void | Promise<void>;
  /** The app's sign-in entry; absent where there is none. */
  signIn: (() => void | Promise<void>) | null;
  reviewConsent?: () => void;
  /** Reads the facts that failed to read again. */
  reread: () => void;
}

function messageOf(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code).toLowerCase() : "";
  if (["network_error", "network", "offline", "timeout", "timed_out"].includes(code))
    return "Couldn't reach your space. Check your connection and try again.";
  if (["unauthorized", "auth", "authentication_required"].includes(code))
    return "Your session ended. Sign in and try again.";
  if (["not_found", "tombstoned", "voice_note_not_found"].includes(code))
    return `This note is no longer available on ${deviceName("phone")}.`;
  if (["quota", "quota_exceeded", "storage_quota"].includes(code)) return "Your space is full.";
  return "Couldn't complete this step. Try again.";
}

/** Runs the blocker's action with the existing function behind it. The reason it did not work, or null. Nothing is swallowed. */
export async function runPipelineAction(kind: PipelineActionKind, env: PipelineActionEnv): Promise<string | null> {
  try {
    switch (kind) {
      case "sign-in":
        if (env.signIn === null) return "Signing in isn't available here.";
        await env.signIn();
        return null;
      case "review-consent":
        if (!env.reviewConsent) return "Private transcription isn't available here.";
        env.reviewConsent();
        return null;
      case "get-model":
        return await downloadOnDeviceModel();
      case "check-again": {
        if (!env.transcription) return "Private transcription isn't available here.";
        await env.transcription.onRecheck();
        // `check()` settles on its own failure and keeps the cause in the snapshot.
        const after = env.latestTranscription();
        return after?.availability === "failed" ? "Couldn't check private transcription right now. Try again." : null;
      }
      case "manage-storage":
        await openManageStorage();
        return null;
      case "reread":
        env.reread();
        return null;
      case "retry":
        switch (env.pipeline.current) {
          case "space": {
            await env.saveNow();
            // Failures no single note owns (the account is not ready, the defaults could not be claimed) are reported to the store, not thrown.
            return pendingStore.generalError() === null ? null : `Couldn't save this note. It is safe on ${deviceName(env.input.device)}. Try again.`;
          }
          case "notes":
            if (env.input.notes.state === "unreadable") {
              env.reread();
              return null;
            }
            if (env.tcw === null) return "Sign in to sync this note.";
            await syncRecordingNote(env.tcw, env.id);
            return null;
          case "transcript":
            switch (transcriptRetryTarget(env.input)) {
              case "reread":
                env.reread();
                return null;
              case "private-cloud": {
                if (!env.transcription) return "Private transcription isn't available here.";
                if (env.input.transcriptProvider === "powerful") {
                  env.transcription.onTranscribe(env.id);
                  return null;
                }
                const sizeBytes = env.privateAudioSource?.sizeBytes ?? env.native?.recording?.sizeBytes ?? null;
                const refusal = privateRefusal(env.transcription, env.durationSecs ?? null, sizeBytes, env.privateAudioSource);
                if (refusal !== null) return privateRefusalCopy(refusal);
                const result = env.transcription.onTranscribePrivately(env.id, env.durationSecs ?? null, sizeBytes);
                return result ? privateRefusalCopy(result) : null;
              }
              case "record":
                if (env.tcw === null) return `Sign in to record the transcript on ${deviceName(env.input.device)}.`;
                await recordOnDeviceTranscript(env.tcw, env.id);
                return null;
              case "sync":
                if (env.tcw === null) return "Sign in to add the transcript to this note.";
                // The desktop queue is separate from Capacitor's ledger. A committed space audio row is
                // sufficient to retry its transcript write, as it is after the upload finishes.
                if (env.input.device === "mac" && !env.input.space.saved) return "Audio must finish uploading before its transcript can be added. Try again afterward.";
                await syncOnDeviceTranscript(env.tcw, { id: env.id, owner: env.tcw.did,
                  ledger: env.input.device === "mac" ? { audio: { state: "saved" } }
                    : env.native?.audio == null ? undefined : { audio: env.native.audio }, stt: { state: "done" } });
                return null;
              case "model":
                return await downloadOnDeviceModel();
              case "note":
                if (env.input.device === "mac") {
                  const queue = getDesktopWhisperQueue();
                  if (!queue) return "Whisper is unavailable on this Mac. Try again after opening Capture settings.";
                  await queue.retry(env.id);
                  return null;
                }
                return await retryOnDeviceNote(env.id);
            }
          // falls through only if `current` is a step with no retry
          case "phone":
          case null:
            return "There is nothing to try again for this step.";
        }
    }
  } catch (caught) {
    logPipelineError("[NotePipeline] action failed", caught);
    return "Couldn't complete this step. Try again.";
  }
}

// --- Hooks ------------------------------------------------------------------------------------------------------

/** A number that changes whenever `subscribe`'s store notifies; for stores that only expose per-key getters. */
function useStoreVersion(subscribe: (listener: () => void) => () => void): number {
  const version = useRef(0);
  const subscribeCounting = useCallback(
    (listener: () => void) => subscribe(() => { version.current += 1; listener(); }),
    [subscribe],
  );
  return useSyncExternalStore(subscribeCounting, () => version.current, () => version.current);
}

interface NativeRead {
  /** The phone has been read for these notes (successfully or not). */
  ready: boolean;
  notes: ReadonlyMap<string, NativeNote>;
  /** The read or its live updates failed: the cause. Never to be taken for "the phone has nothing". */
  error: string | null;
  reread: () => void;
}

/**
 * The notes' native ledger entries, read once per list of ids and again when the plugin says a job ended. `ready`
 * is false until the first read has answered: the route (and so the whole transcript step) depends on it. A read
 * that fails, or a listener that cannot register, is kept as `error` with its own message; it is never read as the
 * phone having no entry for the note.
 */
function useNativeNotes(ids: readonly string[], rowVersion: number): NativeRead {
  const platform = useContext(PlatformContext);
  const localDevice = deviceName(platform === "tauri" ? "mac" : platform === "ios" ? "iphone" : platform === "android" ? "android" : "browser");
  const key = ids.join("\n");
  const needed = ids.length > 0 && nativeVoiceNotesAvailable();
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{ key: string; notes: ReadonlyMap<string, NativeNote>; error: string | null }>({ key: "", notes: new Map(), error: null });
  const [listenError, setListenError] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    setListenError(null);
    const load = () => {
      VoiceNotes.listPending().then(
        ({ recordings }) => {
          if (!alive) return;
          const next = new Map<string, NativeNote>();
          for (const id of ids) {
            const found = recordings.find((recording) => recording.id === id);
            if (found) next.set(id, nativeNoteOf(found));
          }
          setRead({ key, notes: next, error: null });
        },
        (caught: unknown) => {
          logPipelineError("[NotePipeline] Could not read the phone's note ledger", caught);
          if (alive) setRead((previous) => ({ key, notes: previous.key === key ? previous.notes : new Map(), error: `The note list on ${localDevice} wouldn't open: ${messageOf(caught)}` }));
        },
      );
    };
    load();
    const subs = localTranscriptionUnavailable() ? [] : [
      OnDeviceStt.addListener("transcribed", (event) => { if (ids.includes(event.id)) load(); }),
      OnDeviceStt.addListener("failed", (event) => { if (ids.includes(event.id)) load(); }),
    ];
    for (const sub of subs) {
      sub.catch((caught: unknown) => {
        logPipelineError("[NotePipeline] Could not follow on-device transcription", caught);
        if (alive) setListenError({ key, message: `Updates from ${localDevice} failed to start: ${messageOf(caught)}` });
      });
    }
    return () => {
      alive = false;
      for (const sub of subs) sub.then((handle) => handle.remove()).catch(() => {});
    };
    // `ids` is keyed by its content.
  }, [key, needed, attempt, rowVersion, localDevice]);
  const reread = useCallback(() => setAttempt((count) => count + 1), []);
  const error = read.key === key ? read.error : null;
  return {
    ready: !needed || read.key === key,
    notes: read.notes,
    error: error ?? (listenError?.key === key ? listenError.message : null),
    reread,
  };
}

type LocalRead = { note: LocalNoteFacts | null } | { error: string };

/** Each note's local Markdown, read again whenever a note sync finishes (an edit syncs after it is written) or on `reread`. A failed read is kept as its error, not as "no note". */
function useLocalNotes(ids: readonly string[], reread: unknown): ReadonlyMap<string, LocalRead> {
  const platform = useContext(PlatformContext);
  const localDevice = deviceName(platform === "tauri" ? "mac" : platform === "ios" ? "iphone" : platform === "android" ? "android" : "browser");
  const [notes, setNotes] = useState<ReadonlyMap<string, LocalRead>>(new Map());
  const key = ids.join("\n");
  useEffect(() => {
    let alive = true;
    Promise.all(
      ids.map(async (id): Promise<[string, LocalRead]> => {
        try {
          const note = await loadNote(id);
          return [id, { note: note === null ? null : { editedAt: note.editedAt, hasContent: note.md.trim().length > 0 || note.moments.length > 0 } }];
        } catch (caught) {
          logPipelineError("[NotePipeline] Could not read the local note", caught);
          return [id, { error: `The note's text wouldn't open on ${localDevice}: ${messageOf(caught)}` }];
        }
      }),
    ).then((entries) => { if (alive) setNotes(new Map(entries)); });
    return () => { alive = false; };
  }, [key, reread, localDevice]);
  return notes;
}

/** `timeout`: the read ran out of time (its call deadline, or its wait in the write lane): worth one automatic read once the lane is idle. */
type RowRead = { metadata: Record<string, unknown> | null } | { error: string; timeout?: true };

const clientIds = new WeakMap<object, number>();
let clientCount = 0;
/** Who a space read is for: this client, its account and its space. Evidence read under one identity is never used under another. */
function spaceIdentity(tcw: TinyCloudWeb): string {
  let client = clientIds.get(tcw);
  if (client === undefined) {
    client = ++clientCount;
    clientIds.set(tcw, client);
  }
  return `${client}|${tcw.did}|${tcw.spaceId}`;
}

/**
 * The rows of a set of notes and each one's transcript outcome (a transcript commit is authoritative, as in the library):
 * one rows query and one commits query for the whole set, however many notes.
 */
async function readSpaceRows(tcw: TinyCloudWeb, ids: readonly string[]): Promise<Map<string, RowRead>> {
  // The rows query runs on the write lane, which bounds its wait (`SpaceLaneQueueWaitTimeout`) and, once it is running, its call.
  // The commit reads do not use the lane and have no deadline of their own, so they get the UI's.
  const [rows, commits] = await Promise.all([
    resolveVoiceNoteRows(tcw, ids),
    withVoiceNoteReadDeadline(`read the transcript commits of ${ids.length} notes`, () => readTranscriptCommits(tcw, ids)),
  ]);
  return new Map(ids.map((id): [string, RowRead] => {
    const resolved = rows.get(id);
    const row = resolved?.row ?? null;
    const legacy = resolved?.legacy ?? null;
    const commit = commits.get(id) ?? null;
    const transcript = commit ? voiceNoteTranscriptState(null, commit) : voiceNoteTranscriptState(legacyTranscriptMetadata(legacy));
    const committed = commit !== null || legacy !== null;
    return [id, { metadata: row === null ? null : committed
      ? { ...row.metadata, transcription_outcome: transcript.status } : row.metadata }];
  }));
}

interface RowEntry { identity: string; signal: string; read: RowRead }

/**
 * The space rows of notes whose caller has not read them (the receipt, a list without row metadata): the durable evidence
 * that a transcript or a note reached the space, rather than this session's own sync stores. Each note's entry belongs to the
 * identity (client, account, space) and the `signal` it was read under. A note is read again only when its own identity or
 * signal changed, and all the notes that need it go in one batch. An answer that comes back after its note moved on (another
 * signal, another account) is dropped. A failed read is its error, never an empty row.
 */
function useSpaceRows(wanted: readonly { id: string; tcw: TinyCloudWeb; signal: string }[]): ReadonlyMap<string, RowEntry> {
  const [rows, setRows] = useState<ReadonlyMap<string, RowEntry>>(new Map());
  const cache = useRef(new Map<string, RowEntry>());
  const inFlight = useRef(new Map<string, { token: number; identity: string; signal: string }>());
  const tokens = useRef(0);
  const dead = useRef(false);
  useEffect(() => {
    dead.current = false;
    return () => { dead.current = true; };
  }, []);
  const key = wanted.map(({ id, tcw, signal }) => `${id}\t${spaceIdentity(tcw)}\t${signal}`).join("\n");
  useEffect(() => {
    const byClient = new Map<TinyCloudWeb, { id: string; identity: string; signal: string }[]>();
    for (const { id, tcw, signal } of wanted) {
      const identity = spaceIdentity(tcw);
      const have = cache.current.get(id);
      const reading = inFlight.current.get(id);
      if ((have?.identity === identity && have.signal === signal) || (reading?.identity === identity && reading.signal === signal)) continue;
      byClient.set(tcw, [...(byClient.get(tcw) ?? []), { id, identity, signal }]);
    }
    for (const [tcw, due] of byClient) {
      const token = ++tokens.current;
      for (const { id, identity, signal } of due) inFlight.current.set(id, { token, identity, signal });
      const settle = (reads: ReadonlyMap<string, RowRead>) => {
        let changed = false;
        for (const { id, identity, signal } of due) {
          if (dead.current || inFlight.current.get(id)?.token !== token) continue;
          inFlight.current.delete(id);
          cache.current.set(id, { identity, signal, read: reads.get(id) ?? { error: "Your space's copy of this note wouldn't open: no answer" } });
          changed = true;
        }
        if (changed) setRows(new Map(cache.current));
      };
      readSpaceRows(tcw, due.map((entry) => entry.id)).then(settle, (caught: unknown) => {
        logPipelineError("[NotePipeline] Could not read the notes' rows in the space", caught);
        // A call that ran out of time says so as a read; a wait in the lane that ran out keeps its own cause.
        const reason = caught instanceof SpaceLaneQueueWaitTimeout
          ? caught.message
          : caught instanceof VoiceNoteSaveTimeout ? VOICE_NOTE_READ_TIMEOUT_MESSAGE : messageOf(caught);
        const timeout = caught instanceof VoiceNoteSaveTimeout || caught instanceof SpaceLaneQueueWaitTimeout;
        settle(new Map(due.map(({ id }): [string, RowRead] => [id, { error: `Your space's copy of this note wouldn't open: ${reason}`, ...(timeout ? { timeout: true as const } : {}) }])));
      });
    }
  }, [key]);
  return rows;
}

// --- The first note-sync attempt ----------------------------------------------------------------------------------

const autoSync = { started: new Set<string>(), settled: new Set<string>(), listeners: new Set<() => void>() };
const subscribeAutoSync = (listener: () => void) => {
  autoSync.listeners.add(listener);
  return () => { autoSync.listeners.delete(listener); };
};
const notifyAutoSync = () => { for (const listener of [...autoSync.listeners]) listener(); };
const autoSyncKey = (tcw: TinyCloudWeb, id: string, editedAt: string) => JSON.stringify([spaceIdentity(tcw), id, editedAt]);
const autoTranscriptKey = (tcw: TinyCloudWeb, id: string, kind: "add" | "record") => JSON.stringify([spaceIdentity(tcw), id, kind === "add" ? "on-device-transcript" : "on-device-transcript-ledger"]);

export function __resetAutoNoteSyncForTests(): void {
  autoSync.started.clear();
  autoSync.settled.clear();
}

/**
 * A saved note with text and nothing syncing it gets one sync attempt per revision, started here, so that "idle" never
 * means "waiting for something that may never come". Until that attempt settles the notes step reads "Syncing notes…";
 * after it, whatever the sync stores say stands (synced, failed, skipped), and an attempt that changed nothing is a blocker
 * with "Try again". The sync stores keep a failure, so it shows; the attempt's own rejection is logged here.
 */
function useAutoNoteSync(candidates: readonly { tcw: TinyCloudWeb; id: string; key: string }[]): void {
  useEffect(() => {
    for (const { tcw, id, key } of candidates) {
      if (autoSync.started.has(key)) continue;
      autoSync.started.add(key);
      syncRecordingNote(tcw, id)
        .catch((caught: unknown) => { logPipelineError("[NotePipeline] Syncing the note failed", caught); })
        .finally(() => {
          autoSync.settled.add(key);
          for (const listener of [...autoSync.listeners]) listener();
        });
    }
  }, [candidates]);
}

/**
 * A saved note whose on-device transcript is finished but not in the space gets one write attempt per session, started
 * here: after a relaunch nothing else asks, and "adding" must never mean "waiting for something that may never come".
 * The attempt publishes its own progress and failure (`onDeviceTranscriptSyncState`); the failure keeps its cause and
 * "Try again" runs it again. A transcript already in the space that the phone's ledger never recorded (a write that failed
 * before the last quit) gets one ledger repair per session, `kind: "record"`.
 */
function useAutoTranscriptSync(candidates: readonly { tcw: TinyCloudWeb; id: string; key: string; kind: "add" | "record"; recording: VoiceNoteRecording; context: ReturnType<typeof captureAccountContext> }[]): void {
  useEffect(() => subscribeAccountWork(notifyAutoSync), []);
  useEffect(() => {
    for (const { tcw, id, key, kind, recording, context } of candidates) {
      if (!isAccountWorkAllowed(tcw)) continue;
      if (autoSync.started.has(key)) continue;
      autoSync.started.add(key);
      const attempt = kind === "add"
        ? syncOnDeviceTranscript(tcw, recording, context)
        : recordOnDeviceTranscript(tcw, id, context);
      void attempt.then((abandoned) => {
        if (abandoned) { autoSync.started.delete(key); autoSync.settled.delete(key); }
        else autoSync.settled.add(key);
      }, (caught: unknown) => {
        logPipelineError("[NotePipeline] Syncing the on-device transcript failed", caught);
        autoSync.settled.add(key);
        }).finally(notifyAutoSync);
    }
  }, [candidates]);
}

export interface NotePipelineSource {
  tcw: TinyCloudWeb | null;
  /** The identity row exists in the space. It may exist before the audio manifest is committed. */
  rowExists: boolean;
  /** Authoritative when known; otherwise taken from the phone ledger's committed audio state. */
  audioSaved: boolean;
  /** The saved note's exact length when the caller has it (as in the library item). */
  durationSecs?: number | null;
  /**
   * The space row's metadata as the caller read it; null when it has no row or the read is not available.
   * Left out (undefined) when the caller has not read the row (the receipt): the hook reads it itself, and again
   * when the note's transcript or notes change, so completion rests on the space and not on this session's stores.
   */
  metadata?: Record<string, unknown> | null;
}

export interface NotePipelineView {
  pipeline: NotePipeline;
  input?: NotePipelineInput;
  provider?: "local" | "private" | "powerful" | "off" | "unknown";
  /** Where the transcript is made, for the parts of a note that show a transcribe offer of their own. */
  route?: NotePipelineInput["route"];
  /** Runs the blocker's action; its failure shows as `actionError`. */
  onAction: (kind: PipelineActionKind) => void;
  onRetryStep?: (key: StepKey) => void;
  actionError: string | null;
}

interface PipelineState { input: NotePipelineInput; pipeline: NotePipeline; native: NativeNote | null; rowMetadata: Record<string, unknown> | null }

/** Each note's input and pipeline, off one set of subscriptions. Notes the reads have not answered for are left out. */
/** Desktop Whisper is a Tauri queue; Capacitor's native-plugin availability cannot gate it. */
export function onDevicePipelineAvailable(platform: AppPlatform): boolean {
  return platform === "tauri" ? getDesktopWhisperQueue() !== null
    : !localTranscriptionUnavailable() && nativeVoiceNotesAvailable();
}

function usePipelineStates(entries: readonly { id: string; source: NotePipelineSource }[]): {
  states: ReadonlyMap<string, PipelineState>;
  natives: ReadonlyMap<string, NativeNote>;
  nativeReady: boolean;
  reread: () => void;
} {
  const recorder = useRecorder();
  const platform = useContext(PlatformContext);
  const ids = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.snapshot, pendingStore.snapshot);
  const allLanesBusy = useRef(spaceLaneSnapshot().busy);
  const timedOutRows = useRef(false);
  const [laneIdleVersion, setLaneIdleVersion] = useState(0);
  useEffect(() => subscribeSpaceLane(() => {
    const busy = spaceLaneSnapshot().busy;
    const becameIdle = allLanesBusy.current && !busy;
    allLanesBusy.current = busy;
    if (becameIdle && timedOutRows.current) setLaneIdleVersion((version) => version + 1);
  }), []);
  const textLaneBusy = useSyncExternalStore(subscribeSpaceLane, () => spaceLaneSnapshot("text").busy, () => false);
  const textLaneDepth = useSyncExternalStore(subscribeSpaceLane, () => spaceLaneSnapshot("text").depth, () => 0);
  const onDeviceStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const syncVersion = useStoreVersion(subscribeRecordingNoteSync);
  const transcriptSyncVersion = useStoreVersion(subscribeOnDeviceTranscriptSync);
  const whisperVersion = useStoreVersion((listener) => getDesktopWhisperQueue()?.subscribe(listener) ?? (() => undefined));
  const nativeRead = useNativeNotes(ids, pending.rowVersion ?? 0);
  const natives = nativeRead.notes;
  const [localAttempt, setLocalAttempt] = useState(0);
  const locals = useLocalNotes(ids, `${syncVersion}:${localAttempt}`);
  // The capture issues the home shows: the recorder's, with the sessions native parked (account-filtered). Where the
  // Soft home is on it already holds them; elsewhere (wide layouts, the receipt) they are read here.
  const soft = useSoftHome();
  const quarantine = useQuarantinedRecordings(soft === null, recoveryFailedKey(recorder.captureIssues));
  const issues = useMemo(
    () => soft?.issues ?? withQuarantine(recorder.captureIssues, quarantine.items, new Set()),
    [soft, recorder.captureIssues, quarantine.items],
  );
  const quarantineError = soft !== null ? soft.quarantineError : quarantine.error;
  const refreshQuarantine = soft !== null ? soft.refreshQuarantine : quarantine.refresh;
  const captureReadError = quarantineError != null ? messageOf(quarantineError) : null;
  const [rowAttempt, setRowAttempt] = useState(0);
  const [rowRetries, setRowRetries] = useState<ReadonlyMap<string, number>>(new Map());
  const wantedRows = entries.flatMap(({ id, source }) => {
    const tcw = source.tcw;
    const native = natives.get(id);
    const rowExists = source.rowExists || native?.audio?.rowId != null || native?.audio?.state === "saved";
    // Not before the phone has answered: its job state is part of what makes a note's row worth reading again.
    // A note that is not in the space has no row to read.
    if (source.metadata !== undefined || tcw === null || !rowExists || !nativeRead.ready) return [];
    const signal = [
      rowAttempt,
      rowRetries.get(id) ?? 0,
      pending.notes?.some((note) => note.id === id) ? "pending" : "settled",
      recorder.transcription?.jobs.get(id)?.kind ?? "",
      natives.get(id)?.stt?.state ?? "",
      onDeviceTranscriptSyncState(tcw, id)?.state ?? "",
      recordingNoteSyncedAt(tcw, id) ?? "",
    ].join("|");
    return [{ id, tcw, signal }];
  });
  const rows = useSpaceRows(wantedRows);
  useEffect(() => { timedOutRows.current = [...rows.values()].some((entry) => "error" in entry.read && entry.read.timeout === true); }, [rows]);
  // A read that ran out of time is tried once more when the write lane is idle (the uploads that held it up are done); Try again stays.
  const autoRetried = useRef(new Set<string>());
  useEffect(() => {
    const due: string[] = [];
    for (const { id, tcw } of wantedRows) {
      const entry = rows.get(id);
      const identity = spaceIdentity(tcw);
      if (entry === undefined || entry.identity !== identity) continue;
      const retryKey = `${identity}\t${id}`;
      if (!("error" in entry.read)) { autoRetried.current.delete(retryKey); continue; }
      if (allLanesBusy.current || entry.read.timeout !== true || autoRetried.current.has(retryKey)) continue;
      autoRetried.current.add(retryKey);
      due.push(id);
    }
    if (due.length > 0) setRowRetries((before) => { const next = new Map(before); for (const id of due) next.set(id, (before.get(id) ?? 0) + 1); return next; });
  }, [rows, laneIdleVersion, wantedRows]);
  const autoSyncVersion = useStoreVersion(subscribeAutoSync);
  const reread = useCallback(() => {
    nativeRead.reread();
    refreshQuarantine();
    setLocalAttempt((count) => count + 1);
    setRowAttempt((count) => count + 1);
  }, [nativeRead.reread, refreshQuarantine]);
  const device: PipelineDevice = platform === "tauri" ? "mac" : platform === "ios" ? "iphone" : platform === "android" ? "android" : "browser";
  const hasOnDevice = onDevicePipelineAvailable(platform);
  const { states, autoSyncs, autoTranscriptSyncs } = useMemo(() => {
    const out = new Map<string, PipelineState>();
    const wantsSync: { tcw: TinyCloudWeb; id: string; key: string }[] = [];
    const wantsTranscriptSync: { tcw: TinyCloudWeb; id: string; key: string; kind: "add" | "record"; recording: VoiceNoteRecording; context: ReturnType<typeof captureAccountContext> }[] = [];
    for (const { id, source } of entries) {
      const local = locals.get(id);
      const tcw = source.tcw;
      const native = natives.get(id) ?? null;
      const nativeRecording = native?.recording;
      const rowExists = source.rowExists || native?.audio?.rowId != null || native?.audio?.state === "saved";
      const rowEntry = source.metadata === undefined && tcw !== null && rowExists ? rows.get(id) : undefined;
      const row = rowEntry !== undefined && tcw !== null && rowEntry.identity === spaceIdentity(tcw) ? rowEntry.read : undefined;
      const rowAudio = source.metadata !== undefined ? source.metadata : row !== undefined && "metadata" in row ? row.metadata : null;
      const audioSaved = source.audioSaved || native?.audio?.state === "saved" || rowHasCommittedAudio(rowAudio)
        || rowAudio?.audio_stored === 0 || (rowAudio?.audio as { stored?: unknown } | undefined)?.stored === false;
      // The row's answer queues behind uploads on the write lane; the pipeline is shown from what the phone knows meanwhile (`spaceReading`).
      const spaceReading = source.metadata === undefined && tcw !== null && rowExists && row === undefined;
      if (local === undefined || !nativeRead.ready) continue;
      const issue = issues[id] ?? null;
      const rowError = row !== undefined && "error" in row ? row.error : null;
      const localNote = "note" in local ? local.note : null;
      const storeSync = tcw === null
        ? { syncing: false, failed: false, skip: null, syncedAt: null }
        : { syncing: recordingNoteSyncing(tcw, id), failed: recordingNoteSyncError(tcw, id) !== null, skip: recordingNoteSyncSkip(tcw, id), syncedAt: recordingNoteSyncedAt(tcw, id) };
      const facts: Omit<NotePipelineFacts, "noteSync"> = {
        id,
        device,
        online: pending.online,
        saved: audioSaved,
        rowMetadata: source.metadata !== undefined ? source.metadata : row !== undefined && "metadata" in row ? row.metadata : null,
        localNote,
        localNoteError: "error" in local ? local.error : null,
        native,
        readError: nativeRead.error ?? rowError,
        capture: { finalizing: recorder.finalizationPendingId === id && issue === null, issue, readError: captureReadError },
        pending: pending.notes?.find((note) => note.id === id) ?? null,
        lane: { busy: textLaneBusy, depth: textLaneDepth },
        onDeviceStatus: device !== "mac" && hasOnDevice ? onDeviceStatus : null,
        desktopJob: device === "mac" && hasOnDevice ? getDesktopWhisperQueue()?.snapshot().get(id) ?? null : null,
        transcriptSync: tcw === null ? null : onDeviceTranscriptSyncState(tcw, id),
        spaceReading,
        spaceAfterUploads: spaceReading && textLaneDepth > 0,
        cloudJob: recorder.transcription?.jobs.get(id) ?? null,
        cloudChecking: recorder.transcription?.availability === "checking",
      };
      // A saved note with text and no sync of this revision gets its automatic attempt (`useAutoNoteSync`); until it settles it is "syncing".
      let attempting = false;
      if (tcw !== null && audioSaved && !spaceReading && localNote !== null && localNote.hasContent && notesSyncState({ ...facts, noteSync: { ...storeSync, attempting: false } }).state === "idle") {
        const key = autoSyncKey(tcw, id, localNote.editedAt);
        attempting = !autoSync.settled.has(key);
        if (attempting) wantsSync.push({ tcw, id, key });
      }
      let input = buildNotePipelineInput({ ...facts, noteSync: { ...storeSync, attempting } });
      // A saved note whose on-device transcript is done, with none in the space and no write of it in this session, gets one
      // attempt (`useAutoTranscriptSync`); until it settles the transcript step is "adding", never a blocker.
      const onDevice = input.transcript.onDevice;
      if (tcw !== null && nativeRecording !== undefined && rowExists && (!audioSaved || !spaceReading) && isAccountWorkAllowed(tcw) && input.transcript.inSpace === null && input.transcript.readError == null && onDevice !== null && onDevice.sync === null && onDevice.stt?.state === "done") {
        const key = autoTranscriptKey(tcw, id, "add");
        if (!autoSync.settled.has(key)) {
          wantsTranscriptSync.push({ tcw, id, key, kind: "add", recording: nativeRecording, context: captureAccountContext(tcw) });
          input = buildNotePipelineInput({ ...facts, transcriptSync: { state: "syncing" }, noteSync: { ...storeSync, attempting } });
        }
      } else if (tcw !== null && nativeRecording !== undefined && rowExists && isAccountWorkAllowed(tcw) && input.transcript.inSpace !== null && onDevice !== null && onDevice.sync === null && onDevice.stt?.state === "done" && native?.transcriptSync != null && native.transcriptSync.state !== "saved") {
        // The space has it, the phone's ledger does not know: one repair of the ledger. Its failure is published and shown (`unrecorded`).
        const key = autoTranscriptKey(tcw, id, "record");
        if (!autoSync.settled.has(key)) wantsTranscriptSync.push({ tcw, id, key, kind: "record", recording: nativeRecording, context: captureAccountContext(tcw) });
      }
      out.set(id, { input, pipeline: notePipeline(input), native, rowMetadata: facts.rowMetadata });
    }
    return { states: out, autoSyncs: wantsSync, autoTranscriptSyncs: wantsTranscriptSync };
    // The store versions say the per-key getters read above have new answers.
  }, [entries, locals, rows, natives, nativeRead.ready, nativeRead.error, captureReadError, pending, textLaneBusy, textLaneDepth, onDeviceStatus, issues, recorder.finalizationPendingId, recorder.transcription, device, hasOnDevice, syncVersion, transcriptSyncVersion, whisperVersion, autoSyncVersion]);
  useAutoNoteSync(autoSyncs);
  useAutoTranscriptSync(autoTranscriptSyncs);
  return { states, natives, nativeReady: nativeRead.ready, reread };
}

/** Whether a note's audio is in the space. A pasted row counts as saved once its transcript text is in the space; an empty one does not. */
export function rowHasCommittedAudio(metadata: Record<string, unknown> | null | undefined): boolean {
  if (metadata === null || metadata === undefined) return false;
  if (metadata.capture === "pasted") return typeof metadata.transcript_text === "string" && metadata.transcript_text.trim().length > 0;
  const audio = metadata.audio;
  return metadata.audio_stored === true || metadata.audio_stored === 1
    || (typeof audio === "object" && audio !== null && "stored" in audio && audio.stored === true)
    || (typeof metadata.audio_kv_key === "string" && metadata.audio_kv_key.length > 0);
}

/**
 * Several notes' pipelines at once, each with its own action. A note is absent until its local Markdown and the phone's ledger
 * have been read. A note's `onAction` runs against the very input its `pipeline` was drawn from (not a later one), and its
 * rejection shows as that note's `actionError`. Memoise `entries`.
 */
export function useNotePipelines(entries: readonly { id: string; source: NotePipelineSource }[]): ReadonlyMap<string, NotePipelineView> {
  return useNotePipelinesWithLedger(entries).views;
}

/**
 * One note's pipeline and its action. Null until the note's local Markdown and the phone's ledger have been read (the notes
 * step and the route depend on them, so a stepper shown earlier would flash steps in or out).
 */
export function useNotePipeline(id: string | null, source: NotePipelineSource): NotePipelineView | null {
  return useNotePipelineWithLedger(id, source).view;
}

/**
 * `useNotePipeline`, and the phone's ledger entry for the note as soon as the shared read has answered (before the
 * space row has, which the pipeline also waits for). The receipt's route and "Use Private instead" offer need only the ledger.
 * `ledgerReady` false: not read yet. `ledger` null once read: the phone has no entry for the note.
 */
export function useNotePipelineWithLedger(id: string | null, source: NotePipelineSource): { view: NotePipelineView | null; ledger: NativeNote | null; ledgerReady: boolean } {
  const entries = useMemo(() => (id === null ? [] : [{ id, source }]), [id, source]);
  const { views, natives, nativeReady } = useNotePipelinesWithLedger(entries);
  return { view: id === null ? null : views.get(id) ?? null, ledger: id === null ? null : natives.get(id) ?? null, ledgerReady: id !== null && nativeReady };
}

function useNotePipelinesWithLedger(entries: readonly { id: string; source: NotePipelineSource }[]): {
  views: ReadonlyMap<string, NotePipelineView>;
  natives: ReadonlyMap<string, NativeNote>;
  nativeReady: boolean;
} {
  const recorder = useRecorder();
  const { states, natives, nativeReady, reread } = usePipelineStates(entries);
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const latest = useRef({ entries, recorder, reread, states });
  latest.current = { entries, recorder, reread, states };
  const run = useCallback((id: string, state: PipelineState, kind: PipelineActionKind, step?: StepKey) => {
    const { entries: current, recorder: rec, states: currentStates } = latest.current;
    state = currentStates.get(id) ?? state;
    const source = current.find((entry) => entry.id === id)?.source;
    if (source === undefined) return;
    setFailures((before) => { const next = new Map(before); next.delete(id); return next; });
    const rowMetadata = source.metadata ?? state.rowMetadata;
    const capture = rowMetadata?.capture;
    const captureDurationMs = capture !== null && typeof capture === "object" && !Array.isArray(capture)
      && typeof (capture as { duration_ms?: unknown }).duration_ms === "number"
      ? (capture as { duration_ms: number }).duration_ms : null;
    const recording = state.native?.recording;
    const metadataSource = privateAudioSourceFromMetadata(rowMetadata);
    const privateAudioSource = {
      capturePlatform: metadataSource.capturePlatform ?? (state.input.device === "browser" ? "web" : null),
      mimeType: metadataSource.mimeType ?? recording?.mimeType ?? null,
      sizeBytes: metadataSource.sizeBytes ?? recording?.sizeBytes ?? null,
    };
    void runPipelineAction(kind, {
      id,
      tcw: source.tcw,
      pipeline: step === undefined ? state.pipeline : { ...state.pipeline, current: step },
      input: state.input,
      native: state.native,
      transcription: rec.transcription,
      latestTranscription: () => latest.current.recorder.transcription,
      durationSecs: source.durationSecs ?? (captureDurationMs === null ? null : captureDurationMs / 1000)
        ?? (recording === undefined ? null : recording.durationMs / 1000),
      privateAudioSource,
      saveNow: rec.retryPending,
      signIn: rec.signIn,
      reviewConsent: rec.reviewPrivateConsent,
      reread: () => latest.current.reread(),
    }).then((reason) => {
      if (!live.current) return;
      if (reason !== null) console.error("[notePipeline] Action failed", { id, kind, reason });
      setFailures((before) => {
        const next = new Map(before);
        if (reason === null) next.delete(id);
        else next.set(id, reason === "Sign in to sync this note."
          || reason === privateRefusalCopy({ kind: "browser-wav-too-large" })
          ? reason : "Couldn't complete that action. Try again.");
        return next;
      });
    });
  }, []);
  const views = useMemo(() => new Map([...states].map(([id, state]): [string, NotePipelineView] => [id, {
    pipeline: state.pipeline,
    input: state.input,
    provider: state.input.route === "on-device" ? "local" : state.input.route === "off" ? "off" : state.input.transcriptProvider ?? "unknown",
    route: state.input.route,
    onAction: (kind) => run(id, state, kind),
    onRetryStep: (key) => run(id, state, "retry", key),
    actionError: state.pipeline.blocker === undefined ? null : failures.get(id) ?? null,
  }])), [states, failures, run]);
  return { views, natives, nativeReady };
}
