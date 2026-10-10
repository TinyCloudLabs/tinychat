import { deadlineForSpaceCall, voiceNoteCallDeadlineMs } from "./voiceNotes/saveDeadline";

/** Small voice-note storage jobs and the existing background drain share this queue. */
let lane: Promise<unknown> = Promise.resolve();

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
  const result = previous.then(() => {
    const controller = new AbortController();
    let request: Promise<T>;
    try { request = Promise.resolve(job(deadline ? controller.signal : undefined)); }
    catch (error) { release(); throw error; }
    // Keep the lane occupied until the underlying operation has actually settled,
    // even when the waiting caller has received its timeout and cancellation signal.
    request.then(release, release);
    return deadline
      ? deadlineForSpaceCall(deadline.operation, request, controller,
        deadline.timeoutMs ?? voiceNoteCallDeadlineMs(deadline.payloadBytes ?? 0))
      : request;
  }, (error: unknown) => { release(); throw error; });
  return result;
}

/** Tests only: discard a completed lane from the previous case. */
export function resetSpaceLaneForTests(): void { lane = Promise.resolve(); }
