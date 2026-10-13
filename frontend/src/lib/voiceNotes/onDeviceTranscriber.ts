// Bridges the native on-device transcript (`VoiceNotes.getTranscript`, written by the
// `TranscriptionQueue` in ExoStt/stt — see mobile/docs/stt-ios.md, stt-android.md) onto a note's
// space row, through the existing transcript write path (`saveVoiceNoteTranscript`). On-device
// transcription itself runs fully natively and works signed out and offline; this module only
// handles getting an already-produced local transcript onto the space once the note is saved
// there and the account is signed in — the same step the private-cloud path's `prepareVoiceNoteTranscript`
// does for its own source.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { localTranscriptToSave, patchVoiceNoteTranscriptionFailure, saveVoiceNoteTranscript } from "./voiceNoteStore";
import { VoiceNotes, type LocalTranscript, type NoteSttState, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";
import { LOCAL_COPY } from "./notePipelineCopy";
import { assertAccountContext, captureAccountContext, isAccountContextCurrent, isAccountWorkAllowed, StaleAccountContext, type AccountContext } from "./accountContext";

/** One note's local transcript -> space write: running, written, or why it did not land (the local transcript stays valid). */
export type OnDeviceTranscriptSyncState =
  | { state: "syncing" }
  | { state: "synced" }
  | { state: "failed"; message: string }
  /** The transcript is in the space, but this phone's ledger could not be told (`message` is the cause). */
  | { state: "unrecorded"; message: string };

const syncStates = new Map<string, OnDeviceTranscriptSyncState>();
/** The tail of each note's sync chain: attempts for one note run one after another. */
const chains = new Map<string, Promise<void>>();
/** Successful remote publications whose native acknowledgement may still need retry. */
const published = new Set<string>();
const syncListeners = new Set<() => void>();
const syncKey = (tcw: TinyCloudWeb, id: string) => JSON.stringify([tcw.spaceId, tcw.did, id]);
const isCurrent = (tcw: TinyCloudWeb, ctx: AccountContext) => isAccountContextCurrent(ctx, tcw) && isAccountWorkAllowed(tcw);
const checkpoint = (tcw: TinyCloudWeb, ctx: AccountContext) => () => {
  assertAccountContext(ctx, tcw);
  if (!isAccountWorkAllowed(tcw)) throw new StaleAccountContext();
};

/** Account-scoped; null until a sync for this note has started in this session. */
export function onDeviceTranscriptSyncState(tcw: TinyCloudWeb, id: string): OnDeviceTranscriptSyncState | null {
  return syncStates.get(syncKey(tcw, id)) ?? null;
}

export function subscribeOnDeviceTranscriptSync(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
}

function publish(key: string, next: OnDeviceTranscriptSyncState | null): void {
  if (JSON.stringify(syncStates.get(key) ?? null) === JSON.stringify(next)) return;
  if (next) syncStates.set(key, next);
  else syncStates.delete(key);
  for (const listener of [...syncListeners]) listener();
}

/**
 * If this note already has a local on-device transcript and a space row (`ledger.audio.rowId` is
 * present, or audio was already saved), write it onto that row through the existing path, publishing `syncing` then `synced`
 * or `failed` (see `onDeviceTranscriptSyncState`). A no-op, with nothing published, without either.
 * Failures are logged and published, not thrown: the local transcript stays valid, and the next
 * save or "transcribed" event tries again. A recording that says its on-device transcription is done (`stt.state ===
 * "done"`) is expected to have a local transcript: without one the attempt fails with that cause, never silently. Once the
 * space has the transcript, the phone's ledger records it (`transcriptSync` saved, `transcript.outcome`), so the next
 * launch knows without asking the space. Syncs of one note can overlap (save recovery and the
 * native `transcribed` event), so they run one after another per note. A saved
 * source/revision is skipped before network publication. Every await in
 * an attempt has a deadline, so a hung native read or space call fails that attempt (a late
 * completion is ignored) and the chain moves on instead of blocking later syncs forever.
 */
export function syncOnDeviceTranscript(
  tcw: TinyCloudWeb,
  recording: { id: string; owner?: string | null; ledger?: { audio: { state: string; rowId?: string | null } }; stt?: Pick<NoteSttState, "state"> & Partial<Pick<NoteSttState, "error">> },
  requestedAccount: AccountContext = captureAccountContext(tcw),
): Promise<boolean> {
  if (recording.ledger?.audio.state !== "saved" && !recording.ledger?.audio.rowId) return Promise.resolve(false);
  const key = syncKey(tcw, recording.id);
  const expected = recording.stt?.state === "done";
  const failed = recording.stt?.state === "failed";
  return enqueue(key, async () => {
    const abandoned = await syncOnce(tcw, key, recording.id, expected, failed, requestedAccount);
    if (abandoned) abandonSync(key, recording.id, tcw);
    return abandoned;
  });
}

function enqueue<T>(key: string, attempt: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(attempt);
  // The chain goes on whatever this attempt does; the caller still sees this attempt's own outcome.
  const tail = run.then(() => undefined, () => undefined).then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  chains.set(key, tail);
  return run;
}

/**
 * The space already has this note's transcript, but the phone's ledger was never told (`transcriptSync` is not "saved"): tell it,
 * without writing the space again (what is there may be newer than the local copy). Publishes `synced`, or `unrecorded` with the cause.
 */
export function recordOnDeviceTranscript(
  tcw: TinyCloudWeb,
  id: string,
  requestedAccount: AccountContext = captureAccountContext(tcw),
): Promise<boolean> {
  const key = syncKey(tcw, id);
  return enqueue(key, async () => {
    if (!isCurrent(tcw, requestedAccount)) { abandonSync(key, id, tcw); return true; }
    if (!await ownsNativeNote(tcw, key, id, requestedAccount, "unrecorded")) {
      if (!isCurrent(tcw, requestedAccount)) { abandonSync(key, id, tcw); return true; }
      return false;
    }
    let transcript: LocalTranscript | null;
    try {
      checkpoint(tcw, requestedAccount)();
      ({ transcript } = await withVoiceNoteSaveDeadline(`native getTranscript ${id}`, () => {
        checkpoint(tcw, requestedAccount)();
        return VoiceNotes.getTranscript({ id });
      }));
      checkpoint(tcw, requestedAccount)();
    } catch (err) {
      if (!isCurrent(tcw, requestedAccount)) { abandonSync(key, id, tcw); return true; }
      console.warn("[OnDeviceStt] Could not read the local transcript", err);
      publish(key, { state: "unrecorded", message: LOCAL_COPY.transcriptReadFailed });
      return false;
    }
    if (!transcript) {
      publish(key, { state: "unrecorded", message: LOCAL_COPY.missingTranscript });
      return false;
    }
    const abandoned = await recordAndPublish(tcw, key, id, transcript, requestedAccount);
    if (abandoned) abandonSync(key, id, tcw);
    return abandoned;
  });
}

function abandonSync(key: string, id: string, tcw: TinyCloudWeb): void {
  console.warn(`[OnDeviceStt] Abandoned transcript sync id=${id}: ${isAccountWorkAllowed(tcw) ? "account changed" : "account work paused"}`);
  publish(key, null);
}

async function ownsNativeNote(tcw: TinyCloudWeb, key: string, id: string, ctx: AccountContext,
  failureState: "failed" | "unrecorded", missingExpected = false): Promise<VoiceNoteRecording | null> {
  let recordings: Awaited<ReturnType<typeof VoiceNotes.listPending>>["recordings"];
  try {
    checkpoint(tcw, ctx)();
    ({ recordings } = await withVoiceNoteSaveDeadline(`native listPending before transcript sync ${id}`, () => {
      checkpoint(tcw, ctx)();
      return VoiceNotes.listPending();
    }));
    checkpoint(tcw, ctx)();
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return null;
    console.warn("[OnDeviceStt] Could not verify local note ownership", err);
    publish(key, { state: failureState, message: LOCAL_COPY.transcriptCheckFailed });
    return null;
  }
  const note = recordings.find((recording) => recording.id === id);
  if (!note) {
    if (missingExpected) publish(key, { state: "failed", message: LOCAL_COPY.missingTranscript });
    return null;
  }
  if (note.owner !== ctx.did) {
    publish(key, { state: failureState, message: "This note belongs to another account on this phone" });
    return null;
  }
  return note;
}

async function recordAndPublish(tcw: TinyCloudWeb, key: string, id: string, transcript: LocalTranscript,
  ctx: AccountContext): Promise<boolean> {
  try {
    checkpoint(tcw, ctx)();
    await recordTranscriptSaved(tcw, id, transcript, ctx);
    checkpoint(tcw, ctx)();
    publish(key, { state: "synced" });
    return false;
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return true;
    console.warn("[OnDeviceStt] The transcript is in the space but this phone's ledger was not updated", err);
    publish(key, { state: "unrecorded", message: LOCAL_COPY.transcriptSyncFailed });
    return false;
  }
}

async function syncOnce(tcw: TinyCloudWeb, key: string, id: string, expected: boolean, failed: boolean, ctx: AccountContext): Promise<boolean> {
  if (!isCurrent(tcw, ctx)) return true;
  const current = await ownsNativeNote(tcw, key, id, ctx, "failed", expected || failed);
  if (!current) return !isCurrent(tcw, ctx);
  let transcript: LocalTranscript | null;
  try {
    checkpoint(tcw, ctx)();
    ({ transcript } = await withVoiceNoteSaveDeadline(`native getTranscript ${id}`, () => {
      checkpoint(tcw, ctx)();
      return VoiceNotes.getTranscript({ id });
    }));
    checkpoint(tcw, ctx)();
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return true;
    console.warn("[OnDeviceStt] Could not read the local transcript", err);
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptReadFailed });
    if (expected || failed) await persistOnDeviceFailure(tcw, id, "transcript_read_failed", ctx);
    return false;
  }
  if (!transcript) {
    if (expected || failed) {
      if (isCurrent(tcw, ctx)) publish(key, { state: "failed", message: LOCAL_COPY.missingTranscript });
      await persistOnDeviceFailure(tcw, id, failed ? "on_device_transcription_failed" : "on_device_transcript_missing", ctx);
    }
    return false;
  }
  if (!isCurrent(tcw, ctx)) return true;
  const resultKey = JSON.stringify([ctx.spaceId, ctx.did, id, transcript.rev]);
  // The row-created callback, native STT event and post-upload reconcile can
  // all request this same result. The first listPending already supplied the
  // durable ledger. Verify its space commit so a missing copy can be repaired.
  try {
    checkpoint(tcw, ctx)();
    if (current.ledger?.transcriptSync.state === "saved"
      && current.ledger.transcriptSync.rev >= transcript.rev
      && current.ledger.transcript.outcome === transcript.outcome) {
      const commit = await withVoiceNoteSaveDeadline(`space transcript commit id=${id}`,
        () => readTranscriptCommit(tcw, id, checkpoint(tcw, ctx)));
      checkpoint(tcw, ctx)();
      if (commit && commit.rev >= transcript.rev && commit.outcome === transcript.outcome) {
        publish(key, { state: "synced" });
        return false;
      }
      published.delete(resultKey);
    }
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return true;
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptCheckFailed });
    return false;
  }
  if (published.has(resultKey)) return recordAndPublish(tcw, key, id, transcript, ctx);
  publish(key, { state: "syncing" });
  try {
    checkpoint(tcw, ctx)();
    const result = await saveVoiceNoteTranscript(tcw, id, localTranscriptToSave(transcript),
      { generation: ctx.generation, did: ctx.did }, checkpoint(tcw, ctx));
    if (result.ok) published.add(resultKey);
    if (!isCurrent(tcw, ctx)) return true;
    if (result.ok) {
      return await recordAndPublish(tcw, key, id, transcript, ctx);
    }
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", result.error);
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptSyncFailed });
    await persistOnDeviceFailure(tcw, id, "transcript_save_failed", ctx);
    return false;
  } catch (err) {
    if (!isCurrent(tcw, ctx) || err instanceof StaleAccountContext) return true;
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", err);
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptSyncFailed });
    await persistOnDeviceFailure(tcw, id, "transcript_save_failed", ctx);
    return false;
  }
}

async function persistOnDeviceFailure(tcw: TinyCloudWeb, id: string, code: string, ctx: AccountContext): Promise<void> {
  if (!isCurrent(tcw, ctx)) return;
  try {
    await patchVoiceNoteTranscriptionFailure(tcw, id, code, checkpoint(tcw, ctx));
  } catch (error) {
    if (isCurrent(tcw, ctx)) console.warn("[OnDeviceStt] Could not persist the local transcription failure", error);
  }
}

/** The phone's ledger learns the space has this transcript. One retry when the entry changed under the write (`rev_conflict`). */
async function recordTranscriptSaved(tcw: TinyCloudWeb, id: string, transcript: LocalTranscript, ctx: AccountContext): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    checkpoint(tcw, ctx)();
    const pending = await withVoiceNoteSaveDeadline(`native listPending id=${id}`, () => {
      checkpoint(tcw, ctx)();
      return VoiceNotes.listPending();
    });
    checkpoint(tcw, ctx)();
    const note = pending.recordings.find((recording) => recording.id === id);
    if (!note?.ledger || note.rev === undefined) throw new Error("This phone has no ledger entry for the note to record the transcript in");
    if (note.owner !== ctx.did) throw new Error("This note belongs to another account on this phone");
    const { transcriptSync } = note.ledger;
    if (transcriptSync.state === "saved" && transcriptSync.rev >= transcript.rev && note.ledger.transcript.outcome === transcript.outcome) return;
    const patch = {
      transcriptSync: { state: "saved" as const, rev: transcript.rev, at: Date.now() },
      transcript: { ...note.ledger.transcript, outcome: transcript.outcome },
    };
    const rev = note.rev;
    try {
      checkpoint(tcw, ctx)();
      await withVoiceNoteSaveDeadline(`native updateLedger id=${id}`, () => {
        checkpoint(tcw, ctx)();
        return VoiceNotes.updateLedger({ id, did: ctx.did, rev, patch });
      });
      checkpoint(tcw, ctx)();
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "rev_conflict" || attempt > 0) throw err;
    }
  }
}
