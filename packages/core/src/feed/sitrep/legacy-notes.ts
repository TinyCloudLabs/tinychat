import { parseKey, validateState, type BoardRecord } from "./schema";

// cli/watch.ts NOTE_KINDS and noteKey; new Home owner events are not this source.
export const LEGACY_NOTE_KINDS: ReadonlySet<string> = new Set(["ask", "task", "approval", "work", "hold"]);
export interface LegacySendNote {
  kind: BoardRecord["kind"];
  id: string;
  noteId: string;
  at: string;
  text: string;
  sourceKey: string;
  eventKey: string;
}

export function decodeLegacySendNote(record: Pick<BoardRecord, "kind" | "id">, input: unknown): LegacySendNote {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid legacy explicit note");
  const value = input as Record<string, unknown>;
  if (!LEGACY_NOTE_KINDS.has(record.kind) || value.kind !== record.kind || value.id !== record.id || typeof value.sourceKey !== "string" || typeof value.eventKey !== "string" || Object.keys(value).some((key) => !["kind", "id", "noteId", "at", "text", "sourceKey", "eventKey"].includes(key))) throw new Error("Invalid legacy explicit note provenance");
  const key = parseKey(value.sourceKey);
  if (key?.area !== "state" || key.kind !== record.kind || key.id !== record.id) throw new Error("Legacy note does not identify its raw state key");
  const checked = validateState({ kind: record.kind, id: record.id, steps: {}, notes: [{ id: value.noteId, at: value.at, text: value.text }], updatedAt: value.at });
  const note = checked.ok ? checked.value.notes?.[0] : undefined;
  if (!note || value.eventKey !== `note:${record.kind}/${record.id}/${note.id}`) throw new Error("Invalid legacy send-note event identity");
  return { kind: record.kind, id: record.id, noteId: note.id, at: note.at, text: note.text, sourceKey: value.sourceKey, eventKey: value.eventKey };
}
