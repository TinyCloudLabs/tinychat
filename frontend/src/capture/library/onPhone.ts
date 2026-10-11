// Voice notes that are on this device but have no space row yet, listed with the Library's own rows (TC-P1-7).
// A note on the device gets a stand-in item whose id is its recording id behind a prefix; the row it becomes
// is found by that recording id, so the two are never listed together.
import type { PendingNote } from "@/lib/voiceNotes/recorderSaves";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import type { LibraryItem } from "./LibraryRow";

const ON_PHONE_PREFIX = "on-phone:";

export const onPhoneId = (recordingId: string): string => `${ON_PHONE_PREFIX}${recordingId}`;

/** The recording id inside a stand-in's id; null for a real row's id. */
export function recordingIdOfOnPhoneId(id: string): string | null {
  return id.startsWith(ON_PHONE_PREFIX) ? id.slice(ON_PHONE_PREFIX.length) : null;
}

export function onPhoneItem(note: PendingNote): LibraryItem {
  return {
    id: onPhoneId(note.id),
    source: VOICE_NOTE_SOURCE,
    sourceId: note.id,
    title: null,
    startedAt: new Date(note.startedAt).toISOString(),
    durationSecs: Math.round(note.durationMs / 1000),
    onPhone: true,
  };
}

const startedMs = (item: LibraryItem): number => (item.startedAt === null ? 0 : Date.parse(item.startedAt) || 0);

/**
 * The space's rows with the device's notes among them, newest first. A note that has its row in the space is the
 * row (marked `saving` while the device still holds the copy), never a second item. `lingering` notes have left
 * the device but the list has not caught up: they stand in only while no row exists, and are never marked.
 */
export function withOnPhone(
  items: readonly LibraryItem[],
  notes: readonly PendingNote[],
  lingering: readonly PendingNote[] = [],
): LibraryItem[] {
  if (notes.length === 0 && lingering.length === 0) return [...items];
  const pending = new Set(notes.map((note) => note.id));
  const rowIds = new Set<string>();
  const rows = items.map((item) => {
    if (item.source !== VOICE_NOTE_SOURCE) return item;
    rowIds.add(item.sourceId);
    return pending.has(item.sourceId) ? { ...item, saving: true as const } : item;
  });
  const standIns = [...notes, ...lingering].filter((note) => !rowIds.has(note.id)).map(onPhoneItem);
  if (standIns.length === 0) return rows;
  // Newest first, with the space's rows left in the order the space gave them.
  const merged = [...rows];
  for (const standIn of standIns.sort((a, b) => startedMs(b) - startedMs(a))) {
    const at = merged.findIndex((item) => startedMs(item) < startedMs(standIn));
    merged.splice(at === -1 ? merged.length : at, 0, standIn);
  }
  return merged;
}

const SNIPPET_CHARS = 72;

/** One line of a note's own words for a row's title, cut at a word; null when there are none. */
export function noteSnippet(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  if (flat.length <= SNIPPET_CHARS) return flat;
  const cut = flat.slice(0, SNIPPET_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > SNIPPET_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}
