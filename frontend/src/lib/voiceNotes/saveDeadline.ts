/** A single voice-note network/native operation gets its own bounded wait. */
export const VOICE_NOTE_CALL_MIN_DEADLINE_MS = 90_000;
const MIN_UPLOAD_RATE_BYTES_PER_SECOND = 8_000;
let testDeadlineMs: number | null = null;

export class VoiceNoteSaveTimeout extends Error {
  readonly code = "VOICE_NOTE_OPERATION_TIMEOUT";
  constructor(readonly operation: string, readonly timeoutMs: number, message =
    "This note is still on your phone, but saving it is taking too long. Check your connection and try again.") {
    super(message);
    this.name = "VoiceNoteSaveTimeout";
  }
}

/** 90 seconds for latency, plus time for an 8 KB/s uplink to send the payload. */
export function voiceNoteCallDeadlineMs(payloadBytes = 0): number {
  if (testDeadlineMs !== null) return testDeadlineMs;
  return VOICE_NOTE_CALL_MIN_DEADLINE_MS + Math.ceil(Math.max(0, payloadBytes) / MIN_UPLOAD_RATE_BYTES_PER_SECOND * 1000);
}

/** Shorten deadlines in timer-driven unit tests; pass null to restore production sizing. */
export function setVoiceNoteSaveDeadlineForTests(timeoutMs: number | null): void {
  testDeadlineMs = timeoutMs;
}

function timeBound<T>(operation: string, request: Promise<T>, controller: AbortController, timeoutMs: number,
  timeoutMessage?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[VoiceNotes] Timed out ${operation} after ${timeoutMs}ms`);
      controller.abort();
      reject(new VoiceNoteSaveTimeout(operation, timeoutMs, timeoutMessage));
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

/** Bound a native call or a TinyCloud read that intentionally stays off the shared lane. */
export function withVoiceNoteSaveDeadline<T>(operation: string, request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = voiceNoteCallDeadlineMs()): Promise<T> {
  const controller = new AbortController();
  return timeBound(operation, Promise.resolve().then(() => request(controller.signal)), controller, timeoutMs);
}

/** Note-body reads stay off the serialized write lane and use a read-specific message. */
export function withVoiceNoteReadDeadline<T>(operation: string, request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = voiceNoteCallDeadlineMs()): Promise<T> {
  const controller = new AbortController();
  return timeBound(operation, Promise.resolve().then(() => request(controller.signal)), controller, timeoutMs,
    "This recording note couldn't be loaded in time. Check your connection and try again.");
}

/** Internal lane variant: its caller times out, while the lane waits for request settlement. */
export function deadlineForSpaceCall<T>(operation: string, request: Promise<T>, controller: AbortController,
  timeoutMs = voiceNoteCallDeadlineMs()): Promise<T> {
  return timeBound(operation, request, controller, timeoutMs);
}
