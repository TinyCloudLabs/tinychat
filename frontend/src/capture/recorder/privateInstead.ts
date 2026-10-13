import { readableError } from "@/lib/readableError";
// "Use Private instead" for a note committed to Local: private cloud has to be on offer, and the
// note short enough for it. The on-device job is stopped first, and Private starts only once the
// phone's own record of the note says that job has ended, so the two never both transcribe it.
import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { cancelOnDeviceNote } from "@/lib/voiceNotes/onDeviceSttStore";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";
import type { TranscriptionAdmissionRefusal } from "@/lib/voiceNotes/voiceNoteTranscription";

const PRIVATE_REFUSAL_COPY: Record<TranscriptionAdmissionRefusal, string> = {
  checking: "Private transcription is still checking. Try again in a moment.",
  unavailable: "Private transcription is unavailable right now. Try again later.",
  "check-failed": "Couldn’t check Private transcription. Try again in a moment.",
  "no-consent": "Enable Private transcription before trying again.",
  "account-changed": "Your account changed. Try again after signing in.",
};

export function privateRefusalCopy(refusal: TranscriptionAdmissionRefusal): string {
  return PRIVATE_REFUSAL_COPY[refusal];
}

export function privateInsteadOffered(transcription: VoiceNoteTranscriptionProps | undefined, noteId: string, durationSecs: number | null): boolean {
  if (!transcription || transcription.availability !== "available" || !transcription.consented) return false;
  if (durationSecs !== null && durationSecs > transcription.maxSeconds) return false;
  const job = transcription.jobs.get(noteId);
  return job?.kind !== "active" && job?.kind !== "done";
}

export interface StopWait {
  intervalMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT: StopWait = { intervalMs: 250, timeoutMs: 20_000, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

const FINISHED = "This note finished transcribing on this phone just now.";

async function readOnDeviceState(noteId: string): Promise<{ state: string | undefined } | { failure: string }> {
  try {
    const { recordings } = await VoiceNotes.listPending();
    const recording = recordings.find((candidate) => candidate.id === noteId);
    if (!recording) return { failure: "Could not confirm the on-device transcription stopped: the note was not found on this phone." };
    return { state: recording.stt?.state };
  } catch (caught) {
    console.error("[OnDeviceStt] reading the note around cancel failed", noteId, caught);
    return { failure: `Could not confirm the on-device transcription stopped: ${readableError(caught)}` };
  }
}

/**
 * `cancel` only says the request was accepted; the worker stops at its next audio window and can
 * still finish the note. So wait for the note's own state to end. `cancelled` or `failed` mean it
 * stopped, but a cancel that arrives after the worker finished can overwrite `done` with
 * `cancelled`, so a stopped note is only handed over when it has no transcript.
 */
async function waitForOnDeviceToEnd(noteId: string, wait: StopWait): Promise<string | null> {
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const read = await readOnDeviceState(noteId);
    if ("failure" in read) return read.failure;
    if (read.state === "done") return FINISHED;
    if (read.state === "cancelled" || read.state === "failed") {
      try {
        const { transcript } = await VoiceNotes.getTranscript({ id: noteId });
        return transcript ? FINISHED : null;
      } catch (caught) {
        console.error("[OnDeviceStt] reading the transcript after cancel failed", noteId, caught);
        return `Could not confirm the on-device transcription stopped: ${readableError(caught)}`;
      }
    }
    if (Date.now() >= deadline) return "The on-device transcription is still stopping. Try again in a moment.";
    await wait.sleep(wait.intervalMs);
  }
}

/** The reason it could not switch, or null once private cloud has the note. */
export async function switchToPrivate(
  transcription: VoiceNoteTranscriptionProps,
  noteId: string,
  wait: StopWait = DEFAULT_WAIT,
): Promise<string | null> {
  const before = await readOnDeviceState(noteId);
  if ("failure" in before) return before.failure;
  if (before.state === "done") return FINISHED;
  const failure = await cancelOnDeviceNote(noteId);
  if (failure !== null) return failure;
  const unconfirmed = await waitForOnDeviceToEnd(noteId, wait);
  if (unconfirmed !== null) return unconfirmed;
  const refusal = transcription.onTranscribePrivately(noteId);
  return typeof refusal === "string" ? privateRefusalCopy(refusal) : null;
}
