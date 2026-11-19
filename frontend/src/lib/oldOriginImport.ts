// TC-3045: the phone apps moved to their own WebView origin (https://app.tinycloud.one on Android,
// tinycloudone://app.tinycloud.one on iOS). The new origin can't read what the app stored at the old one
// (https://localhost, capacitor://localhost), and the native side wipes the old origin once it is imported.
//
// On the first launch on the new origin, before the app renders, the native side opens the old origin in a hidden
// WebView and exports what's listed in OLD_ORIGIN_ALLOW to an app-private file (mobile: OldOriginMigration). This
// copies it in, keeping anything the new origin already has, and acks. Native deletes the file and only then wipes the
// old origin, so nothing listed here is wiped before it is imported. Without the ack (a failure, or the export not
// answering in time) the old data stays and the next launch tries again.
//
// The allowlist is work that may exist only on the phone, plus settings that aren't synced. It never names a
// secret: the backend JWT, the SDK session keys and share tokens stay behind and are wiped (they are renewed or
// re-read from the account after sign-in).
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface OldOriginAllow {
  /** localStorage keys copied as they are. */
  exact: readonly string[];
  /** localStorage keys copied with any suffix: account-scoped keys (`<key>:<did>…`) and per-item prefixes. */
  prefixes: readonly string[];
  /** IndexedDB databases whose rows are copied; every store, rows keyed in-line. */
  databases: readonly string[];
}

// Literals, not the owning modules' constants: those modules are not in the entry chunk. oldOriginImport.test.ts
// checks each one against its module.
const ACCOUNT_SCOPED = [
  "exo.voiceNotes.privateCloudJobs",
  "exo.voiceNotes.privateChoices",
  "exo.voiceNotes.privateChoiceIntents",
  "exo.voiceNotes.privateChoicePinFailClosed",
  "exo.voiceNotes.privateSourcePinAge",
  "exo.voiceNotes.limitBlockedPrivateChoices",
  "exo.voiceNotes.heldFromTranscription",
  "exo.voiceNotes.autoResubmitted",
  "exo.voiceNotes.powerfulJobs",
  "exo.voiceNotes.powerfulConsent",
  "exo.voiceNotes.privateCloudConsent",
  "exo.voiceNotes.privateConsentPrompted",
  "exo.transcriber.uploadPending",
];

export const OLD_ORIGIN_ALLOW: OldOriginAllow = {
  exact: [
    // Recording settings (transcriberPreference.ts), the discard guard (recorderSaves.ts), the Upload sheet's engine.
    "exo.voiceNotes.transcriber",
    "exo.voiceNotes.identifySpeakers",
    "exo.voiceNotes.uploadAudio",
    "exo.voiceNotes.stopAfter",
    "exo.voiceNotes.autoStop",
    "exo.voiceNotes.discarded",
    "exo.transcriber.uploadEngine",
    // Theme and view settings.
    "xyz.tinycloud.tinychat:theme-choice",
    "tinychat:feed-view-mode:v1",
    "exo.notesView",
    "tinychat:ui:tinycloud-button-shown",
  ],
  prefixes: [
    // Home answers not yet confirmed, "Not sent" notices, post drafts.
    "tinychat.home.answer-outbox.v1:",
    "tinychat.home.answer-unsent.v1:",
    "tinychat.home.post-draft.v1:",
    "exo.voiceNotes.partialAudio.",
    ...ACCOUNT_SCOPED.map((key) => `${key}:`),
  ],
  // Typed recording notes (recordingNotes.ts) and finished transcripts not yet saved (heldResults.ts).
  databases: ["exo-recording-notes", "exo-held-results"],
};

export function isMigratedKey(key: string, allow: OldOriginAllow = OLD_ORIGIN_ALLOW): boolean {
  return allow.exact.includes(key) || allow.prefixes.some((prefix) => key.startsWith(prefix));
}

/** What the export script returns, as JSON. */
export interface OldOriginExport {
  version: 1;
  localStorage: [string, string][];
  databases: Record<string, { stores: Record<string, unknown[]> }>;
}

/**
 * The body of an async function of `allow` (an OldOriginAllow) that the native side runs in a hidden WebView at the old
 * origin; it resolves the OldOriginExport as JSON. Plain source, not a compiled function, so the bundler can't change
 * what the native side runs. Reads only: the old origin is left as it is until the import's ack.
 */
export const OLD_ORIGIN_EXPORT_SCRIPT = `
const keep = (key) => allow.exact.includes(key) || allow.prefixes.some((prefix) => key.startsWith(prefix));
const entries = [];
for (let i = 0; i < localStorage.length; i++) {
  const key = localStorage.key(i);
  if (key !== null && keep(key)) entries.push([key, localStorage.getItem(key)]);
}
const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const present = new Set((await indexedDB.databases()).map((info) => info.name));
const databases = {};
for (const name of allow.databases) {
  if (!present.has(name)) continue;
  const open = indexedDB.open(name);
  open.onupgradeneeded = () => open.transaction.abort();
  const db = await settle(open);
  try {
    const stores = {};
    for (const store of Array.from(db.objectStoreNames)) {
      stores[store] = await settle(db.transaction(store, "readonly").objectStore(store).getAll());
    }
    databases[name] = { stores };
  } finally {
    db.close();
  }
}
return JSON.stringify({ version: 1, localStorage: entries, databases });
`;

export type TakeResult = { state: "done" | "skip" } | { state: "export"; data: string };

export interface OldOriginMigrationPlugin {
  /**
   * `done`: already imported. `skip`: a dev build still served from the old origin. `export`: the export, as JSON,
   * from `script` run with `allow` at the old origin (or the file an earlier launch saved).
   */
  take(options: { allow: OldOriginAllow; script: string }): Promise<TakeResult>;
  /** The export is in: native deletes its file, then wipes the old origin. */
  ack(): Promise<void>;
}

/** Adds the rows a store doesn't have yet (by their in-line key) to `database`'s stores, as its own module opens it. */
export type AddMissingRows = (database: string, store: string, rows: unknown[]) => Promise<void>;

export interface ImportOptions {
  plugin?: OldOriginMigrationPlugin;
  storage?: Pick<Storage, "getItem" | "setItem">;
  addMissingRows?: AddMissingRows;
  /** How long the first launch waits for the export before rendering without it. */
  timeoutMs?: number;
}

export type ImportOutcome =
  | { kind: "none" }
  | { kind: "imported"; keys: string[] }
  | { kind: "failed"; reason: string };

/**
 * The phone app's first launch on its new origin: copy what the old origin's export holds, keeping what this origin
 * already has, then ack. Never throws; resolves `failed` (nothing acked, the next launch tries again) on any error,
 * or when the export doesn't answer within `timeoutMs`. `imported.keys` are the localStorage keys copied.
 */
export async function importOldOrigin(options: ImportOptions = {}): Promise<ImportOutcome> {
  if (!options.plugin && !Capacitor.isNativePlatform()) return { kind: "none" };
  const plugin = options.plugin ?? registerPlugin<OldOriginMigrationPlugin>("OldOriginMigration");
  const storage = options.storage ?? globalThis.localStorage;
  const addRows = options.addMissingRows ?? addMissingAppRows;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the old origin's export did not answer in time")), options.timeoutMs ?? 8000);
    });
    const taken = await Promise.race([plugin.take({ allow: OLD_ORIGIN_ALLOW, script: OLD_ORIGIN_EXPORT_SCRIPT }), timeout]);
    clearTimeout(timer);
    if (taken.state !== "export") return { kind: "none" };
    const data = JSON.parse(taken.data) as OldOriginExport;
    if (data.version !== 1) throw new Error(`unknown export version ${String(data.version)}`);
    const keys: string[] = [];
    for (const [key, value] of data.localStorage) {
      if (typeof key !== "string" || typeof value !== "string" || !isMigratedKey(key)) continue;
      if (storage.getItem(key) !== null) continue;
      storage.setItem(key, value);
      keys.push(key);
    }
    for (const [database, { stores }] of Object.entries(data.databases)) {
      if (!OLD_ORIGIN_ALLOW.databases.includes(database)) continue;
      for (const [store, rows] of Object.entries(stores)) {
        if (rows.length) await addRows(database, store, rows);
      }
    }
    await plugin.ack();
    return { kind: "imported", keys };
  } catch (error) {
    clearTimeout(timer);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[OldOrigin] Could not import the old origin's data; it is kept for the next launch (${reason})`);
    return { kind: "failed", reason };
  }
}

/**
 * Opens each database through its own module, so the new origin gets that module's schema. Imported on demand: both
 * modules pull the voice-note stack into the entry chunk (entry-size-check.ts), and only a launch with rows needs them.
 */
const addMissingAppRows: AddMissingRows = async (database, store, rows) => {
  let db: IDBDatabase;
  let close = false;
  if (database === "exo-recording-notes") {
    db = await (await import("./voiceNotes/recordingNotes")).openRecordingNotesDb();
  } else if (database === "exo-held-results") {
    db = await (await import("./voiceNotes/heldResults")).openHeldResultsDb();
    close = true;
  } else {
    throw new Error(`no importer for ${database}`);
  }
  try {
    await addMissingRows(db, store, rows);
  } finally {
    if (close) db.close();
  }
};

/** Adds each row unless its in-line key is already there. One transaction; resolves once it commits. */
export function addMissingRows(db: IDBDatabase, store: string, rows: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const objects = tx.objectStore(store);
    for (const row of rows) {
      const request = objects.add(row);
      request.onerror = (event) => {
        // Already there: this origin's copy wins. Anything else aborts the transaction.
        if (request.error?.name !== "ConstraintError") return;
        event.preventDefault();
        event.stopPropagation();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`Could not import into ${store}`));
    tx.onabort = () => reject(tx.error ?? new Error(`Importing into ${store} was aborted`));
  });
}
