import { currentStorageAccountDid } from "@/lib/storageStatus";
import { captureEngineAvailable } from "./captureEngine";
import { VoiceNotes } from "./nativeVoiceNotes";

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

type StoredRecordingNote = Omit<RecordingNote, "moments" | "savedEditAt"> & { savedEditAt?: string | null; syncedRevision?: number };
type StoredNote = StoredRecordingNote | { recordingId: string; deleted: true };
const DB_NAME = "exo-recording-notes";
const STORE_NAME = "notes";
const LOCAL_PREFIX = "exo.voiceNotes.note.";
/** Bun's non-browser tests have neither IndexedDB nor localStorage. */
const testMemory = new Map<string, StoredNote>();
let dbPromise: Promise<IDBDatabase> | null = null;
const writes = new Map<string, Promise<unknown>>();
const storageId = (id: string, owner: string | null) => JSON.stringify([owner, id]);
type PersistedNote = StoredNote & { storageId: string; owner?: string | null };

async function currentOwner(): Promise<string | null> {
  const app = currentStorageAccountDid();
  if (app) return app;
  if (captureEngineAvailable()) {
    const account = await VoiceNotes.getCaptureDefaults();
    return account.status === "signed_out" ? null : account.accountDid;
  }
  return null;
}


export async function assertRecordingNoteAccount(owner: string | null): Promise<void> {
  if (owner !== await currentOwner()) throw new Error("Recording note account changed");
}

async function visibleNativeOwner(id: string): Promise<string | null | undefined> {
  if (!captureEngineAvailable()) return undefined;
  const note = (await VoiceNotes.listPending()).recordings.find((note) => note.id === id);
  return note ? note.owner ?? null : undefined;
}

/** Capture the live/local recording owner before queueing a recorder edit. */
export async function recordingNoteOwner(id: string, fallbackOwner?: string | null): Promise<string | null> {
  if (fallbackOwner !== undefined) return fallbackOwner;
  const active = await currentOwner();
  const native = await visibleNativeOwner(id);
  return native === undefined ? active : native;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion === 0) {
        db.createObjectStore(STORE_NAME, { keyPath: "storageId" });
        return;
      }
      const rows = request.transaction!.objectStore(STORE_NAME).getAll();
      rows.onsuccess = () => {
        db.deleteObjectStore(STORE_NAME);
        const next = db.createObjectStore(STORE_NAME, { keyPath: "storageId" });
        for (const row of rows.result as StoredNote[]) next.put({ ...row, storageId: row.recordingId });
      };
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open recording notes"));
  });
  dbPromise = pending;
  void pending.catch(() => { if (dbPromise === pending) dbPromise = null; });
  return pending;
}

async function readStoredKey(key: string): Promise<StoredNote | null> {
  if (typeof indexedDB === "undefined") {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" && !globalThis.localStorage)
      return testMemory.get(key) ?? null;
    const raw = globalThis.localStorage?.getItem(`${LOCAL_PREFIX}${key}`);
    return raw ? JSON.parse(raw) as StoredNote : null;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      if (!request.result) return resolve(null);
      const { storageId: _key, owner: _owner, ...note } = request.result as PersistedNote;
      resolve(note);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read recording note"));
  });
}

async function writeStored(note: StoredNote, owner: string | null): Promise<void> {
  const key = storageId(note.recordingId, owner);
  if (typeof indexedDB === "undefined") {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" && !globalThis.localStorage) {
      testMemory.set(key, note);
      return;
    }
    if (!globalThis.localStorage) throw new Error("Recording note storage is unavailable");
    globalThis.localStorage.setItem(`${LOCAL_PREFIX}${key}`, JSON.stringify(note));
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    tx.objectStore(STORE_NAME).put({ ...note, storageId: key, owner });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save recording note"));
    tx.onabort = () => reject(tx.error ?? new Error("Recording note write was aborted"));
  });
}

async function removeStoredKey(key: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    testMemory.delete(key);
    globalThis.localStorage?.removeItem(`${LOCAL_PREFIX}${key}`);
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not move recording note"));
    tx.onabort = () => reject(tx.error ?? new Error("Recording note move was aborted"));
  });
}

async function readStored(id: string, owner: string | null): Promise<StoredNote | null> {
  const stored = await readStoredKey(storageId(id, owner));
  if (stored) return stored;
  // Old id-only text is kept hidden until a visible native recording proves which account owns it.
  const legacy = await readStoredKey(id);
  if (!legacy || !captureEngineAvailable()) return null;
  const match = (await VoiceNotes.listPending()).recordings.find((note) => note.id === id && (note.owner ?? null) === owner);
  if (!match) return null;
  await writeStored(legacy, owner);
  await removeStoredKey(id);
  return legacy;
}

function loaded(note: StoredRecordingNote): RecordingNote {
  const { syncedRevision: _synced, ...content } = note;
  return { ...content, savedEditAt: content.savedEditAt ?? null, moments: parseMomentLines(content.md) };
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

/** The recorder alone supplies liveRecording after its own authoritative status read. */
export async function loadNote(id: string, requestedOwner?: string | null, liveRecording = false): Promise<RecordingNote | null> {
  validateId(id);
  const owner = requestedOwner === undefined ? await recordingNoteOwner(id) : requestedOwner;
  const accessible = async () => {
    const active = await currentOwner();
    return owner === null ? liveRecording || await visibleNativeOwner(id) === null : owner === active;
  };
  if (owner !== null && !await accessible()) return null;
  return ordered(id, async () => {
    const note = await readStored(id, owner);
    if (!note || !await accessible()) return null;
    return !("deleted" in note) ? loaded(note) : null;
  });
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
  if (old && !("deleted" in old)) {
    const { syncedRevision: _synced, ...content } = old;
    return { ...content, savedEditAt: old.savedEditAt ?? null, editedAt: now, revision: old.revision + 1 };
  }
  return { recordingId: id, md: "", createdAt: now, editedAt: now, savedEditAt: null, revision: 1 };
}

/** Every edit is durable locally before its promise resolves; only space sync is debounced. */
export function saveNote(id: string, md: string, options: { savedEdit?: boolean; owner?: string | null } = {}): Promise<RecordingNote> {
  validateId(id);
  const owner = options.owner === undefined ? recordingNoteOwner(id) : Promise.resolve(options.owner);
  return ordered(id, async () => {
    const boundOwner = await owner;
    const stored = await readStored(id, boundOwner);
    if (stored && "deleted" in stored) throw new Error("This recording was discarded");
    const note = changed(id, stored);
    note.md = md;
    if (options.savedEdit) note.savedEditAt = note.editedAt;
    await writeStored(note, boundOwner);
    return loaded(note);
  });
}

/** A note found in the space becomes available offline without rewriting its timestamps. */
export function adoptNote(remote: Omit<RecordingNote, "savedEditAt"> & { savedEditAt?: string | null }, requestedOwner?: string | null): Promise<RecordingNote> {
  validateId(remote.recordingId);
  const owner = requestedOwner === undefined ? currentOwner() : Promise.resolve(requestedOwner);
  return ordered(remote.recordingId, async () => {
    const boundOwner = await owner;
    const stored = await readStored(remote.recordingId, boundOwner);
    if (stored && "deleted" in stored) throw new Error("This recording was discarded");
    // A stored note keeps its text; its saved-edit time only ever moves forward, so a record without one cannot clear it.
    if (stored) {
      const mine = stored.savedEditAt ?? null;
      const theirs = remote.savedEditAt ?? null;
      const savedEditAt = theirs !== null && (mine === null || Date.parse(theirs) > Date.parse(mine)) ? theirs : mine;
      if (savedEditAt !== mine) await writeStored({ ...stored, savedEditAt }, boundOwner);
      return loaded({ ...stored, savedEditAt });
    }
    const record: Omit<RecordingNote, "moments"> = { recordingId: remote.recordingId, md: remote.md,
      createdAt: remote.createdAt, editedAt: remote.editedAt, savedEditAt: remote.savedEditAt ?? null,
      revision: remote.revision };
    await writeStored(record, boundOwner);
    return loaded(record);
  });
}

/** Keep the revision check and metadata write in one transaction, including across tabs. */
async function updateOwnedNote(id: string, owner: string | null,
  update: (note: StoredNote | null) => StoredNote | null, bindLegacy = false): Promise<void> {
  const key = storageId(id, owner);
  if (typeof indexedDB === "undefined") {
    const stored = await readStoredKey(key);
    const legacy = !stored && bindLegacy ? await readStoredKey(id) : null;
    const next = update(stored ?? legacy);
    if (next ?? legacy) await writeStored((next ?? legacy)!, owner);
    if (legacy) await removeStoredKey(id);
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    const store = tx.objectStore(STORE_NAME);
    const apply = (raw: PersistedNote | undefined, legacy = false) => {
      let note: StoredNote | null = null;
      if (raw) { const { storageId: _key, owner: _owner, ...content } = raw; note = content; }
      const next = update(note);
      if (next ?? (legacy ? note : null)) store.put({ ...(next ?? note)!, storageId: key, owner });
      if (legacy && raw) store.delete(id);
    };
    const read = store.get(key);
    read.onsuccess = () => {
      if (read.result || !bindLegacy) apply(read.result as PersistedNote | undefined);
      else { const old = store.get(id); old.onsuccess = () => apply(old.result as PersistedNote | undefined, true); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not update recording note"));
    tx.onabort = () => reject(tx.error ?? new Error("Recording note update was aborted"));
  });
}

/** Acknowledges only the exact local revision whose Markdown reached the space. */
export function markNoteSynced(id: string, owner: string | null, revision: number): Promise<void> {
  validateId(id);
  return ordered(id, () => updateOwnedNote(id, owner, (note) =>
    note && !("deleted" in note) && note.revision === revision ? { ...note, syncedRevision: revision } : null));
}

/** Synced audio cleanup never removes the only copy of an unsynced Markdown edit. */
export function deleteSyncedNote(id: string, owner: string | null): Promise<void> {
  validateId(id);
  // The purge caller captured this owner from the native row before removing that row.
  return ordered(id, () => updateOwnedNote(id, owner, (note) => {
    if (!note || "deleted" in note || (note.md.trim() && note.syncedRevision !== note.revision)) return null;
    return { recordingId: id, deleted: true };
  }, true));
}

/** A durable tombstone prevents a delayed autosave from recreating a discarded note. */
export function deleteNote(id: string, requestedOwner?: string | null): Promise<void> {
  validateId(id);
  const owner = requestedOwner === undefined ? currentOwner() : Promise.resolve(requestedOwner);
  return ordered(id, async () => {
    const boundOwner = await owner;
    const proven = await visibleNativeOwner(id);
    await writeStored({ recordingId: id, deleted: true }, boundOwner);
    if (proven !== undefined && proven === boundOwner) await removeStoredKey(id);
  });
}

/** Called only after the native completed-note user_choice claim has succeeded. */
export function claimRecordingNote(id: string, owner: string): Promise<void> {
  validateId(id);
  return ordered(id, async () => {
    const unowned = await readStoredKey(storageId(id, null)) ?? await readStoredKey(id);
    if (!unowned) return;
    const existing = await readStoredKey(storageId(id, owner));
    if (!existing) await writeStored(unowned, owner);
    await removeStoredKey(storageId(id, null));
    await removeStoredKey(id);
  });
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
