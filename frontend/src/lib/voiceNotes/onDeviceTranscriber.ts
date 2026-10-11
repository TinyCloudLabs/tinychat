// Bridges the native on-device transcript (`VoiceNotes.getTranscript`, written by the
// `TranscriptionQueue` in ExoStt/stt — see mobile/docs/stt-ios.md, stt-android.md) onto a note's
// space row, through the existing transcript write path (`saveVoiceNoteTranscript`). On-device
// transcription itself runs fully natively and works signed out and offline; this module only
// handles getting an already-produced local transcript onto the space once the note is saved
// there and the account is signed in — the same step the private-cloud path's `prepareVoiceNoteTranscript`
// does for its own source.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { localTranscriptToSave, saveVoiceNoteTranscript } from "./voiceNoteStore";
import { VoiceNotes, type LocalTranscript, type NoteSttState } from "./nativeVoiceNotes";
import { VoiceNoteSaveTimeout, withVoiceNoteSaveDeadline } from "./saveDeadline";
import { LOCAL_COPY } from "./notePipelineCopy";
import { assertAccountContext, captureAccountContext, isAccountContextCurrent, StaleAccountContext, type AccountContext } from "./accountContext";

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
const syncListeners = new Set<() => void>();
const syncKey = (tcw: TinyCloudWeb, id: string) => JSON.stringify([tcw.spaceId, tcw.did, id]);
const isCurrent = (tcw: TinyCloudWeb, ctx: AccountContext) => isAccountContextCurrent(ctx, tcw);
const checkpoint = (tcw: TinyCloudWeb, ctx: AccountContext) => () => assertAccountContext(ctx, tcw);

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
 * If this note already has a local on-device transcript and a space row (`ledger.audio.state ===
 * "saved"`), write it onto that row through the existing path, publishing `syncing` then `synced`
 * or `failed` (see `onDeviceTranscriptSyncState`). A no-op, with nothing published, without either.
 * Failures are logged and published, not thrown: the local transcript stays valid, and the next
 * save or "transcribed" event tries again. A recording that says its on-device transcription is done (`stt.state ===
 * "done"`) is expected to have a local transcript: without one the attempt fails with that cause, never silently. Once the
 * space has the transcript, the phone's ledger records it (`transcriptSync` saved, `transcript.outcome`), so the next
 * launch knows without asking the space. Syncs of one note can overlap (save recovery and the
 * native `transcribed` event), so they run one after another per note, each doing its own native
 * read and write: the published state is the last attempt's, which is the newest. Every await in
 * an attempt has a deadline, so a hung native read or space call fails that attempt (a late
 * completion is ignored) and the chain moves on instead of blocking later syncs forever.
 */
export function syncOnDeviceTranscript(
  tcw: TinyCloudWeb,
  recording: { id: string; owner?: string | null; ledger?: { audio: { state: string } }; stt?: Pick<NoteSttState, "state"> },
  requestedAccount: AccountContext = captureAccountContext(tcw),
): Promise<void> {
  if (recording.ledger?.audio.state !== "saved") return Promise.resolve();
  if (!isCurrent(tcw, requestedAccount)) return Promise.resolve();
  const key = syncKey(tcw, recording.id);
  const expected = recording.stt?.state === "done";
  return enqueue(key, () => syncOnce(tcw, key, recording.id, expected, requestedAccount));
}

function enqueue(key: string, attempt: () => Promise<void>): Promise<void> {
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
): Promise<void> {
  const key = syncKey(tcw, id);
  return enqueue(key, async () => {
    if (!isCurrent(tcw, requestedAccount) || !await ownsNativeNote(tcw, key, id, requestedAccount, "unrecorded")) return;
    let transcript: LocalTranscript | null;
    try {
      checkpoint(tcw, requestedAccount)();
      ({ transcript } = await withVoiceNoteSaveDeadline(`native getTranscript ${id}`, () => {
        checkpoint(tcw, requestedAccount)();
        return VoiceNotes.getTranscript({ id });
      }));
      checkpoint(tcw, requestedAccount)();
    } catch (err) {
      if (!isCurrent(tcw, requestedAccount)) return;
      console.warn("[OnDeviceStt] Could not read the local transcript", err);
      publish(key, { state: "unrecorded", message: `Couldn't read the transcript on this phone: ${err instanceof VoiceNoteSaveTimeout ? "reading it timed out" : errorMessage(err)}` });
      return;
    }
    if (!transcript) {
      publish(key, { state: "unrecorded", message: LOCAL_COPY.missingTranscript });
      return;
    }
    await recordAndPublish(tcw, key, id, transcript, requestedAccount);
  });
}

async function ownsNativeNote(tcw: TinyCloudWeb, key: string, id: string, ctx: AccountContext,
  failureState: "failed" | "unrecorded"): Promise<boolean> {
  let recordings: Awaited<ReturnType<typeof VoiceNotes.listPending>>["recordings"];
  try {
    checkpoint(tcw, ctx)();
    ({ recordings } = await withVoiceNoteSaveDeadline(`native listPending before transcript sync ${id}`, () => {
      checkpoint(tcw, ctx)();
      return VoiceNotes.listPending();
    }));
    checkpoint(tcw, ctx)();
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return false;
    console.warn("[OnDeviceStt] Could not verify local note ownership", err);
    publish(key, { state: failureState, message: `Couldn't check this note on this phone: ${errorMessage(err)}` });
    return false;
  }
  const note = recordings.find((recording) => recording.id === id);
  if (note?.owner !== ctx.did) {
    publish(key, { state: failureState, message: note
      ? "This note belongs to another account on this phone"
      : "This note is no longer on this phone" });
    return false;
  }
  return true;
}

async function recordAndPublish(tcw: TinyCloudWeb, key: string, id: string, transcript: LocalTranscript,
  ctx: AccountContext): Promise<void> {
  try {
    checkpoint(tcw, ctx)();
    await recordTranscriptSaved(tcw, id, transcript, ctx);
    checkpoint(tcw, ctx)();
    publish(key, { state: "synced" });
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return;
    console.warn("[OnDeviceStt] The transcript is in the space but this phone's ledger was not updated", err);
    publish(key, { state: "unrecorded", message: errorMessage(err) });
  }
}

async function syncOnce(tcw: TinyCloudWeb, key: string, id: string, expected: boolean, ctx: AccountContext): Promise<void> {
  if (!isCurrent(tcw, ctx) || !await ownsNativeNote(tcw, key, id, ctx, "failed")) return;
  let transcript: LocalTranscript | null;
  try {
    checkpoint(tcw, ctx)();
    ({ transcript } = await withVoiceNoteSaveDeadline(`native getTranscript ${id}`, () => {
      checkpoint(tcw, ctx)();
      return VoiceNotes.getTranscript({ id });
    }));
    checkpoint(tcw, ctx)();
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return;
    console.warn("[OnDeviceStt] Could not read the local transcript", err);
    const reason = err instanceof VoiceNoteSaveTimeout ? "reading it timed out" : errorMessage(err);
    publish(key, { state: "failed", message: `Couldn't read the transcript on this phone: ${reason}` });
    return;
  }
  if (!transcript) {
    if (expected && isCurrent(tcw, ctx)) publish(key, { state: "failed", message: LOCAL_COPY.missingTranscript });
    return;
  }
  if (!isCurrent(tcw, ctx)) return;
  publish(key, { state: "syncing" });
  try {
    checkpoint(tcw, ctx)();
    const result = await saveVoiceNoteTranscript(tcw, id, localTranscriptToSave(transcript), checkpoint(tcw, ctx));
    checkpoint(tcw, ctx)();
    if (result.ok) {
      await recordAndPublish(tcw, key, id, transcript, ctx);
    } else {
      if (!isCurrent(tcw, ctx)) return;
      console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", result.error);
      publish(key, { state: "failed", message: result.error.message });
    }
  } catch (err) {
    if (!isCurrent(tcw, ctx) || err instanceof StaleAccountContext) return;
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", err);
    publish(key, { state: "failed", message: errorMessage(err) });
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

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
