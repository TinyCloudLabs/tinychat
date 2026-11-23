// Gateway-only sealed peer state. Public records never contain portable delegations or pending authority.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PairedPeer, PairPending } from "./lib-adapter";
import { isRecord } from "../guards";
import { sealedGrantStore } from "../secret-store";

export interface CourierPeer {
  handle: string;
  peerDid: string;
  status: "paired";
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
  retire(owner: string, handle: string): Promise<void>;
  listRetired(owner: string): Promise<PairedPeer[]>;
  clearRetired(owner: string, handle: string): Promise<void>;
}
export interface PendingPairing { pending: PairPending; artifactA: string; startedAt: number }
export const COURIER_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{1,128}$/;
const OWNER = /^did:pkh:eip155:1:0x[a-fA-F0-9]{40}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const artifact = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64 * 1024;

export function isCourierPeer(value: unknown): value is CourierPeer {
  return isRecord(value) && typeof value.handle === "string" && COURIER_HANDLE.test(value.handle)
    && typeof value.peerDid === "string" && DID.test(value.peerDid) && value.status === "paired"
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
    && time(pending.expiresAt) && pending.expiresAt > value.startedAt
    && pending.expiresAt <= value.startedAt + 15 * 60_000;
}

interface PeerRecord { v: 1; handle: string; peer?: CourierPeer; runtime?: PairedPeer; pending?: PendingPairing; retired?: boolean }

export function createCourierPeerStore(dir: string, sealKey: Uint8Array): CourierPeerStore {
  if (sealKey.length !== 32) throw new Error("invalid_courier_seal_key");
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
        || (value.retired !== undefined && typeof value.retired !== "boolean")
        || (!value.peer && !value.runtime && !value.pending)) return [];
      return [value as unknown as PeerRecord];
    });
  }
  function save(owner: string, record: PeerRecord) {
    const { ownerId, store } = records(owner);
    store.save(hash(record.handle), ownerId, record);
  }
  return {
    async list(owner) { return entries(owner).flatMap(entry => !entry.retired && entry.peer ? [entry.peer] : []); },
    async put(owner, peer) {
      if (!isCourierPeer(peer)) throw new Error("invalid_courier_peer");
      const current = entries(owner).find(entry => entry.handle === peer.handle && !entry.retired);
      save(owner, { v: 1, handle: peer.handle, peer, ...(current?.runtime ? { runtime: current.runtime } : {}) });
    },
    async remove(owner, handle) {
      if (!COURIER_HANDLE.test(handle)) throw new Error("invalid_courier_handle");
      records(owner).store.remove(hash(handle));
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
    async retire(owner, handle) {
      const current = entries(owner).find(entry => entry.handle === handle);
      if (!current) return;
      const runtime = current.runtime ?? (current.pending ? {
        handle, peerDid: current.pending.pending.peerDid, delegation: current.pending,
        delegationExpiresAt: current.pending.pending.expiresAt,
      } : undefined);
      save(owner, { ...current, ...(runtime ? { runtime } : {}), retired: true });
    },
    async listRetired(owner) { return entries(owner).flatMap(entry => entry.retired && entry.runtime ? [entry.runtime] : []); },
    async clearRetired(owner, handle) {
      if (entries(owner).some(entry => entry.handle === handle && entry.retired)) records(owner).store.remove(hash(handle));
    },
  };
}
