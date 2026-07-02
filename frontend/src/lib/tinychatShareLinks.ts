import {
  BrowserWasmBindings,
  type EncodedShareData,
  type TinyCloudWeb,
} from "@tinycloud/web-sdk";
import { ServiceContext, SQLService, type ServiceSession } from "@tinycloud/sdk-core";
import type { ExportedMessageRepositoryItem } from "@assistant-ui/react";

import {
  DEFAULT_MODEL,
  DEFAULT_TITLE,
  THREADS_SQL_DB_NAME,
  getThread,
  type ThreadDoc,
} from "./threadStore";

const SHARE_FORMAT = "tinychat.share";
const SHARE_VERSION = 1;
const SHARE_TOKEN_PREFIX = "tcchat1:";
const STORAGE_KEY = "tinychat:shared-with-me:v1";
const DEFAULT_SHARE_DURATION_DAYS = 7;

export interface TinychatSharePayload {
  format: typeof SHARE_FORMAT;
  version: typeof SHARE_VERSION;
  id: string;
  threadId: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  sql: EncodedShareData;
}

export interface StoredTinychatShare extends TinychatSharePayload {
  acceptedAt: string;
  token: string;
}

export interface CreateTinychatShareOptions {
  durationDays?: number;
}

type SqlRowsResult =
  | { ok: true; data: { rows: unknown[][] } }
  | { ok: false; error: { code?: string; message?: string } };

interface TinychatSqlDb {
  query(sql: string, params?: unknown[]): Promise<SqlRowsResult> | SqlRowsResult;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodePayload(payload: TinychatSharePayload): string {
  return `${SHARE_TOKEN_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

export function decodeTinychatShareToken(token: string): TinychatSharePayload {
  const value = token.trim();
  if (!value.startsWith(SHARE_TOKEN_PREFIX)) {
    throw new Error("Invalid TinyCloud Chat share link");
  }

  const parsed = JSON.parse(base64UrlDecode(value.slice(SHARE_TOKEN_PREFIX.length))) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as TinychatSharePayload).format !== SHARE_FORMAT ||
    (parsed as TinychatSharePayload).version !== SHARE_VERSION ||
    typeof (parsed as TinychatSharePayload).threadId !== "string" ||
    typeof (parsed as TinychatSharePayload).id !== "string" ||
    typeof (parsed as TinychatSharePayload).sql !== "object"
  ) {
    throw new Error("Unsupported TinyCloud Chat share link");
  }

  return parsed as TinychatSharePayload;
}

export function readShareTokenFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash.startsWith("#share=")) return null;
  const value = hash.slice("#share=".length);
  return value ? decodeURIComponent(value) : null;
}

function shareLinkForToken(token: string): string {
  const url = new URL(window.location.href);
  url.pathname = "/chat";
  url.search = "";
  url.hash = `share=${encodeURIComponent(token)}`;
  return url.toString();
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function listStoredTinychatShares(): StoredTinychatShare[] {
  const store = storage();
  if (!store) return [];

  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is StoredTinychatShare =>
        Boolean(
          item &&
            typeof item === "object" &&
            (item as StoredTinychatShare).format === SHARE_FORMAT &&
            typeof (item as StoredTinychatShare).token === "string",
        ),
      )
      .filter((item) => new Date(item.expiresAt).getTime() > Date.now())
      .sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt));
  } catch {
    return [];
  }
}

function writeStoredTinychatShares(shares: StoredTinychatShare[]): void {
  const store = storage();
  if (!store) return;
  store.setItem(STORAGE_KEY, JSON.stringify(shares));
}

function storeTinychatShare(
  token: string,
  payload: TinychatSharePayload,
  storedAt: string,
): StoredTinychatShare {
  if (new Date(payload.expiresAt).getTime() <= Date.now()) {
    throw new Error("This share link has expired");
  }

  const share: StoredTinychatShare = {
    ...payload,
    acceptedAt: storedAt,
    token,
  };
  const existing = listStoredTinychatShares().filter((item) => item.id !== share.id);
  writeStoredTinychatShares([share, ...existing]);
  return share;
}

export function saveTinychatShareToken(token: string): StoredTinychatShare {
  const payload = decodeTinychatShareToken(token);
  return storeTinychatShare(token, payload, new Date().toISOString());
}

export function saveCreatedTinychatShare(
  token: string,
  payload: TinychatSharePayload,
): StoredTinychatShare {
  return storeTinychatShare(token, payload, payload.createdAt);
}

export function findStoredTinychatShareForThread(threadId: string): StoredTinychatShare | null {
  return listStoredTinychatShares().find((share) => share.threadId === threadId) ?? null;
}

function normalizeDurationDays(value?: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return DEFAULT_SHARE_DURATION_DAYS;
  return Math.min(365, Math.max(1, Math.round(value)));
}

function minIsoDate(values: string[]): string {
  const min = Math.min(...values.map((value) => Date.parse(value)).filter(Number.isFinite));
  return new Date(min).toISOString();
}

export async function createTinychatShareLink(
  tcw: TinyCloudWeb,
  threadId: string,
  options: CreateTinychatShareOptions = {},
): Promise<{ link: string; payload: TinychatSharePayload; token: string }> {
  const thread = await getThread(tcw, threadId);
  if (!thread || thread.messages.length === 0) {
    throw new Error("Send a message before sharing this chat");
  }

  const durationDays = normalizeDurationDays(options.durationDays);
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
  const sqlShare = await tcw.sharing.generate({
    path: THREADS_SQL_DB_NAME,
    actions: ["tinycloud.sql/read"],
    expiry: expiresAt,
    description: `TinyCloud Chat: ${thread.title || DEFAULT_TITLE}`,
  });

  if (!sqlShare.ok) {
    throw new Error(sqlShare.error.message);
  }

  const sql = tcw.sharing.decodeLink(sqlShare.data.token) as EncodedShareData;
  const sqlExpiresAt = sqlShare.data.expiresAt?.toISOString() ?? expiresAt.toISOString();
  const payload: TinychatSharePayload = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    id: `${threadId}:${Date.now().toString(36)}`,
    threadId,
    title: thread.title || DEFAULT_TITLE,
    createdAt: new Date().toISOString(),
    expiresAt: minIsoDate([sqlExpiresAt]),
    sql,
  };
  const token = encodePayload(payload);
  saveCreatedTinychatShare(token, payload);

  return {
    link: shareLinkForToken(token),
    payload,
    token,
  };
}

let wasmPromise: Promise<BrowserWasmBindings> | null = null;

async function browserWasm(): Promise<BrowserWasmBindings> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const wasm = new BrowserWasmBindings();
      await wasm.ensureInitialized();
      return wasm;
    })();
  }
  return wasmPromise;
}

function authHeader(value: unknown, fallbackCid: string): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const header = (value as { Authorization?: unknown }).Authorization;
    if (typeof header === "string") return header;
  }
  return `Bearer ${fallbackCid}`;
}

function sessionFromEncodedShare(data: EncodedShareData): ServiceSession {
  const delegation = data.delegation as { authHeader?: unknown; cid: string };
  return {
    delegationHeader: { Authorization: authHeader(delegation.authHeader, delegation.cid) },
    delegationCid: delegation.cid,
    spaceId: data.spaceId,
    verificationMethod: data.keyDid,
    jwk: data.key,
  } as ServiceSession;
}

async function createSharedSql(share: StoredTinychatShare): Promise<TinychatSqlDb> {
  const wasm = await browserWasm();
  const context = new ServiceContext({
    invoke: wasm.invoke,
    fetch: globalThis.fetch.bind(globalThis),
    hosts: [share.sql.host],
  });
  context.setSession(sessionFromEncodedShare(share.sql));
  const sql = new SQLService({});
  sql.initialize(context);
  const scoped = sql as SQLService & { db?: (name: string) => TinychatSqlDb };
  return typeof scoped.db === "function" ? scoped.db(THREADS_SQL_DB_NAME) : (sql as TinychatSqlDb);
}

function cellStr(row: unknown[], idx: number, fallback: string): string {
  const value = row[idx];
  return typeof value === "string" ? value : fallback;
}

async function loadThreadFromSql(db: TinychatSqlDb, id: string): Promise<ThreadDoc | null> {
  const threadRes = await db.query(
    "SELECT id, title, model, created_at, updated_at FROM threads WHERE id = ?",
    [id],
  );
  if (!threadRes.ok) throw new Error(threadRes.error.message ?? "Failed to load shared chat");
  const threadRows = threadRes.data.rows;
  if (threadRows.length === 0) return null;
  const thread = threadRows[0];

  const msgRes = await db.query(
    "SELECT payload FROM messages WHERE thread_id = ? ORDER BY position",
    [id],
  );
  if (!msgRes.ok) throw new Error(msgRes.error.message ?? "Failed to load shared messages");

  const messages: ExportedMessageRepositoryItem[] = [];
  for (const row of msgRes.data.rows) {
    const payload = row[0];
    if (typeof payload !== "string") continue;
    try {
      messages.push(JSON.parse(payload) as ExportedMessageRepositoryItem);
    } catch {
      // Ignore corrupt rows in the shared view, matching the signed-in reader.
    }
  }

  return {
    id: cellStr(thread, 0, id),
    title: cellStr(thread, 1, DEFAULT_TITLE),
    model: cellStr(thread, 2, DEFAULT_MODEL),
    createdAt: cellStr(thread, 3, new Date().toISOString()),
    updatedAt: cellStr(thread, 4, new Date().toISOString()),
    messages,
  };
}

export async function loadSharedThreadFromToken(token: string): Promise<ThreadDoc> {
  const share = saveTinychatShareToken(token);
  const sql = await createSharedSql(share);
  const thread = await loadThreadFromSql(sql, share.threadId);
  if (!thread) throw new Error("This shared chat was not found");
  return thread;
}
