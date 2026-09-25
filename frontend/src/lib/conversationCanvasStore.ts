import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, getThread, setSetting, type StoredMessageItem } from "./threadStore";
import { normalizeLegacyMessages, normalizeLegacyThread, type ConversationCanvas } from "../chat/canvas/model";

export const CANVAS_SQL_DB_NAME = "xyz.tinycloud.tinychat/canvas";
export const CANVAS_SETTING_KEY = "conversation-canvas-enabled";
export const CANVAS_PROMOTION_PREFIX = "conversation-canvas-promoted:";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS canvas_threads (thread_id TEXT PRIMARY KEY, active_head_id TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS canvas_nodes (thread_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, position_json TEXT, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_documents (thread_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_document_versions (thread_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, version INTEGER NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_document_placements (thread_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL, placement_order INTEGER NOT NULL, before_message_id TEXT, slot TEXT, PRIMARY KEY (thread_id, id))`,
  `CREATE TABLE IF NOT EXISTS canvas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
const PLACEMENT_MIGRATIONS = [
  "ALTER TABLE canvas_document_placements ADD COLUMN before_message_id TEXT",
  "ALTER TABLE canvas_document_placements ADD COLUMN slot TEXT",
];

type LocalCanvas = Map<string, ConversationCanvas>;
const localStores = new WeakMap<TinyCloudWeb, LocalCanvas>();
const remoteCaches = new WeakMap<TinyCloudWeb, LocalCanvas>();
const writeQueues = new WeakMap<TinyCloudWeb, Map<string, Promise<void>>>();
const schemaReady = new WeakSet<object>();

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
  const result = await db(tcw).batch(SCHEMA.map((sql) => ({ sql })));
  if (!result.ok) throw new Error(`Canvas schema: ${result.error.message}`);
  for (const sql of PLACEMENT_MIGRATIONS) { try { await db(tcw).execute(sql); } catch { /* already migrated */ } }
  schemaReady.add(tcw as unknown as object);
}

function cell(row: unknown[], index: number, fallback = ""): string {
  return typeof row[index] === "string" ? row[index] as string : fallback;
}

async function queryRows(tcw: TinyCloudWeb, sql: string, params: string[]): Promise<unknown[][]> {
  const result = await db(tcw).query(sql, params);
  if (!result.ok) throw new Error(`Canvas read: ${result.error.message}`);
  return result.data.rows;
}

function fromRows(threadId: string, head: string | null, nodes: unknown[][], docs: unknown[][], versions: unknown[][], placements: unknown[][]): ConversationCanvas {
  const documents = docs.map((row) => ({ id: cell(row, 0), title: cell(row, 1), createdAt: cell(row, 2), updatedAt: cell(row, 3), versions: [] as ConversationCanvas["documents"][number]["versions"] }));
  for (const row of versions) {
    const doc = documents.find((item) => item.id === cell(row, 1));
    if (!doc) continue;
    doc.versions.push({ id: cell(row, 0), documentId: cell(row, 1), version: Number(row[2]) || 1, markdown: cell(row, 3), createdAt: cell(row, 4) });
  }
  return {
    version: 1,
    threadId,
    activeHeadId: head,
    nodes: nodes.map((row) => ({ id: cell(row, 0), parentId: typeof row[1] === "string" ? row[1] : null, role: cell(row, 2) as "user" | "assistant" | "system", content: cell(row, 3), createdAt: cell(row, 4), position: typeof row[5] === "string" ? JSON.parse(row[5]) : undefined })),
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
  if (!head.ok) throw new Error(`Canvas read: ${head.error.message}`);
  if (!head.data.rows.length) return null;
  const [nodes, docs, versions, placements] = await Promise.all([
    queryRows(tcw, "SELECT id, parent_id, role, content, created_at, position_json FROM canvas_nodes WHERE thread_id = ?", [threadId]),
    queryRows(tcw, "SELECT id, title, created_at, updated_at FROM canvas_documents WHERE thread_id = ?", [threadId]),
    queryRows(tcw, "SELECT id, document_id, version, markdown, created_at FROM canvas_document_versions WHERE thread_id = ?", [threadId]),
    queryRows(tcw, "SELECT id, document_id, version_id, placement_order, before_message_id, slot FROM canvas_document_placements WHERE thread_id = ?", [threadId]),
  ]);
  const canvas = fromRows(threadId, typeof head.data.rows[0][0] === "string" ? head.data.rows[0][0] : null, nodes, docs, versions, placements);
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
        { sql: "DELETE FROM canvas_threads WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_documents WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_document_versions WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "DELETE FROM canvas_document_placements WHERE thread_id = ?", params: [canvas.threadId] },
        { sql: "INSERT INTO canvas_threads (thread_id, active_head_id, updated_at) VALUES (?, ?, ?)", params: [canvas.threadId, canvas.activeHeadId, now] },
      ];
      for (const node of canvas.nodes) statements.push({ sql: "INSERT INTO canvas_nodes (thread_id,id,parent_id,role,content,created_at,position_json) VALUES (?,?,?,?,?,?,?)", params: [canvas.threadId, node.id, node.parentId, node.role, node.content, node.createdAt, node.position ? JSON.stringify(node.position) : null] });
      for (const doc of canvas.documents) {
        statements.push({ sql: "INSERT INTO canvas_documents (thread_id,id,title,created_at,updated_at) VALUES (?,?,?,?,?)", params: [canvas.threadId, doc.id, doc.title, doc.createdAt, doc.updatedAt] });
        for (const version of doc.versions) statements.push({ sql: "INSERT INTO canvas_document_versions (thread_id,id,document_id,version,markdown,created_at) VALUES (?,?,?,?,?,?)", params: [canvas.threadId, version.id, version.documentId, version.version, version.markdown, version.createdAt] });
      }
      for (const placement of canvas.placements) statements.push({ sql: "INSERT INTO canvas_document_placements (thread_id,id,document_id,version_id,placement_order,before_message_id,slot) VALUES (?,?,?,?,?,?,?)", params: [canvas.threadId, placement.id, placement.documentId, placement.versionId, placement.order, placement.beforeMessageId ?? null, placement.slot ?? null] });
      const result = await db(tcw).batch(statements);
      if (!result.ok) throw new Error(`Canvas write: ${result.error.message}`);
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
    await setSetting(tcw, `${CANVAS_PROMOTION_PREFIX}${threadId}`, "false");
    return;
  }
  await enqueueCanvasWrite(tcw, threadId, async () => {
    await ensureSchema(tcw);
    const result = await db(tcw).batch([
      { sql: "DELETE FROM canvas_nodes WHERE thread_id = ?", params: [threadId] },
      { sql: "DELETE FROM canvas_threads WHERE thread_id = ?", params: [threadId] },
      { sql: "DELETE FROM canvas_documents WHERE thread_id = ?", params: [threadId] },
      { sql: "DELETE FROM canvas_document_versions WHERE thread_id = ?", params: [threadId] },
      { sql: "DELETE FROM canvas_document_placements WHERE thread_id = ?", params: [threadId] },
    ]);
    if (!result.ok) throw new Error(`Canvas delete: ${result.error.message}`);
  });
  remoteCache(tcw).delete(threadId);
  await setSetting(tcw, `${CANVAS_PROMOTION_PREFIX}${threadId}`, "false");
}

/** Promote a legacy linear thread once; its existing threads/messages rows remain untouched. */
export async function promoteLegacyThread(tcw: TinyCloudWeb, threadId: string): Promise<ConversationCanvas | null> {
  const existing = await getCanvas(tcw, threadId);
  if (existing) {
    await setCanvasPromoted(tcw, threadId);
    return existing;
  }
  const legacy = await getThread(tcw, threadId);
  if (!legacy) return null;
  const canvas = normalizeLegacyThread(legacy);
  await saveCanvas(tcw, canvas);
  await setCanvasPromoted(tcw, threadId);
  return canvas;
}

export async function isCanvasPromoted(tcw: TinyCloudWeb, threadId: string): Promise<boolean> {
  return (await getSetting(tcw, `${CANVAS_PROMOTION_PREFIX}${threadId}`)) === "true";
}

/** Marker is written only after the initial Canvas promotion commits. */
export async function setCanvasPromoted(tcw: TinyCloudWeb, threadId: string): Promise<void> {
  await setSetting(tcw, `${CANVAS_PROMOTION_PREFIX}${threadId}`, "true");
}

export async function getCanvasEnabled(tcw: TinyCloudWeb): Promise<boolean> {
  const local = localStores.get(tcw);
  if (local) return false;
  await ensureSchema(tcw);
  const result = await db(tcw).query("SELECT value FROM canvas_settings WHERE key = ?", [CANVAS_SETTING_KEY]);
  return result.ok && result.data.rows.length > 0 && cell(result.data.rows[0], 0) === "true";
}

export async function setCanvasEnabled(tcw: TinyCloudWeb, enabled: boolean): Promise<void> {
  const local = localStores.get(tcw);
  if (local) return;
  await ensureSchema(tcw);
  const result = await db(tcw).execute("INSERT INTO canvas_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [CANVAS_SETTING_KEY, String(enabled)]);
  if (!result.ok) throw new Error(`Canvas setting: ${result.error.message}`);
}

export function normalizeLegacyItems(items: readonly StoredMessageItem[], threadId = ""): ConversationCanvas {
  return normalizeLegacyMessages(items, threadId);
}
