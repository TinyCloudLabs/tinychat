import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";

export const LEGACY_DISCARD_KEY = "exo.voiceNotes.discarded";

/** The old marker is cleared only when every native tombstone has landed. */
export async function migrateLegacyDiscardLedger(storage: Pick<Storage, "getItem" | "removeItem"> | null =
  typeof localStorage === "undefined" ? null : localStorage, checkpoint: () => void = () => undefined): Promise<void> {
  const raw = storage?.getItem(LEGACY_DISCARD_KEY);
  if (!raw) return;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string"))
    throw new Error("Legacy voice-note discard ledger is malformed");
  checkpoint();
  const pending = (await VoiceNotes.listPending()).recordings;
  const present = new Set(pending.map((note) => note.id));
  for (const id of new Set(parsed as string[])) if (present.has(id)) {
    checkpoint();
    await VoiceNotes.deleteAudio({ id });
  }
  storage?.removeItem(LEGACY_DISCARD_KEY);
}

export function isLegacyNote(note: VoiceNoteRecording): boolean {
  return note.version !== 2 || note.ownerUnknown === true || note.legacyImport === true;
}

/** An old sidecar's owner field is never claim evidence, even after localStorage loss. */
export function markLegacyOwnerUnknown(notes: readonly VoiceNoteRecording[]): VoiceNoteRecording[] {
  return notes.map((note) => isLegacyNote(note)
    ? { ...note, ownerUnknown: true, owner: null } : note);
}

/** A matching row is the only automatic evidence that an old note belongs here. */
export async function associateLegacyNotes(tcw: TinyCloudWeb, did: string,
  notes: readonly VoiceNoteRecording[], checkpoint: () => void = () => undefined): Promise<string[]> {
  const associated: string[] = [];
  for (const note of notes) {
    if (!isLegacyNote(note) || note.owner) continue;
    checkpoint();
    const found = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      "SELECT id FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = ? LIMIT 1", [note.id]);
    if (!found.ok) throw new Error(`Legacy association lookup: ${found.error.message}`);
    const id = found.data.rows[0]?.[0];
    if (typeof id !== "string") continue;
    checkpoint();
    await VoiceNotes.claim({ id: note.id, did, evidence: "space_row", rowId: id });
    associated.push(note.id);
  }
  return associated;
}
