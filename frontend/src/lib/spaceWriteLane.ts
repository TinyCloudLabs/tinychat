import { createVoiceNoteSaveTimeout, voiceNoteCallDeadlineMs } from "./voiceNotes/saveDeadline";

/** Small voice-note storage jobs and the existing background drain share this queue. */
let lane: Promise<unknown> = Promise.resolve();
const ABORT_SETTLE_GRACE_MS = 30_000;
let testAbortSettleGraceMs: number | null = null;

export interface SpaceLaneCallDeadline {
  operation: string;
  /** Payload size for uploads; establishes 8 KB/s minimum throughput headroom. */
  payloadBytes?: number;
  timeoutMs?: number;
}

/** Only call sites for one TinyCloud request pass a deadline; composite lane jobs remain serialized. */
export function runOnSpaceLane<T>(job: (signal?: AbortSignal) => Promise<T>, deadline?: SpaceLaneCallDeadline): Promise<T> {
  const previous = lane;
  let release!: () => void;
  lane = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let timedOut = false;
  let released = false;
  let callerSettled = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeoutMs = deadline
    ? deadline.timeoutMs ?? voiceNoteCallDeadlineMs(deadline.payloadBytes ?? 0)
    : null;

  const releaseLane = () => {
    if (released) return;
    released = true;
    if (abortGraceTimer !== undefined) clearTimeout(abortGraceTimer);
    release();
  };

  let callerResolve!: (value: T) => void;
  let callerReject!: (error: unknown) => void;
  const caller = new Promise<T>((resolve, reject) => { callerResolve = resolve; callerReject = reject; });
  const settleCaller = (value: T | undefined, error?: unknown) => {
    if (callerSettled) return;
    callerSettled = true;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (error !== undefined) callerReject(error);
    else callerResolve(value as T);
  };

  // Start the caller's clock at enqueue, so waiting behind another lane job is
  // visible and bounded too. An expired queued job is skipped when its turn arrives.
  if (deadline && timeoutMs !== null) {
    deadlineTimer = setTimeout(() => {
      if (callerSettled) return;
      timedOut = true;
      controller.abort();
      settleCaller(undefined, createVoiceNoteSaveTimeout(deadline.operation, timeoutMs));
      if (started && !released) {
        const graceMs = testAbortSettleGraceMs ?? ABORT_SETTLE_GRACE_MS;
        abortGraceTimer = setTimeout(() => {
          if (released) return;
          console.error(`[VoiceNotes] Releasing space lane after aborted operation did not settle: ${deadline.operation} (grace ${graceMs}ms)`);
          releaseLane();
        }, graceMs);
      }
    }, timeoutMs);
  }

  void previous.then(() => {
    if (timedOut) {
      releaseLane();
      return;
    }
    started = true;
    let request: Promise<T>;
    try { request = Promise.resolve(job(deadline ? controller.signal : undefined)); }
    catch (error) {
      releaseLane();
      settleCaller(undefined, error);
      return;
    }
    request.then((value) => {
      releaseLane();
      settleCaller(value);
    }, (error: unknown) => {
      releaseLane();
      settleCaller(undefined, error);
    });
  }, (error: unknown) => {
    releaseLane();
    settleCaller(undefined, error);
  });

  return caller;
}

/** Tests only: discard a completed lane from the previous case. */
export function resetSpaceLaneForTests(): void { lane = Promise.resolve(); }
/** Tests only: shorten the post-abort lane grace period. */
export function setSpaceLaneAbortGraceForTests(timeoutMs: number | null): void { testAbortSettleGraceMs = timeoutMs; }
