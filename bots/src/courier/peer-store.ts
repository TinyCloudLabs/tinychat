// Gateway-only sealed peer state. Public records never contain portable delegations or pending authority.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import type { CourierLibraryStore, PairedPeer, PairPending } from "./lib-adapter";
import { isRecord } from "../guards";
import { sealedGrantStore } from "../secret-store";

export interface CourierPeer {
  handle: string;
  peerDid: string;
  status: "paired" | "expired";
  pairedAt: number;
  delegationExpiresAt: number;
}
export interface CourierPeerStore {
  list(owner: string): Promise<CourierPeer[]>;
  put(owner: string, peer: CourierPeer): Promise<void>;
  remove(owner: string, handle: string): Promise<void>;
  getRuntime(owner: string, handle: string): Promise<PairedPeer | undefined>;
  listRuntime(owner: string): Promise<PairedPeer[]>;
  putRuntime(owner: string, peer: PairedPeer, pairedAt: number): Promise<void>;
  renewRuntime(owner: string, expected: PairedPeer, successor: PairedPeer): Promise<boolean>;
  listPending(owner: string): Promise<PendingPairing[]>;
  getPending(owner: string, handle: string): Promise<PendingPairing | undefined>;
  putPending(owner: string, pending: PendingPairing): Promise<void>;
  finalizePending(owner: string, expected: PendingPairing, peer: PairedPeer): Promise<boolean>;
  retire(owner: string, handle: string): Promise<void>;
  /** Seals an SDK-side attempt that has no local row (e.g. a pending grant that never activated) for cleanup retries. */
  retireReference(owner: string, peer: RetiredCourierPeer): Promise<void>;
  listRetired(owner: string): Promise<RetiredCourierPeer[]>;
  clearRetired(owner: string, handle: string): Promise<void>;
  transaction: CourierLibraryStore["transaction"];
  /** Releases the state-dir writer lock. */
  close(): void;
}
export interface PendingPairing { pending: PairPending; artifactA: string; startedAt: number }
/** Cleanup target: a retired paired peer, or a retired pending row (signed B, no verified C and so no proof). */
export type RetiredCourierPeer = Pick<PairedPeer, "handle" | "peerDid" | "delegation">;
export const COURIER_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{1,128}$/;
const OWNER = /^did:pkh:eip155:1:0x[a-fA-F0-9]{40}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const artifact = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64 * 1024;
const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;

export function isCourierPeer(value: unknown): value is CourierPeer {
  return isRecord(value) && typeof value.handle === "string" && COURIER_HANDLE.test(value.handle)
    && typeof value.peerDid === "string" && DID.test(value.peerDid) && (value.status === "paired" || value.status === "expired")
    && time(value.pairedAt) && time(value.delegationExpiresAt) && value.delegationExpiresAt > value.pairedAt;
}
function isRuntime(value: unknown): value is PairedPeer {
  return isRecord(value) && typeof value.handle === "string" && COURIER_HANDLE.test(value.handle)
    && typeof value.peerDid === "string" && DID.test(value.peerDid)
    && time(value.delegationExpiresAt) && isRecord(value.delegation);
}
function isPending(value: unknown): value is PendingPairing {
  if (!isRecord(value) || !isRecord(value.pending) || !artifact(value.artifactA) || !time(value.startedAt)) return false;
  const pending = value.pending;
  return typeof pending.handle === "string" && COURIER_HANDLE.test(pending.handle)
    && typeof pending.peerDid === "string" && DID.test(pending.peerDid) && artifact(pending.artifactB)
    && typeof pending.pairingId === "string" && pending.pairingId.length > 0 && pending.pairingId.length <= 128
    && time(pending.createdAt) && pending.createdAt === value.startedAt
    && time(pending.expiresAt) && pending.expiresAt > value.startedAt
    && pending.expiresAt <= value.startedAt + 15 * 60_000;
}

function isRetiredReference(value: unknown): value is RetiredCourierPeer {
  if (!isRecord(value) || !isRecord(value.delegation) || !isRecord(value.delegation.pending)) return false;
  const ref = value.delegation.pending;
  return typeof value.handle === "string" && COURIER_HANDLE.test(value.handle) && typeof value.peerDid === "string" && DID.test(value.peerDid)
    && ref.handle === value.handle && ref.peerDid === value.peerDid
    && typeof ref.pairingId === "string" && ref.pairingId.length > 0 && ref.pairingId.length <= 128;
}

interface PeerRecord { v: 1; handle: string; peer?: CourierPeer; runtime?: PairedPeer; pending?: PendingPairing; cleanup?: RetiredCourierPeer; retired?: boolean; used?: Array<{ cid: string; expiresAt: number }> }

/**
 * One gateway per state dir. The check-and-set, used-CID ledger and SDK queues are in-process, so a second writer on the
 * same directory is refused at start rather than allowed to race them. flock is released by the kernel if the process dies.
 */
function lockStateDir(dir: string): number {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = openSync(join(dir, ".writer.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    try {
      if (libc.symbols.flock(lock, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) !== 0) throw new Error("courier_state_locked");
    } finally { libc.close(); }
    return lock;
  } catch (error) {
    closeSync(lock);
    throw error;
  }
}

export function createCourierPeerStore(dir: string, sealKey: Uint8Array, now: () => number = Date.now): CourierPeerStore {
  if (sealKey.length !== 32) throw new Error("invalid_courier_seal_key");
  let lock: number | undefined = lockStateDir(dir);
  const sdkQueues = new Map<string, Promise<void>>();
  function records(owner: string) {
    if (!OWNER.test(owner)) throw new Error("invalid_courier_owner");
    const ownerId = hash(owner.toLowerCase());
    return { ownerId, store: sealedGrantStore(join(dir, ownerId), sealKey) };
  }
  function entries(owner: string): PeerRecord[] {
    const { ownerId, store } = records(owner);
    return store.load().flatMap(entry => {
      const value = entry.record;
      if (entry.botId !== ownerId || !isRecord(value) || value.v !== 1
        || typeof value.handle !== "string" || !COURIER_HANDLE.test(value.handle) || entry.id !== hash(value.handle)
        || (value.peer !== undefined && (!isCourierPeer(value.peer) || value.peer.handle !== value.handle))
        || (value.runtime !== undefined && (!isRuntime(value.runtime) || value.runtime.handle !== value.handle))
        || (value.pending !== undefined && (!isPending(value.pending) || value.pending.pending.handle !== value.handle))
        || (value.cleanup !== undefined && (!isRetiredReference(value.cleanup) || value.cleanup.handle !== value.handle || value.retired !== true))
        || (value.retired !== undefined && typeof value.retired !== "boolean")
        || (!value.peer && !value.runtime && !value.pending && !value.cleanup && !value.used)
        || (value.used !== undefined && (!Array.isArray(value.used) || !value.used.every(item =>
          isRecord(item) && typeof item.cid === "string" && item.cid.length > 0 && item.cid.length <= 256 && time(item.expiresAt))))) return [];
      return [value as unknown as PeerRecord];
    });
  }
  function writable() { if (lock === undefined) throw new Error("courier_state_closed"); }
  function save(owner: string, record: PeerRecord) {
    writable();
    const { ownerId, store } = records(owner);
    const used = record.used ?? entries(owner).find(entry => entry.handle === record.handle)?.used;
    store.save(hash(record.handle), ownerId, { ...record, ...(used ? { used: used.filter(item => item.expiresAt > now()) } : {}) });
  }
  return {
    close() {
      if (lock === undefined) return;
      closeSync(lock);
      lock = undefined;
    },
    async transaction(scope, operation) {
      const owner = scope.ownerDid.toLowerCase();
      if (!OWNER.test(owner) || !DID.test(scope.courierDid) || scope.host !== "https://node.tinycloud.xyz"
        || scope.spaceId.toLowerCase() !== `tinycloud:${owner.slice(4)}:agents`) throw new Error("invalid_courier_scope");
      const binding = JSON.stringify([owner, scope.courierDid, scope.spaceId.toLowerCase(), scope.host]);
      const tenant = hash(binding);
      const sdkDir = join(dir, "sdk", tenant);
      const sdkStore = sealedGrantStore(sdkDir, sealKey);
      const previous = sdkQueues.get(owner) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        let open = true;
        const checkedId = (handle: string) => {
          if (!open || !COURIER_HANDLE.test(handle) || handle === "__proto__") throw new Error("invalid_courier_transaction");
          return hash(handle);
        };
        try {
          return await operation({
            async get(handle) {
              const id = checkedId(handle);
              const entry = sdkStore.load().find(value => value.id === id);
              if (!entry && !existsSync(join(sdkDir, `${id}.json`))) return undefined;
              const value = entry?.record;
              if (entry?.botId !== tenant || !isRecord(value) || value.v !== 1 || value.binding !== binding
                || value.handle !== handle || !isRecord(value.record)) throw new Error("invalid_courier_sdk_seal");
              // SDK state is opaque here; the SDK validates its record, scope and signatures on every use.
              return value.record;
            },
            async save(handle, record) {
              const id = checkedId(handle);
              writable();
              if (record === undefined) sdkStore.remove(id);
              else {
                if (!isRecord(record)) throw new Error("invalid_courier_sdk_record");
                sdkStore.save(id, tenant, { v: 1, binding, handle, record });
              }
            },
          });
        } finally { open = false; }
      });
      const settled = next.then(() => {}, () => {});
      sdkQueues.set(owner, settled);
      try { return await next; } finally { if (sdkQueues.get(owner) === settled) sdkQueues.delete(owner); }
    },
    async list(owner) {
      return entries(owner).flatMap(entry => !entry.retired && entry.peer
        ? [{ ...entry.peer, status: entry.peer.delegationExpiresAt <= now() ? "expired" as const : "paired" as const }] : []);
    },
    async put(owner, peer) {
      if (!isCourierPeer(peer)) throw new Error("invalid_courier_peer");
      const current = entries(owner).find(entry => entry.handle === peer.handle && !entry.retired);
      save(owner, { v: 1, handle: peer.handle, peer, ...(current?.runtime ? { runtime: current.runtime } : {}) });
    },
    async remove(owner, handle) {
      if (!COURIER_HANDLE.test(handle)) throw new Error("invalid_courier_handle");
      const used = entries(owner).find(entry => entry.handle === handle)?.used?.filter(item => item.expiresAt > now());
      if (used?.length) save(owner, { v: 1, handle, used }); else { writable(); records(owner).store.remove(hash(handle)); }
    },
    async getRuntime(owner, handle) {
      return entries(owner).find(entry => entry.handle === handle && !entry.retired)?.runtime;
    },
    async listRuntime(owner) { return entries(owner).flatMap(entry => !entry.retired && entry.runtime ? [entry.runtime] : []); },
    async putRuntime(owner, runtime, pairedAt) {
      if (!isRuntime(runtime)) throw new Error("invalid_courier_runtime");
      const peer: CourierPeer = { handle: runtime.handle, peerDid: runtime.peerDid, status: "paired", pairedAt, delegationExpiresAt: runtime.delegationExpiresAt };
      if (!isCourierPeer(peer)) throw new Error("invalid_courier_peer");
      save(owner, { v: 1, handle: peer.handle, runtime, peer });
    },
    async renewRuntime(owner, expected, successor) {
      const current = entries(owner).find(entry => entry.handle === expected.handle && !entry.retired);
      if (!current?.runtime || !current.peer || JSON.stringify(current.runtime) !== JSON.stringify(expected)) return false;
      if (!isRuntime(successor) || successor.handle !== expected.handle || successor.peerDid !== expected.peerDid
        || successor.delegationExpiresAt <= expected.delegationExpiresAt) throw new Error("invalid_courier_successor");
      const peer = { ...current.peer, delegationExpiresAt: successor.delegationExpiresAt };
      save(owner, { v: 1, handle: successor.handle, runtime: successor, peer });
      return true;
    },
    async listPending(owner) { return entries(owner).flatMap(entry => !entry.retired && entry.pending ? [entry.pending] : []); },
    async getPending(owner, handle) {
      return entries(owner).find(entry => entry.handle === handle && !entry.retired)?.pending;
    },
    async putPending(owner, pending) {
      if (!isPending(pending)) throw new Error("invalid_courier_pending");
      save(owner, { v: 1, handle: pending.pending.handle, pending });
    },
    async finalizePending(owner, expected, runtime) {
      const all = entries(owner);
      const current = all.find(entry => entry.handle === expected.pending.handle && !entry.retired);
      if (!current?.pending || JSON.stringify(current.pending) !== JSON.stringify(expected)
        || current.pending.pending.expiresAt <= now()) return false;
      if (!isRuntime(runtime) || runtime.handle !== expected.pending.handle || runtime.peerDid !== expected.pending.peerDid
        || !runtime.proof || typeof runtime.proof.cid !== "string" || !runtime.proof.cid || runtime.proof.cid.length > 256) throw new Error("invalid_courier_proof");
      if (all.some(entry => entry.used?.some(item => item.cid === runtime.proof.cid && item.expiresAt > now()))) return false;
      const peer: CourierPeer = { handle: runtime.handle, peerDid: runtime.peerDid, status: "paired", pairedAt: expected.startedAt, delegationExpiresAt: runtime.delegationExpiresAt };
      if (!isCourierPeer(peer)) throw new Error("invalid_courier_peer");
      // One durable rename consumes the pending row and records the verified CID together with the active peer.
      save(owner, { v: 1, handle: peer.handle, runtime, peer, used: [...(current.used ?? []), { cid: runtime.proof.cid, expiresAt: runtime.delegationExpiresAt }] });
      return true;
    },
    async retire(owner, handle) {
      const current = entries(owner).find(entry => entry.handle === handle);
      if (current) save(owner, { ...current, retired: true });
    },
    async retireReference(owner, peer) {
      if (!isRetiredReference(peer)) throw new Error("invalid_courier_reference");
      // Never overwrite another live or retired attempt: each cleanup target keeps its own exact reference.
      const current = entries(owner).find(entry => entry.handle === peer.handle);
      if (current && (current.runtime || current.pending || current.cleanup)) throw new Error("courier_reference_in_use");
      save(owner, { v: 1, handle: peer.handle, cleanup: peer, retired: true });
    },
    async listRetired(owner) {
      return entries(owner).flatMap((entry): RetiredCourierPeer[] => !entry.retired ? []
        : entry.runtime ? [entry.runtime]
        : entry.pending ? [{ handle: entry.handle, peerDid: entry.pending.pending.peerDid, delegation: { pending: entry.pending.pending } }]
        : entry.cleanup ? [entry.cleanup]
        : []);
    },
    async clearRetired(owner, handle) {
      const current = entries(owner).find(entry => entry.handle === handle && entry.retired);
      if (!current) return;
      const used = current.used?.filter(item => item.expiresAt > now());
      if (used?.length) save(owner, { v: 1, handle, used }); else { writable(); records(owner).store.remove(hash(handle)); }
    },
  };
}
