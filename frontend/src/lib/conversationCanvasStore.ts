import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSettingsByPrefix, getThread, replaceThreadMessages, setSetting, type StoredMessageItem } from "./threadStore";
import {
  activePathItems,
  alignActivePath,
  appendCanvasMessage,
  normalizeLegacyMessages,
  normalizeLegacyThread,
  pathFromMessages,
  type ConversationCanvas,
} from "../chat/canvas/model";

// How Canvas relates to the chat history: the chat's `messages` table stays
// the single linear history every reader uses (the chat view, share links,
// other devices and older app builds). Canvas is an overlay for chats the user
// explicitly switched to it: the other branches, pinned documents and layout.
// Picking a branch rewrites the chat history to that branch, and chat
// messages Canvas has not seen are folded in, so no reader ever sees a stale
// or diverging history.

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

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS canvas_threads (thread_id TEXT PRIMARY KEY, active_head_id TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS canvas_nodes (thread_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, position_json TEXT, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_node_payloads (thread_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_documents (thread_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_document_versions (thread_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, version INTEGER NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_document_placements (thread_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL, placement_order INTEGER NOT NULL, before_message_id TEXT, slot TEXT, PRIMARY KEY (thread_id, id))`,
];

type LocalCanvas = Map<string, ConversationCanvas>;
const localStores = new WeakMap<TinyCloudWeb, LocalCanvas>();
const remoteCaches = new WeakMap<TinyCloudWeb, LocalCanvas>();
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

function remoteCache(tcw: TinyCloudWeb): LocalCanvas {
  let cache = remoteCaches.get(tcw);
  if (!cache) {
    cache = new Map();
    remoteCaches.set(tcw, cache);
  }
  return cache;
}

async function enqueueCanvasWrite(
  tcw: TinyCloudWeb,
  threadId: string,
  write: () => Promise<void>,
): Promise<void> {
  let queues = writeQueues.get(tcw);
  if (!queues) {
    queues = new Map();
    writeQueues.set(tcw, queues);
  }
  const previous = queues.get(threadId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  queues.set(threadId, next);
  try {
    await next;
  } finally {
    if (queues.get(threadId) === next) queues.delete(threadId);
  }
}

export function sanitizeCanvas(canvas: ConversationCanvas): ConversationCanvas {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const nearestDurable = (id: string | null): string | null => {
    let current = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = byId.get(current);
      if (!node) return null;
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

function db(tcw: TinyCloudWeb) { return tcw.sql.db(CANVAS_SQL_DB_NAME); }

async function ensureSchema(tcw: TinyCloudWeb): Promise<void> {
  if (schemaReady.has(tcw as unknown as object)) return;
  await ensureCanvasAccess(tcw);
  const result = await db(tcw).batch(SCHEMA.map((sql) => ({ sql })));
  if (!result.ok) throw new Error(`Conversation Canvas storage is unavailable: ${result.error.message}`);
  schemaReady.add(tcw as unknown as object);
}

function cell(row: unknown[], index: number, fallback = ""): string {
  return typeof row[index] === "string" ? row[index] as string : fallback;
}

async function queryRows(tcw: TinyCloudWeb, sql: string, params: string[]): Promise<unknown[][]> {
  const result = await db(tcw).query(sql, params);
  if (!result.ok) throw new Error(`Conversation Canvas could not be read: ${result.error.message}`);
  return result.data.rows;
}

function fromRows(threadId: string, head: string | null, nodes: unknown[][], payloads: unknown[][], docs: unknown[][], versions: unknown[][], placements: unknown[][]): ConversationCanvas {
  const documents = docs.map((row) => ({ id: cell(row, 0), title: cell(row, 1), createdAt: cell(row, 2), updatedAt: cell(row, 3), versions: [] as ConversationCanvas["documents"][number]["versions"] }));
  for (const row of versions) {
    const doc = documents.find((item) => item.id === cell(row, 1));
    if (!doc) continue;
    doc.versions.push({ id: cell(row, 0), documentId: cell(row, 1), version: Number(row[2]) || 1, markdown: cell(row, 3), createdAt: cell(row, 4) });
  }
  const payloadById = new Map(payloads.filter((row) => typeof row[1] === "string").map((row) => [cell(row, 0), cell(row, 1)]));
  return {
    version: 1,
    threadId,
    activeHeadId: head,
    nodes: nodes.map((row) => {
      const payload = payloadById.get(cell(row, 0));
      return {
        id: cell(row, 0),
        parentId: typeof row[1] === "string" ? row[1] : null,
        role: cell(row, 2) as "user" | "assistant" | "system",
        content: cell(row, 3),
        createdAt: cell(row, 4),
        position: typeof row[5] === "string" ? JSON.parse(row[5]) : undefined,
        ...(payload === undefined ? {} : { payload }),
      };
    }),
    documents,
    placements: placements.map((row) => ({ id: cell(row, 0), documentId: cell(row, 1), versionId: cell(row, 2), order: Number(row[3]) || 0, beforeMessageId: typeof row[4] === "string" ? row[4] : null, slot: row[5] === "before" || row[5] === "after" || row[5] === "next-user" ? row[5] : undefined })),
  };
}

export async function getCanvas(tcw: TinyCloudWeb, threadId: string): Promise<ConversationCanvas | null> {
  const local = localStores.get(tcw);
  if (local) return structuredClone(local.get(threadId) ?? null);
  const cached = remoteCache(tcw).get(threadId);
  if (cached) return structuredClone(cached);
  await ensureSchema(tcw);
  const head = await db(tcw).query("SELECT active_head_id FROM canvas_threads WHERE thread_id = ?", [threadId]);
  if (!head.ok) throw new Error(`Conversation Canvas could not be read: ${head.error.message}`);
  if (!head.data.rows.length) return null;
  const [nodes, payloads, docs, versions, placements] = await Promise.all([
    queryRows(tcw, "SELECT id, parent_id, role, content, created_at, position_json FROM canvas_nodes WHERE thread_id = ?", [threadId]),
    queryRows(tcw, "SELECT id, payload FROM canvas_node_payloads WHERE thread_id = ?", [threadId]),
    queryRows(tcw, "SELECT id, title, created_at, updated_at FROM canvas_documents WHERE thread_id = ?", [threadId]),
    queryRows(tcw, "SELECT id, document_id, version, markdown, created_at FROM canvas_document_versions WHERE thread_id = ?", [threadId]),
    queryRows(tcw, "SELECT id, document_id, version_id, placement_order, before_message_id, slot FROM canvas_document_placements WHERE thread_id = ?", [threadId]),
  ]);
  const canvas = fromRows(threadId, typeof head.data.rows[0][0] === "string" ? head.data.rows[0][0] : null, nodes, payloads, docs, versions, placements);
  remoteCache(tcw).set(threadId, structuredClone(canvas));
  return canvas;
}

export async function saveCanvas(tcw: TinyCloudWeb, canvas: ConversationCanvas): Promise<void> {
  canvas = sanitizeCanvas(canvas);
  const local = localStores.get(tcw);
  if (local) { local.set(canvas.threadId, structuredClone(canvas)); return; }
  const snapshot = structuredClone(canvas);
  const cache = remoteCache(tcw);
  const previous = cache.get(canvas.threadId);
  cache.set(canvas.threadId, snapshot);
  try {
    await enqueueCanvasWrite(tcw, canvas.threadId, async () => {
      await ensureSchema(tcw);
      const now = new Date().toISOString();
      const statements: { sql: string; params: (string | number | null)[] }[] = [
        { sql: "DELETE FROM canvas_nodes WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_node_payloads WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_threads WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_documents WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_document_versions WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_document_placements WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "INSERT INTO canvas_threads (thread_id, active_head_id, updated_at) VALUES (?, ?, ?)", params: [canvas.threadId, canvas.activeHeadId, now] },
      ];
      for (const node of canvas.nodes) {
        statements.push({ sql: "INSERT INTO canvas_nodes (thread_id,id,parent_id,role,content,created_at,position_json) VALUES (?,?,?,?,?,?,?)", params: [canvas.threadId, node.id, node.parentId, node.role, node.content, node.createdAt, node.position ? JSON.stringify(node.position) : null] });
        if (node.payload !== undefined) statements.push({ sql: "INSERT INTO canvas_node_payloads (thread_id,id,payload) VALUES (?,?,?)", params: [canvas.threadId, node.id, node.payload] });
      }
      for (const doc of canvas.documents) {
        statements.push({ sql: "INSERT INTO canvas_documents (thread_id,id,title,created_at,updated_at) VALUES (?,?,?,?,?)", params: [canvas.threadId, doc.id, doc.title, doc.createdAt, doc.updatedAt] });
        for (const version of doc.versions) statements.push({ sql: "INSERT INTO canvas_document_versions (thread_id,id,document_id,version,markdown,created_at) VALUES (?,?,?,?,?,?)", params: [canvas.threadId, version.id, version.documentId, version.version, version.markdown, version.createdAt] });
      }
      for (const placement of canvas.placements) statements.push({ sql: "INSERT INTO canvas_document_placements (thread_id,id,document_id,version_id,placement_order,before_message_id,slot) VALUES (?,?,?,?,?,?,?)", params: [canvas.threadId, placement.id, placement.documentId, placement.versionId, placement.order, placement.beforeMessageId ?? null, placement.slot ?? null] });
      const result = await db(tcw).batch(statements);
      if (!result.ok) throw new Error(`Conversation Canvas could not be saved: ${result.error.message}`);
    });
  } catch (error) {
    if (cache.get(canvas.threadId) === snapshot) {
      if (previous) cache.set(canvas.threadId, previous);
      else cache.delete(canvas.threadId);
    }
    throw error;
  }
}

export async function deleteCanvas(tcw: TinyCloudWeb, threadId: string): Promise<void> {
  const local = localStores.get(tcw);
  if (local) {
    local.delete(threadId);
  } else {
    await enqueueCanvasWrite(tcw, threadId, async () => {
      await ensureSchema(tcw);
      const result = await db(tcw).batch([
        { sql: "DELETE FROM canvas_nodes WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_node_payloads WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_threads WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_documents WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_document_versions WHERE thread_id = ?", params: [threadId] },
        { sql: "DELETE FROM canvas_document_placements WHERE thread_id = ?", params: [threadId] },
      ]);
      if (!result.ok) throw new Error(`Conversation Canvas could not be deleted: ${result.error.message}`);
    });
    remoteCache(tcw).delete(threadId);
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
  const messages = legacy?.messages ?? [];
  if (!state.promoted.has(threadId)) return { canvas: normalizeLegacyMessages(messages, threadId), promoted: false };
  const canvas = await getCanvas(tcw, threadId);
  if (!canvas) throw new Error(CANVAS_MISSING_MESSAGE);
  const aligned = alignActivePath(canvas, pathFromMessages(messages));
  if (aligned.changed) await saveCanvas(tcw, aligned.canvas);
  return { canvas: aligned.canvas, promoted: true };
}

/** Switch a chat to Canvas. Only ever called from the user's explicit confirmation. */
export async function promoteLegacyThread(tcw: TinyCloudWeb, threadId: string): Promise<ConversationCanvas> {
  if (!(await loadCanvasState(tcw)).enabled) throw new Error(CANVAS_DISABLED_MESSAGE);
  const legacy = await getThread(tcw, threadId);
  if (!legacy || legacy.messages.length === 0) throw new Error("Send a message before using Canvas for this chat.");
  const existing = await getCanvas(tcw, threadId);
  const canvas = existing ? alignActivePath(existing, pathFromMessages(legacy.messages)).canvas : normalizeLegacyThread(legacy);
  await saveCanvas(tcw, canvas);
  await setCanvasPromoted(tcw, threadId);
  return canvas;
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
  let state: CanvasAccountState;
  try {
    state = await loadCanvasState(tcw);
  } catch {
    return null;
  }
  if (!state.promoted.has(threadId)) return null;
  const canvas = await getCanvas(tcw, threadId);
  if (!canvas) throw new Error(CANVAS_MISSING_MESSAGE);
  return canvas;
}

/** Record a just-saved chat message in a switched chat's Canvas, under its chat parent. */
export async function appendPromotedCanvasMessage(
  tcw: TinyCloudWeb,
  canvas: ConversationCanvas,
  item: StoredMessageItem,
): Promise<ConversationCanvas> {
  const [message] = pathFromMessages([item]);
  if (!message) return canvas;
  let base = canvas;
  const parentId = item.parentId === undefined ? base.activeHeadId : item.parentId;
  if (parentId !== null && !base.nodes.some((node) => node.id === parentId)) {
    // The chat gained messages Canvas has not seen (e.g. from an older app).
    const legacy = await getThread(tcw, base.threadId);
    base = alignActivePath(base, pathFromMessages(legacy?.messages ?? [])).canvas;
  }
  const next = appendCanvasMessage(base, { ...message, createdAt: message.createdAt ?? new Date().toISOString(), parentId });
  await saveCanvas(tcw, next);
  return next;
}

/**
 * Make `canvas`'s active branch the chat: save the Canvas, then rewrite the
 * chat history to exactly that branch so share links and every other client
 * show the same messages as this chat.
 */
export async function selectCanvasBranch(tcw: TinyCloudWeb, canvas: ConversationCanvas): Promise<void> {
  await saveCanvas(tcw, canvas);
  await replaceThreadMessages(tcw, canvas.threadId, activePathItems(canvas));
}
