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
  nativePlatform,
  nativeRecordingSource,
  type VoiceNoteRecording,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { bytesToBase64, VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS } from "@/lib/voiceNotes/voiceNoteAudio";
import { syncOnDeviceTranscript } from "@/lib/voiceNotes/onDeviceTranscriber";
import { saveVoiceNote, type NoteSyncErrorCode, type VoiceNoteAudio, type VoiceNoteAudioSource } from "@/lib/voiceNotes/voiceNoteStore";
import { assertCurrent, type AccountContext } from "@/lib/voiceNotes/accountContext";
import { isLegacyNote } from "@/lib/voiceNotes/legacyMigration";
import { deleteNote } from "@/lib/voiceNotes/recordingNotes";

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
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

/** Its device copy is gone: nothing is left to guard. */
export function clearDiscarded(id: string): void {
  discardedThisSession.delete(id);
  const ids = storedDiscarded();
  if (ids.includes(id)) storeDiscarded(ids.filter((stored) => stored !== id));
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
    await VoiceNotes.deleteAudio({ id });
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
  | { kind: "held"; reason: "legacy" | "unowned" | "other-account" }
  | { kind: "in-flight" }
  | { kind: "failed"; failure: string };

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Upload one committed recording, part by part from the device. The device copy
 * stays for local playback. A saved note carries its audio when it is short enough
 * to transcribe and every part was read in this attempt (handed to transcription, so it is
 * not read back). The in-flight guard matters because upsertMeeting's select-then-insert is
 * not atomic: two concurrent saves of one recording would write two rows.
 */
export async function saveRecording(
  tcw: TinyCloudWeb,
  recording: VoiceNoteRecording,
  onProgress?: (storedBytes: number, totalBytes: number) => void,
): Promise<SaveOutcome> {
  if (savesInFlight.has(recording.id)) return { kind: "in-flight" };
  // Discarded (a pending run, the limit's "autoStopped" or a relaunch met it): deleted, never
  // saved. Before the cloudSaved path, so a discarded note marked as in the space loses both marks.
  if (isDiscarded(recording.id)) return { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) };
  if (isLegacyNote(recording)) return { kind: "held", reason: "legacy" };
  if (!recording.owner) return { kind: "held", reason: "unowned" };
  if (recording.owner !== tcw.did) return { kind: "held", reason: "other-account" };
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
    const kept: Uint8Array[] = [];
    const keep = recording.durationMs <= VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS * 1000;
    const source: VoiceNoteAudioSource = keep
      ? {
          ...native,
          readPart: async (offset, length) => {
            const bytes = await native.readPart(offset, length);
            kept.push(bytes);
            return bytes;
          },
        }
      : native;
    const saved = await saveVoiceNote(tcw, recording, source, nativePlatform(), { onProgress,
      checkpoint: () => { if (isDiscarded(recording.id)) throw new Error("Recording was discarded"); } });
    if (!saved.ok) return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : { kind: "failed", failure: saved.error.message };
    if (isDiscarded(recording.id)) return { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) };
    // The device copy remains playable. This old marker is informational;
    // the indexed row and the native ledger decide idempotence.
    cloudSaved.add(recording.id);
    persistCloudSaved();
    let cleanupError: string | null = null;
    if (recording.owner) {
      try {
        const patch = { audio: { state: "saved" as const, rowId: saved.data.id, at: Date.now() } };
        try {
          await VoiceNotes.updateLedger({ id: recording.id, did: recording.owner, rev: recording.rev ?? 0, patch });
        } catch (caught) {
          if (errorCode(caught) !== "rev_conflict") throw caught;
          const fresh = (await VoiceNotes.listPending()).recordings.find((note) => note.id === recording.id);
          if (!fresh || isLegacyNote(fresh) || fresh.owner !== recording.owner || fresh.rev === undefined) throw caught;
          if (fresh.ledger?.audio?.state !== "saved") {
            await VoiceNotes.updateLedger({ id: recording.id, did: recording.owner, rev: fresh.rev, patch });
          }
        }
        savedThisSession.add(recording.id);
      } catch (caught) {
        cleanupError = `Saved to your space, but this phone could not update its note status: ${messageOf(caught)}`;
      }
      void syncOnDeviceTranscript(tcw, { id: recording.id, ledger: { audio: { state: "saved" } } });
    }
    const whole = keep && kept.reduce((n, c) => n + c.byteLength, 0) === native.size;
    return {
      kind: "saved",
      audio: whole ? { mimeType: recording.mimeType, base64: bytesToBase64(concatBytes(kept)) } : null,
      cleanupError,
      noteSyncError: saved.data.noteSyncError,
    };
  } catch (caught) {
    return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : { kind: "failed", failure: messageOf(caught) };
  } finally {
    savesInFlight.delete(recording.id);
    publishSaveIdle();
  }
}

/** The one owner-aware upload entry point used by the T18 pipeline. */
export async function saveNoteForAccount(tcw: TinyCloudWeb, ctx: AccountContext,
  recording: VoiceNoteRecording, checkpoint: () => void = () => undefined): Promise<SaveOutcome> {
  const check = () => { assertCurrent(ctx); checkpoint(); };
  const checkActive = () => { check(); if (isDiscarded(recording.id)) throw new Error("Recording was discarded"); };
  check();
  if (isDiscarded(recording.id)) return { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) };
  if (tcw.did !== ctx.did || tcw.spaceId !== ctx.spaceId) return { kind: "held", reason: "other-account" };
  if (isLegacyNote(recording)) return { kind: "held", reason: "legacy" };
  if (!recording.owner) return { kind: "held", reason: "unowned" };
  if (recording.owner !== ctx.did) return { kind: "held", reason: "other-account" };
  if (recording.ledger?.audio.state === "saved") return { kind: "already-saved", cleanupError: null };
  if (savesInFlight.has(recording.id)) return { kind: "in-flight" };
  savesInFlight.add(recording.id);
  try {
    const source = nativeRecordingSource(recording);
    const checkedSource: VoiceNoteAudioSource = { ...source, readPart: async (offset, length) => {
      checkActive();
      return source.readPart(offset, length);
    } };
    const saved = await saveVoiceNote(tcw, recording, checkedSource, nativePlatform(), { checkpoint: checkActive });
    if (!saved.ok) return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : { kind: "failed", failure: saved.error.message };
    checkActive();
    const patch = { audio: { state: "saved" as const, rowId: saved.data.id, at: Date.now() } };
    let fresh = recording;
    for (let attempt = 0; attempt < 2; attempt++) {
      check();
      try {
        await VoiceNotes.updateLedger({ id: recording.id, did: ctx.did, rev: fresh.rev ?? 0, patch });
        return { kind: "saved", audio: null, cleanupError: null, noteSyncError: saved.data.noteSyncError };
      } catch (caught) {
        if (errorCode(caught) !== "rev_conflict") throw caught;
        check();
        const current = (await VoiceNotes.listPending()).recordings.find((note) => note.id === recording.id);
        if (!current || current.owner !== ctx.did || isLegacyNote(current)) throw caught;
        if (current.ledger?.audio.state === "saved") return { kind: "saved", audio: null, cleanupError: null,
          noteSyncError: saved.data.noteSyncError };
        fresh = current;
      }
    }
    return { kind: "failed", failure: "Could not update this phone's saved-note status" };
  } catch (caught) {
    return isDiscarded(recording.id)
      ? { kind: "discarded", cleanupError: await deleteDiscarded(recording.id) }
      : { kind: "failed", failure: messageOf(caught) };
  } finally {
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
const noteFailures = new Map<string, string>();
let generalFailure: string | null = null;

function currentFailure(): string | null {
  return generalFailure ?? [...noteFailures.values()].at(-1) ?? null;
}

/**
 * Retry every recording still on the device, oldest first, one at a time. Single-flight: the
 * recorder and the app's save after sign-in (PendingVoiceNotesSaver) share it. Afterwards the
 * phone is listed again and saved copies are excluded from the pending count.
 */
export function savePendingRecordings(tcw: TinyCloudWeb): Promise<PendingRun> {
  if (pendingRunInFlight) return pendingRunInFlight;
  publishPending({ running: true });
  pendingRunInFlight = (async () => {
    let recordings: VoiceNoteRecording[];
    try {
      ({ recordings } = await VoiceNotes.listPending());
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
        saved.push(recording);
        if (outcome.cleanupError) lastError = outcome.cleanupError;
      } else if (outcome.kind === "already-saved" || outcome.kind === "discarded") {
        if (outcome.cleanupError) lastError = outcome.cleanupError;
      } else if (outcome.kind === "held") {
        left.push(recording);
      } else if (outcome.kind === "failed") {
        left.push(recording);
        lastError = outcome.failure;
      }
    }
    await relistPending(lastError);
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

/** Recordings awaiting a space save, as the recorder views show them. */
export interface PendingSnapshot {
  listing: PendingListing;
  /** Which signed-in account this listing was filtered for. */
  accountDid?: string | null;
  /** A save of them is running (savePendingRecordings). */
  running: boolean;
  lastError: string | null;
}

/** How many notes await a space save (0 when unknown or the listing failed). */
export function pendingCount(snapshot: Pick<PendingSnapshot, "listing">): number {
  return snapshot.listing.state === "ok" ? snapshot.listing.count : 0;
}

let pendingSnapshot: PendingSnapshot = { listing: { state: "unknown" }, accountDid: null, running: false, lastError: null };
const pendingListeners = new Set<() => void>();

function publishPending(patch: Partial<PendingSnapshot>): void {
  pendingSnapshot = { ...pendingSnapshot, ...patch };
  for (const listener of pendingListeners) listener();
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
  reportNoteFailure(id: string, message: string): void {
    noteFailures.delete(id);
    noteFailures.set(id, message);
    publishPending({ lastError: currentFailure() });
  },
  setAccount(did: string | null): void {
    if (activeAccountDid !== did) {
      accountChanges++;
      noteFailures.clear();
      generalFailure = null;
      publishPending({ accountDid: did, listing: { state: "unknown" }, lastError: null });
    }
    activeAccountDid = did;
    void relistPending(null);
  },
  /** Track the whole automatic pipeline, including its cloud preflight. */
  beginAutomaticSave: beginTrackedSave,
  /** The owner-aware manual retry uses the same saving state as the legacy path. */
  beginManualSave: beginTrackedSave,
};

function listingFailure(caught: unknown): string {
  return `Could not check this phone for unsaved notes: ${messageOf(caught)}`;
}

/** Re-list the phone and exclude retained copies already saved to the space. */
async function relistPending(lastError?: string | null): Promise<void> {
  if (lastError !== undefined) generalFailure = lastError;
  try {
    const { recordings } = await VoiceNotes.listPending();
    const visible = activeAccountDid
      ? recordings.filter((recording) => !recording.owner || recording.owner === activeAccountDid)
      : recordings;
    const pending = visible.filter((recording) =>
      isDiscarded(recording.id) || (recording.ledger?.audio.state !== "saved" && !savedThisSession.has(recording.id)),
    );
    const pendingIds = new Set(pending.map((note) => note.id));
    for (const id of noteFailures.keys()) if (!pendingIds.has(id)) noteFailures.delete(id);
    publishPending({ accountDid: activeAccountDid, listing: { state: "ok", count: pending.length }, lastError: currentFailure() });
  } catch (caught) {
    publishPending({ listing: { state: "error", message: listingFailure(caught) }, lastError: currentFailure() });
  }
}
