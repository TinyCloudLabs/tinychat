// A note still on this phone has no space row, so its speaker names live in the capture ledger
// (`ledger.speakerNames`, same shape as the row's `metadata.speaker_names`). `createVoiceNoteRow`
// carries them into the row's metadata when the note lands. The ledger write is owner-checked:
// `updateLedger` rejects (`owner_mismatch`) a note that is another account's, which keeps those
// notes read-only, and rev-checked, so a write never overwrites a ledger that moved since it was read.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { VoiceNotes } from "./nativeVoiceNotes";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";

export type LedgerSpeakerNamesRead =
  | { names: Record<string, string> | null }
  /** The note is not this account's, or the engine cannot be asked: renaming stays read-only. */
  | "not-owned"
  /** The phone could not answer: treat as unknown, report the failure. */
  | "unavailable";

/** The note's ledger `speakerNames` map; null when the ledger does not carry one yet. */
export async function readLedgerSpeakerNames(
  tcw: TinyCloudWeb,
  id: string,
): Promise<LedgerSpeakerNamesRead> {
  try {
    const { recordings } = await withVoiceNoteSaveDeadline(`native listPending id=${id}`,
      () => VoiceNotes.listPending());
    const note = recordings.find((recording) => recording.id === id);
    if (!note || note.owner !== tcw.did) return "not-owned";
    return { names: note.ledger?.speakerNames ?? null };
  } catch {
    return "unavailable";
  }
}

/**
 * Write the names `change` produces over the map stored right now. The note is re-read for its
 * owner and rev before every `updateLedger` (the same contract `recordTranscriptSaved` in
 * onDeviceTranscriber.ts follows), so the call composes over the freshest map — a name set by
 * another device between our first read and our write is preserved, never overwritten by the
 * stale snapshot the UI last showed. A `rev_conflict` means the ledger moved under us: read once
 * more and retry once; any other failure or a second conflict propagates and shows as the
 * failed save. Returns the map that was accepted.
 */
export async function saveLedgerSpeakerNames(
  tcw: TinyCloudWeb,
  id: string,
  change: (stored: Record<string, string>) => Record<string, string>,
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
    try {
      await withVoiceNoteSaveDeadline(`native updateLedger id=${id}`,
        () => VoiceNotes.updateLedger({ id, did: tcw.did, rev, patch: { speakerNames: names } }));
      return names;
    } catch (error) {
      if ((error as { code?: string }).code !== "rev_conflict" || attempt > 0) throw error;
    }
  }
}
