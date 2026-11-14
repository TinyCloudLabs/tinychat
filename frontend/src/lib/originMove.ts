// tinycloud.chat serves the same build as the canonical Home origin. Visitors there move to
// home.tinycloud.xyz, unless this browser holds recording work or Home answers that exist only on the legacy
// origin: origins don't share IndexedDB or localStorage, so moving would strand them. Held visitors
// move on their own once that work is saved to their TinyCloud space (or the answers are sent, seen or expired).
// A move also waits until home.tinycloud.xyz serves this same build, and never happens to a page that must finish
// here (an OAuth return, a popup, the static /agents docs) or while this page has work in memory.

import { clearAllHeldAnswers, countStoredAnswers } from "@/feed/answerOutbox";
import { clearAllPostDrafts, countPostDrafts } from "@/feed/postAnswers";
import { UPLOAD_PENDING_STORAGE_KEY, uploadRunner, type UploadState } from "./audioUpload";
import { sameTabReturnState } from "./connectors/googleOAuthReturn";
import { hasVerifiedSpaceCopy } from "./voiceNotes/audioPlaybackCache";
import { HELD_RESULTS_DB, HELD_RESULTS_STORE } from "./voiceNotes/heldResults";
import { hasLocalWorkInProgress } from "./voiceNotes/localWork";
import type { LocalTranscript, OutboxEntry, VoiceNoteRecording } from "./voiceNotes/nativeVoiceNotes";
import { RECORDING_NOTE_LOCAL_PREFIX, RECORDING_NOTES_DB, RECORDING_NOTES_STORE, unsyncedStoredNote } from "./voiceNotes/recordingNotes";
import { isAutomaticRetryableCode } from "./voiceNotes/retryableVoiceNoteErrors";
import { VOICE_NOTE_PENDING_JOBS_KEY } from "./voiceNotes/sourcePins";
import { STORES } from "./voiceNotes/web/idb";

export const CANONICAL_ORIGIN = "https://home.tinycloud.xyz";
export const LEGACY_HOSTNAME = "tinycloud.chat";

/** Written by every build (vite.config.ts `tinychat-version-json`); public/_headers lets tinycloud.chat read it. */
export const CANONICAL_VERSION_URL = `${CANONICAL_ORIGIN}/version.json`;

/** The web voice-note store (webStore.ts `openWebStore` default). */
const VOICE_NOTES_DB = "exo-voice-notes";

/** How often a held visitor re-checks whether the local work has been saved. */
export const ORIGIN_MOVE_RECHECK_MS = 30_000;

/** How long the move waits for home.tinycloud.xyz's version.json before staying. */
export const CANONICAL_VERSION_TIMEOUT_MS = 5_000;

/**
 * Recordings that exist only in this browser, by why they keep the visitor here. Each recording counts once, in the
 * first of these that applies.
 * `saving`: work that is still on its way to the space and finishes by itself (a recording, an
 * unsaved note, outbox work, a held or local transcript, a Private transcription job, unsynced
 * note Markdown, an Upload-sheet job). Infinity when the check failed: unknown blocks.
 * `unclaimed`: committed recordings made signed out, kept until "Save to this account".
 * `otherAccount`: committed recordings bound to an account that is not signed in here.
 * `localAudio`: the signed-in account's notes saved to the space whose audio is not (web audio upload is off by
 * default), by recording id; webStore never deletes that audio, so it stays reachable only on this origin.
 * `signedIn`: an account is signed in here.
 * `heldAnswers`, `unsentAnswers`, `postDrafts`: Home's answers kept only in this origin's localStorage, younger than
 * HELD_ANSWER_TTL_MS: answers waiting to be sent (the feed sends them from here), answers the feed did not take that
 * the owner has not yet seen as "Not sent", and post drafts with at least one answer.
 */
export interface LocalRecordingWork {
  saving: number;
  localAudio: readonly string[];
  unclaimed: number;
  otherAccount: number;
  signedIn: boolean;
  heldAnswers: number;
  unsentAnswers: number;
  postDrafts: number;
}

/** Nothing local-only: the move may go ahead, and no notice shows. */
export const NO_LOCAL_WORK: LocalRecordingWork = {
  saving: 0, localAudio: [], unclaimed: 0, otherAccount: 0, signedIn: false, heldAnswers: 0, unsentAnswers: 0, postDrafts: 0,
};

/** Whether anything in `work` keeps the visitor on this origin. */
export function holdsOriginMove(work: LocalRecordingWork): boolean {
  return work.saving !== 0 || work.localAudio.length > 0 || work.unclaimed > 0 || work.otherAccount > 0 || holdsAnswers(work);
}

function holdsAnswers(work: LocalRecordingWork): boolean {
  return work.heldAnswers > 0 || work.unsentAnswers > 0 || work.postDrafts > 0;
}

/**
 * Removes this origin's held and unsent answers and post drafts, right before the move: once the count let the move
 * go ahead, only expired, empty or malformed ones are left, and they must not linger on the old origin.
 */
export function clearMovedAnswers(): void {
  clearAllHeldAnswers();
  clearAllPostDrafts();
}

/** The count when this browser's recordings could not be read: unknown blocks the move. */
const UNKNOWN_WORK: LocalRecordingWork = { ...NO_LOCAL_WORK, saving: Number.POSITIVE_INFINITY };

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
 * Why this page must stay on the legacy origin whatever is stored, or null.
 * - `popup`: a window another page opened (`window.opener`) reports back to that page; moving it breaks the report.
 * - `oauth-return`: the backend's same-tab Google return (googleOAuthReturn.ts). Its PKCE verifier is in this
 *   origin's sessionStorage (googleOAuthSameTab.ts `saveSameTabVerifier`), so only this origin can finish it.
 * - `agents`: the static agent setup docs and skill tarballs (public/_redirects, public/agents). The app never
 *   runs there; this keeps it so should a request ever reach it.
 */
export function originMoveExemption(
  loc: Pick<Location, "pathname" | "search">,
  opener: boolean,
): "popup" | "oauth-return" | "agents" | null {
  if (opener) return "popup";
  if (sameTabReturnState(loc.search) !== null) return "oauth-return";
  // Mirrors vite.config.ts navigateFallbackDenylist.
  if (/^\/agents(?:\/|$)/.test(loc.pathname)) return "agents";
  return null;
}

export interface CanonicalBuildCheck {
  fetch?: typeof globalThis.fetch;
  /** This bundle's commit; defaults to the one vite.config.ts baked in (none outside a Vite build). */
  commit?: string | null;
  timeoutMs?: number;
}

/**
 * True only when home.tinycloud.xyz serves this exact build: its version.json names this bundle's commit.
 * A bundle without a commit, a network error, a timeout or another build is false, and the visitor stays.
 */
export async function canonicalServesThisBuild(check: CanonicalBuildCheck = {}): Promise<boolean> {
  const commit = check.commit !== undefined ? check.commit
    : typeof __EXO_BUILD_INFO__ === "object" && __EXO_BUILD_INFO__?.commit?.trim() || null;
  const fetchImpl = check.fetch ?? globalThis.fetch;
  if (!commit || typeof fetchImpl !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs ?? CANONICAL_VERSION_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CANONICAL_VERSION_URL, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return !!body && typeof body === "object" && "commit" in body && body.commit === commit;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const deferrals = new Set<object>();
const deferralEnded = new Set<() => void>();

/**
 * Keeps a held page on this origin until the returned function is called: work that lives only in this page's
 * memory (a chat draft or reply, an unsaved Markdown edit, an OAuth popup waiting to post back here, a sign-in)
 * must finish first. Calling the release twice is harmless. A held page re-checks as soon as the last one ends.
 */
export function deferOriginMove(): () => void {
  const token = {};
  deferrals.add(token);
  return () => {
    if (!deferrals.delete(token) || deferrals.size > 0) return;
    for (const listener of [...deferralEnded]) listener();
  };
}

export function isOriginMoveDeferred(): boolean {
  return deferrals.size > 0;
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
      // Never hold up the owning module's upgrade of this database (e.g. #638's v2 schemas).
      open.result.onversionchange = () => open.result.close();
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

function parseJson(raw: string | null): unknown {
  try {
    return JSON.parse(raw ?? "null");
  } catch {
    return null; // Each owning store reads an unparseable value as nothing, so nothing can resume it.
  }
}

/** True for an Upload-sheet job (audioUpload.ts `localStoragePendingUploadStore`) that is not saved yet. */
function isUnsavedUpload(job: unknown): boolean {
  if (!job || typeof job !== "object") return false;
  // A discarded job only has remote cleanup left: no recording of the user's is waiting on it.
  return !("saved" in job && job.saved === true) && !("discarding" in job && job.discarding === true);
}

/**
 * The note ids with a Private transcription job (voiceNoteTranscription.ts `localStorageVoiceNotePendingStore`) whose
 * result is not in the space: a finished transcript held for its commit (`held`), or a job still running or set to
 * retry by itself. A job that failed for good holds no transcript; the note itself is counted from its own store.
 */
function privateJobsInFlight(jobs: unknown): string[] {
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  return Object.entries(jobs).flatMap(([sourceId, job]: [string, unknown]) => {
    if (!job || typeof job !== "object" || !("attemptId" in job) || typeof job.attemptId !== "string") return [];
    const failure = "failure" in job && typeof job.failure === "string" ? job.failure : null;
    return "held" in job && job.held !== undefined || failure === null || isAutomaticRetryableCode(failure) ? [sourceId] : [];
  });
}

/** What this origin's localStorage holds that the space does not, by note id; Upload-sheet jobs are counted apart. */
function readLocalStorage(storage: Pick<Storage, "length" | "key" | "getItem">) {
  const notes: { value: unknown; key: string }[] = [];
  const privateJobs: string[] = [];
  let uploads = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;
    if (key.startsWith(`${UPLOAD_PENDING_STORAGE_KEY}:`)) {
      if (isUnsavedUpload(parseJson(storage.getItem(key)))) uploads++;
    } else if (key.startsWith(RECORDING_NOTE_LOCAL_PREFIX)) {
      notes.push({ value: parseJson(storage.getItem(key)), key: key.slice(RECORDING_NOTE_LOCAL_PREFIX.length) });
    } else if (key.startsWith(`${VOICE_NOTE_PENDING_JOBS_KEY}:`)) {
      privateJobs.push(...privateJobsInFlight(parseJson(storage.getItem(key))));
    }
  }
  return { notes, privateJobs, uploads };
}

const NO_ROWS = new Map<string, unknown[]>();

/**
 * Counts recordings in this browser that are not yet safely in a TinyCloud space, across every
 * owner. Reads only; never creates a database. Any failure returns `saving: Infinity`: the count
 * is unknown, and unknown must block the move.
 *
 * `saving`, by note id:
 * - exo-voice-notes: capture sessions (live, unfinished or awaiting recovery), recordings that failed
 *   recovery, notes not saved or with local work left (localWork.ts), notes with an outbox entry, and a
 *   transcript made in this browser that the note's ledger does not record as saved (`transcriptSync`);
 * - exo-held-results: every row is a finished transcript waiting for its commit (heldResults.ts removes it
 *   once the commit is verified, `removeIf`);
 * - exo-recording-notes (and its localStorage fallback), for every account and unclaimed: non-empty Markdown at a
 *   revision the space has not acknowledged (recordingNotes.ts `unsyncedStoredNote`). An id-only record from
 *   before notes were account-bound counts only when its recording is in exo-voice-notes, whose reconcile pass
 *   re-keys and re-syncs it;
 * - Private transcription jobs in localStorage whose transcript is not in the space;
 * plus unsaved Upload-sheet jobs.
 * The rest keep the visitor here without making progress by themselves, split by owner: notes whose audio has no
 * verified space copy (audioPlaybackCache.ts `hasVerifiedSpaceCopy`), and every counted committed recording that is
 * unclaimed or bound to an account that is not signed in here (webStore.ts keeps them through sign-out until that
 * account syncs or deletes them). Unclaimed ones count as `unclaimed`, another account's as `otherAccount`, and the
 * signed-in account's own (only audio is left for them) as `localAudio`.
 *
 * Not counted, because they hold no data of their own that the counted stores or the space lack:
 * exo-pending-save-state and the Private choice/hold markers (a note id and a status; the note is
 * counted above), Powerful jobs (their remote op keeps the note counted by localWork.ts until saved),
 * the replica's pending rows (key and op only, encrypted), exo-audio-playback-cache (copies of audio in
 * the space), thread and memory caches and tinycloud-home-local (localFirst/localCache.ts: feed, library and chat
 * copies written only from network loads, plus schema-created markers), `exo.transcriber.privateCloudPending`
 * (read by nothing) and `exo.voiceNotes.discarded` (deletions of local data). The "shared with me"
 * list (`tinychat:shared-with-me:v1`) is browser-only and is not carried: its share links still open.
 */
export async function countLocalOnlyRecordingWork(env: OriginMoveEnv = {}): Promise<LocalRecordingWork> {
  const factory = env.factory !== undefined ? env.factory : typeof indexedDB === "undefined" ? null : indexedDB;
  try {
    const storage = env.storage !== undefined ? env.storage : globalThis.localStorage ?? null;
    const saving = new Set<string>();
    const keptHere = new Set<string>();
    const [voice, held, notes] = factory
      ? await Promise.all([
        readExisting<unknown>(factory, VOICE_NOTES_DB,
          [STORES.kv, STORES.sessions, STORES.quarantine, STORES.notes, STORES.outbox, STORES.transcripts]),
        readExisting<unknown>(factory, HELD_RESULTS_DB, [HELD_RESULTS_STORE]),
        readExisting<unknown>(factory, RECORDING_NOTES_DB, [RECORDING_NOTES_STORE]),
      ])
      : [NO_ROWS, NO_ROWS, NO_ROWS];
    const local = storage ? readLocalStorage(storage) : { notes: [], privateJobs: [], uploads: 0 };

    const recordings = new Map<string, VoiceNoteRecording>();
    const capturing = new Set<string>();
    for (const row of (voice.get(STORES.sessions) ?? []) as { id: string }[]) capturing.add(row.id);
    for (const row of (voice.get(STORES.quarantine) ?? []) as { id: string }[]) capturing.add(row.id);
    for (const id of capturing) saving.add(id);
    // entryId is `${noteId}:${opId}` (webStore.ts outboxEntryFor).
    for (const entry of (voice.get(STORES.outbox) ?? []) as OutboxEntry[]) {
      const at = entry.entryId.indexOf(":");
      saving.add(at < 0 ? entry.entryId : entry.entryId.slice(0, at));
    }
    for (const note of (voice.get(STORES.notes) ?? []) as VoiceNoteRecording[]) {
      recordings.set(note.id, note);
      if (note.ledger?.audio.state !== "saved" || hasLocalWorkInProgress(note)) saving.add(note.id);
      else if (!hasVerifiedSpaceCopy(note)) keptHere.add(note.id);
    }
    for (const row of (voice.get(STORES.transcripts) ?? []) as { id: string; transcript: LocalTranscript }[]) {
      // A hosted (AssemblyAI) transcript is written here just before its save to the space, and its remote op
      // stays unfinished until that save (hostedVoiceNotes.ts `markHostedRemoteDone`), so localWork.ts counts it.
      if (row.transcript.engine === "assemblyai") continue;
      const sync = recordings.get(row.id)?.ledger?.transcriptSync;
      if (sync?.state !== "saved" || sync.rev < row.transcript.rev) saving.add(row.id);
    }
    for (const row of held.get(HELD_RESULTS_STORE) ?? []) {
      if (row && typeof row === "object" && "sourceId" in row && typeof row.sourceId === "string") saving.add(row.sourceId);
    }
    // A v1 database (before account binding) keys notes on `recordingId` and has no `storageId`; its upgrade assigns
    // the recording id as the storage id, so that is the key here too.
    const storedNotes = (notes.get(RECORDING_NOTES_STORE) ?? []).map((value) => {
      const row = value && typeof value === "object" ? value as { storageId?: unknown; recordingId?: unknown } : {};
      const key = typeof row.storageId === "string" ? row.storageId : typeof row.recordingId === "string" ? row.recordingId : "";
      return { value, key };
    });
    for (const { value, key } of [...storedNotes, ...local.notes]) {
      const note = unsyncedStoredNote(value, key);
      // An id-only record is re-keyed to its account and acknowledged by the reconcile pass of its recording, so it
      // counts while that recording is here; without it, nothing would ever acknowledge it.
      if (note && (note.owner !== undefined || recordings.has(note.recordingId))) saving.add(note.recordingId);
    }
    for (const id of local.privateJobs) saving.add(id);
    // A committed recording that is unclaimed (made signed out, kept until "Save to this account") or bound to an
    // account that is not signed in here makes no progress by itself: it keeps the visitor here, not "saving".
    const capture = (voice.get(STORES.kv) ?? []).find((row) => row && typeof row === "object" && "key" in row && row.key === "capture");
    const signedIn = capture && typeof capture === "object" && "status" in capture && capture.status === "signed_in"
      && "defaults" in capture && capture.defaults && typeof capture.defaults === "object" && "accountDid" in capture.defaults
      && typeof capture.defaults.accountDid === "string" && capture.defaults.accountDid !== "" ? capture.defaults.accountDid : null;
    for (const id of saving) {
      const owner = recordings.get(id)?.owner;
      if (!capturing.has(id) && recordings.has(id) && (!owner || owner !== signedIn)) {
        saving.delete(id);
        keptHere.add(id);
      } else keptHere.delete(id);
    }
    const localAudio: string[] = [];
    let unclaimed = 0;
    let otherAccount = 0;
    for (const id of keptHere) {
      const owner = recordings.get(id)?.owner;
      if (!owner) unclaimed++;
      else if (owner !== signedIn) otherAccount++;
      else localAudio.push(id);
    }
    const answers = storage ? countStoredAnswers(storage) : { held: 0, unsent: 0 };
    return {
      saving: saving.size + local.uploads, localAudio, unclaimed, otherAccount, signedIn: signedIn !== null,
      heldAnswers: answers.held, unsentAnswers: answers.unsent, postDrafts: storage ? countPostDrafts(storage) : 0,
    };
  } catch (error) {
    console.warn("[originMove] Could not check local recordings; staying on this origin", error);
    return UNKNOWN_WORK;
  }
}

export interface OriginMoveOptions {
  location: Pick<Location, "hostname" | "pathname" | "search" | "hash">;
  /** Whether another page opened this one (`window.opener`). */
  opener?: boolean;
  countWork?: () => Promise<LocalRecordingWork>;
  /** Whether home.tinycloud.xyz serves this build (default `canonicalServesThisBuild`). */
  canonicalReady?: () => Promise<boolean>;
}

/**
 * Stay off the legacy origin, and on an exempt page, without touching storage. Otherwise hold while local-only
 * work is left, and move only once home.tinycloud.xyz serves this build.
 */
export async function decideOriginMove({
  location, opener = false, countWork = countLocalOnlyRecordingWork, canonicalReady = canonicalServesThisBuild,
}: OriginMoveOptions): Promise<OriginMoveDecision> {
  if (!isLegacyOrigin(location) || originMoveExemption(location, opener) !== null) return { kind: "stay" };
  let work: LocalRecordingWork;
  try {
    work = await countWork();
  } catch {
    work = UNKNOWN_WORK;
  }
  if (holdsOriginMove(work)) return { kind: "hold", work };
  const ready = await canonicalReady().catch(() => false);
  return ready ? { kind: "move", url: canonicalUrlFor(location) } : { kind: "stay" };
}

const LIVE_UPLOAD_STAGES: Record<UploadState["stage"], boolean> = {
  preparing: true, uploading: true, queued: true, transcribing: true, saving: true, saved: false, failed: false, elsewhere: false,
};

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface MoveWhenClearOptions {
  location?: Pick<Location, "hostname" | "pathname" | "search" | "hash" | "replace">;
  /** Whether another page opened this one; defaults to `window.opener`. */
  opener?: boolean;
  countWork?: () => Promise<LocalRecordingWork>;
  /** Default `canonicalServesThisBuild`; while false the page stays held and checks again later. */
  canonicalReady?: () => Promise<boolean>;
  /** This tab's Upload-sheet run (default `uploadRunner.snapshot`): a live one is never cut off by the move. */
  upload?: () => UploadState | null;
  /**
   * The work a notice should show while still held, after each check. Zero (nothing to show) until
   * home.tinycloud.xyz has served this build once, and whenever nothing local is left but the move is
   * still blocked (a deferral, or the build check).
   */
  onPending?: (work: LocalRecordingWork) => void;
  intervalMs?: number;
  window?: Listenable;
  document?: Listenable & Pick<Document, "visibilityState">;
}

/**
 * Checks right away, then while held re-checks every `intervalMs`, when the page becomes visible, when
 * the browser comes back online and when the last `deferOriginMove` ends. A visitor kept only by recordings
 * that do not save by themselves (nothing saving) stays put, so once its notice is up the timed re-check pauses until
 * something is saving again. Replaces the location with the canonical URL (computed from the location at that moment) once
 * nothing is left, this tab runs no upload, nothing defers the move and home.tinycloud.xyz serves this
 * build. Returns a function that stops checking.
 */
export function moveWhenClear(options: MoveWhenClearOptions = {}): () => void {
  const location = options.location ?? globalThis.location;
  const opener = options.opener ?? (globalThis.window?.opener != null);
  const count = options.countWork ?? (() => countLocalOnlyRecordingWork());
  const canonicalReady = options.canonicalReady ?? (() => canonicalServesThisBuild());
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
  // A trigger that arrives during a check (a deferral ending, the browser coming online) runs one more after it.
  let again = false;
  // The notice says the visitor will move; it is shown only once home.tinycloud.xyz has served this build.
  let servedThisBuild = false;
  // Off while nothing is saving and the notice is up: nothing changes by itself, so the timer reads nothing.
  let polling = true;

  const buildServed = async () => {
    if (!servedThisBuild) servedThisBuild = await canonicalReady().catch(() => false);
    return servedThisBuild;
  };

  const check = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    again = false;
    try {
      // The build check runs last, and only when the move could otherwise happen or a notice would show.
      const decision = await decideOriginMove({ location, opener, countWork, canonicalReady: async () => true });
      if (stopped) return;
      if (decision.kind === "stay") {
        stop();
        return;
      }
      if (decision.kind === "hold") {
        const { work } = decision;
        const shown = await buildServed();
        // Until home.tinycloud.xyz serves this build, keep asking it, so the notice can appear.
        polling = work.saving !== 0 || holdsAnswers(work) || !shown;
        if (!stopped) options.onPending?.(shown ? work : NO_LOCAL_WORK);
        return;
      }
      polling = true;
      // Nothing local is left: whatever blocks the move now, the notice has no count to show.
      if (isOriginMoveDeferred() || !await canonicalReady().catch(() => false) || stopped || isOriginMoveDeferred()) {
        if (!stopped) options.onPending?.(NO_LOCAL_WORK);
        return;
      }
      stop();
      clearMovedAnswers();
      location.replace(canonicalUrlFor(location));
    } finally {
      running = false;
      if (again) void check();
    }
  };
  const onVisible = () => { if (doc?.visibilityState !== "hidden") void check(); };
  const onCheck = () => { void check(); };
  const timer = setInterval(() => { if (polling) void check(); }, options.intervalMs ?? ORIGIN_MOVE_RECHECK_MS);
  doc?.addEventListener("visibilitychange", onVisible);
  win?.addEventListener("online", onCheck);
  deferralEnded.add(onCheck);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", onVisible);
    win?.removeEventListener("online", onCheck);
    deferralEnded.delete(onCheck);
  }
  void check();
  return stop;
}
