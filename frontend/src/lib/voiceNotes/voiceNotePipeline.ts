import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "@/capture/captureEvents";
import { assertCurrent, setAccountWorkPaused, StaleAccountContext, type AccountContext } from "./accountContext";
import { associateLegacyNotes, markLegacyOwnerUnknown, migrateLegacyDiscardLedger } from "./legacyMigration";
import { VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { errorCode, isDiscarded, pendingStore, saveNoteForAccount, type PendingUploadTicket } from "./recorderSaves";
import { ensureVoiceNoteIdentity, publishDeviceTranscriptProgress, resolveVoiceNoteRows } from "./voiceNoteRows";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";
import { syncRecordingNote, VOICE_NOTE_SOURCE } from "./voiceNoteStore";
import { registerOnDeviceTranscriptCoordinator, syncOnDeviceTranscriptAutomatically, syncOnDeviceTranscriptAttempt,
  type TranscriptSyncOutcome } from "./onDeviceTranscriber";
import { appPlatform } from "@/lib/platform";
import type { StoreAudioOptions } from "./voiceNoteStore";
import { logPipeline } from "@/lib/debugLog";
import { markVoiceNoteInventoryUnknown, writeVoiceNotePendingSnapshot } from "./voiceNotePendingSnapshot";

export interface VoiceNotePipeline {
  process(ctx: AccountContext, id: string, trigger?: "stop" | "background", onRowCreated?: () => void,
    onSaved?: (note: VoiceNoteRecording) => void): Promise<void | "owned-by-another-run" | "retry-scheduled">;
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
  testOptions: Pick<StoreAudioOptions, "retryDelaysMs"> & {
    saveRetryDelaysMs?: readonly number[]; transcriptRetryDelaysMs?: readonly number[]; transcriptPassCooldownMs?: number;
  } = {}): VoiceNotePipeline {
  setAccountWorkPaused(tcw, false);
  let cancellation = 0;
  let accepting = true;
  const active = new Set<Promise<unknown>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();
  const transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const transcriptRetries = new Map<string, { attempts: number; nextAt: number; exhaustedUntil: number }>();
  const settledTranscripts = new Map<string, number>();
  let continuation: ReturnType<typeof setTimeout> | null = null;
  let unregisterTranscriptCoordinator: (() => void) | null = null;
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
  const scheduleRetry = (ctx: AccountContext, id: string, epoch: number, at: number,
    onRowCreated?: () => void, onSaved?: (note: VoiceNoteRecording) => void) => {
    if (retryTimers.has(id)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(id);
      if (!accepting || epoch !== cancellation) return;
      const ticket = pendingStore.enqueueUpload(id);
      if (!ticket.owns) return;
      void run(async () => {
        try {
          const saved = await processOne(ctx, id, epoch, true, ticket, onRowCreated, onSaved);
          syncDesktopAfterUpload(ctx, saved);
          if (saved) {
            checkFor(ctx, epoch)();
            captureEvents.emit("library-changed", { source: VOICE_NOTE_SOURCE, sourceId: saved.id });
            onSaved?.(saved);
          }
        } catch (error) {
          if (!saveDeferredForAccountTransition(error)) pendingStore.reportNoteFailure(id, error);
        } finally { await pendingStore.refresh(); }
      }).catch((error) => console.warn("[VoiceNotes] Scheduled retry could not refresh pending notes", error));
    }, Math.max(0, at - Date.now()));
    retryTimers.set(id, timer);
  };
  const syncDesktopAfterUpload = (ctx: AccountContext, note: VoiceNoteRecording | null) => {
    if (!note || appPlatform() !== "tauri" || note.options?.transcriber !== "on-device") return;
    // Upload owns no slot by this point. Whisper and upload may finish in either order.
    void syncOnDeviceTranscriptAutomatically(tcw, { id: note.id, owner: note.owner,
      ledger: { audio: { state: "saved" } }, stt: note.stt }, ctx)
      .catch((error) => console.warn("[VoiceNotes] Desktop transcript sync is still pending", { id: note.id, error }));
  };
  const processOne = async (ctx: AccountContext, id: string, epoch: number, trackPending = false,
    uploadTicket?: PendingUploadTicket, onRowCreated?: () => void,
    onSaved?: (note: VoiceNoteRecording) => void): Promise<VoiceNoteRecording | null> => {
    if (uploadTicket && !uploadTicket.owns) return null;
    try {
    const check = checkFor(ctx, epoch);
    check();
    const retryAt = pendingStore.retryAt(id);
    if (retryAt && retryAt > Date.now()) {
      scheduleRetry(ctx, id, epoch, retryAt, onRowCreated, onSaved);
      return null;
    }
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
      check();
      pendingStore.setHeld(id, undefined);
      pendingStore.setRetrying(id, null);
      const result = await saveNoteForAccount(tcw, ctx, note, check, {
        ...testOptions,
        uploadTicket,
        onRowCreated,
      });
      const attempt = retryAttempts.get(id) ?? 0;
      if (result.kind === "failed" && result.failureKind === "timeout" && attempt < retryDelays.length) {
        const delay = testOptions.saveRetryDelaysMs
          ? retryDelays[attempt]!
          : Math.round(retryDelays[attempt]! * (0.8 + Math.random() * 0.4));
        const nextAttemptAt = Date.now() + delay;
        retryAttempts.set(id, attempt + 1);
        pendingStore.setRetrying(id, nextAttemptAt);
        if (uploadTicket) pendingStore.publishUpload(id, uploadTicket.owner, { state: "retrying", bytes: 0, total: note.sizeBytes });
        logPipeline("save", id, "retrying");
        scheduleRetry(ctx, id, epoch, nextAttemptAt, onRowCreated, onSaved);
        return null;
      }
      retryAttempts.delete(id);
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
  let transcriptCursor: { startedAt: number; id: string } | null = null;
  let transcriptPassTail: Promise<void> = Promise.resolve();
  let settledInspectionRun = 0;
  const transcriptFlights = new Map<string, { promise: Promise<TranscriptSyncOutcome>; markDirty: (note: VoiceNoteRecording) => void }>();
  const retryRevisions = new Map<string, number>();
  const transcriptKey = (ctx: AccountContext, id: string, rev: number) =>
    `${ctx.did}:${ctx.generation}:${id}:${rev}`;
  const scheduleTranscriptTurn = (ctx: AccountContext, epoch: number, id: string, delay: number) => {
    if (transcriptTimers.has(id)) return;
    const timer = setTimeout(() => {
      transcriptTimers.delete(id);
      if (!accepting || cancellation !== epoch) return;
      void run(async () => {
        const check = checkFor(ctx, epoch);
        check();
        const note = (await withVoiceNoteSaveDeadline(`native listPending for transcript retry ${id}`,
          () => VoiceNotes.listPending())).recordings.find((entry) => entry.id === id);
        check();
        if (note && note.owner === ctx.did && !isDiscarded(id))
          await attemptTranscript(ctx, note, check);
      }).catch((error) => { if (!saveDeferredForAccountTransition(error)) console.warn("[VoiceNotes] Transcript retry deferred", { id, error }); });
    }, delay);
    transcriptTimers.set(id, timer);
  };
  const syncTranscriptRevision = async (ctx: AccountContext, note: VoiceNoteRecording, check: () => void,
    flightKey: string, revision?: number): Promise<TranscriptSyncOutcome> => {
    check();
    if (note.owner !== ctx.did || note.ownerUnknown || isDiscarded(note.id)) return { state: "abandoned" };
    if (revision === undefined && retryRevisions.has(flightKey)) {
      try {
        const { transcript } = await withVoiceNoteSaveDeadline(`native getTranscript before retry ${note.id}`,
          () => VoiceNotes.getTranscript({ id: note.id }));
        check();
        revision = transcript?.rev;
      } catch (error) {
        check();
        console.warn("[VoiceNotes] Native transcript revision unavailable", { id: note.id, error });
      }
    }
    const knownKey = transcriptKey(ctx, note.id, revision ?? 0);
    const retry = transcriptRetries.get(knownKey);
    const now = Date.now();
    if (retry && (retry.nextAt > now || retry.exhaustedUntil > now))
      return { state: "deferred", rev: revision };
    // A later foreground turn starts a new bounded episode only after the exhausted cooldown.
    if (retry?.exhaustedUntil && retry.exhaustedUntil <= now) transcriptRetries.delete(knownKey);
    const result = await syncOnDeviceTranscriptAttempt(tcw, note, ctx);
    if (result.state === "abandoned") return result;
    check();
    const key = transcriptKey(ctx, note.id, result.rev ?? revision ?? 0);
    if (result.state === "committed" || result.state === "terminal") {
      if (result.rev) settledTranscripts.set(note.id, result.rev);
      transcriptRetries.delete(key);
      retryRevisions.delete(flightKey);
    } else if (result.state === "retryable" || result.state === "receipt-pending") {
      retryRevisions.set(flightKey, result.rev ?? revision ?? 0);
      const previous = transcriptRetries.get(key);
      const delays = testOptions.transcriptRetryDelaysMs ?? [5_000, 30_000, 120_000];
      const attempts = previous?.attempts ?? 0;
      if (attempts >= delays.length)
        transcriptRetries.set(key, { attempts, nextAt: 0, exhaustedUntil: Date.now() + 120_000 });
      else {
        const delay = delays[attempts]!;
        transcriptRetries.set(key, { attempts: attempts + 1, nextAt: Date.now() + delay, exhaustedUntil: 0 });
        scheduleTranscriptTurn(ctx, cancellation, note.id, delay);
      }
    }
    return result;
  };
  const attemptTranscript = (ctx: AccountContext, note: VoiceNoteRecording, check: () => void,
    revision?: number): Promise<TranscriptSyncOutcome> => {
    const flightKey = transcriptKey(ctx, note.id, 0);
    const current = transcriptFlights.get(flightKey);
    if (current) {
      current.markDirty(note);
      return current.promise;
    }
    let dirty = false;
    let latest = note;
    const work = (async () => {
      let outcome = await syncTranscriptRevision(ctx, note, check, flightKey, revision);
      let completedRev = outcome.rev ?? revision ?? 0;
      while (dirty) {
        dirty = false;
        check();
        let nextRev: number | undefined;
        try {
          const { transcript } = await withVoiceNoteSaveDeadline(`native getTranscript after overlapping sync ${note.id}`,
            () => VoiceNotes.getTranscript({ id: note.id }));
          check();
          nextRev = transcript?.rev;
        } catch (error) {
          check();
          console.warn("[VoiceNotes] Overlapping transcript revision read deferred", { id: note.id, error });
          scheduleTranscriptTurn(ctx, cancellation, note.id, testOptions.transcriptRetryDelaysMs?.[0] ?? 5_000);
        }
        if (nextRev === undefined || nextRev <= completedRev) continue;
        outcome = await syncTranscriptRevision(ctx, latest, check, flightKey, nextRev);
        completedRev = Math.max(completedRev, outcome.rev ?? nextRev);
      }
      return outcome;
    })();
    transcriptFlights.set(flightKey, { promise: work, markDirty: (next) => { dirty = true; latest = next; } });
    void work.finally(() => { if (transcriptFlights.get(flightKey)?.promise === work) transcriptFlights.delete(flightKey); })
      .catch(() => undefined);
    return work;
  };
  const inspectTranscripts = async (ctx: AccountContext, check: () => void,
    scheduleContinuation: boolean): Promise<void> => {
    check();
    const notes = markLegacyOwnerUnknown((await withVoiceNoteSaveDeadline("native listPending for transcripts",
      () => VoiceNotes.listPending())).recordings);
    check();
    const complete = notes.filter((note) => note.owner === ctx.did && !note.ownerUnknown && !note.legacyImport
      && !isDiscarded(note.id) && note.stt?.state === "done");
    const unresolved = complete.filter((note) => !note.ledger?.audio.rowId && note.ledger?.audio.state === "saved");
    const resolved = unresolved.length > 0 ? await resolveVoiceNoteRows(tcw, unresolved.map((note) => note.id), check) : null;
    check();
    const candidates = complete.filter((note) => note.ledger?.audio.rowId
      || (note.ledger?.audio.state === "saved" && resolved?.get(note.id)?.row))
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    const start = transcriptCursor === null ? 0 : candidates.findIndex((note) =>
      note.startedAt > transcriptCursor!.startedAt || (note.startedAt === transcriptCursor!.startedAt && note.id > transcriptCursor!.id));
    const ordered = start < 0 ? candidates : [...candidates.slice(start), ...candidates.slice(0, start)];
    let inspected = 0;
    let remaining = false;
    for (const note of ordered) {
      if (inspected >= 8) { remaining = true; break; }
      inspected++;
      transcriptCursor = { startedAt: note.startedAt, id: note.id };
      check();
      let revision: number | undefined;
      try {
        const { transcript } = await withVoiceNoteSaveDeadline(`native getTranscript before sync ${note.id}`,
          () => VoiceNotes.getTranscript({ id: note.id }));
        check();
        revision = transcript?.rev;
      } catch (error) {
        check();
        console.warn("[VoiceNotes] Native transcript inspection deferred", { id: note.id, error });
      }
      if (revision && settledTranscripts.get(note.id) === revision) {
        settledInspectionRun++;
        continue;
      }
      const outcome = await attemptTranscript(ctx, note, check, revision);
      settledInspectionRun = outcome.state === "deferred" ? settledInspectionRun + 1 : 0;
    }
    if (remaining && settledInspectionRun < candidates.length && scheduleContinuation && continuation === null) {
      const epoch = cancellation;
      continuation = setTimeout(() => {
        continuation = null;
        if (!accepting || cancellation !== epoch) return;
        void run(() => transcriptPass(ctx, checkFor(ctx, epoch), true))
          .catch((error) => { if (!saveDeferredForAccountTransition(error)) console.warn("[VoiceNotes] Transcript continuation deferred", error); });
      }, testOptions.transcriptPassCooldownMs ?? 250);
    }
  };
  const transcriptPass = (ctx: AccountContext, check: () => void, scheduleContinuation: boolean): Promise<void> => {
    const turn = transcriptPassTail.then(() => inspectTranscripts(ctx, check, scheduleContinuation));
    transcriptPassTail = turn.catch(() => undefined);
    return turn;
  };
  unregisterTranscriptCoordinator = registerOnDeviceTranscriptCoordinator(tcw,
    (recording, ctx) => run(() => attemptTranscript(ctx, recording as VoiceNoteRecording,
      checkFor(ctx, cancellation))));
  return {
    process(ctx, id, _trigger = "stop", onRowCreated, onSaved) {
      if (!accepting) return Promise.reject(new VoiceNoteSaveDeferred());
      const epoch = cancellation;
      const uploadTicket = pendingStore.enqueueUpload(id);
      if (!uploadTicket.owns) return Promise.resolve("owned-by-another-run");
      return run(async () => {
        syncDesktopAfterUpload(ctx, await processOne(ctx, id, epoch, false, uploadTicket, onRowCreated, onSaved));
        if ((pendingStore.retryAt(id) ?? 0) > Date.now()) return "retry-scheduled" as const;
      });
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
        const observedAt = new Date().toISOString();
        let notes: VoiceNoteRecording[];
        try {
          notes = markLegacyOwnerUnknown((await withVoiceNoteSaveDeadline("native listPending for reconcile",
            () => VoiceNotes.listPending())).recordings);
        } catch (error) {
          check();
          markVoiceNoteInventoryUnknown(ctx);
          throw error;
        }
        check();
        void run(async () => {
          try { await writeVoiceNotePendingSnapshot(tcw, notes, ctx, observedAt, undefined, check); }
          catch (error) {
            if (!saveDeferredForAccountTransition(error)) console.warn("[VoiceNotes] Pending snapshot publication deferred", error);
          }
        });
        void run(async () => {
          for (const note of notes) {
            check();
            if (note.owner !== ctx.did || note.ownerUnknown || isDiscarded(note.id)
              || (!note.ledger?.audio.rowId && note.ledger?.audio.state !== "saved")) continue;
            const state = note.stt?.state;
            if (state === "queued" || state === "waiting_for_model" || state === "running")
              await publishDeviceTranscriptProgress(tcw, note.id, state, check);
          }
        }).catch((error) => {
          if (!saveDeferredForAccountTransition(error)) console.warn("[VoiceNotes] Local progress publication deferred", error);
        });
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
        await transcriptPass(ctx, check, false);
        check();
        let discardError: unknown;
        const saveQueue = notes.filter((note) => note.owner === ctx.did && !note.ownerUnknown &&
          note.ledger?.audio.state !== "saved" && !isDiscarded(note.id)).sort((a, b) => a.startedAt - b.startedAt);
        const uploadTickets = new Map(saveQueue.map((note) => [note.id, pendingStore.enqueueUpload(note)]));
        try {
        for (const note of [...notes].sort((a, b) => a.startedAt - b.startedAt)) {
          check();
          if (note.owner === ctx.did && !note.ownerUnknown) {
            if (trigger === "manual") {
              pendingStore.setRetrying(note.id, null);
              retryAttempts.delete(note.id);
              const timer = retryTimers.get(note.id);
              if (timer) clearTimeout(timer);
              retryTimers.delete(note.id);
            }
            let saved: VoiceNoteRecording | null = null;
            try {
              saved = await processOne(ctx, note.id, epoch, true, uploadTickets.get(note.id), undefined, onSaved);
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
        await transcriptPass(ctx, check, true);
        check();
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
    cancelAll() {
      accepting = false; cancellation++;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      for (const timer of transcriptTimers.values()) clearTimeout(timer);
      transcriptTimers.clear();
      if (continuation !== null) clearTimeout(continuation);
      continuation = null;
      transcriptRetries.clear();
      retryRevisions.clear();
      settledInspectionRun = 0;
      transcriptFlights.clear();
      unregisterTranscriptCoordinator?.();
      unregisterTranscriptCoordinator = null;
      settledTranscripts.clear();
      setAccountWorkPaused(tcw, true);
    },
    resume() {
      accepting = true; setAccountWorkPaused(tcw, false);
      unregisterTranscriptCoordinator ??= registerOnDeviceTranscriptCoordinator(tcw,
        (recording, ctx) => run(() => attemptTranscript(ctx, recording as VoiceNoteRecording,
          checkFor(ctx, cancellation))));
    },
    isAccepting() { return accepting; },
    async quiescent(timeoutMs) {
      if (active.size === 0) return true;
      const settled = Promise.allSettled([...active]).then(() => true);
      if (timeoutMs <= 0) return false;
      return Promise.race([settled, new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
    },
  };
}
