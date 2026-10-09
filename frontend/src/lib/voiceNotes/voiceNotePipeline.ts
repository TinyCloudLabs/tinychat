import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { assertCurrent, type AccountContext } from "./accountContext";
import { associateLegacyNotes, markLegacyOwnerUnknown, migrateLegacyDiscardLedger } from "./legacyMigration";
import { VoiceNotes } from "./nativeVoiceNotes";
import { isDiscarded, saveNoteForAccount } from "./recorderSaves";
import { ensureVoiceNoteIdentity, sweepArchived } from "./voiceNoteRows";

export interface VoiceNotePipeline {
  process(ctx: AccountContext, id: string): Promise<void>;
  /** T19 calls setCaptureDefaults on ready before this association and upload pass. */
  reconcileAll(ctx: AccountContext): Promise<void>;
  cancelAll(): void;
  resume(): void;
  isAccepting(): boolean;
  quiescent(timeoutMs: number): Promise<boolean>;
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
    assertCurrent(ctx);
    if (!accepting) throw new Error("Voice-note save is suspended during account transition");
    if (epoch !== cancellation) throw new Error("Voice-note save was cancelled");
    if (tcw.did !== ctx.did || tcw.spaceId !== ctx.spaceId) throw new Error("Voice-note space changed");
  };
  const processOne = async (ctx: AccountContext, id: string, epoch: number) => {
    const check = checkFor(ctx, epoch);
    check();
    const gate = await ensureVoiceNoteIdentity(tcw, check);
    if (gate.status !== "established") throw Object.assign(new Error(gate.reason ?? gate.status), { code: gate.status });
    check();
    await sweepArchived(tcw, check);
    check();
    const note = (await VoiceNotes.listPending()).recordings.find((r) => r.id === id);
    if (!note) return;
    check();
    const result = await saveNoteForAccount(tcw, ctx, note, check);
    if (result.kind === "failed") throw new Error(result.failure);
    if (result.kind === "discarded" && result.cleanupError) throw new Error(result.cleanupError);
  };
  return {
    process(ctx, id) {
      if (!accepting) return Promise.reject(new Error("Voice-note save is suspended during account transition"));
      const epoch = cancellation;
      return run(() => processOne(ctx, id, epoch));
    },
    reconcileAll(ctx) {
      if (!accepting) return Promise.reject(new Error("Voice-note save is suspended during account transition"));
      const epoch = cancellation;
      return run(async () => {
        const check = checkFor(ctx, epoch);
        check();
        let migrationError: unknown;
        try { await migrateLegacyDiscardLedger(undefined, check); }
        catch (error) { check(); migrationError = error; }
        check();
        const gate = await ensureVoiceNoteIdentity(tcw, check);
        if (gate.status !== "established") throw Object.assign(new Error(gate.reason ?? gate.status), { code: gate.status });
        check();
        await sweepArchived(tcw, check);
        check();
        const notes = markLegacyOwnerUnknown((await VoiceNotes.listPending()).recordings);
        check();
        await associateLegacyNotes(tcw, ctx.did, notes, check);
        let discardError: unknown;
        for (const note of [...notes].sort((a, b) => a.startedAt - b.startedAt)) {
          check();
          if (note.owner === ctx.did && !note.ownerUnknown) {
            try { await processOne(ctx, note.id, epoch); }
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
