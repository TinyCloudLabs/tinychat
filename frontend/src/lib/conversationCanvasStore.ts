import { reportStorageError, storageSaveMessage, trackStorageWrites } from "./storageStatus";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSettingsByPrefix, getThread, rewriteThreadMessages, setSetting, type StoredMessageItem } from "./threadStore";
import {
  activePathItems,
  alignActivePath,
  branchAt,
  normalizeLegacyMessages,
  normalizeLegacyThread,
  pathFromMessages,
  recordChatMessage,
  type ConversationCanvas,
} from "../chat/canvas/model";

// How Canvas relates to the chat history: the chat's `messages` table stays
// the single linear history every reader uses (the chat view, share links,
// other devices and older app builds). Canvas is an overlay for chats the user
// explicitly switched to it: the other branches, pinned documents and layout.
// Picking a branch rewrites the chat history to that branch, and chat
// messages Canvas has not seen are folded in, so no reader ever sees a stale
// or diverging history.
//
// Writes never replace a whole Canvas from a possibly stale copy: every
// change is a mutation applied to a fresh read and written as upserts behind
// a revision check, so edits from another tab or device are kept. Rows are
// only deleted when the Canvas itself is (placements excepted: unpinning
// removes one, still behind the revision check).

export const CANVAS_SQL_DB_NAME = "xyz.tinycloud.tinychat/canvas";
export const CANVAS_SETTING_PREFIX = "conversation-canvas-";
export const CANVAS_SETTING_KEY = `${CANVAS_SETTING_PREFIX}enabled`;
export const CANVAS_PROMOTION_PREFIX = `${CANVAS_SETTING_PREFIX}promoted:`;

/** The grant Canvas storage needs: the `canvas` entry of manifest.json. */
export const CANVAS_PERMISSIONS: PermissionEntry[] = [
  { service: "tinycloud.sql", space: "applications", path: CANVAS_SQL_DB_NAME, actions: ["read", "write", "schema"], skipPrefix: true },
];

export const CANVAS_ACCESS_MESSAGE =
  "Conversation Canvas needs permission to keep its data in your TinyCloud space. Approve the request, or sign out and back in to grant it.";
export const CANVAS_DISABLED_MESSAGE = "Turn on Conversation Canvas in Settings first.";
export const CANVAS_MISSING_MESSAGE = "This chat uses Conversation Canvas, but its Canvas data could not be found.";

function canvasStorageError(error: { code?: string; message?: string }, context: string): Error {
  reportStorageError(error);
  return new Error(storageSaveMessage(error) ?? `Conversation Canvas ${context}: ${error.message ?? "unknown"}`);
}
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS canvas_threads (thread_id TEXT PRIMARY KEY, active_head_id TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS canvas_revisions (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS canvas_nodes (thread_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, position_json TEXT, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_node_payloads (thread_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_documents (thread_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_document_versions (thread_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, version INTEGER NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_document_placements (thread_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL, placement_order INTEGER NOT NULL, before_message_id TEXT, slot TEXT, PRIMARY KEY (thread_id, id))`,
];

type LocalCanvas = Map<string, ConversationCanvas>;
const localStores = new WeakMap<TinyCloudWeb, LocalCanvas>();
const writeQueues = new WeakMap<TinyCloudWeb, Map<string, Promise<void>>>();
const schemaReady = new WeakSet<object>();
const accessGranted = new WeakSet<object>();

// ── Account state: the opt-in flag and the switched chats ────────────────

export interface CanvasAccountState {
  /** The Settings opt-in. Only this shows the Canvas surface and allows switching a chat. */
  enabled: boolean;
  /** Chats switched to Canvas. Only these ever touch Canvas storage while chatting. */
  promoted: Set<string>;
}

const accountStates = new WeakMap<TinyCloudWeb, Promise<CanvasAccountState>>();

/**
 * One read of the account's Canvas settings (the flag and every switched
 * chat), stored with the cross-device settings so it never creates the Canvas
 * database. Shared by the thread list, Settings and every turn. The thread
 * list awaits it beside listThreads, so a failure surfaces there; a failed
 * read is forgotten so the next call retries.
 */
export function loadCanvasState(tcw: TinyCloudWeb): Promise<CanvasAccountState> {
  let state = accountStates.get(tcw);
  if (!state) {
    const pending = getSettingsByPrefix(tcw, CANVAS_SETTING_PREFIX).then((settings) => ({
      enabled: settings.get(CANVAS_SETTING_KEY) === "true",
      promoted: new Set(
        [...settings]
          .filter(([key, value]) => key.startsWith(CANVAS_PROMOTION_PREFIX) && value === "true")
          .map(([key]) => key.slice(CANVAS_PROMOTION_PREFIX.length)),
      ),
    }));
    state = pending;
    accountStates.set(tcw, pending);
    pending.catch(() => {
      if (accountStates.get(tcw) === pending) accountStates.delete(tcw);
    });
  }
  return state;
}

/** Apply a write to the loaded state; an unloaded state reads the write fresh. */
async function updateLoadedState(tcw: TinyCloudWeb, change: (state: CanvasAccountState) => void): Promise<void> {
  const pending = accountStates.get(tcw);
  if (!pending) return;
  let state: CanvasAccountState;
  try {
    state = await pending;
  } catch {
    return; // Already forgotten; the next load reads the write.
  }
  change(state);
}

export async function getCanvasEnabled(tcw: TinyCloudWeb): Promise<boolean> {
  return (await loadCanvasState(tcw)).enabled;
}

export async function setCanvasEnabled(tcw: TinyCloudWeb, enabled: boolean): Promise<void> {
  if (enabled) await ensureCanvasAccess(tcw);
  await setSetting(tcw, CANVAS_SETTING_KEY, String(enabled));
  await updateLoadedState(tcw, (state) => { state.enabled = enabled; });
}

export async function isCanvasPromoted(tcw: TinyCloudWeb, threadId: string): Promise<boolean> {
  return (await loadCanvasState(tcw)).promoted.has(threadId);
}

/** Marker is written only after the initial Canvas promotion commits. */
export async function setCanvasPromoted(tcw: TinyCloudWeb, threadId: string): Promise<void> {
  await setSetting(tcw, `${CANVAS_PROMOTION_PREFIX}${threadId}`, "true");
  await updateLoadedState(tcw, (state) => { state.promoted.add(threadId); });
}

// ── Access: sessions from before the `canvas` manifest entry ─────────────

/**
 * Sessions signed in before the `canvas` manifest entry shipped (up to 30
 * days) lack the grant. requestPermissions returns at once when the session
 * already covers it and otherwise asks the user, adding the grant to this
 * session on approval. Runs before any Canvas storage use; remembered per
 * session.
 */
export async function ensureCanvasAccess(tcw: TinyCloudWeb): Promise<void> {
  if (localStores.has(tcw) || accessGranted.has(tcw as unknown as object)) return;
  let approved: boolean;
  try {
    approved = (await tcw.requestPermissions(CANVAS_PERMISSIONS)).approved;
  } catch (error) {
    throw new Error(`${CANVAS_ACCESS_MESSAGE} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  if (!approved) throw new Error(CANVAS_ACCESS_MESSAGE);
  accessGranted.add(tcw as unknown as object);
}

// ── Storage ──────────────────────────────────────────────────────────────

const WRITE_ATTEMPTS = 3;

async function enqueueCanvasWrite<T>(
  tcw: TinyCloudWeb,
  threadId: string,
  write: () => Promise<T>,
): Promise<T> {
  let queues = writeQueues.get(tcw);
  if (!queues) {
    queues = new Map();
    writeQueues.set(tcw, queues);
  }
  const previous = queues.get(threadId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  const tail = next.then(() => undefined, () => undefined);
  queues.set(threadId, tail);
  try {
    return await next;
  } finally {
    if (queues.get(threadId) === tail) queues.delete(threadId);
  }
}

// In-tab change notifications, so an open Canvas view re-reads after a send.
const listeners = new Map<string, Set<() => void>>();

export function subscribeCanvasChanges(threadId: string, listener: () => void): () => void {
  const set = listeners.get(threadId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(threadId, set);
  return () => { set.delete(listener); };
}

export function notifyCanvasChanged(threadId: string): void {
  for (const listener of listeners.get(threadId) ?? []) listener();
}

export function sanitizeCanvas(canvas: ConversationCanvas): ConversationCanvas {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const nearestDurable = (id: string | null): string | null => {
    let current = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = byId.get(current);
      if (!node) return current;
      if (!node.transient) return node.id;
      current = node.parentId;
    }
    return null;
  };
  return {
    ...canvas,
    nodes: canvas.nodes.filter((node) => !node.transient).map((node) => ({ ...node, parentId: nearestDurable(node.parentId) })),
    activeHeadId: nearestDurable(canvas.activeHeadId),
  };
}

export function useLocalCanvasStorage(tcw: TinyCloudWeb): TinyCloudWeb {
  if (!localStores.has(tcw)) localStores.set(tcw, new Map());
  return tcw;
}

export function isLocalCanvasStorage(tcw: TinyCloudWeb): boolean { return localStores.has(tcw); }

function db(tcw: TinyCloudWeb) { return trackStorageWrites(tcw.sql.db(CANVAS_SQL_DB_NAME)); }

async function ensureSchema(tcw: TinyCloudWeb): Promise<void> {
  if (schemaReady.has(tcw as unknown as object)) return;
  await ensureCanvasAccess(tcw);
  const database = db(tcw);
  const tables = SCHEMA.map((sql) => sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)?.[1]).filter(
    (table): table is string => table !== undefined,
  );
  const existingResult = await database.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`,
    tables,
  );
  if (!existingResult.ok) throw canvasStorageError(existingResult.error, "storage is unavailable");
  const existingRows = existingResult.data.rows as unknown as unknown[][];
  const existing = new Set(existingRows.map((row) => row[0]).filter((name): name is string => typeof name === "string"));
  for (const sql of SCHEMA) {
    const table = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)?.[1];
    if (!table || existing.has(table)) continue;
    const result = await database.execute(sql);
    if (!result.ok) throw canvasStorageError(result.error, "storage is unavailable");
  }
  schemaReady.add(tcw as unknown as object);
}

function cell(row: unknown[], index: number): string {
  return typeof row[index] === "string" ? row[index] as string : "";
}

function optional(row: unknown[], index: number): string | null {
  return typeof row[index] === "string" ? row[index] as string : null;
}

/**
 * All of one chat's Canvas rows in one round trip: [kind, a, b, c, d, e, f,
 * rowid]. rowid keeps insertion order (upserts keep a row's rowid), which is
 * the order nodes and documents are shown in.
 */
const READ_SQL = [
  "SELECT 'r', CAST(revision AS TEXT), NULL, NULL, NULL, NULL, NULL, rowid FROM canvas_revisions WHERE thread_id = ?",
  "SELECT 'h', active_head_id, NULL, NULL, NULL, NULL, NULL, rowid FROM canvas_threads WHERE thread_id = ?",
  "SELECT 'n', id, parent_id, role, content, created_at, position_json, rowid FROM canvas_nodes WHERE thread_id = ?",
  "SELECT 'p', id, payload, NULL, NULL, NULL, NULL, rowid FROM canvas_node_payloads WHERE thread_id = ?",
  "SELECT 'd', id, title, created_at, updated_at, NULL, NULL, rowid FROM canvas_documents WHERE thread_id = ?",
  "SELECT 'v', id, document_id, CAST(version AS TEXT), markdown, created_at, NULL, rowid FROM canvas_document_versions WHERE thread_id = ?",
  "SELECT 'l', id, document_id, version_id, CAST(placement_order AS TEXT), before_message_id, slot, rowid FROM canvas_document_placements WHERE thread_id = ?",
].join(" UNION ALL ");

interface StoredCanvas {
  canvas: ConversationCanvas | null;
  revision: number;
}
async function readStoredCanvas(tcw: TinyCloudWeb, threadId: string): Promise<StoredCanvas> {
  await ensureSchema(tcw);
  const result = await db(tcw).query(READ_SQL, Array(7).fill(threadId));
  if (!result.ok) throw canvasStorageError(result.error, "could not be read");
  let revision = 0;
  let hasHead = false;
  let head: string | null = null;
  const nodes: ConversationCanvas["nodes"] = [];
  const payloads = new Map<string, string>();
  const documents: ConversationCanvas["documents"] = [];
  const versions: ConversationCanvas["documents"][number]["versions"] = [];
  const placements: ConversationCanvas["placements"] = [];
  const rows = (result.data.rows as unknown[][]).slice().sort((left, right) => Number(left[7]) - Number(right[7]));
  for (const row of rows) {
    switch (row[0]) {
      case "r": revision = Number(row[1]) || 0; break;
      case "h": hasHead = true; head = optional(row, 1); break;
      case "n": nodes.push({
        id: cell(row, 1),
        parentId: optional(row, 2),
        role: cell(row, 3) as "user" | "assistant" | "system",
        content: cell(row, 4),
        createdAt: cell(row, 5),
        ...(typeof row[6] === "string" ? { position: JSON.parse(row[6]) as { x: number; y: number } } : {}),
      }); break;
      case "p": payloads.set(cell(row, 1), cell(row, 2)); break;
      case "d": documents.push({ id: cell(row, 1), title: cell(row, 2), createdAt: cell(row, 3), updatedAt: cell(row, 4), versions: [] }); break;
      case "v": versions.push({ id: cell(row, 1), documentId: cell(row, 2), version: Number(row[3]) || 1, markdown: cell(row, 4), createdAt: cell(row, 5) }); break;
      case "l": placements.push({
        id: cell(row, 1),
        documentId: cell(row, 2),
        versionId: cell(row, 3),
        order: Number(row[4]) || 0,
        beforeMessageId: optional(row, 5),
        slot: row[6] === "before" || row[6] === "after" || row[6] === "next-user" ? row[6] : undefined,
      }); break;
    }
  }
  if (!hasHead) return { canvas: null, revision };
  for (const version of versions.sort((a, b) => a.version - b.version)) {
    documents.find((doc) => doc.id === version.documentId)?.versions.push(version);
  }
  return {
    revision,
    canvas: {
      version: 1,
      threadId,
      activeHeadId: head,
      nodes: nodes.map((node) => payloads.has(node.id) ? { ...node, payload: payloads.get(node.id)! } : node),
      documents,
      placements,
    },
  };
}

type Statement = { sql: string; params: (string | number | null)[] };

const BUMP_REVISION = "INSERT INTO canvas_revisions (thread_id, revision) VALUES (?, 1) ON CONFLICT(thread_id) DO UPDATE SET revision = canvas_revisions.revision + 1";

function nodeStatements(threadId: string, canvas: Pick<ConversationCanvas, "nodes">): Statement[] {
  const statements: Statement[] = [];
  for (const node of canvas.nodes) {
    statements.push({
      sql: `INSERT INTO canvas_nodes (thread_id,id,parent_id,role,content,created_at,position_json) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(thread_id, id) DO UPDATE SET parent_id = excluded.parent_id, role = excluded.role, content = excluded.content, created_at = excluded.created_at, position_json = excluded.position_json`,
      params: [threadId, node.id, node.parentId, node.role, node.content, node.createdAt, node.position ? JSON.stringify(node.position) : null],
    });
    if (node.payload !== undefined) {
      statements.push({
        sql: "INSERT INTO canvas_node_payloads (thread_id,id,payload) VALUES (?,?,?) ON CONFLICT(thread_id, id) DO UPDATE SET payload = excluded.payload",
        params: [threadId, node.id, node.payload],
      });
    }
  }
  return statements;
}

function headStatement(threadId: string, activeHeadId: string | null): Statement {
  return {
    sql: "INSERT INTO canvas_threads (thread_id, active_head_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET active_head_id = excluded.active_head_id, updated_at = excluded.updated_at",
    params: [threadId, activeHeadId, new Date().toISOString()],
  };
}

/** Upserts for a whole Canvas; placements not in it are the only rows removed. */
function writeStatements(canvas: ConversationCanvas): Statement[] {
  const threadId = canvas.threadId;
  const statements: Statement[] = [headStatement(threadId, canvas.activeHeadId), ...nodeStatements(threadId, canvas)];
  for (const doc of canvas.documents) {
    statements.push({
      sql: "INSERT INTO canvas_documents (thread_id,id,title,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(thread_id, id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
      params: [threadId, doc.id, doc.title, doc.createdAt, doc.updatedAt],
    });
    for (const version of doc.versions) {
      statements.push({
        sql: "INSERT INTO canvas_document_versions (thread_id,id,document_id,version,markdown,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(thread_id, id) DO NOTHING",
        params: [threadId, version.id, version.documentId, version.version, version.markdown, version.createdAt],
      });
    }
  }
  const kept = canvas.placements.map((placement) => placement.id);
  statements.push(kept.length === 0
    ? { sql: "DELETE FROM canvas_document_placements WHERE thread_id = ?", params: [threadId] }
    : { sql: `DELETE FROM canvas_document_placements WHERE thread_id = ? AND id NOT IN (${kept.map(() => "?").join(",")})`, params: [threadId, ...kept] });
  for (const placement of canvas.placements) {
    statements.push({
      sql: `INSERT INTO canvas_document_placements (thread_id,id,document_id,version_id,placement_order,before_message_id,slot) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(thread_id, id) DO UPDATE SET document_id = excluded.document_id, version_id = excluded.version_id, placement_order = excluded.placement_order, before_message_id = excluded.before_message_id, slot = excluded.slot`,
      params: [threadId, placement.id, placement.documentId, placement.versionId, placement.order, placement.beforeMessageId ?? null, placement.slot ?? null],
    });
  }
  return statements;
}

/** The current Canvas of a chat, read fresh (there is no cross-call cache to go stale). */
export async function getCanvas(tcw: TinyCloudWeb, threadId: string): Promise<ConversationCanvas | null> {
  const local = localStores.get(tcw);
  if (local) return structuredClone(local.get(threadId) ?? null);
  return (await readStoredCanvas(tcw, threadId)).canvas;
}

/**
 * Change a chat's Canvas: `mutate` runs on a fresh read and the result is
 * written as upserts behind a revision check. Batches are not transactions,
 * so the check is the first statement — on a mismatch (another tab or device
 * wrote meanwhile) it fails before anything is written, and the change is
 * re-applied to a new read.
 */
export async function mutateCanvas(
  tcw: TinyCloudWeb,
  threadId: string,
  mutate: (current: ConversationCanvas | null) => ConversationCanvas | Promise<ConversationCanvas>,
): Promise<ConversationCanvas> {
  const local = localStores.get(tcw);
  if (local) {
    const next = sanitizeCanvas(await mutate(structuredClone(local.get(threadId) ?? null)));
    local.set(threadId, structuredClone(next));
    return next;
  }
  return enqueueCanvasWrite(tcw, threadId, async () => {
    let lastError = "conflict";
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const stored = await readStoredCanvas(tcw, threadId);
      const next = sanitizeCanvas(await mutate(stored.canvas));
      const result = await db(tcw).batch([
        {
          // Inserting a NULL revision fails the batch unless nobody wrote since the read.
          sql: "INSERT INTO canvas_revisions (thread_id, revision) SELECT ?, NULL WHERE COALESCE((SELECT revision FROM canvas_revisions WHERE thread_id = ?), 0) != ?",
          params: [threadId, threadId, stored.revision],
        },
        { sql: BUMP_REVISION, params: [threadId] },
        ...writeStatements(next),
      ]);
      if (result.ok) return next;
      lastError = result.error.message;
      // An unchanged revision means the check passed and a real error stopped the batch.
      const after = await readStoredCanvas(tcw, threadId);
      if (after.revision === stored.revision) throw new Error(`Conversation Canvas could not be saved: ${result.error.message}`);
    }
    throw new Error(`Conversation Canvas kept changing on another device while saving; try again. (${lastError})`);
  });
}

export async function deleteCanvas(tcw: TinyCloudWeb, threadId: string): Promise<void> {
  const local = localStores.get(tcw);
  if (local) {
    local.delete(threadId);
  } else {
    await enqueueCanvasWrite(tcw, threadId, async () => {
      await ensureSchema(tcw);
      const result = await db(tcw).batch([
        { sql: BUMP_REVISION, params: [threadId] },
        { sql: "DELETE FROM canvas_threads WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_nodes WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_node_payloads WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_documents WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_document_versions WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_document_placements WHERE thread_id = ?", params: [threadId] },
      ]);
      if (!result.ok) throw canvasStorageError(result.error, "could not be deleted");
    });
  }
  await setSetting(tcw, `${CANVAS_PROMOTION_PREFIX}${threadId}`, "false");
  await updateLoadedState(tcw, (state) => { state.promoted.delete(threadId); });
}

// ── The chat ↔ Canvas contract ───────────────────────────────────────────

/**
 * What the Canvas view shows. A chat that was never switched gets a preview
 * built from its history; nothing is written. A switched chat first folds in
 * chat messages Canvas has not seen.
 */
export async function openCanvas(
  tcw: TinyCloudWeb,
  threadId: string,
): Promise<{ canvas: ConversationCanvas; promoted: boolean }> {
  const state = await loadCanvasState(tcw);
  const legacy = await getThread(tcw, threadId);
  const path = pathFromMessages(legacy?.messages ?? []);
  if (!state.promoted.has(threadId)) return { canvas: normalizeLegacyMessages(legacy?.messages ?? [], threadId), promoted: false };
  const current = await getCanvas(tcw, threadId);
  if (!current) throw new Error(CANVAS_MISSING_MESSAGE);
  if (!alignActivePath(current, path).changed) return { canvas: current, promoted: true };
  const canvas = await mutateCanvas(tcw, threadId, (fresh) => {
    if (!fresh) throw new Error(CANVAS_MISSING_MESSAGE);
    return alignActivePath(fresh, path).canvas;
  });
  return { canvas, promoted: true };
}

/** Switch a chat to Canvas. Only ever called from the user's explicit confirmation. */
export async function promoteLegacyThread(tcw: TinyCloudWeb, threadId: string): Promise<ConversationCanvas> {
  if (!(await loadCanvasState(tcw)).enabled) throw new Error(CANVAS_DISABLED_MESSAGE);
  const legacy = await getThread(tcw, threadId);
  if (!legacy || legacy.messages.length === 0) throw new Error("Send a message before using Canvas for this chat.");
  const canvas = await mutateCanvas(tcw, threadId, (fresh) =>
    fresh ? alignActivePath(fresh, pathFromMessages(legacy.messages)).canvas : normalizeLegacyThread(legacy));
  await setCanvasPromoted(tcw, threadId);
  return canvas;
}

async function isPromotedForTurn(tcw: TinyCloudWeb, threadId: string): Promise<boolean> {
  try {
    return (await loadCanvasState(tcw)).promoted.has(threadId);
  } catch {
    return false;
  }
}

/**
 * The Canvas for a turn: null for every chat that was not switched (Canvas
 * storage is never touched). Sending never fails because the account-state
 * read failed: the thread list already surfaced that, and the chat history is
 * the source of truth, so the turn proceeds as an ordinary chat. A switched
 * chat whose Canvas cannot be read fails the turn with a clear message,
 * because its pinned documents belong in the request.
 */
export async function promotedCanvasForTurn(tcw: TinyCloudWeb, threadId: string): Promise<ConversationCanvas | null> {
  if (!(await isPromotedForTurn(tcw, threadId))) return null;
  const canvas = await getCanvas(tcw, threadId);
  if (!canvas) throw new Error(CANVAS_MISSING_MESSAGE);
  return canvas;
}

/**
 * Record a just-sent chat message in a switched chat's Canvas, under its chat
 * parent; a no-op for every other chat. Purely additive (an upsert plus a
 * revision bump), so it needs no read and cannot overwrite anything; a parent
 * Canvas has not seen yet is repaired when the chat history is folded in.
 */
export async function recordPromotedChatMessage(
  tcw: TinyCloudWeb,
  threadId: string,
  item: StoredMessageItem,
): Promise<boolean> {
  if (!(await isPromotedForTurn(tcw, threadId))) return false;
  const [message] = pathFromMessages([item]);
  if (!message) return true;
  const parentId = item.parentId ?? null;
  const local = localStores.get(tcw);
  if (local) {
    const current = local.get(threadId);
    if (!current) throw new Error(CANVAS_MISSING_MESSAGE);
    local.set(threadId, recordChatMessage(current, message, parentId));
    return true;
  }
  const node = recordChatMessage({ version: 1, threadId, nodes: [], activeHeadId: null, documents: [], placements: [] }, message, parentId);
  await enqueueCanvasWrite(tcw, threadId, async () => {
    await ensureSchema(tcw);
    const result = await db(tcw).batch([
      { sql: BUMP_REVISION, params: [threadId] },
      ...nodeStatements(threadId, node),
      headStatement(threadId, message.id),
    ]);
    if (!result.ok) throw canvasStorageError(result.error, "could not be saved");
  });
  return true;
}

/**
 * Make `headId` the chat's branch. Inside the chat's write queue it re-reads
 * the chat history and a fresh Canvas, folds in every chat message Canvas has
 * not seen (so switching away keeps them as a branch rather than erasing
 * them), switches the Canvas head, then rewrites the chat history to exactly
 * that branch behind a check that the history did not change meanwhile.
 */
export async function selectCanvasBranch(
  tcw: TinyCloudWeb,
  threadId: string,
  headId: string | null,
): Promise<ConversationCanvas> {
  let selected: ConversationCanvas | null = null;
  await rewriteThreadMessages(tcw, threadId, async (current) => {
    const canvas = await mutateCanvas(tcw, threadId, (fresh) => {
      if (!fresh) throw new Error(CANVAS_MISSING_MESSAGE);
      return branchAt(alignActivePath(fresh, pathFromMessages(current)).canvas, headId);
    });
    selected = canvas;
    return activePathItems(canvas);
  });
  if (!selected) throw new Error(CANVAS_MISSING_MESSAGE);
  return selected;
}
