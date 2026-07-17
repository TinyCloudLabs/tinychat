import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { ExportedMessageRepositoryItem } from "@assistant-ui/react";
import { historyPrefetch } from "./historyPrefetch";
import { MEMORY_TEMPLATE } from "./memory";
import type { CompactionCheckpoint } from "../chat/compaction";

// ── Storage layout ───────────────────────────────────────────────────
//
// Threads live in a per-space SQLite database, accessed browser-direct through
// the TinyCloud SQL service. This is a single backend — pure SQL, no KV. Two
// tables hold the data:
//
//   threads(id, title, model, created_at, updated_at)
//   messages(thread_id, position, payload, created_at)   -- payload = JSON item
//
// DB HANDLE CONVENTION (critical): the SQL service sends the db name VERBATIM
// as the invoke path — it does NOT app-prefix like KV does. The session
// capability grants the SQL resource `xyz.tinycloud.tinychat/threads` (the
// manifest path `threads` resolved with the app id). So the db name MUST be the
// FULL resolved path `${APP_ID}/threads`; `db("threads")` 401s. The node derives
// the SQLite FILE from the last path segment (`threads`) but authorizes against
// the full resource string.
//
// The signed-in session already holds the tinycloud.sql capability on its own
// space (no backend delegation). Every SQL op returns a Result (never throws);
// auth failures surface as `error.code === "AUTH_UNAUTHORIZED"`.

export const APP_ID = "xyz.tinycloud.tinychat";
export const DEFAULT_TITLE = "New chat";
// New-chat default — a confirmed tier-1 (signed + on-chain-verifiable) model, so a
// new user lands on a fully verifiable endpoint (green "Response verified"). Must be
// kept in sync with VERIFIABLE_MODELS in lib/completionStore.ts and the backend
// PICKER_MODELS default (REDPILL_DEFAULT_MODEL).
export const DEFAULT_MODEL = "deepseek/deepseek-v3.2";

/**
 * Db handle name. MUST be the full resolved path so the SQL invoke resource
 * equals the granted resource. See the DB HANDLE CONVENTION note above.
 */
export const THREADS_SQL_DB_NAME = `${APP_ID}/threads`;
const SQL_DB_NAME = THREADS_SQL_DB_NAME;

/** Schema creates, run before the first write per session (via ensureSchema). */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    thread_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, position)
  )`,
  // No explicit index: the node's SQLite authorizer denies CREATE INDEX, and the
  // (thread_id, position) PRIMARY KEY already provides the index that covers
  // `WHERE thread_id=? ORDER BY position`, so an explicit one would be redundant.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Memory: per-space "about me" doc, single row keyed by id='user_context'.
  // No CREATE INDEX (authorizer denies it) — the PK already covers the lookup.
  `CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Compaction checkpoints (spec §C.7): append-only per-thread LLM summaries.
  // The latest row per thread (by created_at, tie-break id) is the active
  // checkpoint. APPEND-ONLY — never UPSERT/UPDATE/DELETE (the memory-loss
  // incident lesson). No CREATE INDEX (authorizer denies it); the reader
  // selects by thread_id and picks the latest in JS.
  `CREATE TABLE IF NOT EXISTS compactions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    covers_through_message_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
];

/** Stable id of the single user_context row in the memory table. */
const MEMORY_ROW_ID = "user_context";

/**
 * Stable id of the last-known-good backup row, stored in the SAME `memory`
 * table (no schema change). `setMemory` snapshots the prior live doc here
 * before writing the new one; `getMemory` auto-restores from it if the live
 * row is ever found missing/empty; `clearMemory` deletes both rows so an
 * explicit "Clear memory" is not silently resurrected.
 */
const MEMORY_BACKUP_ROW_ID = "user_context_backup";

// Monotonically increasing counter bumped on every memory mutation (set/clear
// and the runtime/panel write-back paths). Used by the MemoryPanel mount-time
// reconcile to drop a stale SQL read that lost the race against a more recent
// write — without this, a SELECT in flight when an extraction lands would
// roll memoryRef back to the pre-extraction value on the next render.
let _memoryWriteGen = 0;
/** Snapshot the memory write counter — see _memoryWriteGen above. */
export function memoryWriteGen(): number {
  return _memoryWriteGen;
}

/** A persisted history item — stored verbatim from the ThreadHistoryAdapter. */
export type StoredMessageItem = ExportedMessageRepositoryItem;

export interface ThreadDoc {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessageItem[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  model: string;
}

/** Minimal structural view of a SQL service error (Result.error). */
type SqlError = { code: string; message: string };

/** True when an error (or thrown value) is an AUTH_UNAUTHORIZED SQL failure. */
function authUnauthorized(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code?: unknown }).code === "AUTH_UNAUTHORIZED";
  }
  return false;
}

/** Wrap a SqlError in a throwable that preserves `.code` for authUnauthorized. */
class SqlOpError extends Error {
  readonly code: string;
  constructor(error: SqlError, context: string) {
    super(`${context}: [${error.code}] ${error.message}`);
    this.name = "SqlOpError";
    this.code = error.code;
  }
}

/** A SQL database handle bound to the granted per-space resource. */
function store(tcw: TinyCloudWeb) {
  return tcw.sql.db(SQL_DB_NAME);
}

function sortSummaries(summaries: ThreadSummary[]): ThreadSummary[] {
  return [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Schema bootstrap (memoized per space) ────────────────────────────

const schemaReadySpaces = new Set<string>();
const schemaInFlight = new Map<string, Promise<void>>();

/**
 * Ensure the schema (threads, messages, idx_messages_thread) exists. Memoized
 * per account so it's a no-op after the first call per session.
 *
 * Memo key prefers `tcw.did` over `tcw.spaceId` for the same reason as
 * `cacheKey` below: spaceId is undefined on a RESTORED session, and an empty
 * key disabled the memo entirely — every SQL helper paid a schema batch
 * (~2s round-trip) before its real query, doubling all boot traffic.
 *
 * Concurrent first-callers share one in-flight batch instead of each issuing
 * their own (boot fires listThreads / getThread / getMemory / getThreadModel
 * roughly simultaneously, and the node degrades badly under parallel invokes).
 *
 * The CREATEs run as ordinary write statements in one `batch` transaction.
 * NOTE: do NOT use `execute(..., { schema })` — the schema option is authorized
 * differently and returns "400 Schema error: not authorized" under our
 * read+write grant, whereas plain DDL statements (CREATE TABLE …) are allowed.
 * On failure we do NOT memoize and we propagate so the caller can surface it.
 */
async function ensureSchema(tcw: TinyCloudWeb): Promise<void> {
  const did = typeof tcw.did === "string" && tcw.did.length > 0 ? tcw.did : null;
  const space = typeof tcw.spaceId === "string" && tcw.spaceId.length > 0 ? tcw.spaceId : null;
  const memoKey = did ?? space ?? "";
  if (memoKey && schemaReadySpaces.has(memoKey)) return;

  const inFlight = memoKey ? schemaInFlight.get(memoKey) : undefined;
  if (inFlight) return inFlight;

  const run = (async () => {
    const result = await store(tcw).batch(SCHEMA.map((sql) => ({ sql })));
    if (!result.ok) {
      throw new SqlOpError(result.error, "ensureSchema");
    }
    if (memoKey) schemaReadySpaces.add(memoKey);
  })();

  if (memoKey) {
    schemaInFlight.set(memoKey, run);
    void run.catch(() => {}).finally(() => schemaInFlight.delete(memoKey));
  }
  return run;
}

// ── Read helpers (rows are CELL-arrays, mapped by column order) ───────

/** Extract a string cell, defaulting when null/missing. */
function cellStr(row: unknown[], idx: number, fallback: string): string {
  const v = row[idx];
  return typeof v === "string" ? v : fallback;
}

/** Read a single thread row + its messages (ordered). Null if no thread. */
export async function getThread(tcw: TinyCloudWeb, id: string): Promise<ThreadDoc | null> {
  await ensureSchema(tcw);

  const threadRes = await store(tcw).query(
    "SELECT id, title, model, created_at, updated_at FROM threads WHERE id = ?",
    [id],
  );
  if (!threadRes.ok) throw new SqlOpError(threadRes.error, "getThread(thread)");
  const threadRows = threadRes.data.rows;
  if (threadRows.length === 0) return null;
  const tr = threadRows[0];

  const msgRes = await store(tcw).query(
    "SELECT payload FROM messages WHERE thread_id = ? ORDER BY position",
    [id],
  );
  if (!msgRes.ok) throw new SqlOpError(msgRes.error, "getThread(messages)");

  const messages: StoredMessageItem[] = [];
  for (const mrow of msgRes.data.rows) {
    const payload = mrow[0];
    if (typeof payload !== "string") continue;
    try {
      messages.push(JSON.parse(payload) as StoredMessageItem);
    } catch {
      // Skip an unparseable payload rather than failing the whole load.
    }
  }

  return {
    id: cellStr(tr, 0, id),
    title: cellStr(tr, 1, DEFAULT_TITLE),
    model: cellStr(tr, 2, DEFAULT_MODEL),
    createdAt: cellStr(tr, 3, new Date().toISOString()),
    updatedAt: cellStr(tr, 4, new Date().toISOString()),
    messages,
  };
}

/** Read just a thread's model (cheap — avoids loading the whole message list). */
export async function getThreadModel(tcw: TinyCloudWeb, id: string): Promise<string | null> {
  await ensureSchema(tcw);
  const res = await store(tcw).query("SELECT model FROM threads WHERE id = ?", [id]);
  if (!res.ok) throw new SqlOpError(res.error, "getThreadModel");
  const rows = res.data.rows;
  if (rows.length === 0) return null;
  const model = rows[0][0];
  return typeof model === "string" ? model : null;
}

/** Read just a thread's title (cheap — for the live sidebar title update). */
export async function getThreadTitle(tcw: TinyCloudWeb, id: string): Promise<string | null> {
  await ensureSchema(tcw);
  const res = await store(tcw).query("SELECT title FROM threads WHERE id = ?", [id]);
  if (!res.ok) throw new SqlOpError(res.error, "getThreadTitle");
  const rows = res.data.rows;
  return rows.length > 0 ? cellStr(rows[0], 0, DEFAULT_TITLE) : null;
}

// ── Settings (cross-device key/value prefs, stored in the user's space) ──
//
// These live in the same per-space SQLite DB as threads, so they sync to ANY
// device that signs in as this user (browser, iOS app, …) — unlike localStorage,
// which is device-local. Callers use localStorage as an instant-paint cache and
// reconcile against these (SQL is the source of truth).

/** Read a cross-device setting value from the user's space. Null if unset. */
export async function getSetting(tcw: TinyCloudWeb, key: string): Promise<string | null> {
  await ensureSchema(tcw);
  const res = await store(tcw).query("SELECT value FROM settings WHERE key = ?", [key]);
  if (!res.ok) throw new SqlOpError(res.error, "getSetting");
  const rows = res.data.rows;
  return rows.length > 0 ? cellStr(rows[0], 0, "") : null;
}

/** Upsert a cross-device setting value into the user's space. */
export async function setSetting(tcw: TinyCloudWeb, key: string, value: string): Promise<void> {
  await ensureSchema(tcw);
  const res = await store(tcw).execute(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
  if (!res.ok) throw new SqlOpError(res.error, "setSetting");
}

// ── Memory (per-space user_context doc, single row) ───────────────────

/** localStorage cache key for the per-space memory doc. */
function memoryCacheKey(tcw: TinyCloudWeb): string | null {
  const did = typeof tcw.did === "string" && tcw.did.length > 0 ? tcw.did : null;
  const space = typeof tcw.spaceId === "string" && tcw.spaceId.length > 0 ? tcw.spaceId : null;
  const id = did ?? space;
  return id ? `tinychat:memory:${id}` : null;
}

/** Read the cached memory doc (instant paint). Returns null if absent. */
export function readMemoryCache(tcw: TinyCloudWeb): string | null {
  const key = memoryCacheKey(tcw);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

function writeMemoryCache(tcw: TinyCloudWeb, content: string): void {
  const key = memoryCacheKey(tcw);
  if (!key) return;
  try {
    window.localStorage.setItem(key, content);
  } catch {
    // localStorage full/disabled — cache is optional.
  }
}

function removeMemoryCache(tcw: TinyCloudWeb): void {
  const key = memoryCacheKey(tcw);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Read the per-space user_context memory doc. Returns null if unset.
 *
 * On AUTH_UNAUTHORIZED or other SQL errors, falls back to the localStorage
 * cache rather than throwing — memory is best-effort and must never block
 * the chat path.
 */
export async function getMemory(tcw: TinyCloudWeb): Promise<string | null> {
  try {
    await ensureSchema(tcw);
    const res = await store(tcw).query(
      "SELECT content FROM memory WHERE id = ?",
      [MEMORY_ROW_ID],
    );
    if (!res.ok) throw new SqlOpError(res.error, "getMemory");
    const rows = res.data.rows;
    const liveContent = rows.length > 0 ? cellStr(rows[0], 0, "") : "";
    if (liveContent.trim().length > 0) {
      writeMemoryCache(tcw, liveContent);
      return liveContent;
    }
    // Live row empty/missing — try the last-known-good backup. If present,
    // restore it into the live row so subsequent reads short-circuit on the
    // happy path without paying the second query each time.
    const bk = await store(tcw).query(
      "SELECT content FROM memory WHERE id = ?",
      [MEMORY_BACKUP_ROW_ID],
    );
    if (bk.ok && bk.data.rows.length > 0) {
      const bkContent = cellStr(bk.data.rows[0], 0, "");
      if (bkContent.trim().length > 0) {
        const now = new Date().toISOString();
        const restoreRes = await store(tcw).execute(
          `INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
          [MEMORY_ROW_ID, bkContent, now],
        );
        if (!restoreRes.ok) {
          // Data is still safe — bkContent is returned to the caller — but
          // subsequent reads will pay the extra backup query until the live
          // row is repopulated. Log so the failure is observable.
          console.warn(
            "[threadStore] getMemory: failed to restore backup row into live",
            restoreRes.error,
          );
        }
        writeMemoryCache(tcw, bkContent);
        return bkContent;
      }
    }
    return null;
  } catch (err) {
    if (authUnauthorized(err)) {
      console.warn("[threadStore] getMemory unauthorized — falling back to cache", err);
    } else {
      console.warn("[threadStore] getMemory failed — falling back to cache", err);
    }
    return readMemoryCache(tcw);
  }
}

/** Upsert the per-space user_context doc and refresh the localStorage cache. */
export async function setMemory(tcw: TinyCloudWeb, content: string): Promise<void> {
  // Bump BEFORE SQL: any in-flight memory read will see a different counter
  // on completion and skip its ref assignment (see memoryWriteGen above).
  _memoryWriteGen++;
  await ensureSchema(tcw);
  const now = new Date().toISOString();
  const UPSERT =
    `INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`;

  // Snapshot the prior live doc as last-known-good before overwriting. Best
  // effort: if the read fails or the prior doc is empty, we just skip the
  // backup write and move on — never block or fail the primary write.
  const stmts: { sql: string; params: string[] }[] = [];
  const prior = await store(tcw).query(
    "SELECT content FROM memory WHERE id = ?",
    [MEMORY_ROW_ID],
  );
  if (prior.ok && prior.data.rows.length > 0) {
    const priorContent = cellStr(prior.data.rows[0], 0, "");
    if (priorContent.trim().length > 0) {
      stmts.push({ sql: UPSERT, params: [MEMORY_BACKUP_ROW_ID, priorContent, now] });
    }
  } else if (!prior.ok) {
    console.warn(
      "[threadStore] setMemory: prior-doc read failed, backup skipped",
      prior.error,
    );
  }
  stmts.push({ sql: UPSERT, params: [MEMORY_ROW_ID, content, now] });

  const res = await store(tcw).batch(stmts);
  if (!res.ok) throw new SqlOpError(res.error, "setMemory");
  writeMemoryCache(tcw, content);
}

/**
 * Replace the per-space user_context doc with the empty-section scaffold
 * (`MEMORY_TEMPLATE`). Non-destructive vs. `clearMemory`: the section
 * headers stay so the next extraction has a stable structure to fill in,
 * and the prior live doc is snapshotted into the backup row by reusing
 * `setMemory` — so writeGen bump, backup snapshot, and cache refresh all
 * come for free. Returns the template that was written.
 */
export async function resetMemoryToTemplate(tcw: TinyCloudWeb): Promise<string> {
  await setMemory(tcw, MEMORY_TEMPLATE);
  return MEMORY_TEMPLATE;
}

/** Delete the per-space user_context doc and drop the localStorage cache.
 *  Also drops the last-known-good backup row so an explicit "Clear memory" is
 *  not resurrected by `getMemory`'s auto-restore. */
export async function clearMemory(tcw: TinyCloudWeb): Promise<void> {
  _memoryWriteGen++;
  await ensureSchema(tcw);
  const res = await store(tcw).batch([
    { sql: "DELETE FROM memory WHERE id = ?", params: [MEMORY_ROW_ID] },
    { sql: "DELETE FROM memory WHERE id = ?", params: [MEMORY_BACKUP_ROW_ID] },
  ]);
  if (!res.ok) throw new SqlOpError(res.error, "clearMemory");
  removeMemoryCache(tcw);
}

// ── Compaction checkpoints (append-only per-thread summaries; §C.7) ──
//
// Writes are INSERT-only (§F.2). The reader selects every row for a thread and
// picks the latest by created_at (tie-break id) in JS — never relying on SQL
// ORDER BY semantics. A tiny per-thread in-memory cache short-circuits the
// extra SELECT on the hot request path; it is invalidated on append. No
// localStorage tier this milestone (§H.4).

const compactionCache = new Map<string, CompactionCheckpoint | null>();

/** Pure latest-row picker (exported for tests): latest created_at, tie-break id. */
export function latestCompaction(rows: CompactionCheckpoint[]): CompactionCheckpoint | null {
  let best: CompactionCheckpoint | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const byTime = row.createdAt.localeCompare(best.createdAt);
    if (byTime > 0 || (byTime === 0 && row.id.localeCompare(best.id) > 0)) {
      best = row;
    }
  }
  return best;
}

/** Append a compaction checkpoint (INSERT-only). Invalidates the per-thread cache. */
export async function appendCompaction(
  tcw: TinyCloudWeb,
  threadId: string,
  coversThroughMessageId: string,
  summary: string,
): Promise<CompactionCheckpoint> {
  await ensureSchema(tcw);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const res = await store(tcw).execute(
    `INSERT INTO compactions (id, thread_id, covers_through_message_id, summary, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, threadId, coversThroughMessageId, summary, createdAt],
  );
  if (!res.ok) throw new SqlOpError(res.error, "appendCompaction");
  const cp: CompactionCheckpoint = { id, threadId, coversThroughMessageId, summary, createdAt };
  compactionCache.set(threadId, cp);
  return cp;
}

/** Latest checkpoint for a thread, or null. Reads the cache first, else SQL. */
export async function getLatestCompaction(
  tcw: TinyCloudWeb,
  threadId: string,
): Promise<CompactionCheckpoint | null> {
  if (compactionCache.has(threadId)) return compactionCache.get(threadId) ?? null;
  await ensureSchema(tcw);
  const res = await store(tcw).query(
    "SELECT id, thread_id, covers_through_message_id, summary, created_at FROM compactions WHERE thread_id = ?",
    [threadId],
  );
  if (!res.ok) throw new SqlOpError(res.error, "getLatestCompaction");
  const rows: CompactionCheckpoint[] = res.data.rows.map((row) => ({
    id: cellStr(row, 0, ""),
    threadId: cellStr(row, 1, threadId),
    coversThroughMessageId: cellStr(row, 2, ""),
    summary: cellStr(row, 3, ""),
    createdAt: cellStr(row, 4, ""),
  }));
  const latest = latestCompaction(rows);
  compactionCache.set(threadId, latest);
  return latest;
}

// ── Local instant cache (stale-while-revalidate) ─────────────────────
//
// Each SQL op is a ~1.6–2.2s signed round-trip, so blocking the sidebar on even
// one call is slow. We mirror the summary list in localStorage, keyed by spaceId
// (the data boundary), render from it instantly, and revalidate in the
// background. Cache writes only PATCH an already-full cache so we never render a
// partial list.

function cacheKey(tcw: TinyCloudWeb): string | null {
  // Prefer the primary DID: it is present on BOTH fresh sign-in and a restored
  // session, whereas tcw.spaceId is undefined after restore — which would
  // silently disable the cache on every reload. did is a stable per-account id
  // (did:pkh:eip155:<chain>:<address>), giving correct per-account isolation.
  const did = typeof tcw.did === "string" && tcw.did.length > 0 ? tcw.did : null;
  const space = typeof tcw.spaceId === "string" && tcw.spaceId.length > 0 ? tcw.spaceId : null;
  const id = did ?? space;
  return id ? `tinychat:index:${id}` : null;
}

/**
 * Sync membership check against the local thread-index cache.
 *  - `false`: cache is warm and the id is NOT in it → a never-persisted
 *    (brand-new) thread; safe to skip the SQL history read entirely.
 *  - `true`: id is in the cached index.
 *  - `null`: no usable cache → unknown; caller must do the SQL read.
 *
 * Safety: any thread reachable in the UI came from `listThreads`, whose warm
 * path returns exactly this cache — so a persisted, UI-visible thread can
 * never be falsely reported absent. (Persisted ids keep their `__LOCALID_`
 * prefix forever, so the prefix is NOT a usable "unsaved" signal — this
 * membership check is the reliable alternative.)
 */
export function isKnownThreadId(tcw: TinyCloudWeb, id: string): boolean | null {
  const cached = readCache(tcw);
  if (!cached || cached.length === 0) return null;
  return cached.some((s) => s.id === id);
}

/** Coerce a cached summaries blob (`{threads:[...]}` or bare `[...]`). */
function coerceSummaries(raw: unknown): ThreadSummary[] | null {
  if (raw == null) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const arr = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { threads?: unknown }).threads)
      ? ((value as { threads: unknown[] }).threads)
      : null;
  if (!arr) return null;
  return arr
    .filter((s): s is Partial<ThreadSummary> => typeof s === "object" && s !== null)
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: s.id as string,
      title: typeof s.title === "string" ? s.title : DEFAULT_TITLE,
      updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : new Date().toISOString(),
      model: typeof s.model === "string" ? s.model : DEFAULT_MODEL,
    }));
}

// Monotonically increasing counter bumped by every mutator before it touches
// SQL or the cache. listThreads snapshots this before kicking off the background
// revalidate and drops the writeCache if the counter advanced in the meantime —
// preventing a stale SELECT (issued before a delete/rename) from clobbering
// removeCacheEntry's correct post-mutation cache.
let mutationGen = 0;

function readCache(tcw: TinyCloudWeb): ThreadSummary[] | null {
  const key = cacheKey(tcw);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null; // absent → cold (distinct from an empty list)
    return coerceSummaries(raw);
  } catch {
    return null;
  }
}

function writeCache(tcw: TinyCloudWeb, summaries: ThreadSummary[]): void {
  const key = cacheKey(tcw);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ threads: sortSummaries(summaries) }));
  } catch {
    // localStorage full/disabled — the cache is optional, ignore.
  }
}

/** Patch an EXISTING cache. No-op if there's no cache yet (avoid partial lists). */
function patchCacheEntry(tcw: TinyCloudWeb, summary: ThreadSummary): void {
  const cached = readCache(tcw);
  if (!cached) return;
  writeCache(tcw, [...cached.filter((s) => s.id !== summary.id), summary]);
}

function removeCacheEntry(tcw: TinyCloudWeb, id: string): void {
  const cached = readCache(tcw);
  if (!cached) return;
  writeCache(tcw, cached.filter((s) => s.id !== id));
}

/**
 * Drop the local thread-index cache so the next `listThreads` does a cold SQL
 * read. Used after bulk operations (e.g. Claude import) that touch many rows
 * at once — `patchCacheEntry` only knows how to add one summary at a time and
 * we'd rather pay one network round-trip than leave a partial cache.
 */
export function clearThreadIndexCache(tcw: TinyCloudWeb): void {
  // Bump the gen so any in-flight revalidate's writeCache is dropped.
  mutationGen++;
  // A bulk change touched many rows — drop every prefetched doc and force the
  // next list() to re-deliver a fresh baseline.
  historyPrefetch.clear();
  lastDeliveredSig = null;
  const key = cacheKey(tcw);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // localStorage disabled — nothing to clear.
  }
}

// ── Thread-index change subscription (sidebar freshness) ─────────────
//
// The SWR revalidate (and the mutators) update the localStorage cache but the
// rendered sidebar stays stale until the next mount. Subscribers — the runtime
// layer — re-fetch the assistant-ui thread list when a list that DIFFERS from
// what was last delivered to the UI lands. We deep-compare by id+title+
// updatedAt (the only fields the sidebar renders / sorts on) so identical
// revalidates never trigger a needless refetch.

type ThreadIndexListener = (summaries: ThreadSummary[], changed: boolean) => void;

// ── Index sync visibility ────────────────────────────────────────────
//
// The warm-path revalidate is fire-and-forget, so assistant-ui's
// `threads.isLoading` flips false the moment the CACHE paints (<1 frame) and
// the sidebar gets no loading affordance while the real SQL read (~3-7s on
// boot) is in flight. This tiny store tracks that revalidate so the sidebar
// can show its sync shimmer for the duration (via useSyncExternalStore).

let indexSyncing = false;
const syncListeners = new Set<() => void>();

function setIndexSyncing(v: boolean): void {
  if (indexSyncing === v) return;
  indexSyncing = v;
  for (const cb of syncListeners) {
    try {
      cb();
    } catch {
      // listener errors must never break the revalidate path
    }
  }
}

/** Subscribe to index-sync transitions (useSyncExternalStore contract). */
export function subscribeIndexSyncing(cb: () => void): () => void {
  syncListeners.add(cb);
  return () => {
    syncListeners.delete(cb);
  };
}

/** True while the warm-path list revalidate is in flight. */
export function isIndexSyncing(): boolean {
  return indexSyncing;
}
const indexListeners = new Set<ThreadIndexListener>();
// The signature of the list currently rendered in the UI. `null` until the
// first list() return marks one delivered.
let lastDeliveredSig: string | null = null;

function indexSignature(summaries: ThreadSummary[]): string {
  return sortSummaries(summaries)
    .map((s) => `${s.id} ${s.title} ${s.updatedAt}`)
    .join("");
}

/**
 * Subscribe to thread-index settles. The callback fires with the fresh,
 * newest-first summaries whenever a revalidate or mutator lands a list —
 * `changed` says whether it differs from the one last delivered to the UI.
 * (The sidebar reload should be gated on `changed`; the history prefetch must
 * NOT be — on a typical boot the revalidate returns an unchanged list, and
 * prefetch still has to warm it.) Returns an unsubscribe fn.
 */
export function subscribeThreadIndex(cb: ThreadIndexListener): () => void {
  indexListeners.add(cb);
  return () => {
    indexListeners.delete(cb);
  };
}

/**
 * Record the list just handed to the UI (by `listThreads`) as the delivered
 * baseline WITHOUT notifying — there's nothing to refresh, it's already
 * rendered. A later differing revalidate/mutation is what fires listeners.
 */
function markIndexDelivered(summaries: ThreadSummary[]): void {
  lastDeliveredSig = indexSignature(summaries);
}

/** Notify subscribers that a list settled; `changed` = differs from delivered. */
function notifyThreadIndex(summaries: ThreadSummary[]): void {
  const sig = indexSignature(summaries);
  const changed = sig !== lastDeliveredSig;
  lastDeliveredSig = sig;
  const sorted = sortSummaries(summaries);
  for (const cb of indexListeners) {
    try {
      cb(sorted, changed);
    } catch (err) {
      console.warn("[threadStore] thread-index listener failed", err);
    }
  }
}

// ── SQL fetch for the sidebar ────────────────────────────────────────

/** Freshest summaries from SQL: one SELECT, rows mapped from cell-arrays. */
async function fetchFromSql(tcw: TinyCloudWeb): Promise<ThreadSummary[]> {
  await ensureSchema(tcw);
  const res = await store(tcw).query(
    "SELECT id, title, model, updated_at FROM threads ORDER BY updated_at DESC",
  );
  if (!res.ok) throw new SqlOpError(res.error, "fetchFromSql");
  return res.data.rows.map((row) => ({
    id: cellStr(row, 0, ""),
    title: cellStr(row, 1, DEFAULT_TITLE),
    model: cellStr(row, 2, DEFAULT_MODEL),
    updatedAt: cellStr(row, 3, new Date().toISOString()),
  }));
}

/**
 * List thread summaries, newest first.
 *
 * Stale-while-revalidate: if a local cache exists, return it IMMEDIATELY and
 * refresh in the background. Cold (no cache): ensure the schema, read from SQL,
 * then cache. Never throws — any error (including AUTH_UNAUTHORIZED) is logged
 * and the cached value (or `[]`) is returned.
 */
export async function listThreads(tcw: TinyCloudWeb): Promise<ThreadSummary[]> {
  const cached = readCache(tcw);
  // Only treat a NON-EMPTY cache as a valid instant paint. An empty cached array
  // (e.g. written transiently before threads loaded, or after a failed read)
  // falls through to the cold path so it self-heals instead of showing a blank
  // sidebar indefinitely.
  if (cached && cached.length > 0) {
    // The cached list is what the UI renders right now — it's the baseline a
    // differing revalidate is compared against.
    markIndexDelivered(cached);
    const startGen = mutationGen;
    setIndexSyncing(true);
    void coldLoad(tcw)
      .then((fresh) => {
        // Drop a revalidate whose SELECT was in flight when a mutation happened
        // — otherwise it would resurrect deleted/renamed rows by overwriting
        // the cache mutators have already corrected.
        if (mutationGen !== startGen) return;
        writeCache(tcw, fresh);
        // Converge the sidebar: notify only if the fresh list differs from
        // what's rendered (requirement #2). This is the boot-time refresh.
        notifyThreadIndex(fresh);
      })
      .catch((err) => console.warn("[threadStore] background revalidation failed", err))
      .finally(() => setIndexSyncing(false));
    return cached;
  }
  // Cold load — no usable local cache. Pay the network once, then cache.
  const startGen = mutationGen;
  const fresh = await coldLoad(tcw);
  if (mutationGen === startGen) writeCache(tcw, fresh);
  // The cold result IS what the UI renders — mark it delivered FIRST so the
  // notify carries changed=false (no sidebar reload), then notify so the
  // prefetch queue still warms the cold-loaded list.
  markIndexDelivered(fresh);
  notifyThreadIndex(fresh);
  return fresh;
}

/**
 * The cold-path read used by both the first load and the background revalidate.
 * Pure SQL: ensure the schema then read summaries. Never throws — logs and
 * falls back to the cache (or `[]`).
 */
async function coldLoad(tcw: TinyCloudWeb): Promise<ThreadSummary[]> {
  try {
    await ensureSchema(tcw);
    return await fetchFromSql(tcw);
  } catch (err) {
    if (authUnauthorized(err)) {
      console.warn(
        "[threadStore] SQL unauthorized — sign in again to get the tinycloud.sql capability",
        err,
      );
    } else {
      console.error("[threadStore] listThreads cold load failed:", err);
    }
    return readCache(tcw) ?? [];
  }
}

// ── Mutations ────────────────────────────────────────────────────────

/**
 * Create an in-memory thread doc. Does NOT write — empty threads never hit
 * storage. The row is created lazily by appendMessage on the first message
 * (runtime.tsx only calls this as a fallback inside appendMessage).
 */
export async function createThread(
  tcw: TinyCloudWeb,
  id: string,
  model: string = DEFAULT_MODEL,
): Promise<ThreadDoc> {
  mutationGen++;
  void tcw;
  const now = new Date().toISOString();
  return {
    id,
    title: DEFAULT_TITLE,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function firstTextOf(item: StoredMessageItem): string {
  const parts = item.message?.content ?? [];
  for (const part of parts) {
    if (part && (part as { type?: string }).type === "text") {
      const text = (part as { text?: string }).text;
      if (typeof text === "string" && text.trim().length > 0) return text.trim();
    }
  }
  return "";
}

/**
 * Append one finalized message item. Upserts the thread row and inserts the
 * message at the next position — both in a single batch, with the position
 * computed server-side via a subquery (no read round-trip, race-safe).
 */
export async function appendMessage(
  tcw: TinyCloudWeb,
  id: string,
  item: StoredMessageItem,
): Promise<void> {
  mutationGen++;
  await ensureSchema(tcw);

  // Read the current title (to know whether to derive one) and existing model.
  const head = await store(tcw).query(
    "SELECT title, model FROM threads WHERE id = ?",
    [id],
  );
  if (!head.ok) throw new SqlOpError(head.error, "appendMessage(head)");
  const exists = head.data.rows.length > 0;
  const currentTitle = exists ? cellStr(head.data.rows[0], 0, DEFAULT_TITLE) : DEFAULT_TITLE;
  const currentModel = exists ? cellStr(head.data.rows[0], 1, DEFAULT_MODEL) : DEFAULT_MODEL;

  // Derive a title from the first user message while still default.
  let title = currentTitle;
  if (title === DEFAULT_TITLE && item.message?.role === "user") {
    const text = firstTextOf(item);
    if (text) title = text.slice(0, 60);
  }

  const now = new Date().toISOString();
  const payload = JSON.stringify(item);

  const res = await store(tcw).batch([
    {
      sql: `INSERT INTO threads (id, title, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              model = excluded.model,
              updated_at = excluded.updated_at`,
      params: [id, title, currentModel, now, now],
    },
    {
      sql: `INSERT INTO messages (thread_id, position, payload, created_at)
            VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM messages WHERE thread_id = ?), ?, ?)`,
      params: [id, id, payload, now],
    },
  ]);
  if (!res.ok) throw new SqlOpError(res.error, "appendMessage(batch)");

  patchCacheEntry(tcw, { id, title, updatedAt: now, model: currentModel });
  // The thread's stored messages changed — drop any prefetched doc so a later
  // open re-reads. And the list ordering/title may have changed: converge the
  // sidebar (the runtime gates this behind "no stream running").
  historyPrefetch.invalidate(id);
  notifyThreadIndex(readCache(tcw) ?? []);
}

/** Default model for imported (non-native) conversations — see spec §8. Must be
 * an offered picker model (backend PICKER_MODELS). */
export const IMPORT_DEFAULT_MODEL = "phala/gpt-oss-20b";

/**
 * Write one normalized Claude conversation as a thread row + ordered message
 * rows in a single signed batch. Idempotent — re-importing the same id clean-
 * replaces its messages and updates the row's title/model/timestamps (no
 * `(thread_id, position)` PK collision). Preserves the conversation's
 * original `createdAt`/`updatedAt` so the sidebar sorts by the original
 * Claude date, not import time.
 *
 * The caller (the import dialog) is responsible for building the items via
 * `claudeImport.toStoredItem`.
 */
export async function importThread(
  tcw: TinyCloudWeb,
  conv: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    model?: string;
    items: StoredMessageItem[];
  },
): Promise<void> {
  mutationGen++;
  await ensureSchema(tcw);

  const model = conv.model ?? IMPORT_DEFAULT_MODEL;

  const stmts: { sql: string; params: (string | number)[] }[] = [
    { sql: "DELETE FROM messages WHERE thread_id = ?", params: [conv.id] },
    {
      sql: `INSERT INTO threads (id, title, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              model = excluded.model,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at`,
      params: [conv.id, conv.title, model, conv.createdAt, conv.updatedAt],
    },
  ];

  conv.items.forEach((item, position) => {
    const messageCreatedAt = (item.message as { createdAt?: unknown })?.createdAt;
    const rowCreatedAt =
      typeof messageCreatedAt === "string" && messageCreatedAt.length > 0
        ? messageCreatedAt
        : conv.createdAt;
    stmts.push({
      sql: `INSERT INTO messages (thread_id, position, payload, created_at)
            VALUES (?, ?, ?, ?)`,
      params: [conv.id, position, JSON.stringify(item), rowCreatedAt],
    });
  });

  const res = await store(tcw).batch(stmts);
  if (!res.ok) throw new SqlOpError(res.error, "importThread");

  patchCacheEntry(tcw, {
    id: conv.id,
    title: conv.title,
    updatedAt: conv.updatedAt,
    model,
  });
  historyPrefetch.invalidate(conv.id);
  notifyThreadIndex(readCache(tcw) ?? []);
}

/** Set/rename a thread title. No-op effect if the row doesn't exist (fine). */
export async function setThreadTitle(
  tcw: TinyCloudWeb,
  id: string,
  title: string,
): Promise<void> {
  mutationGen++;
  await ensureSchema(tcw);
  const now = new Date().toISOString();
  const res = await store(tcw).execute(
    "UPDATE threads SET title = ?, updated_at = ? WHERE id = ?",
    [title, now, id],
  );
  if (!res.ok) throw new SqlOpError(res.error, "setThreadTitle");
  const cached = readCache(tcw);
  if (cached) {
    const prior = cached.find((s) => s.id === id);
    patchCacheEntry(tcw, { id, title, updatedAt: now, model: prior?.model ?? DEFAULT_MODEL });
  }
  // The prefetched doc carries the old title — evict it. Converge the sidebar.
  historyPrefetch.invalidate(id);
  notifyThreadIndex(readCache(tcw) ?? []);
}

export const renameThread = setThreadTitle;

/** Persist the per-thread model selection. */
export async function setThreadModel(
  tcw: TinyCloudWeb,
  id: string,
  model: string,
): Promise<void> {
  mutationGen++;
  await ensureSchema(tcw);
  const now = new Date().toISOString();
  const res = await store(tcw).execute(
    "UPDATE threads SET model = ?, updated_at = ? WHERE id = ?",
    [model, now, id],
  );
  if (!res.ok) throw new SqlOpError(res.error, "setThreadModel");
  // The summary cache doesn't carry the title here; patch only updatedAt+model
  // against the existing cached entry if present.
  const cached = readCache(tcw);
  if (cached) {
    const prior = cached.find((s) => s.id === id);
    patchCacheEntry(tcw, {
      id,
      title: prior?.title ?? DEFAULT_TITLE,
      updatedAt: now,
      model,
    });
  }
  historyPrefetch.invalidate(id);
  notifyThreadIndex(readCache(tcw) ?? []);
}

/** Delete a thread and its messages. */
export async function deleteThread(tcw: TinyCloudWeb, id: string): Promise<void> {
  // Bump BEFORE SQL: any listThreads() revalidate already in flight will see
  // a different mutationGen on completion and will not clobber the cache.
  mutationGen++;
  await ensureSchema(tcw);
  const res = await store(tcw).batch([
    { sql: "DELETE FROM messages WHERE thread_id = ?", params: [id] },
    { sql: "DELETE FROM threads WHERE id = ?", params: [id] },
  ]);
  if (!res.ok) throw new SqlOpError(res.error, "deleteThread");
  removeCacheEntry(tcw, id);
  // Evict from the cache AND drop it from the prefetch queue (no point fetching
  // a deleted thread). Converge the sidebar.
  historyPrefetch.invalidate(id);
  notifyThreadIndex(readCache(tcw) ?? []);
}
