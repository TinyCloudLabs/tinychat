// Per-connector key access (TC-3804, TC-3284). Each connector's credential is sealed to its own key, and sign-in no
// longer opens it: TinyChat asks OpenKey for `decrypt` + `key.create` on that one key, for at most 7 days, the first
// time a save or a foreground read needs it (pattern: bots/historyAuthorization.ts). Background reads never ask; a
// denied read pauses the connector until the owner approves from its row.
//
// Kept here, per owner and connector: when the last approval ends (memory + localStorage, no secret values), so a
// paused row can say whether access ended or was never given; and which connectors a background read found paused.

import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { secretKeyPath } from "@tinycloud/sdk-services";
import { connectWallet } from "@tinyboilerplate/client";

import { APP_NAME } from "../homeSite";
import { openkeyPasskeysSupported } from "../openkeyPasskeys";
import { encryptionNetworkId } from "./encryptionGrant";
import type { ConnectorDescriptor, ConnectorId } from "./types";

/** The longest approval TinyChat asks for: 7 days, less 5 minutes of clock skew. */
export const CONNECTOR_KEY_ACCESS_MAX_MS = 7 * 24 * 60 * 60_000 - 5 * 60_000;

/** The node's code for a read of a key this session has no grant for (missing, lapsed or revoked). */
export const DECRYPT_DENIED = "DECRYPT_DENIED";

export const APPROVE_IN_OPENKEY = "Approve in OpenKey";
export const CONNECTOR_KEY_ACCESS_NOTE = "Each approval lasts up to 7 days.";

type Connector = Pick<ConnectorDescriptor, "id" | "name" | "secretName" | "secretScope">;
type AccessTcw = Pick<TinyCloudWeb, "session" | "hasPermissions" | "setRuntimePermissionSigner" | "requestPermissions">;

/** What OpenKey shows for one connector's approval. */
export function connectorKeyAccessPurpose(d: Pick<ConnectorDescriptor, "id" | "name">): string {
  return d.id === "google-meet"
    ? `Lets TinyChat use your ${d.name} connection to bring in your meetings. Only this connection, for up to 7 days.`
    : `Lets TinyChat use your ${d.name} key to bring in your meetings. Only this key, for up to 7 days.`;
}

/** A save refused because the owner didn't approve. */
export function connectorNotConnectedMessage(d: Pick<ConnectorDescriptor, "name">): string {
  return `${d.name} isn't connected. TinyChat needs your approval in OpenKey to use it. Nothing was saved.`;
}

/** One entry per connector: decrypt and key.create on its own key under the owner's default network, nothing else. */
export function connectorKeyPermissions(address: string, chainId: number, connectors: readonly Connector[]): PermissionEntry[] {
  const network = encryptionNetworkId(address, chainId);
  return connectors.map((d) => ({
    service: "tinycloud.encryption",
    path: `${network}/${secretKeyPath(d.secretName, d.secretScope)}`,
    actions: ["decrypt", "key.create"],
    skipPrefix: true,
    description: connectorKeyAccessPurpose(d),
  }));
}

export function isDecryptDenied(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DECRYPT_DENIED;
}

/** True when this session holds access to every connector's key. Never prompts. */
export function hasConnectorKeyAccess(tcw: Pick<TinyCloudWeb, "session" | "hasPermissions">, connectors: readonly Connector[]): boolean {
  const session = tcw.session();
  if (!session) return false;
  return tcw.hasPermissions(connectorKeyPermissions(session.address, session.chainId, connectors));
}

export type ConnectorKeyAccessResult = "granted" | "declined" | "session-changed" | "session-expired";

export interface ConnectorKeyAccessOptions {
  connect?: typeof connectWallet;
  now?: () => number;
}

/**
 * Foreground only. Asks OpenKey once for every connector in `connectors` that this session can't already use, and
 * resolves "granted" only when this same session now holds all of them. Background code never calls this.
 */
export async function askConnectorKeyAccess(
  tcw: AccessTcw,
  connectors: readonly Connector[],
  options: ConnectorKeyAccessOptions = {},
): Promise<ConnectorKeyAccessResult> {
  const session = tcw.session();
  if (!session) return "session-expired";
  const permissions = connectorKeyPermissions(session.address, session.chainId, connectors);
  const owner = session.address.toLowerCase();
  if (tcw.hasPermissions(permissions)) {
    // Already held (approved in another dialog or row): the paused rows can try again.
    for (const d of connectors) pausedKeys.delete(pausedKey(owner, d.id));
    emit();
    return "granted";
  }
  const now = options.now ?? Date.now;
  const { chainId, sessionKey } = session;
  // session() returns fresh snapshots; bind the flow to the owner and session key, not the wrapper object.
  const sameSession = () => {
    const current = tcw.session();
    return current?.address.toLowerCase() === owner && current.chainId === chainId && current.sessionKey === sessionKey;
  };
  const connect = options.connect ?? connectWallet;
  const connected = await connect({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
  if (connected.address.toLowerCase() !== owner || !sameSession()) return "session-changed";
  tcw.setRuntimePermissionSigner({ signMessage: async (message) => (await connected.openkey.signMessage({ message })).signature });
  const sessionEnds = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
  const expiryMs = Math.min(CONNECTOR_KEY_ACCESS_MAX_MS, sessionEnds - now());
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) return "session-expired";
  const result = await tcw.requestPermissions(permissions, { expiryMs });
  if (!result.approved) return "declined";
  if (!sameSession()) return "session-changed";
  if (!tcw.hasPermissions(permissions)) return "declined";
  const endsAt = now() + expiryMs;
  for (const d of connectors) {
    rememberAccessEnd(owner, d.id, endsAt);
    pausedKeys.delete(pausedKey(owner, d.id));
  }
  emit();
  return "granted";
}

/** Foreground only: true when `d`'s key can be used now, after asking OpenKey if needed. A failed ask is logged and refused. */
export async function approveConnectorKeyAccess(
  tcw: AccessTcw,
  d: Connector,
  options?: ConnectorKeyAccessOptions,
): Promise<boolean> {
  try {
    return (await askConnectorKeyAccess(tcw, [d], options)) === "granted";
  } catch (cause) {
    console.error(`OpenKey approval for ${d.id} failed`, cause);
    return false;
  }
}

/** Foreground reads only: a read denied for `d`'s key asks OpenKey once and reads again; otherwise the first result. */
export async function readWithConnectorKeyAccess<R extends { ok: boolean; error?: unknown }>(
  tcw: AccessTcw,
  d: Connector,
  read: () => Promise<R>,
  options?: ConnectorKeyAccessOptions,
): Promise<R> {
  const first = await read();
  if (first.ok || !isDecryptDenied(first.error)) return first;
  if (!(await approveConnectorKeyAccess(tcw, d, options))) return first;
  return read();
}

// ── When access ends, per owner and connector ────────────────────────

const STORAGE_KEY = "tinychat:connector-key-access:v1";
let accessEnds: Record<string, number> | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadAccessEnds(): Record<string, number> {
  if (accessEnds) return accessEnds;
  accessEnds = {};
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value)) accessEnds[key] = value;
      }
    }
  } catch {
    // An unreadable record only means a paused row can't say when access ended.
  }
  return accessEnds;
}

function rememberAccessEnd(owner: string, id: ConnectorId, endsAt: number): void {
  const ends = loadAccessEnds();
  ends[pausedKey(owner, id)] = endsAt;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(ends));
  } catch {
    // Memory still has it for this tab.
  }
}

/** When the owner's last approval for this connector ended, or null when none has ended (or none was given). */
export function connectorKeyAccessEndedAt(owner: string, id: ConnectorId, now = Date.now()): Date | null {
  const endsAt = loadAccessEnds()[pausedKey(owner.toLowerCase(), id)];
  return endsAt !== undefined && endsAt <= now ? new Date(endsAt) : null;
}

// ── Connectors a background read found paused ────────────────────────

const pausedKeys = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function pausedKey(owner: string, id: ConnectorId): string {
  return `${owner}:${id}`;
}

function emit(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** A background read was denied: the connector stays paused until the owner approves from its row. Never prompts. */
export function markConnectorKeyAccessPaused(tcw: Pick<TinyCloudWeb, "session">, id: ConnectorId): void {
  const owner = tcw.session()?.address.toLowerCase();
  if (!owner || pausedKeys.has(pausedKey(owner, id))) return;
  pausedKeys.add(pausedKey(owner, id));
  emit();
}

export function isConnectorKeyAccessPaused(owner: string | null | undefined, id: ConnectorId): boolean {
  return !!owner && pausedKeys.has(pausedKey(owner.toLowerCase(), id));
}

/** The paused row's sentence: access ended on a date, or was never given on this device. */
export function connectorPausedMessage(owner: string, d: Pick<ConnectorDescriptor, "id" | "name">, now = Date.now()): string {
  const endedAt = connectorKeyAccessEndedAt(owner, d.id, now);
  if (!endedAt) return `Paused. Approve TinyChat's access to keep your ${d.name} meetings coming in.`;
  const date = endedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `Paused since ${date}. TinyChat's access to ${d.name} ended.`;
}

export function onConnectorKeyAccessChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes whenever a connector is paused or approved; for useSyncExternalStore. */
export function connectorKeyAccessVersion(): number {
  return version;
}

/** Tests only. */
export function resetConnectorKeyAccessForTests(): void {
  accessEnds = null;
  pausedKeys.clear();
  listeners.clear();
  version = 0;
}
