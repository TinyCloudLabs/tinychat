// tinycloud.chat serves the same build as the canonical Home origin. Visitors there move to
// home.tinycloud.xyz, unless this browser holds recording work that exists only on the legacy
// origin: origins don't share IndexedDB or localStorage, so moving would strand it. Held visitors
// move on their own once that work is saved to their TinyCloud space.

import { UPLOAD_PENDING_STORAGE_KEY, uploadRunner, type UploadState } from "./audioUpload";
import { hasVerifiedSpaceCopy } from "./voiceNotes/audioPlaybackCache";
import { hasLocalWorkInProgress } from "./voiceNotes/localWork";
import type { OutboxEntry, VoiceNoteRecording } from "./voiceNotes/nativeVoiceNotes";
import { STORES } from "./voiceNotes/web/idb";

export const CANONICAL_ORIGIN = "https://home.tinycloud.xyz";
export const LEGACY_HOSTNAME = "tinycloud.chat";

/** The web voice-note store (webStore.ts `openWebStore` default). */
const VOICE_NOTES_DB = "exo-voice-notes";

/** How often a held visitor re-checks whether the local work has been saved. */
export const ORIGIN_MOVE_RECHECK_MS = 30_000;

/**
 * Recordings that exist only in this browser, by why they keep the visitor here.
 * `saving`: work that is still on its way to the space and finishes by itself (a recording, an
 * unsaved note, outbox work, an Upload-sheet job). Infinity when the check failed: unknown blocks.
 * `localAudio`: notes saved to the space whose audio is not (web audio upload is off by default);
 * webStore never deletes that audio, so it stays reachable only on this origin.
 */
export interface LocalRecordingWork {
  saving: number;
  localAudio: number;
}

export type OriginMoveDecision =
  | { kind: "stay" }
  | { kind: "move"; url: string }
  | { kind: "hold"; work: LocalRecordingWork };

export interface OriginMoveEnv {
  /** Defaults to the global indexedDB; null for none. */
  factory?: IDBFactory | null;
  /** Defaults to the global localStorage; null for none. */
  storage?: Pick<Storage, "length" | "key" | "getItem"> | null;
}

export function isLegacyOrigin(loc: Pick<Location, "hostname">): boolean {
  return loc.hostname === LEGACY_HOSTNAME;
}

export function canonicalUrlFor(loc: Pick<Location, "pathname" | "search" | "hash">): string {
  return CANONICAL_ORIGIN + loc.pathname + loc.search + loc.hash;
}

/**
 * Opens `name` without creating it. Null when the database does not exist. Never upgrades: an
 * open that would create the database is aborted, so the owning module's later open still runs
 * its own schema upgrade.
 */
async function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | null> {
  if (typeof factory.databases === "function") {
    const known = await factory.databases();
    if (!known.some((info) => info.name === name)) return null;
  }
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    let created = false;
    const open = factory.open(name);
    open.onupgradeneeded = () => {
      created = true;
      open.transaction?.abort();
    };
    open.onsuccess = () => {
      // Unreachable after an aborted upgrade; kept so a non-conforming factory never leaks a created database.
      if (created) { open.result.close(); resolve(null); return; }
      resolve(open.result);
    };
    open.onerror = (event) => {
      if (created) { event.preventDefault(); resolve(null); return; }
      reject(open.error ?? new Error(`Could not open ${name}`));
    };
  });
}

function readAll<T>(db: IDBDatabase, names: readonly string[]): Promise<Map<string, T[]>> {
  const present = names.filter((name) => db.objectStoreNames.contains(name));
  if (present.length === 0) return Promise.resolve(new Map());
  return new Promise<Map<string, T[]>>((resolve, reject) => {
    const rows = new Map<string, T[]>();
    const tx = db.transaction(present, "readonly");
    for (const name of present) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => rows.set(name, req.result as T[]);
    }
    tx.oncomplete = () => resolve(rows);
    tx.onerror = () => reject(tx.error ?? new Error("Could not read local recordings"));
    tx.onabort = () => reject(tx.error ?? new Error("Local recordings read aborted"));
  });
}

async function readExisting<T>(factory: IDBFactory, name: string, stores: readonly string[]): Promise<Map<string, T[]>> {
  const db = await openExisting(factory, name);
  if (!db) return new Map();
  try {
    return await readAll<T>(db, stores);
  } finally {
    db.close();
  }
}

/** The Upload-sheet jobs stored in this browser (audioUpload.ts `localStoragePendingUploadStore`) that are not saved yet. */
function countUnsavedUploads(storage: Pick<Storage, "length" | "key" | "getItem">): number {
  const prefix = `${UPLOAD_PENDING_STORAGE_KEY}:`;
  let count = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    let job: unknown;
    try {
      job = JSON.parse(storage.getItem(key) ?? "null");
    } catch {
      continue; // The upload store reads an unparseable record as no job, so nothing can resume it.
    }
    if (!job || typeof job !== "object") continue;
    const { saved, discarding } = job as { saved?: unknown; discarding?: unknown };
    // A discarded job only has remote cleanup left: no recording of the user's is waiting on it.
    if (saved !== true && discarding !== true) count++;
  }
  return count;
}

/**
 * Counts recordings in this browser that are not yet safely in a TinyCloud space, across every
 * owner. `saving`: capture sessions (live, unfinished or awaiting recovery), recordings that failed
 * recovery, notes not saved or with local work left (localWork.ts), notes with an outbox entry, and
 * unsaved Upload-sheet jobs. `localAudio`: the remaining notes whose audio has no verified space
 * copy (audioPlaybackCache.ts `hasVerifiedSpaceCopy`). Reads only; never creates a database.
 * Any failure returns `saving: Infinity`: the count is unknown, and unknown must block the move.
 */
export async function countLocalOnlyRecordingWork(env: OriginMoveEnv = {}): Promise<LocalRecordingWork> {
  const factory = env.factory !== undefined ? env.factory : typeof indexedDB === "undefined" ? null : indexedDB;
  try {
    const storage = env.storage !== undefined ? env.storage : globalThis.localStorage ?? null;
    const saving = new Set<string>();
    const localAudio = new Set<string>();
    const voice = factory
      ? await readExisting<unknown>(factory, VOICE_NOTES_DB, [STORES.sessions, STORES.quarantine, STORES.notes, STORES.outbox])
      : new Map<string, unknown[]>();
    for (const row of (voice.get(STORES.sessions) ?? []) as { id: string }[]) saving.add(row.id);
    for (const row of (voice.get(STORES.quarantine) ?? []) as { id: string }[]) saving.add(row.id);
    // entryId is `${noteId}:${opId}` (webStore.ts outboxEntryFor).
    for (const entry of (voice.get(STORES.outbox) ?? []) as OutboxEntry[]) {
      const at = entry.entryId.indexOf(":");
      saving.add(at < 0 ? entry.entryId : entry.entryId.slice(0, at));
    }
    for (const note of (voice.get(STORES.notes) ?? []) as VoiceNoteRecording[]) {
      if (note.ledger?.audio.state !== "saved" || hasLocalWorkInProgress(note)) saving.add(note.id);
      else if (!hasVerifiedSpaceCopy(note)) localAudio.add(note.id);
    }
    for (const id of saving) localAudio.delete(id);
    return { saving: saving.size + (storage ? countUnsavedUploads(storage) : 0), localAudio: localAudio.size };
  } catch (error) {
    console.warn("[originMove] Could not check local recordings; staying on this origin", error);
    return { saving: Number.POSITIVE_INFINITY, localAudio: 0 };
  }
}

export interface OriginMoveOptions {
  location: Pick<Location, "hostname" | "pathname" | "search" | "hash">;
  countWork?: () => Promise<LocalRecordingWork>;
}

/** Stay off the legacy origin without touching storage; on it, move unless local-only work is left. */
export async function decideOriginMove({ location, countWork = countLocalOnlyRecordingWork }: OriginMoveOptions): Promise<OriginMoveDecision> {
  if (!isLegacyOrigin(location)) return { kind: "stay" };
  let work: LocalRecordingWork;
  try {
    work = await countWork();
  } catch {
    work = { saving: Number.POSITIVE_INFINITY, localAudio: 0 };
  }
  return work.saving === 0 && work.localAudio === 0 ? { kind: "move", url: canonicalUrlFor(location) } : { kind: "hold", work };
}

const LIVE_UPLOAD_STAGES: Record<UploadState["stage"], boolean> = {
  preparing: true, uploading: true, queued: true, transcribing: true, saving: true, saved: false, failed: false, elsewhere: false,
};

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface MoveWhenClearOptions {
  location?: Pick<Location, "hostname" | "pathname" | "search" | "hash" | "replace">;
  countWork?: () => Promise<LocalRecordingWork>;
  /** This tab's Upload-sheet run (default `uploadRunner.snapshot`): a live one is never cut off by the move. */
  upload?: () => UploadState | null;
  /** Called with each new count while still held, so a notice can update. */
  onPending?: (work: LocalRecordingWork) => void;
  intervalMs?: number;
  window?: Listenable;
  document?: Listenable & Pick<Document, "visibilityState">;
}

/**
 * While held, re-checks every `intervalMs`, when the page becomes visible and when the browser comes
 * back online, and replaces the location with the canonical URL (computed from the location at that
 * moment) once nothing is left and this tab runs no upload. Returns a function that stops checking.
 */
export function moveWhenClear(options: MoveWhenClearOptions = {}): () => void {
  const location = options.location ?? globalThis.location;
  const count = options.countWork ?? (() => countLocalOnlyRecordingWork());
  const upload = options.upload ?? (() => uploadRunner.snapshot());
  // Read after the count, right before deciding: an upload sending its file or storing its audio
  // counts as saving even before (or after) its stored job says so.
  const countWork = async (): Promise<LocalRecordingWork> => {
    const work = await count();
    const live = upload();
    return live && (LIVE_UPLOAD_STAGES[live.stage] || live.audio.stage === "storing")
      ? { ...work, saving: Math.max(work.saving, 1) }
      : work;
  };
  const win = options.window ?? globalThis.window;
  const doc = options.document ?? globalThis.document;
  let stopped = false;
  let running = false;

  const check = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const decision = await decideOriginMove({ location, countWork });
      if (stopped) return;
      if (decision.kind === "move") {
        stop();
        location.replace(decision.url);
      } else if (decision.kind === "hold") {
        options.onPending?.(decision.work);
      } else {
        stop();
      }
    } finally {
      running = false;
    }
  };
  const onVisible = () => { if (doc?.visibilityState !== "hidden") void check(); };
  const onOnline = () => { void check(); };
  const timer = setInterval(() => { void check(); }, options.intervalMs ?? ORIGIN_MOVE_RECHECK_MS);
  doc?.addEventListener("visibilitychange", onVisible);
  win?.addEventListener("online", onOnline);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", onVisible);
    win?.removeEventListener("online", onOnline);
  }
  return stop;
}
