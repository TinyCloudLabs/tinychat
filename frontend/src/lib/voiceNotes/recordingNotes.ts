/** Local-first Markdown and moments for one native recording. The mobile WebView has IndexedDB;
 * the localStorage adapter keeps the browser harness usable where IndexedDB is absent. */
export interface RecordingMoment { atMs: number; label: string }
export interface RecordingNote {
  recordingId: string;
  md: string;
  moments: RecordingMoment[];
  createdAt: string;
  editedAt: string;
  /** When the saved-note Save last rewrote the note; null until then. Recorder writes never set it, and records stored
   * before the field existed read as null. */
  savedEditAt: string | null;
  /** Local revision; a remote sync repeats if a newer edit arrived while it was writing. */
  revision: number;
}

type StoredNote = Omit<RecordingNote, "moments" | "savedEditAt"> & { savedEditAt?: string | null } | { recordingId: string; deleted: true };
const DB_NAME = "exo-recording-notes";
const STORE_NAME = "notes";
const LOCAL_PREFIX = "exo.voiceNotes.note.";
/** Bun's non-browser tests have neither IndexedDB nor localStorage. */
const testMemory = new Map<string, StoredNote>();
let dbPromise: Promise<IDBDatabase> | null = null;
const writes = new Map<string, Promise<unknown>>();

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "recordingId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open recording notes"));
  });
  dbPromise = pending;
  void pending.catch(() => { if (dbPromise === pending) dbPromise = null; });
  return pending;
}

async function readStored(id: string): Promise<StoredNote | null> {
  if (typeof indexedDB === "undefined") {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" && !globalThis.localStorage)
      return testMemory.get(id) ?? null;
    const raw = globalThis.localStorage?.getItem(`${LOCAL_PREFIX}${id}`);
    return raw ? JSON.parse(raw) as StoredNote : null;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as StoredNote | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read recording note"));
  });
}

async function writeStored(note: StoredNote): Promise<void> {
  if (typeof indexedDB === "undefined") {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" && !globalThis.localStorage) {
      testMemory.set(note.recordingId, note);
      return;
    }
    if (!globalThis.localStorage) throw new Error("Recording note storage is unavailable");
    globalThis.localStorage.setItem(`${LOCAL_PREFIX}${note.recordingId}`, JSON.stringify(note));
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    tx.objectStore(STORE_NAME).put(note);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save recording note"));
    tx.onabort = () => reject(tx.error ?? new Error("Recording note write was aborted"));
  });
}

function validateId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid recording id");
}

function ordered<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  writes.set(id, next);
  void next.finally(() => { if (writes.get(id) === next) writes.delete(id); }).catch(() => undefined);
  return next;
}

export async function loadNote(id: string): Promise<RecordingNote | null> {
  validateId(id);
  await writes.get(id)?.catch(() => undefined);
  const note = await readStored(id);
  return note && !("deleted" in note) ? { ...note, savedEditAt: note.savedEditAt ?? null, moments: parseMomentLines(note.md) } : null;
}

/** Only these Markdown lines are moments. Other list items and prose are ignored. */
export function parseMomentLines(md: string): RecordingMoment[] {
  const moments: RecordingMoment[] = [];
  for (const line of md.split(/\r?\n/)) {
    const match = /^\s*-\s+\*\*(\d+):(\d{2})(?::(\d{2}))?\*\*(?:[ \t]+(.*))?$/.exec(line);
    if (!match) continue;
    const first = Number(match[1]);
    const middle = Number(match[2]);
    const last = match[3] === undefined ? null : Number(match[3]);
    if (middle > 59 || (last !== null && last > 59)) continue;
    const seconds = last === null ? first * 60 + middle : first * 3600 + middle * 60 + last;
    if (!Number.isSafeInteger(seconds)) continue;
    moments.push({ atMs: seconds * 1000, label: (match[4] ?? "").trim() });
  }
  return moments;
}

function changed(id: string, old: StoredNote | null): Omit<RecordingNote, "moments"> {
  const now = new Date(Math.max(Date.now(), old && !("deleted" in old) ? Date.parse(old.editedAt) + 1 : 0)).toISOString();
  return old && !("deleted" in old) ? { ...old, savedEditAt: old.savedEditAt ?? null, editedAt: now, revision: old.revision + 1 }
    : { recordingId: id, md: "", createdAt: now, editedAt: now, savedEditAt: null, revision: 1 };
}

/** Every edit is durable locally before its promise resolves; only space sync is debounced. */
export function saveNote(id: string, md: string, options: { savedEdit?: boolean } = {}): Promise<RecordingNote> {
  validateId(id);
  return ordered(id, async () => {
    const stored = await readStored(id);
    if (stored && "deleted" in stored) throw new Error("This recording was discarded");
    const note = changed(id, stored);
    note.md = md;
    if (options.savedEdit) note.savedEditAt = note.editedAt;
    await writeStored(note);
    return { ...note, moments: parseMomentLines(md) };
  });
}

/** A note found in the space becomes available offline without rewriting its timestamps. */
export function adoptNote(remote: Omit<RecordingNote, "savedEditAt"> & { savedEditAt?: string | null }): Promise<RecordingNote> {
  validateId(remote.recordingId);
  return ordered(remote.recordingId, async () => {
    const stored = await readStored(remote.recordingId);
    if (stored && "deleted" in stored) throw new Error("This recording was discarded");
    // A stored note keeps its text; its saved-edit time only ever moves forward, so a record without one cannot clear it.
    if (stored) {
      const mine = stored.savedEditAt ?? null;
      const theirs = remote.savedEditAt ?? null;
      const savedEditAt = theirs !== null && (mine === null || Date.parse(theirs) > Date.parse(mine)) ? theirs : mine;
      if (savedEditAt !== mine) await writeStored({ ...stored, savedEditAt });
      return { ...stored, savedEditAt, moments: parseMomentLines(stored.md) };
    }
    const record: Omit<RecordingNote, "moments"> = { recordingId: remote.recordingId, md: remote.md,
      createdAt: remote.createdAt, editedAt: remote.editedAt, savedEditAt: remote.savedEditAt ?? null,
      revision: remote.revision };
    await writeStored(record);
    return { ...record, moments: parseMomentLines(record.md) };
  });
}

/** A durable tombstone prevents a delayed autosave from recreating a discarded note. */
export function deleteNote(id: string): Promise<void> {
  validateId(id);
  return ordered(id, () => writeStored({ recordingId: id, deleted: true }));
}

/** JSON scalars and arrays are valid YAML flow values; Markdown stays byte-for-byte intact. */
export function noteMarkdown(note: RecordingNote): string {
  return `---\nrecordingId: ${JSON.stringify(note.recordingId)}\ncreatedAt: ${JSON.stringify(note.createdAt)}\n${note.savedEditAt === null ? "" : `edited: ${JSON.stringify(note.savedEditAt)}\n`}moments: ${JSON.stringify(parseMomentLines(note.md))}\n---\n${note.md}`;
}

export function parseNoteMarkdown(markdown: string): RecordingNote {
  const match = /^---\nrecordingId: (.+)\ncreatedAt: (.+)\n(?:edited: (.+)\n)?moments: (.+)\n---\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error("Invalid recording note frontmatter");
  const id: unknown = JSON.parse(match[1]!);
  const createdAt: unknown = JSON.parse(match[2]!);
  const savedEditAt: unknown = match[3] === undefined ? null : JSON.parse(match[3]);
  const moments: unknown = JSON.parse(match[4]!);
  if (typeof id !== "string" || typeof createdAt !== "string" || (savedEditAt !== null && typeof savedEditAt !== "string") || !Array.isArray(moments) ||
    !moments.every((m) => m && typeof m === "object" && Number.isFinite(m.atMs) && m.atMs >= 0 &&
      (m.label === undefined || typeof m.label === "string"))) throw new Error("Invalid recording note frontmatter");
  validateId(id);
  const md = match[5]!;
  const derived = parseMomentLines(md);
  if (JSON.stringify(moments) !== JSON.stringify(derived)) throw new Error("Recording note moments disagree with its Markdown");
  return { recordingId: id, createdAt, editedAt: savedEditAt ?? createdAt, savedEditAt, moments: derived, md, revision: 1 };
}
