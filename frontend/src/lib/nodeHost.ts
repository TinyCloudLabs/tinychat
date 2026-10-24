// Which TinyCloud node the app talks to.
//
// The default is the build's host (VITE_TINYCLOUD_HOST, else the SDK's own default). On the desktop
// app only, the Settings screen can point the app at a node on this computer: exactly
// `http://127.0.0.1:<port>` and nothing else. The address is read ONCE at startup; changing it signs
// out and reloads, so a session always runs against the host it was created on.
//
// Only the Settings screen writes the keys below. Nothing here reads a URL parameter, a deep link or a
// message from another window.
import { appPlatform, type AppPlatform } from "./platform";

export const NODE_HOST_STORAGE_KEY = "xyz.tinycloud.tinychat:node-host";
export const NODE_PIN_KEY_PREFIX = "xyz.tinycloud.tinychat:node-pin:";
/** The hosted node a build without VITE_TINYCLOUD_HOST reports to native sign-in. */
export const HOSTED_DEFAULT_HOST = "https://tee.node.tinycloud.xyz";

/** `did:key` of an Ed25519 key, the form a node reports as its `nodeId`. */
const NODE_DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const LOOPBACK_ADDRESS = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/;

export interface NodeHostConfig {
  /** Hosts to give the SDK. Empty: the SDK's own default. */
  hosts: string[];
  /** The node ID saved for hosts[0] when it is a local node and one has been confirmed. */
  pinnedDid?: string;
}

export interface NodePin {
  nodeId: string;
  /** UTC ISO time of the first confirmed sign-in. */
  firstSeenAt: string;
}

type NodeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface NodeHostDeps {
  env?: { VITE_TINYCLOUD_HOST?: string };
  storage?: NodeStorage | null;
  platform?: AppPlatform;
}

function defaultStorage(): NodeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isNodeDid(value: unknown): value is string {
  return typeof value === "string" && NODE_DID.test(value);
}

/** `http://127.0.0.1:<port>` (port 1-65535, optional trailing slash) in its normalized form, or null. */
export function parseLoopbackNodeAddress(input: string): string | null {
  const match = LOOPBACK_ADDRESS.exec(input.trim().toLowerCase());
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
}

export function isLocalNodeHost(host: string | undefined | null): boolean {
  return typeof host === "string" && parseLoopbackNodeAddress(host) === host;
}

/**
 * The hosts for this run. A saved local address counts only on the desktop app, and only if it is
 * exactly a normalized loopback address; anything else in storage is removed.
 */
export function resolveNodeHosts(deps: NodeHostDeps = {}): NodeHostConfig {
  const env = deps.env ?? import.meta.env;
  const buildHosts = env.VITE_TINYCLOUD_HOST ? [env.VITE_TINYCLOUD_HOST] : [];
  if ((deps.platform ?? appPlatform()) !== "tauri") return { hosts: buildHosts };
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  if (!storage) return { hosts: buildHosts };
  let saved: string | null;
  try {
    saved = storage.getItem(NODE_HOST_STORAGE_KEY);
  } catch {
    return { hosts: buildHosts };
  }
  if (saved === null) return { hosts: buildHosts };
  if (!isLocalNodeHost(saved)) {
    try { storage.removeItem(NODE_HOST_STORAGE_KEY); } catch { /* unreadable storage: the default stays */ }
    return { hosts: buildHosts };
  }
  const pin = readNodePin(saved, storage);
  return { hosts: [saved], ...(pin ? { pinnedDid: pin.nodeId } : {}) };
}

/** Settings only: save a validated local address. Returns false, writing nothing, for any other value. */
export function saveNodeHost(input: string, storage: NodeStorage | null = defaultStorage()): boolean {
  const address = parseLoopbackNodeAddress(input);
  if (!address || !storage) return false;
  try {
    storage.setItem(NODE_HOST_STORAGE_KEY, address);
    return true;
  } catch {
    return false;
  }
}

/** Settings only ("Use the default"). */
export function clearNodeHost(storage: NodeStorage | null = defaultStorage()): void {
  try { storage?.removeItem(NODE_HOST_STORAGE_KEY); } catch { /* nothing to clear */ }
}

const pinKey = (address: string) => `${NODE_PIN_KEY_PREFIX}${address}`;

/** The confirmed node ID for a local address, or null (none saved, or the saved value is not a valid record). */
export function readNodePin(address: string, storage: NodeStorage | null = defaultStorage()): NodePin | null {
  if (!storage || !isLocalNodeHost(address)) return null;
  try {
    const raw = storage.getItem(pinKey(address));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<NodePin> | null;
    if (!parsed || !isNodeDid(parsed.nodeId) || typeof parsed.firstSeenAt !== "string") return null;
    return { nodeId: parsed.nodeId, firstSeenAt: parsed.firstSeenAt };
  } catch {
    return null;
  }
}

/** Written only after a first sign-in against that address succeeded and the user confirmed the node. */
export function writeNodePin(address: string, nodeId: string, now: Date = new Date(), storage: NodeStorage | null = defaultStorage()): boolean {
  if (!storage || !isLocalNodeHost(address) || !isNodeDid(nodeId)) return false;
  try {
    storage.setItem(pinKey(address), JSON.stringify({ nodeId, firstSeenAt: now.toISOString() } satisfies NodePin));
    return true;
  } catch {
    return false;
  }
}

export function clearNodePin(address: string, storage: NodeStorage | null = defaultStorage()): void {
  if (!isLocalNodeHost(address)) return;
  try { storage?.removeItem(pinKey(address)); } catch { /* nothing to clear */ }
}
