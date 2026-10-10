import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { assertCurrent, StaleAccountContext, type AccountContext } from "./accountContext";
import { associateLegacyNotes, markLegacyOwnerUnknown, migrateLegacyDiscardLedger } from "./legacyMigration";
import { VoiceNotes } from "./nativeVoiceNotes";
import { isDiscarded, saveNoteForAccount } from "./recorderSaves";
import { ensureVoiceNoteIdentity, sweepArchived } from "./voiceNoteRows";

export interface VoiceNotePipeline {
  process(ctx: AccountContext, id: string, trigger?: "stop" | "background"): Promise<void>;
  /** T19 calls setCaptureDefaults on ready before this association and upload pass. */
  reconcileAll(ctx: AccountContext, trigger?: "reconcile" | "manual"): Promise<void>;
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

function logSaveStart(id: string, trigger: "stop" | "background" | "reconcile" | "manual"): void {
  console.debug(`[VoiceNotes] automatic save starting id=${id} trigger=${trigger}`);
}

/** T22 extends these lanes with transcription and cleanup, retaining this API. */
export function createVoiceNotePipeline(tcw: TinyCloudWeb): VoiceNotePipeline {
  let cancellation = 0;
  let accepting = true;
  const active = new Set<Promise<void>>();
  const run = (job: () => Promise<void>): Promise<void> => {
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
  const processOne = async (ctx: AccountContext, id: string, epoch: number) => {
    const check = checkFor(ctx, epoch);
    check();
    const gate = await ensureVoiceNoteIdentity(tcw, check);
    if (gate.status !== "established") throw Object.assign(new Error(gate.reason ?? gate.status), { code: gate.status });
    check();
    // Identity does the initial archive repair, and reconcileAll sweeps once for the
    // session. A fresh Stop must not repeat that space-wide work before its upload.
    const note = (await VoiceNotes.listPending()).recordings.find((r) => r.id === id);
    if (!note) return;
    check();
    const result = await saveNoteForAccount(tcw, ctx, note, check);
    if (result.kind === "failed") { check(); throw new Error(result.failure); }
    if (result.kind === "discarded" && result.cleanupError) throw new Error(result.cleanupError);
  };
  return {
    process(ctx, id, trigger = "stop") {
      if (!accepting) return Promise.reject(new VoiceNoteSaveDeferred());
      const epoch = cancellation;
      logSaveStart(id, trigger);
      return run(() => processOne(ctx, id, epoch));
    },
    reconcileAll(ctx, trigger = "reconcile") {
      if (!accepting) return Promise.reject(new VoiceNoteSaveDeferred());
      const epoch = cancellation;
      return run(async () => {
        const check = checkFor(ctx, epoch);
        check();
        let migrationError: unknown;
        try { await migrateLegacyDiscardLedger(undefined, check); }
        catch (error) { check(); migrationError = error; }
        check();
        const notes = markLegacyOwnerUnknown((await VoiceNotes.listPending()).recordings);
        check();
        // A phone can retain notes from another account. They are never candidates for
        // this space, so do not queue a schema check and archive sweep ahead of a new Stop.
        if (notes.length > 0 && notes.every((note) => note.owner && note.owner !== ctx.did)) {
          if (migrationError) throw Object.assign(new Error(`Voice-note discard migration failed: ${String(migrationError)}`),
            { code: "discard_migration_failed", cause: migrationError });
          return;
        }
        const gate = await ensureVoiceNoteIdentity(tcw, check);
        if (gate.status !== "established") throw Object.assign(new Error(gate.reason ?? gate.status), { code: gate.status });
        check();
        await sweepArchived(tcw, check);
        check();
        await associateLegacyNotes(tcw, ctx.did, notes, check);
        let discardError: unknown;
        for (const note of [...notes].sort((a, b) => a.startedAt - b.startedAt)) {
          check();
          if (note.owner === ctx.did && !note.ownerUnknown) {
            try {
              logSaveStart(note.id, trigger);
              await processOne(ctx, note.id, epoch);
            }
            catch (error) {
              check();
              if (!isDiscarded(note.id)) throw error;
              discardError ??= error;
            }
          }
        }
        if (migrationError) throw Object.assign(new Error(`Voice-note discard migration failed: ${String(migrationError)}`),
          { code: "discard_migration_failed", cause: migrationError });
        if (discardError) throw discardError;
      });
    },
    cancelAll() { accepting = false; cancellation++; },
    resume() { accepting = true; },
    isAccepting() { return accepting; },
    async quiescent(timeoutMs) {
      if (active.size === 0) return true;
      const settled = Promise.allSettled([...active]).then(() => true);
      if (timeoutMs <= 0) return false;
      return Promise.race([settled, new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
    },
  };
}
