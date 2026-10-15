// Bridges the native on-device transcript (`VoiceNotes.getTranscript`, written by the
// `TranscriptionQueue` in ExoStt/stt — see mobile/docs/stt-ios.md, stt-android.md) onto a note's
// space row, through the existing transcript write path (`saveVoiceNoteTranscript`). On-device
// transcription itself runs fully natively and works signed out and offline; this module only
// handles getting an already-produced local transcript onto the space once the note is saved
// there and the account is signed in — the same step the private-cloud path's `prepareVoiceNoteTranscript`
// does for its own source.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { deviceName } from "@/lib/platform";

import { localTranscriptToSave, patchVoiceNoteTranscriptionFailure, saveVoiceNoteTranscript } from "./voiceNoteStore";
import { VoiceNotes, type LocalTranscript, type NoteSttState, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";
import { LOCAL_COPY } from "./notePipelineCopy";
import { assertAccountContext, captureAccountContext, isAccountContextCurrent, isAccountWorkAllowed, StaleAccountContext, type AccountContext } from "./accountContext";
import { preserveVoiceNoteTranscriptHistory } from "./voiceNoteTranscriptHistory";
import { patchDeviceTranscriptSyncError, publishDeviceTranscriptArtifact, resolveVoiceNoteRow, transcriptHash } from "./voiceNoteRows";
import { runOnSpaceLane } from "../spaceWriteLane";
import { transcriptKvKey } from "../connectors/connectorStore";

/** One note's local transcript -> space write, including retry classification for foreground recovery. */
export type OnDeviceTranscriptSyncState =
  | { state: "syncing"; rev?: number }
  | { state: "synced"; rev?: number }
  | { state: "failed"; message: string; rev?: number; retryable?: boolean }
  /** The transcript is committed, but the native receipt still needs repair. */
  | { state: "unrecorded"; message: string; rev?: number; retryable?: boolean };

export type TranscriptSyncOutcome = { state: "committed" | "receipt-pending" | "retryable" | "deferred" | "terminal" | "abandoned"; rev?: number };
const syncStates = new Map<string, OnDeviceTranscriptSyncState>();
/** One active write per account/note; later triggers re-read the native revision in order. */
const chains = new Map<string, Promise<void>>();
const syncRevisions = new Map<string, number>();
function transientSyncError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /network|offline|timeout|timed.out|lane|429|503|unavailable|temporar/i.test(`${code} ${message}`);
}
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

export async function syncOnDeviceTranscriptAttempt(tcw: TinyCloudWeb,
  recording: Parameters<typeof syncOnDeviceTranscript>[1],
  requestedAccount: AccountContext = captureAccountContext(tcw)): Promise<TranscriptSyncOutcome> {
  if (recording.ledger?.audio.state !== "saved" && !recording.ledger?.audio.rowId) return { state: "deferred" };
  const abandoned = await syncOnDeviceTranscript(tcw, recording, requestedAccount);
  if (abandoned) return { state: "abandoned" };
  const result = onDeviceTranscriptSyncState(tcw, recording.id);
  const rev = syncRevisions.get(syncKey(tcw, recording.id));
  const revision = rev === undefined ? {} : { rev };
  if (result?.state === "synced") return { state: "committed", ...revision };
  if (result?.state === "unrecorded" && result.retryable) return { state: "receipt-pending", ...revision };
  if (result?.state === "failed" && result.retryable) return { state: "retryable", ...revision };
  return { state: result?.state === "failed" || result?.state === "unrecorded" ? "terminal" : "deferred", ...revision };
}

function enqueue(key: string, attempt: () => Promise<boolean>): Promise<boolean> {
  const run = (chains.get(key) ?? Promise.resolve()).then(attempt);
  const tail = run.then(() => undefined, () => undefined).then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  chains.set(key, tail);
  return run;
}

/** Check both the authoritative winner and its readable revision/fixed bodies before a receipt-only acknowledgement. */
async function verifiedLocalCommit(tcw: TinyCloudWeb, id: string, transcript: LocalTranscript,
  ctx: AccountContext): Promise<"matching" | "missing" | "conflict"> {
  const check = checkpoint(tcw, ctx);
  check();
  const commit = await readTranscriptCommit(tcw, id, check);
  check();
  if (!commit) return "missing";
  const expectedHash = await transcriptHash(localTranscriptToSave(transcript).sentences);
  check();
  if (commit.rev > transcript.rev || (commit.rev === transcript.rev
    && (commit.outcome !== transcript.outcome || commit.hash !== expectedHash))) return "conflict";
  if (commit.rev < transcript.rev) return "missing";
  const body = await runOnSpaceLane((signal) => { check(); return tcw.kv.get(commit.bodyKey, { signal }); },
    { operation: "KV verify voice note transcript" });
  check();
  if (!body.ok) return body.error.code === "KV_NOT_FOUND" ? "missing" : Promise.reject(body.error);
  let sentences: unknown;
  try { sentences = typeof body.data.data === "string" ? JSON.parse(body.data.data) : body.data.data; }
  catch { return "missing"; }
  if (!Array.isArray(sentences) || await transcriptHash(sentences) !== expectedHash) return "missing";
  check();
  const fixed = await runOnSpaceLane((signal) => { check(); return tcw.kv.get(transcriptKvKey("exo-voice-note", id), { signal }); },
    { operation: "KV verify fixed voice note transcript" });
  check();
  if (!fixed.ok) return fixed.error.code === "KV_NOT_FOUND" ? "missing" : Promise.reject(fixed.error);
  let fixedSentences: unknown;
  try { fixedSentences = typeof fixed.data.data === "string" ? JSON.parse(fixed.data.data) : fixed.data.data; }
  catch { return "missing"; }
  if (!Array.isArray(fixedSentences) || await transcriptHash(fixedSentences) !== expectedHash) return "missing";
  check();
  const row = await resolveVoiceNoteRow(tcw, id, check);
  check();
  const text = localTranscriptToSave(transcript).metadata.transcript_text;
  if (!row || row.metadata.transcription_outcome !== transcript.outcome
    || (row.metadata.transcript_text ?? null) !== text) return "missing";
  const winner = await readTranscriptCommit(tcw, id, check);
  check();
  return winner?.rev === transcript.rev && winner.hash === expectedHash && winner.outcome === transcript.outcome
    ? "matching" : "conflict";
}

export function recordOnDeviceTranscript(
  tcw: TinyCloudWeb,
  id: string,
  requestedAccount: AccountContext = captureAccountContext(tcw),
): Promise<boolean> {
  const key = syncKey(tcw, id);
  return enqueue(key, async () => {
    syncRevisions.delete(key);
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
      publish(key, { state: "unrecorded", message: LOCAL_COPY.transcriptReadFailed, retryable: transientSyncError(err) });
      return false;
    }
    if (!transcript) {
      publish(key, { state: "unrecorded", message: LOCAL_COPY.missingTranscript });
      return false;
    }
    syncRevisions.set(key, transcript.rev);
    try {
      const evidence = await verifiedLocalCommit(tcw, id, transcript, requestedAccount);
      if (evidence === "conflict") {
        publish(key, { state: "failed", message: "A different transcript revision is already in this space." });
        return false;
      }
      const abandoned = evidence === "matching"
        ? await recordAndPublish(tcw, key, id, transcript, requestedAccount)
        : await syncOnce(tcw, key, id, true, false, requestedAccount);
      if (abandoned) abandonSync(key, id, tcw);
      return abandoned;
    } catch (err) {
      if (!isCurrent(tcw, requestedAccount)) { abandonSync(key, id, tcw); return true; }
      publish(key, { state: "unrecorded", message: LOCAL_COPY.transcriptCheckFailed, retryable: transientSyncError(err) });
      return false;
    }
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
    publish(key, { state: failureState, message: LOCAL_COPY.transcriptCheckFailed, retryable: transientSyncError(err) });
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
    publish(key, { state: "unrecorded", message: LOCAL_COPY.transcriptSyncFailed,
      retryable: !/newer transcript receipt|belongs to another account/i.test(String(err)) });
    return false;
  }
}

async function syncOnce(tcw: TinyCloudWeb, key: string, id: string, expected: boolean, failed: boolean, ctx: AccountContext): Promise<boolean> {
  if (!isCurrent(tcw, ctx)) return true;
  const current = await ownsNativeNote(tcw, key, id, ctx, "failed", expected || failed);
  if (!current) return !isCurrent(tcw, ctx);
  syncRevisions.delete(key);
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
    const transient = transientSyncError(err);
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptReadFailed, retryable: transient });
    if ((expected || failed) && !transient) await persistOnDeviceFailure(tcw, id, "transcript_read_failed", ctx);
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
  syncRevisions.set(key, transcript.rev);
  try {
    await publishDeviceTranscriptArtifact(tcw, id, transcript, checkpoint(tcw, ctx));
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return true;
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptSyncFailed, retryable: transientSyncError(err) });
    return false;
  }
  // Native callbacks, row receipts and sweeps all verify the same durable winner.
  // A local saved receipt alone is not evidence that either KV body was published.
  try {
    const evidence = await verifiedLocalCommit(tcw, id, transcript, ctx);
    if (evidence === "conflict") {
      publish(key, { state: "failed", message: "A different transcript revision is already in this space." });
      return false;
    }
    if (evidence === "matching") {
      if (current.ledger?.transcriptSync?.state === "saved"
        && current.ledger.transcriptSync.rev === transcript.rev
        && current.ledger.transcript?.outcome === transcript.outcome) {
        publish(key, { state: "synced" });
        return false;
      }
      return recordAndPublish(tcw, key, id, transcript, ctx);
    }
  } catch (err) {
    if (!isCurrent(tcw, ctx)) return true;
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptCheckFailed, retryable: transientSyncError(err) });
    return false;
  }
  publish(key, { state: "syncing" });
  try {
    const prepared = localTranscriptToSave(transcript);
    if (transcript.rerunBase) {
      const check = checkpoint(tcw, ctx);
      check();
      const current = await readTranscriptCommit(tcw, id, check);
      check();
      if (!current || current.rev !== transcript.rerunBase.rev || current.hash !== transcript.rerunBase.hash)
        throw new Error("The committed transcript changed before this rerun could sync. Try again.");
      await preserveVoiceNoteTranscriptHistory(tcw, current, checkpoint(tcw, ctx));
    }
    const result = await saveVoiceNoteTranscript(tcw, id, prepared,
      { generation: ctx.generation, did: ctx.did }, checkpoint(tcw, ctx));
    if (!isCurrent(tcw, ctx)) return true;
    if (result.ok) {
      const evidence = await verifiedLocalCommit(tcw, id, transcript, ctx);
      if (evidence !== "matching") {
        publish(key, { state: "failed", message: LOCAL_COPY.transcriptSyncFailed, retryable: true });
        await persistOnDeviceFailure(tcw, id, "transcript_save_failed", ctx, transcript);
        return false;
      }
      return await recordAndPublish(tcw, key, id, transcript, ctx);
    }
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", result.error);
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptSyncFailed, retryable: transientSyncError(result.error) });
    await persistOnDeviceFailure(tcw, id, "transcript_save_failed", ctx, transcript);
    return false;
  } catch (err) {
    if (!isCurrent(tcw, ctx) || err instanceof StaleAccountContext) return true;
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", err);
    publish(key, { state: "failed", message: LOCAL_COPY.transcriptSyncFailed, retryable: transientSyncError(err) });
    await persistOnDeviceFailure(tcw, id, "transcript_save_failed", ctx, transcript);
    return false;
  }
}

async function persistOnDeviceFailure(tcw: TinyCloudWeb, id: string, code: string, ctx: AccountContext,
  transcript?: LocalTranscript): Promise<void> {
  if (!isCurrent(tcw, ctx)) return;
  try {
    if (transcript) await patchDeviceTranscriptSyncError(tcw, id, transcript.rev, code, checkpoint(tcw, ctx));
    else await patchVoiceNoteTranscriptionFailure(tcw, id, code, checkpoint(tcw, ctx));
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
    if (!note?.ledger || note.rev === undefined) throw new Error(`This note has no ledger entry on ${deviceName()} to record the transcript in`);
    if (note.owner !== ctx.did) throw new Error(`This note belongs to another account on ${deviceName()}`);
    const transcriptSync = note.ledger.transcriptSync;
    if (transcriptSync?.state === "saved" && transcriptSync.rev === transcript.rev
      && note.ledger.transcript?.outcome === transcript.outcome) return;
    if ((transcriptSync?.rev ?? 0) > transcript.rev) throw new Error("A newer transcript receipt already exists");
    const patch = {
      transcriptSync: { state: "saved" as const, rev: transcript.rev, at: Date.now() },
      transcript: { ...note.ledger.transcript, state: "done" as const, outcome: transcript.outcome,
        reason: null, attempts: note.ledger.transcript?.attempts ?? 0, nextAttemptAt: null },
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
