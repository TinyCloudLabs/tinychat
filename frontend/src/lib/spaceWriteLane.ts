/** Small voice-note storage jobs and the existing background drain share this queue. */
let lane: Promise<unknown> = Promise.resolve();

/** One request can be slow on mobile, but must never hold the shared queue forever. */
export const SPACE_OPERATION_DEADLINE_MS = 90_000;
let saveDeadlineMs = SPACE_OPERATION_DEADLINE_MS;

/** Tests can shorten the deadline without replacing the platform timer APIs. */
export function setVoiceNoteSaveDeadlineForTests(timeoutMs: number): void {
  saveDeadlineMs = timeoutMs;
}

export class SpaceOperationTimeout extends Error {
  readonly code = "SPACE_OPERATION_TIMEOUT";
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`TinyCloud didn't respond while saving this note. It's still on this phone — try again.`);
    this.name = "SpaceOperationTimeout";
  }
}

export function withVoiceNoteSaveDeadline<T>(operation: string, request: Promise<T>, timeoutMs = saveDeadlineMs): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[VoiceNotes] Timed out ${operation} after ${timeoutMs}ms`);
      reject(new SpaceOperationTimeout(operation, timeoutMs));
    }, timeoutMs);
    request.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function runOnSpaceLane<T>(job: () => Promise<T>, operation = "TinyCloud space operation"): Promise<T> {
  const result = lane.then(() => withVoiceNoteSaveDeadline(operation, job(), saveDeadlineMs));
  lane = result.then(() => undefined, () => undefined);
  return result;
}

/** Tests only: discard a completed lane from the previous case. */
export function resetSpaceLaneForTests(): void { lane = Promise.resolve(); }
