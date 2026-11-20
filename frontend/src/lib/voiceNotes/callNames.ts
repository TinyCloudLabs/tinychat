// Names in the call (phase 1), the save step. While a recording of both sides runs, the desktop app can read the
// names of the people in the call from the meeting app's window (when the user turned that on). Once the note's row
// exists they move onto it (`writeCallParticipants`: the people, and the suggestion for Them with one other person),
// then the app's copy is cleared. Best-effort: nothing here fails or holds up a save. It runs when the row is created,
// and again as the retry after each transcript commit and on each pass over the notes already saved (which needs no
// transcriber); the write applies once, so running it again is harmless. Until then a note shows the names straight
// from the app's copy (`readCallNamesOnThisMac`), so they show while the space cannot be reached.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "@/capture/captureEvents";
import { parseCallParticipants, SUGGESTED_SPEAKER, suggestSpeakerNames, type CallParticipants } from "@/capture/library/callParticipants";
import { rememberCallRoster } from "./callSpeakersOnThisMac";
import { getDesktopCaptureExtras } from "./desktopCaptureExtras";
import { readLedgerSuggestionsEnded } from "./ledgerSpeakerNames";
import { writeCallParticipants } from "./voiceNoteRows";

/**
 * - none: nothing to save (no desktop app here, a build without the feature, or nothing was read)
 * - saved: written to the row now; kept: the row already had them. Both clear the app's copy.
 * - refused: what the app handed over is not in the agreed shape; it is not saved, and the app's copy is cleared
 * - no-row: there is no voice-note row of a recording of both sides; it stays on this Mac
 * - failed: a step failed; the next try saves it
 */
export type CallNamesSaveOutcome = "none" | "saved" | "kept" | "refused" | "no-row" | "failed";

/** Saves the names read during recording `sourceId` on its row `rowId`. Never throws; logs no names. */
export async function saveCallNames(tcw: TinyCloudWeb, sourceId: string, rowId: string,
  checkpoint: () => void = () => undefined): Promise<CallNamesSaveOutcome> {
  const callNames = getDesktopCaptureExtras()?.callNames;
  if (!callNames) return "none";
  try {
    checkpoint();
    const read = await callNames.read(sourceId);
    if (read === null || read === undefined) return "none";
    const participants = parseCallParticipants(read);
    if (participants === null) {
      // It can never be saved, so it does not stay on this Mac or come back on every later try.
      console.warn("[callNames] The names read from the call window are not in the agreed shape; they were not saved");
      await callNames.clear(sourceId);
      return "refused";
    }
    checkpoint();
    // A suggestion the user already kept, changed or put back while the note was on this Mac is not made again.
    const suggested = suggestSpeakerNames(participants, new Date().toISOString())[SUGGESTED_SPEAKER] ?? null;
    const suggestion = suggested !== null && (await readLedgerSuggestionsEnded(sourceId)).includes(SUGGESTED_SPEAKER)
      ? null : suggested;
    checkpoint();
    const outcome = await writeCallParticipants(tcw, rowId, participants, suggestion, checkpoint);
    if (outcome === "missing") return "no-row";
    if (outcome === "written") captureEvents.emit("library-changed", { source: "exo-voice-note", sourceId });
    // Who spoke when: a transcript of this recording made after the names leave this Mac still numbers the people.
    rememberCallRoster(sourceId, participants);
    await callNames.clear(sourceId);
    return outcome === "written" ? "saved" : "kept";
  } catch (error) {
    // A build without the feature refused the call: the extras have dropped it for the session, and said so once.
    if (!getDesktopCaptureExtras()?.callNames) return "none";
    console.warn("[callNames] The names from the call window will be saved on the next try:",
      error instanceof Error ? error.message : String(error));
    return "failed";
  }
}

/**
 * The names read during recording `sourceId` that the app still holds (not yet on its row), checked and cleaned as
 * the save checks them; null when there are none, they are not in the agreed shape, or the app cannot answer. Never
 * throws; logs no names.
 */
export async function readCallNamesOnThisMac(sourceId: string): Promise<CallParticipants | null> {
  const callNames = getDesktopCaptureExtras()?.callNames;
  if (!callNames) return null;
  try {
    return parseCallParticipants(await callNames.read(sourceId));
  } catch {
    return null;
  }
}
