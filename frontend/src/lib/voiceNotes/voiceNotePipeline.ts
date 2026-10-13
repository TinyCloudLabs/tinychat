import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "@/capture/captureEvents";
import { assertCurrent, setAccountWorkPaused, StaleAccountContext, type AccountContext } from "./accountContext";
import { associateLegacyNotes, markLegacyOwnerUnknown, migrateLegacyDiscardLedger } from "./legacyMigration";
import { VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { errorCode, isDiscarded, pendingStore, saveNoteForAccount, type PendingUploadTicket } from "./recorderSaves";
import { ensureVoiceNoteIdentity } from "./voiceNoteRows";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";
import { syncRecordingNote, VOICE_NOTE_SOURCE } from "./voiceNoteStore";
import { syncOnDeviceTranscript } from "./onDeviceTranscriber";
import { appPlatform } from "@/lib/platform";
import type { StoreAudioOptions } from "./voiceNoteStore";
import { readPendingSaveStates } from "./pendingSaveState";
import { logPipeline } from "@/lib/debugLog";

export interface VoiceNotePipeline {
  process(ctx: AccountContext, id: string, trigger?: "stop" | "background", onRowCreated?: () => void): Promise<void | "owned-by-another-run">;
  /** T19 calls setCaptureDefaults on ready before this association and upload pass. */
  reconcileAll(ctx: AccountContext, trigger?: "reconcile" | "manual", onSaved?: (note: VoiceNoteRecording) => void): Promise<void>;
  cancelAll(): void;
  resume(): void;
  isAccepting(): boolean;
  quiescent(timeoutMs: number): Promise<boolean>;
}

export class VoiceNoteSaveDeferred extends Error {
  readonly code = "account_transition";
  constructor() { super("Voice-note save is suspended during account transition"); }
}

export function saveDeferredForAccountTransition(error: unknown): boolean {
  return error instanceof VoiceNoteSaveDeferred || error instanceof StaleAccountContext;
}

/** T22 extends these lanes with transcription and cleanup, retaining this API. */
export function createVoiceNotePipeline(tcw: TinyCloudWeb,
  testOptions: Pick<StoreAudioOptions, "retryDelaysMs"> & { saveRetryDelaysMs?: readonly number[] } = {}): VoiceNotePipeline {
  setAccountWorkPaused(tcw, false);
  let cancellation = 0;
  let accepting = true;
  const active = new Set<Promise<unknown>>();
  const run = <T>(job: () => Promise<T>): Promise<T> => {
    const promise = job();
    active.add(promise);
    void promise.finally(() => active.delete(promise)).catch(() => undefined);
    return promise;
  };
  const checkFor = (ctx: AccountContext, epoch: number) => () => {
    if (!accepting || epoch !== cancellation) throw new VoiceNoteSaveDeferred();
    assertCurrent(ctx);
    if (tcw.did !== ctx.did || tcw.spaceId !== ctx.spaceId) throw new Error("Voice-note space changed");
  };
  const waitRetry = async (until: number, check: () => void) => {
    while (until > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
      check();
    }
  };
  const syncDesktopAfterUpload = (ctx: AccountContext, note: VoiceNoteRecording | null) => {
    if (!note || appPlatform() !== "tauri" || note.options?.transcriber !== "on-device") return;
    // Upload owns no slot by this point. Whisper and upload may finish in either order.
    void syncOnDeviceTranscript(tcw, { id: note.id, owner: note.owner,
      ledger: { audio: { state: "saved" } }, stt: note.stt }, ctx)
      .catch((error) => console.warn("[VoiceNotes] Desktop transcript sync is still pending", { id: note.id, error }));
  };
  const processOne = async (ctx: AccountContext, id: string, epoch: number, trackPending = false,
    uploadTicket?: PendingUploadTicket, onRowCreated?: () => void): Promise<VoiceNoteRecording | null> => {
    if (uploadTicket && !uploadTicket.owns) return null;
    try {
    const check = checkFor(ctx, epoch);
    check();
    if (uploadTicket) pendingStore.preparingUpload(uploadTicket);
    const gate = await withVoiceNoteSaveDeadline("voice-note space setup", () => ensureVoiceNoteIdentity(tcw, check));
    if (gate.status !== "established") throw Object.assign(new Error(gate.reason ?? gate.status), { code: gate.status, cause: gate.cause });
    check();
    // Identity does the archive repair once per account. A fresh Stop must not
    // repeat that space-wide work before its upload.
    const note = (await withVoiceNoteSaveDeadline(`native listPending id=${id}`, () => VoiceNotes.listPending())).recordings.find((r) => r.id === id);
    if (!note) return null;
    check();
    // Reconcile's post-upload pass retries Markdown sync for saved notes. Stop and
    // background paths also avoid repeating that round trip for already-saved audio.
    if (note.ledger?.audio.state === "saved" && !isDiscarded(id)) return null;
    pendingStore.clearNoteFailure(id);
    const finish = trackPending && note.ledger?.audio.state !== "saved"
      ? pendingStore.beginAutomaticSave() : () => undefined;
    try {
      const retryDelays = testOptions.saveRetryDelaysMs ?? [5_000, 30_000, 120_000];
      let result: Awaited<ReturnType<typeof saveNoteForAccount>>;
      for (let attempt = 0; ; attempt++) {
        const retryAt = (await readPendingSaveStates(ctx.did, [id])).get(id)?.retryAt;
        if (retryAt && retryAt > Date.now()) await waitRetry(retryAt, check);
        check();
        pendingStore.setHeld(id, undefined);
        pendingStore.setRetrying(id, null);
        result = await saveNoteForAccount(tcw, ctx, note, check, {
          ...testOptions,
          uploadTicket,
          onRowCreated,
        });
        if (result.kind !== "failed" || result.failureKind !== "timeout" || attempt >= retryDelays.length) break;
        const delay = testOptions.saveRetryDelaysMs
          ? retryDelays[attempt]!
          : Math.round(retryDelays[attempt]! * (0.8 + Math.random() * 0.4));
        const nextAttemptAt = Date.now() + delay;
        pendingStore.setRetrying(id, nextAttemptAt);
        if (uploadTicket) pendingStore.publishUpload(id, uploadTicket.owner, { state: "retrying", bytes: 0, total: note.sizeBytes });
        logPipeline("save", id, "retrying");
        await waitRetry(nextAttemptAt, check);
      }
      if (result.kind === "failed") {
        check();
        throw Object.assign(new Error(result.failure), {
          code: errorCode(result.failureCause), cause: result.failureCause, failureKind: result.failureKind,
        });
      }
      if (result.kind === "discarded" && result.cleanupError) throw new Error(result.cleanupError);
      if (result.kind === "held") pendingStore.setHeld(id, result.reason);
      return result.kind === "saved" ? note : null;
    } finally { finish(); }
    } finally { if (uploadTicket) pendingStore.settleUploadQueue(uploadTicket); }
  };
  return {
    process(ctx, id, _trigger = "stop", onRowCreated) {
      if (!accepting) return Promise.reject(new VoiceNoteSaveDeferred());
      const epoch = cancellation;
      const uploadTicket = pendingStore.enqueueUpload(id);
      if (!uploadTicket.owns) return Promise.resolve("owned-by-another-run");
      return run(async () => { syncDesktopAfterUpload(ctx, await processOne(ctx, id, epoch, false, uploadTicket, onRowCreated)); });
    },
    reconcileAll(ctx, trigger = "reconcile", onSaved) {
      if (!accepting) return Promise.reject(new VoiceNoteSaveDeferred());
      const epoch = cancellation;
      return run(async () => {
        const check = checkFor(ctx, epoch);
        check();
        let migrationError: unknown;
        try { await migrateLegacyDiscardLedger(undefined, check); }
        catch (error) { check(); migrationError = error; }
        check();
        const notes = markLegacyOwnerUnknown((await withVoiceNoteSaveDeadline("native listPending for reconcile", () => VoiceNotes.listPending())).recordings);
        check();
        // A phone can retain notes from another account. They are never candidates for
        // this space, so do not queue a schema check and archive sweep ahead of a new Stop.
        if (notes.length > 0 && notes.every((note) => note.owner && note.owner !== ctx.did)) {
          if (migrationError) throw Object.assign(new Error(`Voice-note discard migration failed: ${String(migrationError)}`),
            { code: "discard_migration_failed", cause: migrationError });
          return;
        }
        try {
          const gate = await withVoiceNoteSaveDeadline("voice-note space setup", () => ensureVoiceNoteIdentity(tcw, check));
          if (gate.status !== "established") throw Object.assign(new Error(gate.reason ?? gate.status), { code: gate.status, cause: gate.cause });
          check();
          // Identity already sweeps archived rows. Running it again here delays
          // every queued upload behind a second space-wide SQL pass.
          await associateLegacyNotes(tcw, ctx.did, notes, check);
        } catch (error) {
          check();
          for (const note of notes) {
            if (note.owner === ctx.did && !note.ownerUnknown && note.ledger?.audio.state !== "saved" && !isDiscarded(note.id)) {
              pendingStore.reportNoteFailure(note.id, error);
            }
          }
          throw error;
        }
        let discardError: unknown;
        const saveQueue = notes.filter((note) => note.owner === ctx.did && !note.ownerUnknown &&
          note.ledger?.audio.state !== "saved" && !isDiscarded(note.id)).sort((a, b) => a.startedAt - b.startedAt);
        const uploadTickets = new Map(saveQueue.map((note) => [note.id, pendingStore.enqueueUpload(note)]));
        try {
        for (const note of [...notes].sort((a, b) => a.startedAt - b.startedAt)) {
          check();
          if (note.owner === ctx.did && !note.ownerUnknown) {
            if (trigger === "manual") pendingStore.setRetrying(note.id, null);
            let saved: VoiceNoteRecording | null = null;
            try {
              saved = await processOne(ctx, note.id, epoch, true, uploadTickets.get(note.id));
              syncDesktopAfterUpload(ctx, saved);
              check();
              if (saved) captureEvents.emit("library-changed", { source: VOICE_NOTE_SOURCE, sourceId: note.id });
            }
            catch (error) {
              check();
              if (isDiscarded(note.id)) discardError ??= error;
              else pendingStore.reportNoteFailure(note.id, error);
            } finally {
              // The native ledger is authoritative for the In progress count. Publish
              // each completed note during a long reconcile pass, not only at the end.
              check();
              await pendingStore.refresh();
            }
            if (saved) onSaved?.(saved);
          }
        }
        } finally {
          for (const ticket of uploadTickets.values()) pendingStore.settleUploadQueue(ticket);
        }
        // Pending audio uploads went first. This untracked catch-up pass restores
        // reconcile's Markdown retry without making saved audio look like an upload.
        for (const note of notes) {
          check();
          if (note.owner !== ctx.did || note.ledger?.audio.state !== "saved" || isDiscarded(note.id)) continue;
          try { await syncRecordingNote(tcw, note.id, check); }
          catch (error) {
            check();
            console.warn("[VoiceNotes] Saved audio's Markdown sync is still pending", { id: note.id, error });
          }
        }
        if (migrationError) throw Object.assign(new Error(`Voice-note discard migration failed: ${String(migrationError)}`),
          { code: "discard_migration_failed", cause: migrationError });
        if (discardError) throw discardError;
      });
    },
    cancelAll() { accepting = false; cancellation++; setAccountWorkPaused(tcw, true); },
    resume() { accepting = true; setAccountWorkPaused(tcw, false); },
    isAccepting() { return accepting; },
    async quiescent(timeoutMs) {
      if (active.size === 0) return true;
      const settled = Promise.allSettled([...active]).then(() => true);
      if (timeoutMs <= 0) return false;
      return Promise.race([settled, new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
    },
  };
}
