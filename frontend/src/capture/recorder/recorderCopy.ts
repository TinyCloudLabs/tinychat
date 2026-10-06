// What the recorder says: the status, the limit, the transcription route and
// the receipt (plan §2.10). The mic-state sentences are the ones the Voice
// notes card has always used (`micStatusText`), moved here with it.

import type { MicState, MicStateReason } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { RecorderPhase } from "./recorderReducer";

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** How long before the limit the card starts showing it ("Recording 55:00 of 60:00"). */
const LIMIT_WARNING_MS = 5 * 60 * 1000;

/** "60-minute", or "15-second" for a limit that is not whole minutes (a test override). */
export function formatLimit(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}-minute` : `${Math.round(ms / 1000)}-second`;
}

export function limitNoticeText(maxDurationMs: number): string {
  return `Stopped at the ${formatLimit(maxDurationMs)} limit.`;
}

// The card's mic-problem clauses, shared with the recorder's sentence under the timer.
const SILENCED_CLAUSE = "the system is blocking the microphone (a call, another app, or the mic privacy toggle)";
const NO_SIGNAL_CLAUSE = "no sound is reaching the microphone";

/** Copy for what the OS is telling us about the microphone. */
export function micStatusText(
  phase: RecorderPhase,
  mic: { state: MicState; reason: MicStateReason },
  elapsedMs: number,
  maxDurationMs?: number,
): string {
  if (phase === "starting") return "Starting the microphone…";
  if (phase === "stopping" || phase === "saving") return "Saving to your TinyCloud space…";
  if (phase !== "recording") return "Not recording. The microphone is off.";
  const time = maxDurationMs !== undefined && elapsedMs >= maxDurationMs - LIMIT_WARNING_MS
    ? `${formatDuration(Math.min(elapsedMs, maxDurationMs))} of ${formatDuration(maxDurationMs)}`
    : formatDuration(elapsedMs);
  if (mic.state === "silenced") {
    return `Recording ${time}, but ${SILENCED_CLAUSE}.`;
  }
  if (mic.reason === "no_signal") {
    return `Recording ${time}, but ${NO_SIGNAL_CLAUSE}.`;
  }
  return `Recording ${time}`;
}

/** The mic is live but the OS or the input says something is wrong. */
export function micWarning(mic: { state: MicState; reason: MicStateReason }): "silenced" | "no-signal" | null {
  if (mic.state === "silenced") return "silenced";
  if (mic.reason === "no_signal") return "no-signal";
  return null;
}

/** The recorder's status line: short, with the timer and the meta line beside it. */
export function recorderStatusText(
  phase: RecorderPhase,
  mic: { state: MicState; reason: MicStateReason },
  savePercent: number | null,
): string {
  if (phase === "starting") return "Starting the microphone…";
  if (phase === "stopping") return "Saving to your space";
  if (phase === "saving") return typeof savePercent === "number" ? `Saving to your space · ${savePercent}%` : "Saving to your space";
  if (phase !== "recording") return "Not recording";
  const warning = micWarning(mic);
  if (warning === "silenced") return "Mic silenced";
  if (warning === "no-signal") return "No sound";
  return "Recording";
}

/** The sentence under the timer while the mic has a problem (the card's own words). */
export function micWarningSentence(mic: { state: MicState; reason: MicStateReason }): string | null {
  const warning = micWarning(mic);
  if (warning === "silenced") return sentence(SILENCED_CLAUSE);
  if (warning === "no-signal") return sentence(NO_SIGNAL_CLAUSE);
  return null;
}

function sentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/** "Voice note · started 9:28", or "Stops at 60:00" in the last five minutes. */
export function recorderMetaText(startedAt: number | null, elapsedMs: number, maxDurationMs: number): string {
  if (elapsedMs >= maxDurationMs - LIMIT_WARNING_MS) return `Stops at ${formatDuration(maxDurationMs)}`;
  return startedAt === null ? "Voice note" : `Voice note · started ${clockTime(startedAt)}`;
}

/** "9:41", in the phone's locale. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export const RECEIPT_SAVED = "Saved to your TinyCloud space";
export const RECEIPT_KEPT = "Kept on this phone. Not in your space yet.";
export const ISLAND_SAVED = "Saved to your space";
export const ISLAND_KEPT = "Kept on this phone";

/** "Voice note · 0:42 · 9:41" */
export function receiptMetaText(durationMs: number, at: number): string {
  return `Voice note · ${formatDuration(durationMs)} · ${clockTime(at)}`;
}
