import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { ExportedMessageRepositoryItem } from "@assistant-ui/react";

// ── Storage layout ───────────────────────────────────────────────────
//
// One KV doc per thread, stored browser-direct in the user's TinyCloud space:
//   xyz.tinycloud.tinychat/threads/<threadId>
//
// The signed-in session already holds tinycloud.kv capability on its own space
// (no backend delegation). All ops go through `tcw.kv`, which returns a Result
// (never throws). Values come back as a string OR an already-parsed object.

export const APP_ID = "xyz.tinycloud.tinychat";
export const THREADS_PREFIX = `${APP_ID}/threads/`;
export const DEFAULT_TITLE = "New chat";
export const DEFAULT_MODEL = "openai/gpt-5-mini";

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

function threadKey(id: string): string {
  return `${THREADS_PREFIX}${id}`;
}

/** Normalize the string-or-object value returned by kv.get into a ThreadDoc. */
function coerceThreadDoc(raw: unknown): ThreadDoc | null {
  if (raw == null) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Partial<ThreadDoc>;
  if (typeof doc.id !== "string") return null;
  return {
    id: doc.id,
    title: typeof doc.title === "string" ? doc.title : DEFAULT_TITLE,
    model: typeof doc.model === "string" ? doc.model : DEFAULT_MODEL,
    createdAt: typeof doc.createdAt === "string" ? doc.createdAt : new Date().toISOString(),
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : new Date().toISOString(),
    messages: Array.isArray(doc.messages) ? (doc.messages as StoredMessageItem[]) : [],
  };
}

/** Read a single thread doc; returns null if missing or unreadable. */
export async function getThread(tcw: TinyCloudWeb, id: string): Promise<ThreadDoc | null> {
  const result = await tcw.kv.get<unknown>(threadKey(id));
  if (!result.ok) return null;
  return coerceThreadDoc(result.data.data);
}

async function putThread(tcw: TinyCloudWeb, doc: ThreadDoc): Promise<void> {
  const result = await tcw.kv.put(threadKey(doc.id), doc);
  if (!result.ok) {
    throw new Error(`Failed to save thread: ${result.error.message}`);
  }
}

/** List thread summaries, newest first. */
export async function listThreads(tcw: TinyCloudWeb): Promise<ThreadSummary[]> {
  const result = await tcw.kv.list({ prefix: THREADS_PREFIX, removePrefix: true });
  if (!result.ok) return [];

  const ids = result.data.keys
    .map((key) => key.replace(/^\/+/, ""))
    .filter((key) => key.length > 0 && !key.includes("/"));

  // Fetch sequentially: the KV transport drops some responses under high
  // concurrency (a parallel `Promise.all` over many keys loses docs at random),
  // which made the sidebar list unstable and sometimes empty after reload.
  const summaries: ThreadSummary[] = [];
  for (const id of ids) {
    const doc = await getThread(tcw, id);
    if (!doc) continue;
    // Skip message-less docs. New threads are only persisted on their first
    // message (appendMessage creates on demand), so an empty doc is either a
    // legacy orphan or a never-used thread — keep it out of the sidebar.
    if (doc.messages.length === 0) continue;
    summaries.push({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt, model: doc.model });
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

/** Create an empty thread doc. */
export async function createThread(
  tcw: TinyCloudWeb,
  id: string,
  model: string = DEFAULT_MODEL,
): Promise<ThreadDoc> {
  const now = new Date().toISOString();
  const doc: ThreadDoc = {
    id,
    title: DEFAULT_TITLE,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await putThread(tcw, doc);
  return doc;
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

/** Append one finalized message item (read-modify-write). */
export async function appendMessage(
  tcw: TinyCloudWeb,
  id: string,
  item: StoredMessageItem,
): Promise<void> {
  const existing = (await getThread(tcw, id)) ?? (await createThread(tcw, id));

  const next: ThreadDoc = {
    ...existing,
    messages: [...existing.messages, item],
    updatedAt: new Date().toISOString(),
  };

  // Derive a title from the first user message while still default.
  if (next.title === DEFAULT_TITLE && item.message?.role === "user") {
    const text = firstTextOf(item);
    if (text) next.title = text.slice(0, 60);
  }

  await putThread(tcw, next);
}

/** Set/rename a thread title. */
export async function setThreadTitle(
  tcw: TinyCloudWeb,
  id: string,
  title: string,
): Promise<void> {
  const existing = await getThread(tcw, id);
  if (!existing) return;
  await putThread(tcw, { ...existing, title, updatedAt: new Date().toISOString() });
}

export const renameThread = setThreadTitle;

/** Persist the per-thread model selection. */
export async function setThreadModel(
  tcw: TinyCloudWeb,
  id: string,
  model: string,
): Promise<void> {
  const existing = await getThread(tcw, id);
  if (!existing) return;
  await putThread(tcw, { ...existing, model, updatedAt: new Date().toISOString() });
}

/** Delete a thread doc. */
export async function deleteThread(tcw: TinyCloudWeb, id: string): Promise<void> {
  await tcw.kv.delete(threadKey(id));
}
