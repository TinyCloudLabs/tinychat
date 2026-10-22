import {
  BrowserWasmBindings,
  type EncodedShareData,
  type TinyCloudWeb,
} from "@tinycloud/web-sdk";
import { KVService, ServiceContext, SQLService, type ServiceSession } from "@tinycloud/sdk-core";
import type { ExportedMessageRepositoryItem } from "@assistant-ui/react";

import {
  DEFAULT_MODEL,
  DEFAULT_TITLE,
  getThread,
  isLocalThreadStorage,
  type ThreadDoc,
} from "./threadStore";
import { CHAT_SHARING_PAUSED, ChatSharingPausedError } from "./chatSharing";
import { THREADS_SQL_DB_NAME } from "./threadKeys";
import {
  type OwnedShareIndexEntry,
  isShareId,
  isSnapshotPath,
  listShareIndexKeys,
  parseKvValue,
  parseOwnedShareIndexEntry,
  shareIndexKeyFor,
  snapshotKeyFor,
} from "./shareRecords";

const SHARE_FORMAT = "tinychat.share";
const SHARE_VERSION = 1;
const SNAPSHOT_SHARE_VERSION = 2;
const SNAPSHOT_FORMAT = "tinychat.share.snapshot";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_MAX_BYTES = 256 * 1024;
const SHARE_TOKEN_PREFIX = "tcchat1:";
const STORAGE_KEY = "tinychat:shared-with-me:v1";
const DEFAULT_SHARE_DURATION_DAYS = 7;

// Version 1: SQL share created before snapshots. Still accepted so existing links open.
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

// Version 2: a snapshot of one thread at its own KV key, granted read-only.
export interface TinychatSnapshotSharePayload {
  format: typeof SHARE_FORMAT;
  version: typeof SNAPSHOT_SHARE_VERSION;
  id: string;
  threadId: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  key: string;
  kv: EncodedShareData;
}

export type AnyTinychatSharePayload = TinychatSharePayload | TinychatSnapshotSharePayload;

export type StoredTinychatShare = AnyTinychatSharePayload & {
  acceptedAt: string;
  token: string;
};

export interface OwnedTinychatShare {
  shareId: string;
  threadId: string;
  title: string;
  createdAt: string;
  expiresAt: string;
}

export type TinychatShareSnapshotRole = "user" | "assistant" | "system";

export interface TinychatShareSnapshotMessage {
  role: TinychatShareSnapshotRole;
  text: string;
  timestamp: string;
}

export interface TinychatShareSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  title: string;
  createdAt: string;
  messages: TinychatShareSnapshotMessage[];
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

function encodePayload(payload: AnyTinychatSharePayload): string {
  return `${SHARE_TOKEN_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

export function decodeTinychatShareToken(token: string): AnyTinychatSharePayload {
  const value = token.trim();
  if (!value.startsWith(SHARE_TOKEN_PREFIX)) {
    throw new Error("Invalid TinyCloud Chat share link");
  }

  const parsed = JSON.parse(base64UrlDecode(value.slice(SHARE_TOKEN_PREFIX.length))) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Unsupported TinyCloud Chat share link");
  }
  const candidate = parsed as Record<string, unknown>;
  const common =
    candidate.format === SHARE_FORMAT &&
    typeof candidate.threadId === "string" &&
    typeof candidate.id === "string";
  const legacy = common && candidate.version === SHARE_VERSION && typeof candidate.sql === "object";
  const snapshot =
    common &&
    candidate.version === SNAPSHOT_SHARE_VERSION &&
    isShareId(candidate.id) &&
    isSnapshotPath(candidate.key) &&
    typeof candidate.kv === "object" &&
    candidate.kv !== null &&
    // The viewer reads `kv.path` (the path the grant covers), so that path must be a snapshot.
    isSnapshotPath((candidate.kv as { path?: unknown }).path);
  if (!legacy && !snapshot) {
    throw new Error("Unsupported TinyCloud Chat share link");
  }

  return parsed as AnyTinychatSharePayload;
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
  payload: AnyTinychatSharePayload,
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
  payload: AnyTinychatSharePayload,
): StoredTinychatShare {
  return storeTinychatShare(token, payload, payload.createdAt);
}

export function findStoredTinychatShareForThread(threadId: string): StoredTinychatShare | null {
  return listStoredTinychatShares().find((share) => share.threadId === threadId) ?? null;
}

export function normalizeDurationDays(value?: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return DEFAULT_SHARE_DURATION_DAYS;
  return Math.min(365, Math.max(1, Math.round(value)));
}

function minIsoDate(values: string[]): string {
  const min = Math.min(...values.map((value) => Date.parse(value)).filter(Number.isFinite));
  return new Date(min).toISOString();
}

function snapshotTextOf(item: ThreadDoc["messages"][number]): string {
  const parts = item.message?.content ?? [];
  return parts
    .map((part) => (part && (part as { type?: string }).type === "text" ? (part as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .map((text) => text.trim())
    .join("\n\n");
}

function snapshotTimestampOf(item: ThreadDoc["messages"][number], fallback: string): string {
  const raw = (item.message as { createdAt?: unknown }).createdAt;
  const time = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

export function buildShareSnapshot(thread: ThreadDoc, createdAt: string): TinychatShareSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    title: thread.title || DEFAULT_TITLE,
    createdAt,
    messages: thread.messages
      .map((item) => ({
        role: item.message.role,
        text: snapshotTextOf(item),
        timestamp: snapshotTimestampOf(item, createdAt),
      }))
      .filter((entry) => entry.text.length > 0),
  };
}

function serializeSnapshot(snapshot: TinychatShareSnapshot): string {
  const json = JSON.stringify(snapshot);
  if (new TextEncoder().encode(json).byteLength > SNAPSHOT_MAX_BYTES) {
    throw new Error("This chat is too large to share");
  }
  return json;
}

export async function createTinychatShareLink(
  tcw: TinyCloudWeb,
  threadId: string,
  options: CreateTinychatShareOptions = {},
): Promise<{ link: string; payload: TinychatSnapshotSharePayload; token: string }> {
  if (isLocalThreadStorage(tcw)) {
    throw new Error("Sharing is disabled during local validation");
  }
  if (CHAT_SHARING_PAUSED) {
    throw new ChatSharingPausedError();
  }
  const thread = await getThread(tcw, threadId);
  if (!thread || thread.messages.length === 0) {
    throw new Error("Send a message before sharing this chat");
  }

  const durationDays = normalizeDurationDays(options.durationDays);
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
  const title = thread.title || DEFAULT_TITLE;
  const shareId = crypto.randomUUID();
  const key = snapshotKeyFor(shareId);
  const indexKey = shareIndexKeyFor(shareId);

  const createdAt = new Date().toISOString();
  const stored = await tcw.kv.put(key, serializeSnapshot(buildShareSnapshot(thread, createdAt)));
  if (!stored.ok) throw new Error(stored.error.message);

  const grant = await tcw.sharing.generate({
    path: key,
    actions: ["tinycloud.kv/get"],
    expiry: expiresAt,
    description: `TinyCloud Chat: ${title}`,
  });
  if (!grant.ok) {
    await tcw.kv.delete(key);
    throw new Error(grant.error.message);
  }

  const kv = tcw.sharing.decodeLink(grant.data.token) as EncodedShareData;
  const grantExpiresAt = minIsoDate([grant.data.expiresAt?.toISOString() ?? expiresAt.toISOString()]);
  const indexEntry: OwnedShareIndexEntry = {
    shareId,
    threadId,
    title,
    key,
    cid: kv.delegation.cid,
    createdAt,
    expiresAt: grantExpiresAt,
  };
  const indexed = await tcw.kv.put(indexKey, JSON.stringify(indexEntry));
  if (!indexed.ok) {
    await tcw.revokeDelegation(kv.delegation.cid);
    await tcw.kv.delete(key);
    throw new Error(indexed.error.message);
  }

  const payload: TinychatSnapshotSharePayload = {
    format: SHARE_FORMAT,
    version: SNAPSHOT_SHARE_VERSION,
    id: shareId,
    threadId,
    title,
    createdAt,
    expiresAt: grantExpiresAt,
    key,
    kv,
  };
  const token = encodePayload(payload);
  saveCreatedTinychatShare(token, payload);

  return {
    link: shareLinkForToken(token),
    payload,
    token,
  };
}

export async function listOwnedTinychatShares(tcw: TinyCloudWeb): Promise<OwnedTinychatShare[]> {
  // While paused the owner list is empty: no index listing and no lapsed-share cleanup.
  if (CHAT_SHARING_PAUSED) return [];
  const indexKeys = await listShareIndexKeys(tcw);

  const now = Date.now();
  const shares: OwnedTinychatShare[] = [];
  for (const indexKey of indexKeys) {
    const res = await tcw.kv.get(indexKey, { source: "network" });
    if (!res.ok) continue;
    const entry = parseOwnedShareIndexEntry(res.data.data);
    if (!entry) continue;
    if (Date.parse(entry.expiresAt) <= now) {
      // Grant has lapsed; remove the owner's copy of the snapshot and its index entry.
      await tcw.kv.delete(entry.key);
      await tcw.kv.delete(indexKey);
      continue;
    }
    shares.push({
      shareId: entry.shareId,
      threadId: entry.threadId,
      title: entry.title,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    });
  }
  return shares.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeOwnedTinychatShare(tcw: TinyCloudWeb, shareId: string): Promise<void> {
  const indexKey = shareIndexKeyFor(shareId);
  const res = await tcw.kv.get(indexKey, { source: "network" });
  if (!res.ok) throw new Error(res.error.message);
  const entry = parseOwnedShareIndexEntry(res.data.data);
  if (!entry) throw new Error("This share could not be read");

  // Revoke first: if it fails, nothing is deleted and the owner can retry.
  const revoked = await tcw.revokeDelegation(entry.cid);
  if (!revoked.ok) throw new Error(revoked.error.message);
  const deleted = await tcw.kv.delete(entry.key);
  if (!deleted.ok) throw new Error(deleted.error.message);
  const removedIndex = await tcw.kv.delete(indexKey);
  if (!removedIndex.ok) throw new Error(removedIndex.error.message);
  writeStoredTinychatShares(listStoredTinychatShares().filter((share) => share.id !== shareId));
}

export const SHARE_STOP_FAILED_MESSAGE = "Could not stop this share. Try again.";

// Owner UI entry point. Returns a fixed message so SDK error text is never shown to the owner.
export async function stopOwnedTinychatShare(
  tcw: TinyCloudWeb,
  shareId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await revokeOwnedTinychatShare(tcw, shareId);
    return { ok: true };
  } catch {
    return { ok: false, message: SHARE_STOP_FAILED_MESSAGE };
  }
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

async function createSharedSql(share: TinychatSharePayload): Promise<TinychatSqlDb> {
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

async function createSharedKv(share: TinychatSnapshotSharePayload): Promise<KVService> {
  const wasm = await browserWasm();
  const context = new ServiceContext({
    invoke: wasm.invoke,
    fetch: globalThis.fetch.bind(globalThis),
    hosts: [share.kv.host],
  });
  context.setSession(sessionFromEncodedShare(share.kv));
  const kv = new KVService({});
  kv.initialize(context);
  return kv;
}

function isSnapshotMessage(value: unknown): value is TinychatShareSnapshotMessage {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<TinychatShareSnapshotMessage>;
  return (
    (entry.role === "user" || entry.role === "assistant" || entry.role === "system") &&
    typeof entry.text === "string" &&
    typeof entry.timestamp === "string"
  );
}

function parseSnapshot(raw: unknown): TinychatShareSnapshot {
  const value = parseKvValue(raw);
  if (!value || typeof value !== "object") {
    throw new Error("This shared chat could not be read");
  }
  const snapshot = value as Partial<TinychatShareSnapshot>;
  if (
    snapshot.format !== SNAPSHOT_FORMAT ||
    snapshot.version !== SNAPSHOT_VERSION ||
    typeof snapshot.title !== "string" ||
    !Array.isArray(snapshot.messages) ||
    !snapshot.messages.every(isSnapshotMessage) ||
    typeof snapshot.createdAt !== "string"
  ) {
    throw new Error("This shared chat could not be read");
  }
  return snapshot as TinychatShareSnapshot;
}

export function snapshotItems(shareId: string, messages: TinychatShareSnapshotMessage[]): ExportedMessageRepositoryItem[] {
  return messages.map((entry, index) => {
    const id = `${shareId}-${index}`;
    const createdAt = new Date(entry.timestamp);
    const content = [{ type: "text" as const, text: entry.text }];
    const message =
      entry.role === "assistant"
        ? {
            id,
            role: "assistant" as const,
            content,
            createdAt,
            status: { type: "complete" as const, reason: "stop" as const },
            attachments: [],
            metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
          }
        : { id, role: entry.role, content, createdAt, attachments: [], metadata: { custom: {} } };
    return { message, parentId: index === 0 ? null : `${shareId}-${index - 1}` } as ExportedMessageRepositoryItem;
  });
}

export type SnapshotKvOpener = (share: TinychatSnapshotSharePayload) => Promise<KVService>;

function serializedBytes(raw: unknown): number {
  const text = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "");
  return new TextEncoder().encode(text).byteLength;
}

// Reads the path named by `share.kv.path`. `openKv` is injectable for tests.
async function loadSnapshotThread(share: TinychatSnapshotSharePayload, openKv: SnapshotKvOpener): Promise<ThreadDoc> {
  const kv = await openKv(share);
  const res = await kv.get(share.kv.path, { source: "network" });
  if (!res.ok) throw new Error("This shared chat was not found");
  // The SDK download takes no size option, so check the size before parsing.
  if (serializedBytes(res.data.data) > SNAPSHOT_MAX_BYTES) {
    throw new Error("This shared chat could not be read");
  }
  const snapshot = parseSnapshot(res.data.data);
  return {
    id: share.threadId,
    title: snapshot.title,
    model: DEFAULT_MODEL,
    createdAt: share.createdAt,
    updatedAt: share.createdAt,
    messages: snapshotItems(share.id, snapshot.messages),
  };
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

export async function loadSharedThreadFromToken(
  token: string,
  openKv: SnapshotKvOpener = createSharedKv,
): Promise<ThreadDoc> {
  const share = saveTinychatShareToken(token);
  if (share.version === SNAPSHOT_SHARE_VERSION) {
    return loadSnapshotThread(share, openKv);
  }
  const sql = await createSharedSql(share);
  const thread = await loadThreadFromSql(sql, share.threadId);
  if (!thread) throw new Error("This shared chat was not found");
  return thread;
}
