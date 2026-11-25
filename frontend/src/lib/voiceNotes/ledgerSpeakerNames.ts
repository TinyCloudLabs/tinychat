// A note still on this phone has no space row, so its speaker names live in the capture ledger
// (`ledger.speakerNames`, same shape as the row's `metadata.speaker_names`). `createVoiceNoteRow`
// carries them into the row's metadata when the note lands. The ledger write is owner-checked:
// `updateLedger` rejects (`owner_mismatch`) a note that is another account's, which keeps those
// notes read-only, and rev-checked, so a write never overwrites a ledger that moved since it was read.
// Names in the call: `ledger.speakerSuggestionsEnded` lists the labels whose suggestion the user acted on
// while the note was local; the row then never gets that suggestion (callNames.ts).
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { VoiceNotes } from "./nativeVoiceNotes";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";

export type LedgerSpeakerNamesRead =
  | { names: Record<string, string> | null; ended: readonly string[] }
  /** The note is not this account's, or the engine cannot be asked: renaming stays read-only. */
  | "not-owned"
  /** The phone could not answer: treat as unknown, report the failure. */
  | "unavailable";

const endedOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((label): label is string => typeof label === "string") : [];

/** The note's ledger `speakerNames` map (null when the ledger does not carry one yet) and its ended suggestions. */
export async function readLedgerSpeakerNames(
  tcw: TinyCloudWeb,
  id: string,
): Promise<LedgerSpeakerNamesRead> {
  try {
    const { recordings } = await withVoiceNoteSaveDeadline(`native listPending id=${id}`,
      () => VoiceNotes.listPending());
    const note = recordings.find((recording) => recording.id === id);
    if (!note || note.owner !== tcw.did) return "not-owned";
    return { names: note.ledger?.speakerNames ?? null, ended: endedOf(note.ledger?.speakerSuggestionsEnded) };
  } catch {
    return "unavailable";
  }
}

/**
 * The labels whose suggestion ended while note `id` was on this device; empty when the note is not here or the
 * device cannot answer.
 */
export async function readLedgerSuggestionsEnded(id: string): Promise<readonly string[]> {
  try {
    const { recordings } = await withVoiceNoteSaveDeadline(`native listPending id=${id}`,
      () => VoiceNotes.listPending());
    return endedOf(recordings.find((recording) => recording.id === id)?.ledger?.speakerSuggestionsEnded);
  } catch {
    return [];
  }
}

/**
 * Write the names `change` produces over the map stored right now. The note is re-read for its
 * owner and rev before every `updateLedger` (the same contract `recordTranscriptSaved` in
 * onDeviceTranscriber.ts follows), so the call composes over the freshest map — a name set by
 * another device between our first read and our write is preserved, never overwritten by the
 * stale snapshot the UI last showed. A `rev_conflict` means the ledger moved under us: read once
 * more and retry once; any other failure or a second conflict propagates and shows as the
 * failed save. Returns the map that was accepted. With `endSuggestion` the same write also ends that
 * label's suggestion (`speakerSuggestionsEnded`), as a name written on a row does.
 */
export async function saveLedgerSpeakerNames(
  tcw: TinyCloudWeb,
  id: string,
  change: (stored: Record<string, string>) => Record<string, string>,
  endSuggestion?: string,
): Promise<Record<string, string>> {
  for (let attempt = 0; ; attempt++) {
    const { recordings } = await withVoiceNoteSaveDeadline(`native listPending id=${id}`,
      () => VoiceNotes.listPending());
    const note = recordings.find((recording) => recording.id === id);
    if (!note) throw new Error("The note is no longer on this device");
    if (note.owner !== tcw.did) throw new Error("This note belongs to another account on this device");
    const rev = note.rev;
    if (rev === undefined) throw new Error("The note has no ledger entry on this device");
    const names = change(note.ledger?.speakerNames ?? {});
    const ended = endedOf(note.ledger?.speakerSuggestionsEnded);
    const patch = endSuggestion === undefined || ended.includes(endSuggestion) ? { speakerNames: names }
      : { speakerNames: names, speakerSuggestionsEnded: [...ended, endSuggestion] };
    try {
      await withVoiceNoteSaveDeadline(`native updateLedger id=${id}`,
        () => VoiceNotes.updateLedger({ id, did: tcw.did, rev, patch }));
      return names;
    } catch (error) {
      if ((error as { code?: string }).code !== "rev_conflict" || attempt > 0) throw error;
    }
  }
}
