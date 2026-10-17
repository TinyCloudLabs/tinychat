import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "@/capture/captureEvents";
import { assertCurrent, setAccountWorkPaused, StaleAccountContext, type AccountContext } from "./accountContext";
import { associateLegacyNotes, markLegacyOwnerUnknown, migrateLegacyDiscardLedger } from "./legacyMigration";
import { VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { errorCode, isDiscarded, pendingStore, saveNoteForAccount, type PendingUploadTicket } from "./recorderSaves";
import { ensureVoiceNoteIdentity, spaceLaneAbandonedSqlCalls } from "./voiceNoteRows";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";
import { CONNECTORS_SQL_DB_NAME } from "@/lib/connectors/connectorStore";
import { withAbortTimeout } from "@/lib/abortTimeout";
import { syncRecordingNote, VOICE_NOTE_SOURCE } from "./voiceNoteStore";
import { syncOnDeviceTranscript } from "./onDeviceTranscriber";
import { appPlatform } from "@/lib/platform";
import type { AudioPutGate, StoreAudioOptions } from "./voiceNoteStore";
import { logPipeline } from "@/lib/debugLog";

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

/** First wait between drain probes that got no answer; doubles up to the maximum (TC-1274). */
const DRAIN_PROBE_BACKOFF_MS = 30_000;
const DRAIN_PROBE_MAX_BACKOFF_MS = 10 * 60_000;
/** A probe unanswered by then counts as "still busy"; the next attempt sends a fresh one. */
const DRAIN_PROBE_TIMEOUT_MS = 30_000;

/** T22 extends these lanes with transcription and cleanup, retaining this API. */
export function createVoiceNotePipeline(tcw: TinyCloudWeb,
  testOptions: Pick<StoreAudioOptions, "retryDelaysMs"> & { saveRetryDelaysMs?: readonly number[];
    drainProbeTimeoutMs?: number; drainProbeBackoffMs?: number } = {}): VoiceNotePipeline {
  setAccountWorkPaused(tcw, false);
  let cancellation = 0;
  let accepting = true;
  const active = new Set<Promise<unknown>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();
  // TC-1274: the node runs one request at a time per space database, in arrival order,
  // and keeps running an SQL call this app aborted at its deadline. A retry sent then
  // queues behind the abandoned call and deepens the backlog. Retries and reconcile passes
  // therefore first wait for one probe of the connectors database to answer: once it
  // does, everything queued before it has finished. One probe serves every waiter.
  const probeTimeoutMs = testOptions.drainProbeTimeoutMs ?? DRAIN_PROBE_TIMEOUT_MS;
  const firstBackoffMs = testOptions.drainProbeBackoffMs ?? DRAIN_PROBE_BACKOFF_MS;
  let drainedThrough = 0;
  let drainProbe: Promise<void> | null = null;
  let probeBackoffMs = firstBackoffMs;
  // Executor form: the frontend's ES2022 lib has no Promise.withResolvers.
  let releaseDrainWaiters = () => {};
  let drainWaitersReleased = new Promise<void>((resolve) => { releaseDrainWaiters = resolve; });
  const awaitServerDrain = async (check: () => void) => {
    while (spaceLaneAbandonedSqlCalls() > drainedThrough) {
      if (!drainProbe) {
        const probe: Promise<void> = (async () => {
          const through = spaceLaneAbandonedSqlCalls();
          // The race also covers a transport that ignores the abort signal.
          const answered = await withAbortTimeout(probeTimeoutMs, (timeout) => Promise.race([
            tcw.sql.db(CONNECTORS_SQL_DB_NAME).query("SELECT 1", [], { signal: timeout }).then((result) => result.ok, () => false),
            new Promise<false>((resolve) => timeout.addEventListener("abort", () => resolve(false), { once: true })),
          ]));
          if (answered) {
            drainedThrough = Math.max(drainedThrough, through);
            probeBackoffMs = firstBackoffMs;
            return;
          }
          // Unanswered or timed out: the node may still be busy, and a probe it never
          // answered may itself stay queued, so space the next one out.
          await new Promise<void>((resolve) => setTimeout(resolve, Math.round(probeBackoffMs * (0.8 + Math.random() * 0.4))));
          probeBackoffMs = Math.min(probeBackoffMs * 2, DRAIN_PROBE_MAX_BACKOFF_MS);
        })().finally(() => { if (drainProbe === probe) drainProbe = null; });
        drainProbe = probe;
      }
      await Promise.race([drainProbe, drainWaitersReleased]);
      check();
    }
  };
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
          // processOne settles the ticket; a retry cancelled while it waits must settle it here.
          try { await awaitServerDrain(checkFor(ctx, epoch)); }
          catch (error) { pendingStore.settleUploadQueue(ticket); throw error; }
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
    void syncOnDeviceTranscript(tcw, { id: note.id, owner: note.owner,
      ledger: { audio: { state: "saved" } }, stt: note.stt }, ctx)
      .catch((error) => console.warn("[VoiceNotes] Desktop transcript sync is still pending", { id: note.id, error }));
  };
  const processOne = async (ctx: AccountContext, id: string, epoch: number, trackPending = false,
    uploadTicket?: PendingUploadTicket, onRowCreated?: () => void,
    onSaved?: (note: VoiceNoteRecording) => void, audioGate?: AudioPutGate): Promise<VoiceNoteRecording | null> => {
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
        audioGate,
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
        const notes = markLegacyOwnerUnknown((await withVoiceNoteSaveDeadline("native listPending for reconcile", () => VoiceNotes.listPending())).recordings);
        check();
        // A phone can retain notes from another account. They are never candidates for
        // this space, so do not queue a schema check and archive sweep ahead of a new Stop.
        if (notes.length > 0 && notes.every((note) => note.owner && note.owner !== ctx.did)) {
          if (migrationError) throw Object.assign(new Error(`Voice-note discard migration failed: ${String(migrationError)}`),
            { code: "discard_migration_failed", cause: migrationError });
          return;
        }
        await awaitServerDrain(check);
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
        // At most one audio PUT per pass: the first storage-full error sets this gate for the rest.
        const audioGate: AudioPutGate = { full: null };
        const saveQueue = notes.filter((note) => note.owner === ctx.did && !note.ownerUnknown &&
          note.ledger?.audio.state !== "saved" && !isDiscarded(note.id)).sort((a, b) => a.startedAt - b.startedAt);
        const uploadTickets = new Map(saveQueue.map((note) => [note.id, pendingStore.enqueueUpload(note)]));
        try {
        for (const note of [...notes].sort((a, b) => a.startedAt - b.startedAt)) {
          check();
          if (note.owner === ctx.did && !note.ownerUnknown) {
            // Storage full: later notes in this pass still save their row, Markdown and
            // local-only work. Only their audio PUT is skipped, so each trigger probes once.
            if (trigger === "manual") {
              pendingStore.setRetrying(note.id, null);
              retryAttempts.delete(note.id);
              const timer = retryTimers.get(note.id);
              if (timer) clearTimeout(timer);
              retryTimers.delete(note.id);
            }
            let saved: VoiceNoteRecording | null = null;
            try {
              saved = await processOne(ctx, note.id, epoch, true, uploadTickets.get(note.id), undefined, onSaved, audioGate);
              syncDesktopAfterUpload(ctx, saved);
              check();
              if (saved) captureEvents.emit("library-changed", { source: VOICE_NOTE_SOURCE, sourceId: note.id });
            }
            catch (error) {
              check();
              if (isDiscarded(note.id)) discardError ??= error;
              else {
                pendingStore.reportNoteFailure(note.id, error);
              }
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
    cancelAll() {
      accepting = false; cancellation++; for (const timer of retryTimers.values()) clearTimeout(timer); retryTimers.clear();
      // Waiters wake now; after resume() a new waiter sends a fresh probe, never the old one.
      drainProbe = null;
      releaseDrainWaiters(); drainWaitersReleased = new Promise<void>((resolve) => { releaseDrainWaiters = resolve; });
      setAccountWorkPaused(tcw, true);
    },
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
