import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";

export const LEGACY_DISCARD_KEY = "exo.voiceNotes.discarded";

/** The old marker is cleared only when every native tombstone has landed. */
export async function migrateLegacyDiscardLedger(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null =
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
    // Keep markers written by a concurrent discard. Only remove the id whose
    // native tombstone was acknowledged.
    const current = storage?.getItem(LEGACY_DISCARD_KEY);
    const ids: unknown = current ? JSON.parse(current) : [];
    if (Array.isArray(ids)) {
      const remaining = ids.filter((entry) => entry !== id);
      if (remaining.length) storage?.setItem(LEGACY_DISCARD_KEY, JSON.stringify(remaining));
      else storage?.removeItem(LEGACY_DISCARD_KEY);
    }
  }
  // IDs already absent on the phone were handled by an earlier run. Retire only
  // this run's snapshot; a discard added while migration ran keeps its marker.
  checkpoint();
  const current = storage?.getItem(LEGACY_DISCARD_KEY);
  const ids: unknown = current ? JSON.parse(current) : [];
  if (Array.isArray(ids)) {
    const handled = new Set(parsed as string[]);
    const remaining = ids.filter((entry) => !handled.has(entry));
    if (remaining.length) storage?.setItem(LEGACY_DISCARD_KEY, JSON.stringify(remaining));
    else storage?.removeItem(LEGACY_DISCARD_KEY);
  }
}

/** A legacy format needs owner evidence only until native claim records an owner. */
export function isLegacyNote(note: VoiceNoteRecording): boolean {
  return note.ownerUnknown === true || ((note.version !== 2 || note.legacyImport === true) && !note.owner);
}

/** Keep native claims; only ownerless legacy notes await space-row or user evidence. */
export function markLegacyOwnerUnknown(notes: readonly VoiceNoteRecording[]): VoiceNoteRecording[] {
  return notes.map((note) => isLegacyNote(note) && !note.owner
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
    try {
      await VoiceNotes.claim({ id: note.id, did, evidence: "space_row", rowId: id });
      associated.push(note.id);
    } catch (error) {
      if ((error as { code?: string }).code !== "owner_mismatch") throw error;
      console.warn("[VoiceNotes] legacy note belongs to another account", { id: note.id, did });
    }
  }
  return associated;
}
