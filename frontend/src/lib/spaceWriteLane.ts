import { createVoiceNoteSaveTimeout, voiceNoteCallDeadlineMs } from "./voiceNotes/saveDeadline";

/** Small voice-note storage jobs and the existing background drain share this queue. */
let lane: Promise<void> = Promise.resolve();
const ABORT_SETTLE_GRACE_MS = 30_000;
/** Allow legitimate multi-minute syncs to finish before failing a queued save. */
const QUEUE_WAIT_LIMIT_MS = 10 * 60_000;
let testAbortSettleGraceMs: number | null = null;
let testQueueWaitLimitMs: number | null = null;
let nextLaneJobId = 0;
let activeLaneJob: { id: number; operation: string } | null = null;

export interface SpaceLaneCallDeadline {
  operation: string;
  /** Payload size for uploads; establishes 8 KB/s minimum throughput headroom. */
  payloadBytes?: number;
  timeoutMs?: number;
}

export class SpaceLaneQueueWaitTimeout extends Error {
  readonly code = "SPACE_LANE_QUEUE_TIMEOUT";
  constructor(readonly operation: string, readonly waitingOn: string, readonly timeoutMs: number) {
    super("Saving is waiting for another sync to finish. Try again shortly.");
    this.name = "SpaceLaneQueueWaitTimeout";
  }
}

type CallerSettlement<T> = { kind: "resolve"; value: T } | { kind: "reject"; error: unknown };

/** Only call sites for one TinyCloud request pass a deadline; composite lane jobs remain serialized. */
export function runOnSpaceLane<T>(job: (signal?: AbortSignal) => Promise<T>, deadline?: SpaceLaneCallDeadline): Promise<T> {
  const previous = lane;
  const jobId = ++nextLaneJobId;
  let release!: () => void;
  lane = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let timedOut = false;
  let released = false;
  let callerSettled = false;
  let queueWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let callDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const queueWaitMs = testQueueWaitLimitMs ?? QUEUE_WAIT_LIMIT_MS;

  const releaseLane = () => {
    if (released) return;
    released = true;
    if (abortGraceTimer !== undefined) clearTimeout(abortGraceTimer);
    if (activeLaneJob?.id === jobId) activeLaneJob = null;
    release();
  };

  let callerResolve!: (value: T) => void;
  let callerReject!: (error: unknown) => void;
  const caller = new Promise<T>((resolve, reject) => { callerResolve = resolve; callerReject = reject; });
  const settleCaller = (settlement: CallerSettlement<T>) => {
    if (callerSettled) return;
    callerSettled = true;
    if (queueWaitTimer !== undefined) clearTimeout(queueWaitTimer);
    if (callDeadlineTimer !== undefined) clearTimeout(callDeadlineTimer);
    if (settlement.kind === "resolve") callerResolve(settlement.value);
    else callerReject(settlement.error);
  };

  // Queue time has its own generous limit. A healthy drain may run longer than a
  // single-call deadline; only a call that has actually started uses that budget.
  if (deadline) {
    queueWaitTimer = setTimeout(() => {
      if (callerSettled || started) return;
      timedOut = true;
      controller.abort();
      const waitingOn = activeLaneJob?.operation ?? "background drain";
      const error = new SpaceLaneQueueWaitTimeout(deadline.operation, waitingOn, queueWaitMs);
      console.error(`[VoiceNotes] Space lane queue wait timed out for ${deadline.operation} after ${queueWaitMs}ms; waiting on ${waitingOn}`);
      settleCaller({ kind: "reject", error });
    }, queueWaitMs);
  }

  void previous.then(() => {
    if (timedOut) {
      releaseLane();
      return;
    }
    started = true;
    if (queueWaitTimer !== undefined) clearTimeout(queueWaitTimer);
    const operation = deadline?.operation ?? "background drain";
    activeLaneJob = { id: jobId, operation };

    // The operation budget begins now, after the prior lane job has finished.
    const timeoutMs = deadline
      ? deadline.timeoutMs ?? voiceNoteCallDeadlineMs(deadline.payloadBytes ?? 0)
      : null;
    if (deadline && timeoutMs !== null) {
      callDeadlineTimer = setTimeout(() => {
        if (callerSettled) return;
        timedOut = true;
        controller.abort();
        settleCaller({ kind: "reject", error: createVoiceNoteSaveTimeout(deadline.operation, timeoutMs) });
        if (!released) {
          const graceMs = testAbortSettleGraceMs ?? ABORT_SETTLE_GRACE_MS;
          abortGraceTimer = setTimeout(() => {
            if (released) return;
            console.error(`[VoiceNotes] Releasing space lane after aborted operation did not settle: ${deadline.operation} (grace ${graceMs}ms)`);
            releaseLane();
          }, graceMs);
        }
      }, timeoutMs);
    }

    let request: Promise<T>;
    try { request = Promise.resolve(job(deadline ? controller.signal : undefined)); }
    catch (error) {
      releaseLane();
      settleCaller({ kind: "reject", error });
      return;
    }
    request.then((value) => {
      releaseLane();
      settleCaller({ kind: "resolve", value });
    }, (error: unknown) => {
      releaseLane();
      settleCaller({ kind: "reject", error });
    });
  }, (error: unknown) => {
    releaseLane();
    settleCaller({ kind: "reject", error });
  });

  return caller;
}

/** Tests only: discard a completed lane from the previous case. */
export function resetSpaceLaneForTests(): void { lane = Promise.resolve(); activeLaneJob = null; }
/** Tests only: shorten the post-abort lane grace period. */
export function setSpaceLaneAbortGraceForTests(timeoutMs: number | null): void { testAbortSettleGraceMs = timeoutMs; }
/** Tests only: shorten the queue wait ceiling without changing call deadlines. */
export function setSpaceLaneQueueWaitForTests(timeoutMs: number | null): void { testQueueWaitLimitMs = timeoutMs; }
