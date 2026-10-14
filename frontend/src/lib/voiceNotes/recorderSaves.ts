// The voice-note saves, shared by the recorder and by the app's save after
// sign-in (PendingVoiceNotesSaver). Module singletons, so there is one set of
// guards however many views mount (StrictMode mounts effects twice), moved
// here from the Voice notes card (TC-761, PR4). Never copy them into another
// module; a second set would save a recording twice.
//
// `pendingStore` is what the recorder views show about recordings awaiting a
// space save: what the phone last listed (unknown, a count, or a listing
// that failed), whether a save of them is running, and the last failure.
// `savePendingRecordings` publishes to it when it starts and ends.
//
// A recording the user discarded is marked (`markDiscarded`, PR5) before it is
// stopped, and every save deletes a marked recording instead of saving it.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  VoiceNotes,
  nativeRecordingSource,
  type VoiceNoteRecording,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { syncOnDeviceTranscript } from "@/lib/voiceNotes/onDeviceTranscriber";
import { saveVoiceNote, type NoteSyncErrorCode, type VoiceNoteAudio, type VoiceNoteAudioSource, type StoreAudioOptions } from "@/lib/voiceNotes/voiceNoteStore";
import { assertAccountContext, assertCurrent, captureAccountContext, type AccountContext } from "@/lib/voiceNotes/accountContext";
import { isLegacyNote } from "@/lib/voiceNotes/legacyMigration";
import { deleteNote } from "@/lib/voiceNotes/recordingNotes";
import { VoiceNoteSaveTimeout, withVoiceNoteSaveDeadline } from "@/lib/voiceNotes/saveDeadline";
import { readableError } from "@/lib/readableError";
import { logPipeline, logPipelineError } from "@/lib/debugLog";
import { putPendingSaveState, readPendingSaveStates } from "./pendingSaveState";
import { captureEvents } from "@/capture/captureEvents";
import { appPlatform } from "@/lib/platform";

export const TINYCLOUD_NETWORK_FAILURE_MESSAGE =
  "Couldn't reach your TinyCloud space. This note is still on your phone — try again.";
export const TINYCLOUD_UPLOAD_REJECTED_MESSAGE =
  "The TinyCloud node rejected this upload. This note is still on your phone — try again after the node is fixed.";

function rawErrorMessage(error: unknown): string {
  return readableError(error);
}

const NETWORK_FAILURE_SUFFIX = /(?:^|:\s)(?:Load failed|The network connection was lost\.|Fetch API cannot load .+? due to access control checks\.|Failed to fetch|NetworkError when attempting to fetch resource\.)\s*$/i;

export function isTinyCloudNetworkFailure(error: unknown): boolean {
  return NETWORK_FAILURE_SUFFIX.test(rawErrorMessage(error));
}

export function isTinyCloudUploadRejected(error: unknown): boolean {
  return /Fetch API cannot load .+? due to access control checks\./i.test(rawErrorMessage(error));
}

/** The native console gets only a stable code; the dev log holds a redacted error chain. */
export function logVoiceNoteError(operation: string, error: unknown): void {
  const rawCode = errorCode(error);
  const code = rawCode && /^[A-Za-z0-9_-]{1,64}$/.test(rawCode) ? rawCode : null;
  logPipelineError(operation, error);
  console.warn(`[VoiceNotes] ${operation}${code ? ` (code=${code})` : ""}`);
}

/** Map WebKit's unhelpful network messages to specific recovery copy. */
export function messageOf(error: unknown): string {
  const message = rawErrorMessage(error);
  if (isTinyCloudUploadRejected(error)) {
    logVoiceNoteError("TinyCloud upload rejected", error);
    return TINYCLOUD_UPLOAD_REJECTED_MESSAGE;
  }
  if (isTinyCloudNetworkFailure(error)) {
    // Keep credential-bearing URLs out of the native console.
    logVoiceNoteError("TinyCloud network failure", error);
    return TINYCLOUD_NETWORK_FAILURE_MESSAGE;
  }
  logPipelineError("voice note", error);
  return message;
}

/** Explicitly put an older local-only recording in the space; changing the device default does not call this. */
export async function uploadLocalVoiceNote(tcw: TinyCloudWeb, id: string): Promise<void> {
  if (savesInFlight.has(id)) throw new Error("This note is already being saved");
  const recording = (await VoiceNotes.listPending()).recordings.find((note) => note.id === id);
  if (!recording || recording.owner !== tcw.did) throw new Error("Audio is not on this device");
  savesInFlight.add(id);
  try {
    const result = await saveVoiceNote(tcw, recording, nativeRecordingSource(recording), appPlatform(), {}, true);
    if (!result.ok) throw new Error(result.error.message);
    captureEvents.emit("library-changed", { source: "exo-voice-note", sourceId: id });
  } finally {
    savesInFlight.delete(id);
    publishSaveIdle();
  }
}

export function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}

/** Recordings being uploaded right now, across mounts (StrictMode mounts effects twice). */
const savesInFlight = new Set<string>();
const saveIdleListeners = new Set<() => void>();
/** A swap must not retire the service graph while a recording is writing. */
export function voiceNoteSaveBusy(): boolean {
  return savesInFlight.size > 0 || pendingRunInFlight !== null || trackedSavesInFlight > 0;
}

/** Resolve after the recording and the pending-run single-flight guard settle. */
export function whenVoiceNoteSavesIdle(): Promise<void> {
  if (!voiceNoteSaveBusy()) return Promise.resolve();
  return new Promise((resolve) => saveIdleListeners.add(resolve));
}

function publishSaveIdle(): void {
  if (voiceNoteSaveBusy()) return;
  for (const listener of saveIdleListeners) listener();
  saveIdleListeners.clear();
}
/**
 * Recordings this app session saved to the space: a late "autoStopped"
 * event or a pending retry that still lists one must not save it again.
 */
const savedThisSession = new Set<string>();

/**
 * Old bridge-reload marker. It is kept for migration, never used as evidence
 * that the durable native ledger was updated.
 */
export const VOICE_NOTE_CLOUD_SAVED_KEY = "exo.voiceNotes.cloudSaved";

function cloudSavedStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadCloudSaved(): Set<string> {
  const raw = cloudSavedStorage()?.getItem(VOICE_NOTE_CLOUD_SAVED_KEY);
  if (!raw) return new Set();
  try {
    const ids: unknown = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch (caught) {
    console.warn("[VoiceNotes] The saved-notes marker could not be read", caught);
    return new Set();
  }
}

const cloudSaved = loadCloudSaved();

function persistCloudSaved(): void {
  const storage = cloudSavedStorage();
  if (!storage) return;
  if (cloudSaved.size === 0) storage.removeItem(VOICE_NOTE_CLOUD_SAVED_KEY);
  else storage.setItem(VOICE_NOTE_CLOUD_SAVED_KEY, JSON.stringify([...cloudSaved]));
}

/** localStorage key: the recordings the user discarded whose device copy may still be on the phone. */
export const VOICE_NOTE_DISCARDED_KEY = "exo.voiceNotes.discarded";

/**
 * Discarded in this app session. localStorage keeps the same ids across a
 * relaunch (the app killed between stop and delete); without it the guard lasts
 * this session, and the worst case is a discarded note saved.
 */
const discardedThisSession = new Set<string>();

function storedDiscarded(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(VOICE_NOTE_DISCARDED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function storeDiscarded(ids: string[]): void {
  try {
    if (ids.length === 0) globalThis.localStorage?.removeItem(VOICE_NOTE_DISCARDED_KEY);
    else globalThis.localStorage?.setItem(VOICE_NOTE_DISCARDED_KEY, JSON.stringify(ids));
  } catch {
    // Best-effort: the guard then lasts this session only.
  }
}

/** The user discarded this recording: from now on every save deletes it instead. */
export function markDiscarded(id: string): void {
  discardedThisSession.add(id);
  const ids = storedDiscarded();
  if (!ids.includes(id)) storeDiscarded([...ids, id]);
}

export function isDiscarded(id: string): boolean {
  return discardedThisSession.has(id) || storedDiscarded().includes(id);
}

/** Recordings whose discard went through and whose device copy is gone, this session. */
const deletedThisSession = new Set<string>();

/** The user discarded this recording, and it is still marked or its copy has been deleted: it never became a saved note. */
export function wasDiscarded(id: string): boolean {
  return isDiscarded(id) || deletedThisSession.has(id);
}

/** It was not discarded after all (the discard failed): the guard goes, the recording stays. */
export function unmarkDiscarded(id: string): void {
  discardedThisSession.delete(id);
  const ids = storedDiscarded();
  if (ids.includes(id)) storeDiscarded(ids.filter((stored) => stored !== id));
}

/** Its device copy is gone: nothing is left to guard, and `wasDiscarded` still remembers it. */
export function clearDiscarded(id: string): void {
  deletedThisSession.add(id);
  unmarkDiscarded(id);
}

const discardDeletes = new Map<string, Promise<string | null>>();

/**
 * Delete a discarded recording's device copy, then forget it (both marks). A
 * failed delete leaves it marked, so the next save that meets it deletes it;
 * the error message when the phone kept it.
 */
export async function deleteDiscarded(id: string): Promise<string | null> {
  const existing = discardDeletes.get(id);
  if (existing) return existing;
  if (!isDiscarded(id)) return null;
  const deleting = deleteDiscardedOnce(id).finally(() => discardDeletes.delete(id));
  discardDeletes.set(id, deleting);
  return deleting;
}

async function deleteDiscardedOnce(id: string): Promise<string | null> {
  try {
    await withVoiceNoteSaveDeadline(`native deleteAudio id=${id}`, () => VoiceNotes.deleteAudio({ id }));
  } catch (caught) {
    return `Discarded, but this phone kept its copy: ${messageOf(caught)}`;
  }
  try {
    // Keep the discard marker until the local Markdown tombstone is durable.
    await deleteNote(id);
  } catch (caught) {
    return `Discarded audio, but this phone kept its note text: ${messageOf(caught)}`;
  }
  clearDiscarded(id);
  // Saved to the space before it was discarded: the local copy is gone, so that mark goes too.
  if (cloudSaved.delete(id)) {
    persistCloudSaved();
    savedThisSession.add(id);
  }
  return null;
}

/**
 * What saving one recording came to. Saving to the space retains the local
 * copy. `cleanupError` reports a native ledger update failure; the next run
 * still avoids a duplicate upload.
 *  - `saved`: in the space now.
 *  - `already-saved`: saved earlier; its device copy stays for playback.
 *  - `discarded`: the user discarded it; its device copy was deleted, not saved.
 *  - `in-flight`: another run is saving it right now.
 *  - `failed`: not in the space; it stays on the phone.
 */
export type SaveOutcome =
  | { kind: "saved"; audio: VoiceNoteAudio | null; cleanupError: string | null; noteSyncError?: NoteSyncErrorCode }
  | { kind: "already-saved"; cleanupError: string | null }
  | { kind: "discarded"; cleanupError: string | null }
  | { kind: "held"; reason: "signed-out" | "legacy" | "unowned" | "other-account" }
  | { kind: "in-flight" }
  | { kind: "failed"; failure: string; failureKind: "offline" | "rejected" | "timeout" | "quota" | "auth" | "server" | "source" | "other"; failureCause: unknown };

function failedOutcome(error: unknown): Extract<SaveOutcome, { kind: "failed" }> {
  if (errorCode(error) === "ROW_LEDGER_FAILED") {
    return { kind: "failed", failure: "Couldn't save this note to your space. It's still on this phone — try again.", failureKind: "other", failureCause: error };
  }
  return { kind: "failed", failure: messageOf(error), failureKind: classifyNoteFailure(error), failureCause: error };
}

async function recordRowId(
  tcw: TinyCloudWeb, recording: VoiceNoteRecording, ctx: AccountContext, rowId: string,
  checkActive: () => void,
): Promise<void> {
  let fresh = recording;
  for (let attempt = 0; attempt < 2; attempt++) {
    checkActive();
    const patch = { audio: { ...(fresh.ledger?.audio ?? { state: "pending" as const, rowId: null, at: null }), rowId } };
    try {
      await withVoiceNoteSaveDeadline(`native updateLedger row id=${recording.id}`, () => {
        checkActive();
        return VoiceNotes.updateLedger({ id: recording.id, did: ctx.did, rev: fresh.rev ?? 0, patch });
      });
      checkActive();
      pendingStore.recordRowCreated();
      if (recording.stt?.state === "done" || recording.stt?.state === "failed")
        void syncOnDeviceTranscript(tcw, { ...fresh, ledger: { ...fresh.ledger, audio: { ...patch.audio } } }, ctx);
      return;
    } catch (caught) {
      if (errorCode(caught) !== "rev_conflict") throw caught;
      checkActive();
      const current = (await withVoiceNoteSaveDeadline(`native listPending row id=${recording.id}`, () => {
        checkActive();
        return VoiceNotes.listPending();
      })).recordings.find((note) => note.id === recording.id);
      checkActive();
      if (!current || current.owner !== ctx.did || isLegacyNote(current)) throw caught;
      if (current.ledger?.audio.rowId === rowId) {
        pendingStore.recordRowCreated();
        if (current.stt?.state === "done" || current.stt?.state === "failed") void syncOnDeviceTranscript(tcw, current, ctx);
        return;
      }
      fresh = current;
    }
  }
  throw Object.assign(new Error("Could not record this phone's TinyCloud row"), { code: "ROW_LEDGER_FAILED" });
}

/**
 * Upload one committed recording, part by part from the device. The device copy
 * stays for local playback. Transcription reads the device copy after the upload,
 * so this save never buffers another copy in memory. The in-flight guard matters
 * because upsertMeeting's select-then-insert is not atomic: two concurrent saves
 * of one recording would write two rows.
 */
export async function saveRecording(
  tcw: TinyCloudWeb,
  recording: VoiceNoteRecording,
  onProgress?: (storedBytes: number, totalBytes: number) => void,
  onRowCreated?: () => void,
): Promise<SaveOutcome> {
  if (savesInFlight.has(recording.id)) return { kind: "in-flight" };
  // Discarded (a pending run, the limit's "autoStopped" or a relaunch met it): deleted, never
  // saved. Before the cloudSaved path, so a discarded note marked as in the space loses both marks.
  if (isDiscarded(recording.id)) return { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) };
  if (isLegacyNote(recording)) return { kind: "held", reason: "legacy" };
  if (!recording.owner) return { kind: "held", reason: "unowned" };
  if (recording.owner !== tcw.did) return { kind: "held", reason: "other-account" };
  const ctx = captureAccountContext({ did: tcw.did, spaceId: tcw.spaceId });
  const checkActive = () => {
    assertAccountContext(ctx, tcw);
    if (isDiscarded(recording.id)) throw new Error("Recording was discarded");
  };
  if (recording.ledger?.audio.state === "saved") {
    void syncOnDeviceTranscript(tcw, recording);
    return { kind: "already-saved", cleanupError: null };
  }
  // Old localStorage markers are never authority: a lost marker must be safe,
  // and a stale marker must not suppress a note whose native ledger is pending.
  if (savedThisSession.has(recording.id)) return { kind: "already-saved", cleanupError: null };
  savesInFlight.add(recording.id);
  try {
    const native = nativeRecordingSource(recording);
    const saved = await saveVoiceNote(tcw, recording, native, appPlatform(), { onProgress,
      onRowCreated: async (rowId) => { await recordRowId(tcw, recording, ctx, rowId, checkActive); onRowCreated?.(); },
      checkpoint: checkActive });
    if (!saved.ok) return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : failedOutcome(saved.error);
    if (isDiscarded(recording.id)) return { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) };
    // The device copy remains playable. This old marker is informational;
    // the indexed row and the native ledger decide idempotence.
    cloudSaved.add(recording.id);
    persistCloudSaved();
    let cleanupError: string | null = null;
    if (recording.owner) {
      const owner = recording.owner;
      try {
        checkActive();
        let fresh = (await withVoiceNoteSaveDeadline(`native listPending audio saved id=${recording.id}`, () => {
          checkActive();
          return VoiceNotes.listPending();
        })).recordings.find((note) => note.id === recording.id);
        checkActive();
        if (!fresh || isLegacyNote(fresh) || fresh.owner !== owner || fresh.rev === undefined) throw new Error("Could not reread this phone's note status");
        const patch = { audio: { state: "saved" as const, rowId: saved.data.id, at: Date.now() } };
        try {
          await withVoiceNoteSaveDeadline(`native updateLedger id=${recording.id}`, () => {
            checkActive();
            return VoiceNotes.updateLedger({ id: recording.id, did: owner, rev: fresh!.rev!, patch });
          });
          checkActive();
        } catch (caught) {
          if (errorCode(caught) !== "rev_conflict") throw caught;
          checkActive();
          fresh = (await withVoiceNoteSaveDeadline(`native listPending id=${recording.id}`, () => { checkActive(); return VoiceNotes.listPending(); })).recordings.find((note) => note.id === recording.id);
          checkActive();
          if (!fresh || isLegacyNote(fresh) || fresh.owner !== owner || fresh.rev === undefined) throw caught;
          if (fresh.ledger?.audio?.state !== "saved") {
            const rev = fresh.rev;
            await withVoiceNoteSaveDeadline(`native updateLedger id=${recording.id}`, () => { checkActive(); return VoiceNotes.updateLedger({ id: recording.id, did: owner, rev, patch }); });
            checkActive();
          }
        }
        savedThisSession.add(recording.id);
      } catch (caught) {
        cleanupError = `Saved to your space, but this phone could not update its note status: ${messageOf(caught)}`;
      }
      void syncOnDeviceTranscript(tcw, { id: recording.id, ledger: { audio: { state: "saved" } } });
    }
    return {
      kind: "saved",
      audio: null,
      cleanupError,
      noteSyncError: saved.data.noteSyncError,
    };
  } catch (caught) {
    return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : failedOutcome(caught);
  } finally {
    savesInFlight.delete(recording.id);
    publishSaveIdle();
  }
}

/** The one owner-aware upload entry point used by the T18 pipeline. */
export async function saveNoteForAccount(tcw: TinyCloudWeb, ctx: AccountContext,
  recording: VoiceNoteRecording, checkpoint: () => void = () => undefined,
  audioOptions: Pick<StoreAudioOptions, "retryDelaysMs" | "onProgress" | "onRetry" | "onUploadStart"> &
    { uploadTicket?: PendingUploadTicket; onRowCreated?: () => void } = {}): Promise<SaveOutcome> {
  const check = () => { assertCurrent(ctx); checkpoint(); };
  const checkActive = () => { check(); if (isDiscarded(recording.id)) throw new Error("Recording was discarded"); };
  check();
  if (isDiscarded(recording.id)) return { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) };
  if (tcw.did !== ctx.did || tcw.spaceId !== ctx.spaceId) return { kind: "held", reason: "other-account" };
  if (isLegacyNote(recording)) return { kind: "held", reason: "legacy" };
  if (!recording.owner) return { kind: "held", reason: "unowned" };
  if (recording.owner !== ctx.did) return { kind: "held", reason: "other-account" };
  if (recording.ledger?.audio.state === "saved") return { kind: "already-saved", cleanupError: null };
  if (audioOptions.uploadTicket && !audioOptions.uploadTicket.owns) return { kind: "in-flight" };
  if (savesInFlight.has(recording.id)) return { kind: "in-flight" };
  savesInFlight.add(recording.id);
  const ticket = audioOptions.uploadTicket ?? pendingStore.enqueueUpload(recording);
  if (!ticket.owns) {
    savesInFlight.delete(recording.id);
    return { kind: "in-flight" };
  }
  const uploadOwner = ticket.owner;
  pendingStore.beginUpload(recording, ticket);
  try {
    const source = nativeRecordingSource(recording);
    const checkedSource: VoiceNoteAudioSource = { ...source, readPart: async (offset, length) => {
      checkActive();
      return source.readPart(offset, length);
    } };
    const saved = await saveVoiceNote(tcw, recording, checkedSource, appPlatform(), {
      ...audioOptions,
      onRowCreated: async (rowId) => { await recordRowId(tcw, recording, ctx, rowId, checkActive); audioOptions.onRowCreated?.(); },
      onUploadStart: (total) => {
        pendingStore.publishUpload(recording.id, uploadOwner, { state: "uploading", bytes: 0, total });
        audioOptions.onUploadStart?.(total);
      },
      onProgress: (bytes, total) => {
        pendingStore.publishUpload(recording.id, uploadOwner, { state: "uploading", bytes, total });
        audioOptions.onProgress?.(bytes, total);
      },
      onRetry: (attempt, code) => {
        logPipeline("audio_upload", recording.id, "retry");
        const current = uploadStates.get(recording.id)?.upload;
        pendingStore.publishUpload(recording.id, uploadOwner, { state: "retrying", bytes: current?.bytes ?? 0, total: current?.total ?? recording.sizeBytes });
        audioOptions.onRetry?.(attempt, code);
      },
      checkpoint: checkActive,
    });
    if (!saved.ok) return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : failedOutcome(saved.error);
    checkActive();
    const patch = { audio: { state: "saved" as const, rowId: saved.data.id, at: Date.now() } };
    let fresh = recording;
    for (let attempt = 0; attempt < 2; attempt++) {
      check();
      try {
        await withVoiceNoteSaveDeadline(`native updateLedger id=${recording.id}`, () => VoiceNotes.updateLedger({ id: recording.id, did: ctx.did, rev: fresh.rev ?? 0, patch }));
        return { kind: "saved", audio: null, cleanupError: null, noteSyncError: saved.data.noteSyncError };
      } catch (caught) {
        if (errorCode(caught) !== "rev_conflict") throw caught;
        check();
        const current = (await withVoiceNoteSaveDeadline(`native listPending id=${recording.id}`, () => VoiceNotes.listPending())).recordings.find((note) => note.id === recording.id);
        if (!current || current.owner !== ctx.did || isLegacyNote(current)) throw caught;
        if (current.ledger?.audio.state === "saved") return { kind: "saved", audio: null, cleanupError: null,
          noteSyncError: saved.data.noteSyncError };
        fresh = current;
      }
    }
    return failedOutcome(Object.assign(new Error("Could not update this phone's saved-note status"), { code: "STORE_ERROR" }));
  } catch (caught) {
    return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : failedOutcome(caught);
  } finally {
    if (!audioOptions.uploadTicket) pendingStore.settleUploadQueue(ticket);
    savesInFlight.delete(recording.id);
    publishSaveIdle();
  }
}

export interface PendingRun {
  total: number;
  /** Not in the space: they stay on the phone. */
  left: VoiceNoteRecording[];
  /** Saved to the space by this run. */
  saved: VoiceNoteRecording[];
  lastError: string | null;
}

let pendingRunInFlight: Promise<PendingRun> | null = null;
let trackedSavesInFlight = 0;
let activeAccountDid: string | null = null;
/** Bumped whenever the active account changes, so a run can tell "not registered yet" from "signed out since". */
let accountChanges = 0;
type NoteFailure = NonNullable<PendingNote["failed"]>;
const noteFailures = new Map<string, NoteFailure>();
const heldReasons = new Map<string, NonNullable<PendingNote["held"]>>();
const retryTimes = new Map<string, number>();
function persistNoteStatus(id: string): void {
  void putPendingSaveState(activeAccountDid, { id, failed: noteFailures.get(id), held: heldReasons.get(id), retryAt: retryTimes.get(id) })
    .catch((error) => console.warn("[VoiceNotes] Could not retain this note's save status", error));
}
type UploadProgress = NonNullable<PendingNote["upload"]>;
export interface PendingUploadTicket { id: string; owner: symbol; owns: boolean }
const uploadStates = new Map<string, {
  owner: symbol;
  upload: UploadProgress;
  waitingBehind: number;
  lastPublishedAt: number;
  lastPercent: number;
}>();
let generalFailure: string | null = null;
let statusRestoreGeneration = 0;

function currentFailure(): string | null {
  return generalFailure ?? [...noteFailures.values()].at(-1)?.message ?? null;
}

function failureStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const meta = (error as { meta?: unknown }).meta;
    if (meta && typeof meta === "object" && typeof (meta as { status?: unknown }).status === "number") return (meta as { status: number }).status;
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  const match = rawErrorMessage(error).match(/Failed to execute query:\s*([45]\d\d)\b/i);
  return match ? Number(match[1]) : undefined;
}

export function classifyNoteFailure(error: unknown): NoteFailure["kind"] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4 && !chain.includes(current); depth++) {
    chain.push(current);
    current = current && typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause : undefined;
  }
  const explicitKind = chain.map((item) => item && typeof item === "object"
    ? (item as { failureKind?: unknown }).failureKind : undefined)
    .find((kind) => kind === "offline" || kind === "rejected" || kind === "timeout" || kind === "quota" || kind === "auth"
      || kind === "server" || kind === "source" || kind === "other");
  if (explicitKind) return explicitKind as NoteFailure["kind"];
  const codes = chain.map((item) => errorCode(item)?.toUpperCase() ?? "");
  const messages = chain.map(rawErrorMessage);
  const statuses = chain.map(failureStatus);
  if (codes.some((code) => code === "VOICE_NOTE_SOURCE_READ_FAILED" || code === "VOICE_NOTE_AUDIO_TOO_LARGE"
    || code === "STORE_CORRUPT_AUDIO" || code === "VOICE_NOTE_AUDIO_CORRUPT")) return "source";
  if (codes.some((code) => code === "STORAGE_QUOTA_EXCEEDED" || code === "STORAGE_LIMIT_REACHED" || /quota/i.test(code))) return "quota";
  if (statuses.some((status) => status === 401 || status === 403)
    || codes.some((code) => /AUTH|UNAUTHENTICATED|UNAUTHORIZED|FORBIDDEN|CAPABILITY/.test(code))) return "auth";
  if (statuses.some((status) => status !== undefined && status >= 500)
    || codes.some((code) => /SERVER_ERROR|INTERNAL_SERVER/.test(code))) return "server";
  if (chain.some((item) => item instanceof VoiceNoteSaveTimeout
    || (item && typeof item === "object" && (item as { name?: unknown }).name === "VoiceNoteSaveTimeout"))
    || codes.some((code) => code === "SPACE_LANE_QUEUE_TIMEOUT" || code === "VOICE_NOTE_OPERATION_TIMEOUT" || /timeout|timed out/i.test(code))) return "timeout";
  if (chain.some(isTinyCloudUploadRejected)) return "rejected";
  if (chain.some(isTinyCloudNetworkFailure) || codes.includes("NETWORK_ERROR")
    || messages.some((message) => /offline|network|failed to fetch|load failed/i.test(message))) return "offline";
  return "other";
}

function clearPendingErrors(): void {
  generalFailure = null;
  const cleared = [...noteFailures.keys()];
  noteFailures.clear();
  for (const id of cleared) persistNoteStatus(id);
  const notes = pendingSnapshot.notes?.map(({ failed: _failed, ...note }) => note);
  publishPending({ lastError: null, notes });
}

/**
 * Retry every recording still on the device, oldest first, one at a time. Single-flight: the
 * recorder and the app's save after sign-in (PendingVoiceNotesSaver) share it. Afterwards the
 * phone is listed again and saved copies are excluded from the pending count.
 */
export function savePendingRecordings(tcw: TinyCloudWeb): Promise<PendingRun> {
  if (pendingRunInFlight) return pendingRunInFlight;
  clearPendingErrors();
  publishPending({ running: true });
  pendingRunInFlight = (async () => {
    let recordings: VoiceNoteRecording[];
    try {
      ({ recordings } = await withVoiceNoteSaveDeadline("native listPending for pending saves", () => VoiceNotes.listPending()));
    } catch (caught) {
      // Nothing is known about the phone: told as such, never as "nothing pending".
      const message = listingFailure(caught);
      publishPending({ listing: { state: "error", message } });
      return { total: 0, left: [], saved: [], lastError: message };
    }
    const left: VoiceNoteRecording[] = [];
    const saved: VoiceNoteRecording[] = [];
    let lastError: string | null = null;
    for (const recording of [...recordings].sort((a, b) => a.startedAt - b.startedAt)) {
      const outcome = await saveRecording(tcw, recording);
      if (outcome.kind === "saved") {
        noteFailures.delete(recording.id);
        heldReasons.delete(recording.id);
        retryTimes.delete(recording.id);
        persistNoteStatus(recording.id);
        saved.push(recording);
        if (outcome.cleanupError) lastError = outcome.cleanupError;
      } else if (outcome.kind === "already-saved" || outcome.kind === "discarded") {
        noteFailures.delete(recording.id);
        heldReasons.delete(recording.id);
        retryTimes.delete(recording.id);
        persistNoteStatus(recording.id);
        if (outcome.cleanupError) lastError = outcome.cleanupError;
      } else if (outcome.kind === "held") {
        left.push(recording);
      } else if (outcome.kind === "failed") {
        left.push(recording);
        lastError = outcome.failure;
        noteFailures.set(recording.id, { kind: outcome.failureKind, message: outcome.failure });
        persistNoteStatus(recording.id);
      }
      // Publish each note's new ledger state as soon as its save settles. A long
      // reconcile pass must not leave the Capture count stale until its last note.
      await relistPending(lastError);
    }
    return { total: recordings.length, left, saved, lastError };
  })().finally(() => {
    pendingRunInFlight = null;
    publishPending({ running: trackedSavesInFlight > 0 });
    publishSaveIdle();
  });
  return pendingRunInFlight;
}

/** What the phone last listed as pending: not yet asked, a count, or a listing that failed. */
export type PendingListing = { state: "unknown" } | { state: "ok"; count: number } | { state: "error"; message: string };

/** One recording still on the device, as the Library lists it until its space row lands. */
export interface PendingNote {
  id: string;
  startedAt: number;
  durationMs: number;
  /** This note failed its latest save attempt, so its Recent row must not imply it's still saving. */
  failed?: { kind: "offline" | "rejected" | "timeout" | "quota" | "auth" | "server" | "source" | "other"; message: string };
  held?: "signed-out" | "other-account" | "legacy" | "unowned";
  retryAt?: number;
  upload?: { state: "waiting" | "preparing" | "uploading" | "retrying"; bytes: number; total: number };
  waitingBehind?: number;
}

/** Recordings awaiting a space save, as the recorder views show them. */
export interface PendingSnapshot {
  listing: PendingListing;
  /** The recordings behind a `listing` of state "ok" (this account's); absent until listed, after a failed listing, and in screen fixtures. */
  notes?: PendingNote[];
  /** Which signed-in account this listing was filtered for. */
  accountDid?: string | null;
  /** A save of them is running (savePendingRecordings). */
  running: boolean;
  lastError: string | null;
  uploadingId: string | null;
  online: boolean;
  /** Bumped when a new space row id is written to the phone ledger. */
  rowVersion?: number;
}

/** How many notes await a space save (0 when unknown or the listing failed). */
export function pendingCount(snapshot: Pick<PendingSnapshot, "listing">): number {
  return snapshot.listing.state === "ok" ? snapshot.listing.count : 0;
}

let pendingSnapshot: PendingSnapshot = { listing: { state: "unknown" }, accountDid: null, running: false, lastError: null,
  uploadingId: null, rowVersion: 0, online: typeof navigator === "undefined" ? true : navigator.onLine !== false };
const pendingListeners = new Set<() => void>();

function publishPending(patch: Partial<PendingSnapshot>): void {
  pendingSnapshot = { ...pendingSnapshot, ...patch };
  for (const listener of pendingListeners) listener();
}

function activeUploadId(): string | null {
  for (const [id, state] of uploadStates) {
    if (state.upload.state === "uploading" || state.upload.state === "retrying") return id;
  }
  return null;
}

function mergeUploadState(note: PendingNote): PendingNote {
  const state = uploadStates.get(note.id);
  return state ? { ...note, upload: state.upload, waitingBehind: state.waitingBehind } : note;
}

function publishUploadQueue(notes = pendingSnapshot.notes): void {
  let ahead = 0;
  for (const state of uploadStates.values()) {
    state.waitingBehind = state.upload.state === "waiting" ? ahead : 0;
    ahead++;
  }
  publishPending({ uploadingId: activeUploadId(), notes: notes?.map(mergeUploadState) });
}

function publishOwnedUpload(id: string, owner: symbol, upload: UploadProgress): void {
  const state = uploadStates.get(id);
  if (!state || state.owner !== owner) return;
  const now = Date.now();
  const percent = upload.total > 0 ? Math.floor(upload.bytes / upload.total * 100) : 0;
  if (upload.state === "uploading" && state.upload.state === "uploading" && percent - state.lastPercent < 1 && now - state.lastPublishedAt < 250) return;
  state.upload = upload;
  state.lastPublishedAt = now;
  state.lastPercent = percent;
  publishUploadQueue();
}

function beginTrackedSave(): () => void {
  trackedSavesInFlight++;
  publishPending({ running: true });
  return () => {
    trackedSavesInFlight--;
    publishPending({ running: trackedSavesInFlight > 0 || pendingRunInFlight !== null });
    publishSaveIdle();
  };
}

export const pendingStore = {
  /** The same object until something changes (useSyncExternalStore). */
  snapshot(): PendingSnapshot {
    return pendingSnapshot;
  },
  recordRowCreated(): void {
    publishPending({ rowVersion: (pendingSnapshot.rowVersion ?? 0) + 1 });
  },
  subscribe(listener: () => void): () => void {
    pendingListeners.add(listener);
    return () => {
      pendingListeners.delete(listener);
    };
  },
  /** Count the phone's unsaved notes again, with what went wrong, if anything. */
  refresh(lastError?: string | null): Promise<void> {
    return relistPending(lastError);
  },
  /** The failure no single note owns (the account is not ready, the defaults could not be claimed); null when there is none. */
  generalError(): string | null {
    return generalFailure;
  },
  /** A retry that cannot start still needs a visible result beside Save now. */
  reportError(message: string): void {
    generalFailure = message;
    publishPending({ lastError: currentFailure() });
  },
  /**
   * Writes for a run on behalf of `did`, valid only in the account session the run began in: while nothing has
   * changed since (`did` active, or no account registered yet), or after exactly the first registration of `did` when
   * none was registered at the start (the saver registers the signed-in account just after mount). Any later change
   * (another account, a sign-out, a return to the same account) ends the session: its writes are dropped (a dropped
   * error is logged), so a late result never clears or replaces a later session's state.
   */
  forAccount(did: string): { refresh(lastError?: string | null): Promise<void>; reportError(message: string): void } {
    const startedAs = activeAccountDid;
    const changesAtStart = accountChanges;
    const current = () => accountChanges === changesAtStart
      ? activeAccountDid === did || activeAccountDid === null
      : startedAs === null && accountChanges === changesAtStart + 1 && activeAccountDid === did;
    return {
      refresh: (lastError) => (current() ? relistPending(lastError) : Promise.resolve()),
      reportError: (message) => {
        if (current()) pendingStore.reportError(message);
        else console.warn("[VoiceNotes] Dropped a pending-save error from a previous account", message);
      },
    };
  },
  reportNoteFailure(id: string, error: unknown): void {
    const visibleMessage = messageOf(error);
    const failure = { kind: classifyNoteFailure(error), message: visibleMessage };
    noteFailures.delete(id);
    noteFailures.set(id, failure);
    retryTimes.delete(id);
    persistNoteStatus(id);
    publishPending({
      lastError: currentFailure(),
      notes: pendingSnapshot.notes?.map((note) => note.id === id ? { ...note, failed: failure } : note),
    });
  },
  setOnline(online: boolean): void { publishPending({ online }); },
  setRetrying(id: string, at: number | null): void {
    if (at === null) retryTimes.delete(id);
    else retryTimes.set(id, at);
    persistNoteStatus(id);
    publishPending({ notes: pendingSnapshot.notes?.map((note) => note.id === id ? { ...note, retryAt: at ?? undefined } : note) });
  },
  retryAt(id: string): number | undefined { return retryTimes.get(id); },
  setHeld(id: string, held: PendingNote["held"]): void {
    if (held) heldReasons.set(id, held);
    else heldReasons.delete(id);
    persistNoteStatus(id);
    publishPending({ notes: pendingSnapshot.notes?.map((note) => note.id === id ? { ...note, held } : note) });
  },
  enqueueUpload(recording: VoiceNoteRecording | string): PendingUploadTicket {
    const id = typeof recording === "string" ? recording : recording.id;
    const existing = uploadStates.get(id);
    if (existing) return { id, owner: existing.owner, owns: false };
    const owner = Symbol(id);
    heldReasons.delete(id);
    uploadStates.set(id, { owner, upload: { state: "waiting", bytes: 0,
      total: typeof recording === "string" ? 0 : recording.sizeBytes }, waitingBehind: 0, lastPublishedAt: 0, lastPercent: -1 });
    publishUploadQueue();
    return { id, owner, owns: true };
  },
  beginUpload(recording: VoiceNoteRecording, ticket: PendingUploadTicket): void {
    const state = uploadStates.get(recording.id);
    if (!ticket.owns || !state || state.owner !== ticket.owner) return;
    heldReasons.delete(recording.id);
    state.upload = { state: "waiting", bytes: 0, total: recording.sizeBytes };
    publishUploadQueue();
  },
  preparingUpload(ticket: PendingUploadTicket): void {
    const state = uploadStates.get(ticket.id);
    if (!ticket.owns || !state || state.owner !== ticket.owner) return;
    state.upload = { ...state.upload, state: "preparing" };
    publishUploadQueue();
  },
  publishUpload(id: string, owner: symbol, upload: UploadProgress): void {
    publishOwnedUpload(id, owner, upload);
  },
  settleUploadQueue(ticket: PendingUploadTicket): void {
    if (!ticket.owns || uploadStates.get(ticket.id)?.owner !== ticket.owner) return;
    uploadStates.delete(ticket.id);
    const notes = pendingSnapshot.notes?.map((note) => {
      if (note.id === ticket.id) {
        const { upload: _upload, waitingBehind: _waitingBehind, ...rest } = note;
        return rest;
      }
      return note;
    });
    publishUploadQueue(notes);
  },
  clearNoteFailure(id: string): void {
    if (!noteFailures.delete(id)) return;
    persistNoteStatus(id);
    const notes = pendingSnapshot.notes?.map((note) => {
      if (note.id !== id || !note.failed) return note;
      const { failed: _failed, ...rest } = note;
      return rest;
    });
    publishPending({ lastError: currentFailure(), notes });
  },
  setAccount(did: string | null): void {
    if (activeAccountDid !== did) {
      accountChanges++;
      noteFailures.clear();
      heldReasons.clear();
      retryTimes.clear();
      generalFailure = null;
      publishPending({ accountDid: did, listing: { state: "unknown" }, notes: undefined, lastError: null });
    }
    activeAccountDid = did;
    void relistPending(null);
  },
  /** Track the whole automatic pipeline, including its cloud preflight. */
  beginAutomaticSave: beginTrackedSave,
  /** The owner-aware manual retry uses the same saving state as the legacy path. */
  beginManualSave: () => { clearPendingErrors(); return beginTrackedSave(); },
};

function listingFailure(caught: unknown): string {
  return `Could not check this phone for unsaved notes: ${messageOf(caught)}`;
}

/** Re-list the phone and exclude retained copies already saved to the space. */
async function relistPending(lastError?: string | null): Promise<void> {
  const restoreGeneration = ++statusRestoreGeneration;
  if (lastError !== undefined) generalFailure = lastError;
  try {
    const { recordings } = await withVoiceNoteSaveDeadline("native listPending for pending count", () => VoiceNotes.listPending());
    const visible = activeAccountDid
      ? recordings.filter((recording) => !recording.owner || recording.owner === activeAccountDid)
      : recordings;
    const pending = visible.filter((recording) =>
      isDiscarded(recording.id) || (recording.ledger?.audio.state !== "saved" && !savedThisSession.has(recording.id)),
    );
    const pendingIds = new Set(pending.map((note) => note.id));
    for (const id of noteFailures.keys()) if (!pendingIds.has(id)) noteFailures.delete(id);
    const notes = pending
      .filter((recording) => !isDiscarded(recording.id))
      .map((recording) => ({ id: recording.id, startedAt: recording.startedAt, durationMs: recording.durationMs,
        ...(noteFailures.has(recording.id) ? { failed: noteFailures.get(recording.id)! } : {}),
        ...(retryTimes.has(recording.id) ? { retryAt: retryTimes.get(recording.id)! } : {}),
        ...(uploadStates.has(recording.id) ? { upload: uploadStates.get(recording.id)!.upload,
          waitingBehind: uploadStates.get(recording.id)!.waitingBehind } : {}),
        ...((activeAccountDid ? heldReasons.get(recording.id) : "signed-out") ?
          { held: activeAccountDid ? heldReasons.get(recording.id)! : "signed-out" as const } : {}) }));
    publishPending({ accountDid: activeAccountDid, listing: { state: "ok", count: pending.length }, notes, lastError: currentFailure() });
    const did = activeAccountDid;
    void readPendingSaveStates(did, [...pendingIds]).then((retained) => {
      if (restoreGeneration !== statusRestoreGeneration || did !== activeAccountDid) return;
      if (retained.size === 0) return;
      for (const [id, status] of retained) {
        if (!pendingIds.has(id)) continue;
        if (status.failed && !noteFailures.has(id)) noteFailures.set(id, status.failed);
        if (status.held && !heldReasons.has(id)) heldReasons.set(id, status.held);
        if (status.retryAt && !retryTimes.has(id)) retryTimes.set(id, status.retryAt);
      }
      publishPending({ notes: pendingSnapshot.notes?.map((note) => ({ ...note,
        ...(noteFailures.has(note.id) ? { failed: noteFailures.get(note.id)! } : {}),
        ...(heldReasons.has(note.id) ? { held: heldReasons.get(note.id)! } : {}),
        ...(retryTimes.has(note.id) ? { retryAt: retryTimes.get(note.id)! } : {}),
      })), lastError: currentFailure() });
    }).catch((error) => console.warn("[VoiceNotes] Could not restore pending save status", error));
  } catch (caught) {
    publishPending({ listing: { state: "error", message: listingFailure(caught) }, notes: undefined, lastError: currentFailure() });
  }
}
