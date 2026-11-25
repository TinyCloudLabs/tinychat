// Inbox layout 2, read only. No attachment reads, cross-shard SQL or provider actions (TC-3314).
import type { DelegatedAccess } from "@tinycloud/node-sdk";
import { isKvMissingKeyResult } from "@tinyboilerplate/server";

export const INBOX_DB_PREFIX = "xyz.tinycloud.inbox/db/";
export const INBOX_MEDIA_PREFIX = "xyz.tinycloud.inbox/media/";
const STATE = `${INBOX_DB_PREFIX}state`;
const MAIN = `${INBOX_DB_PREFIX}main`;
export const TELEGRAM_TOOL_NAMES = ["list_telegram_chats", "read_telegram_chat"] as const;
export type TelegramTool = typeof TELEGRAM_TOOL_NAMES[number];
export function isTelegramTool(name: string): name is TelegramTool { return TELEGRAM_TOOL_NAMES.some(tool => tool === name); }
export class TelegramReadError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "denied" | "not_ready" | "registry_invalid" | "rejected") { super(`telegram_${code}`); }
}
export interface TelegramPort {
  query(database: string, sql: string, params: Array<string | number | null>): Promise<unknown[][]>;
  get(key: string): Promise<string | null>;
}

export function delegatedTelegramPort(access: () => Promise<DelegatedAccess>): TelegramPort {
  let pending: Promise<DelegatedAccess> | undefined;
  const active = () => pending ??= access();
  return {
    async query(database, sql, params) {
      if (!(database === STATE || /^xyz\.tinycloud\.inbox\/db\/main(?:-[2-9][0-9]*|-1[0-9]+)?$/.test(database)) || !/^SELECT\b/.test(sql) || sql.includes(";")) throw new TelegramReadError("invalid");
      const result = await (await active()).sql.db(database).query<unknown>(sql, params);
      if (!result.ok) {
        const meta = result.error.meta;
        const status = meta && typeof meta === "object" && "status" in meta ? meta.status : undefined;
        if (status === 401 || status === 403) throw new TelegramReadError("rejected");
        throw new Error(result.error.message);
      }
      return result.data.rows;
    },
    async get(key) {
      if (!/^xyz\.tinycloud\.inbox\/media\/[A-Za-z0-9_-]+\/bodies\/[a-f0-9]{64}$/.test(key)) throw new TelegramReadError("invalid");
      const result = await (await active()).kv.get<unknown>(key, { binary: true, maxResponseBytes: 10_000_000 });
      if (isKvMissingKeyResult(result, key)) return null;
      if (!result.ok) {
        const meta = result.error.meta;
        const status = meta && typeof meta === "object" && "status" in meta ? meta.status : undefined;
        if (status === 401 || status === 403) throw new TelegramReadError("rejected");
        throw new Error("telegram_body_unavailable");
      }
      const value = result.data.data;
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return new TextDecoder().decode(value);
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
      return JSON.stringify(value);
    },
  };
}

async function ready(port: TelegramPort): Promise<void> {
  let rows: unknown[][];
  try { rows = await port.query(MAIN, "SELECT source FROM layout_complete WHERE id=1", []); }
  catch (error) { if (error instanceof Error && /no such table: layout_complete/.test(error.message)) throw new TelegramReadError("not_ready"); throw error; }
  if (!rows.length || !["migrated", "empty", "fresh"].includes(String(rows[0][0]))) throw new TelegramReadError("not_ready");
}
async function shards(port: TelegramPort): Promise<string[]> {
  let rows: unknown[][];
  try { rows = await port.query(STATE, "SELECT sequence FROM inbox_shards ORDER BY sequence", []); }
  catch (error) { if (error instanceof Error && /no such table: inbox_shards/.test(error.message)) return [MAIN]; throw error; }
  if (!rows.length) return [MAIN];
  return rows.map((row, i) => {
    if (row[0] !== i + 1) throw new TelegramReadError("registry_invalid");
    return i === 0 ? MAIN : `${MAIN}-${i + 1}`;
  });
}

export async function listTelegramChats(port: TelegramPort, args: { query?: unknown }, denied: ReadonlySet<string>) {
  if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 100)) throw new TelegramReadError("invalid");
  await ready(port);
  const rows = await port.query(STATE, "SELECT c.account_id, c.source_chat_id, c.title FROM chats c JOIN accounts a ON a.id=c.account_id WHERE a.connector='telegram' AND c.kind<>'mail-thread' AND (?='' OR instr(lower(COALESCE(c.title,'')),lower(?))>0) ORDER BY c.updated_at DESC, c.account_id, c.source_chat_id", [args.query ?? "", args.query ?? ""]);
  const chats: Array<{ chat: string; title: string }> = [];
  let remaining = 60 * 1024;
  for (const [account, id, title] of rows) {
    const chat = `${account}:${id}`;
    if (denied.has(chat)) continue;
    const entry = { chat, title: typeof title === "string" ? title.slice(0, 200) : "" };
    remaining -= Buffer.byteLength(JSON.stringify(JSON.stringify(entry))) + 1;
    if (remaining < 0) break;
    chats.push(entry);
  }
  return { chats };
}

interface Cursor { sent_at: number; source_message_id: string }
interface MessageRow { id: string; senderId: string; time: number; key: unknown }
export async function readTelegramChat(port: TelegramPort, args: { chat?: unknown; before?: unknown; limit?: unknown }, denied: ReadonlySet<string>, now = Date.now()) {
  if (typeof args.chat !== "string" || !/^[A-Za-z0-9_-]+:-?[0-9]+$/.test(args.chat) || args.chat.length > 128) throw new TelegramReadError("invalid");
  if (denied.has(args.chat)) throw new TelegramReadError("denied");
  const split = args.chat.indexOf(":");
  const account = args.chat.slice(0, split), chatId = args.chat.slice(split + 1);
  const limit = args.limit === undefined ? 40 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new TelegramReadError("invalid");
  let before: Cursor | undefined;
  if (args.before !== undefined && args.before !== null) {
    if (typeof args.before !== "string" || args.before.length > 200) throw new TelegramReadError("invalid");
    let value: unknown;
    try { value = JSON.parse(args.before); } catch { throw new TelegramReadError("invalid"); }
    if (!value || typeof value !== "object" || !("sent_at" in value) || !Number.isSafeInteger(value.sent_at) || !("source_message_id" in value) || typeof value.source_message_id !== "string" || !/^[0-9]{1,19}$/.test(value.source_message_id)) throw new TelegramReadError("invalid");
    before = value as Cursor;
  }
  await ready(port);
  const chats = await port.query(STATE, "SELECT c.title FROM chats c JOIN accounts a ON a.id=c.account_id WHERE c.account_id=? AND c.source_chat_id=? AND a.connector='telegram' AND c.kind<>'mail-thread' LIMIT 1", [account, chatId]);
  if (!chats.length) throw new TelegramReadError("not_found");
  const databases = await shards(port);
  const rows: MessageRow[] = [];
  for (const database of databases) {
    const params: Array<string | number | null> = [account, chatId, now];
    if (before) params.push(before.sent_at, before.sent_at, before.source_message_id);
    params.push(limit + 1);
    const found = await port.query(database, `SELECT source_message_id, sender_id, sent_at, body_kv_key FROM messages WHERE account_id=? AND source_chat_id=? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?)${before ? " AND (sent_at<? OR (sent_at=? AND CAST(source_message_id AS INTEGER)<CAST(? AS INTEGER)))" : ""} ORDER BY sent_at DESC, CAST(source_message_id AS INTEGER) DESC LIMIT ?`, params);
    for (const [id, senderId, time, key] of found) {
      if (typeof id !== "string" || !/^[0-9]{1,19}$/.test(id) || typeof senderId !== "string" || senderId.length > 64 || !Number.isSafeInteger(time)) throw new TelegramReadError("invalid");
      rows.push({ id, senderId, time: time as number, key });
    }
  }
  rows.sort((a, b) => b.time - a.time || (BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0));
  const selected = rows.slice(0, limit);
  const senders = [...new Set(selected.map(row => row.senderId))];
  const participants = new Map<string, { name: string; observed: number }>();
  if (senders.length) for (const database of databases) {
    const people = await port.query(database, `SELECT source_participant_id, display_name, address, observed_at FROM participants WHERE account_id=? AND source_chat_id=? AND source_participant_id IN (${senders.map(() => "?").join(",")})`, [account, chatId, ...senders]);
    for (const [id, name, address, observed] of people) {
      if (typeof id !== "string" || typeof observed !== "number" || (participants.get(id)?.observed ?? -1) >= observed) continue;
      const label = [typeof name === "string" ? name.slice(0, 200) : "", typeof address === "string" ? `(${address.slice(0, 100)})` : ""].filter(Boolean).join(" ");
      participants.set(id, { name: label || `Telegram user ${id}`, observed });
    }
  }
  const title = typeof chats[0][0] === "string" ? chats[0][0].slice(0, 200) : "";
  const messages: Array<{ id: string; sender: string; time: number; text: string | null; truncated: boolean }> = [];
  // Account for the JSON string inside the HTTP envelope, not just message text. Reserve cursor/headroom bytes.
  let remaining = 60 * 1024 - 512 - Buffer.byteLength(JSON.stringify({ ok: true, text: JSON.stringify({ chat: args.chat, title, messages: [], before: null }) }));
  for (const row of selected) {
    let text: string | null = null;
    if (typeof row.key === "string" && row.key.startsWith(`${INBOX_MEDIA_PREFIX}${account}/bodies/`) && /^[a-f0-9]{64}$/.test(row.key.slice(`${INBOX_MEDIA_PREFIX}${account}/bodies/`.length))) {
      const raw = await port.get(row.key);
      if (raw !== null) {
        const body: unknown = JSON.parse(raw);
        if (body && typeof body === "object" && "text" in body && typeof body.text === "string") text = body.text;
      }
    }
    let truncated = false;
    if (text !== null) {
      const encoded = new TextEncoder().encode(text.slice(0, 2048));
      truncated = text.length > 2048 || encoded.length > 2048;
      if (truncated) {
        const marker = " [message shortened]";
        let end = Math.min(encoded.length, 2048 - marker.length);
        while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
        text = new TextDecoder().decode(encoded.subarray(0, end)) + marker;
      }
    }
    const chatSender = row.senderId.startsWith("chat:") ? row.senderId.slice(5) : undefined;
    const fallback = chatSender === undefined ? `Telegram user ${row.senderId}` : chatSender === chatId && title ? title : `Telegram chat ${chatSender}`;
    const message = { id: row.id, sender: participants.get(row.senderId)?.name ?? fallback, time: row.time, text, truncated };
    const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(message))) - 2 + (messages.length ? 1 : 0);
    if (bytes > remaining) break;
    remaining -= bytes;
    messages.push(message);
  }
  const last = messages.at(-1);
  return { chat: args.chat, title, messages,
    before: rows.length > messages.length && last ? JSON.stringify({ sent_at: last.time, source_message_id: last.id }) : null };
}

/** `deniedNow` is reloaded after the reads finish: a chat denied mid-call is dropped or refused before anything is serialized. */
export async function runTelegramTool(tool: TelegramTool, args: Record<string, unknown>, port: TelegramPort, denied: ReadonlySet<string>, deniedNow: () => Promise<ReadonlySet<string>>): Promise<string> {
  if (tool === "list_telegram_chats") {
    const result = await listTelegramChats(port, args, denied);
    const latest = await deniedNow();
    return JSON.stringify({ chats: result.chats.filter(chat => !latest.has(chat.chat)) });
  }
  const result = await readTelegramChat(port, args, denied);
  if ((await deniedNow()).has(result.chat as string)) throw new TelegramReadError("not_found");
  return JSON.stringify(result);
}
