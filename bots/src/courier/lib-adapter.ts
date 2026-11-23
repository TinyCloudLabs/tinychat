import { createHash } from "node:crypto";
import * as courier from "@tinycloud/courier";
import { deserializeDelegation, type TinyCloudNode } from "@tinycloud/node-sdk";
import { isRecord } from "../guards";
import { verifyCourierGrant, type CourierGrant } from "./grant-store";
import type { CourierIdentity } from "./identity";

export interface CourierContext {
  identity: CourierIdentity;
  grant: CourierGrant;
  host: string;
  kv: unknown;
}
export interface CourierPeerReference { handle: string; peerDid: string; pairingId: string }
export interface PairPending extends CourierPeerReference { artifactB: string; expiresAt: number; createdAt: number }
export interface PairedPeer {
  handle: string;
  peerDid: string;
  delegation: unknown;
  delegationExpiresAt: number;
  /** Only facts from the verified signed proof; an absent signed timestamp is never invented. */
  proof: { cid: string; issuedAt?: number; notBefore?: number };
}
export interface CourierInbound { threadId: string; messageId: string; intent: "ask" | "inform" | "request" | "task"; text: string; sentAt: number }
export interface CourierReply { inReplyTo: string; idempotencyKey: string }
export interface CourierReceipt { threadId: string; messageId: string }
export interface CourierLibraryScope { ownerDid: string; courierDid: string; spaceId: string; host: string }
/** Opaque SDK state: the sealed store preserves it, while the library validates its authority and scope. */
export interface CourierLibraryTransaction {
  get(handle: string): Promise<unknown>;
  save(handle: string, record: unknown): Promise<void>;
}
export interface CourierLibraryStore {
  transaction<T>(scope: CourierLibraryScope, operation: (tx: CourierLibraryTransaction) => Promise<T>): Promise<T>;
}
interface LibraryContext {
  ownerDid: string;
  courierDid: string;
  host: string;
  node: TinyCloudNode;
  createReader(): Promise<TinyCloudNode>;
  store: CourierLibraryStore;
}
interface LibraryPending extends CourierPeerReference { artifactB: string; createdAt: number; expiresAt: number }
interface LibraryPaired extends CourierPeerReference { delegationCid: string; delegationExpiresAt: number }
interface LibraryApi {
  acceptPairing(ctx: LibraryContext, artifactA: string): Promise<LibraryPending>;
  finalizePairing(ctx: LibraryContext, pending: CourierPeerReference, artifactC: string): Promise<LibraryPaired>;
  unpair(ctx: LibraryContext, peer: CourierPeerReference): Promise<void>;
  listInbound(ctx: LibraryContext, peer: CourierPeerReference): Promise<CourierInbound[]>;
  acknowledgeInbound(ctx: LibraryContext, peer: CourierPeerReference, ids: CourierReceipt[]): Promise<void>;
  sendMessage(ctx: LibraryContext, peer: CourierPeerReference, threadId: string, text: string, reply: CourierReply): Promise<{ messageId: string }>;
}

export class CourierUpdateRequired extends Error {
  readonly code = "courier_update_required";
  constructor() { super("courier_update_required"); }
}
export class RenewalUnavailable extends Error {
  readonly code = "renewal_unavailable";
  constructor() { super("renewal_unavailable"); }
}

/** beta.17 is development-only: missing headless exports refuse, never fall back to unsigned pairing or CLI state. */
function library<K extends keyof LibraryApi>(name: K): LibraryApi[K] {
  // Pinned beta lacks these exports, so a named import cannot link; detect on the namespace at call time.
  const value: unknown = (courier as Record<string, unknown>)[name];
  if (typeof value !== "function") throw new CourierUpdateRequired();
  return value as LibraryApi[K];
}

export async function courierContext(owner: string, grant: CourierGrant, store: CourierLibraryStore): Promise<CourierContext> {
  if (!store || typeof store.transaction !== "function") throw new Error("Courier requires its sealed transaction store");
  const verified = await verifyCourierGrant(owner, grant);
  const value: LibraryContext = {
    ownerDid: owner.toLowerCase(), courierDid: verified.identity.did, host: courier.DEFAULT_HOST,
    node: verified.node, store,
    // No peer grants or process-global Courier state survive into a fresh reader.
    async createReader() { return (await verifyCourierGrant(owner, grant)).node; },
  };
  return { identity: verified.identity, grant, host: courier.DEFAULT_HOST, kv: value };
}

function context(ctx: CourierContext): LibraryContext {
  const value = ctx.kv;
  if (ctx.host !== courier.DEFAULT_HOST || ctx.grant.expiresAt <= Date.now() || !isRecord(value)
    || value.courierDid !== ctx.identity.did || value.host !== ctx.host || typeof value.ownerDid !== "string"
    || !value.node || typeof value.createReader !== "function" || !isRecord(value.store)
    || typeof value.store.transaction !== "function") throw new Error("invalid Courier context");
  return value as unknown as LibraryContext;
}

function reference(peer: PairedPeer): CourierPeerReference {
  const value = peer.delegation;
  const ref = isRecord(value) && isRecord(value.pending) ? value.pending : isRecord(value) ? value.ref : undefined;
  if (!isRecord(ref) || ref.handle !== peer.handle || ref.peerDid !== peer.peerDid
    || typeof ref.pairingId !== "string" || !ref.pairingId) throw new Error("invalid Courier peer reference");
  return { handle: peer.handle, peerDid: peer.peerDid, pairingId: ref.pairingId };
}

async function record(ctx: LibraryContext, ref: CourierPeerReference) {
  const scope: Record<string, string> = { ownerDid: ctx.ownerDid, courierDid: ctx.courierDid, host: ctx.host, spaceId: ctx.node.restorableSession!.spaceId };
  return ctx.store.transaction(scope as unknown as CourierLibraryScope, async tx => {
    const value = await tx.get(ref.handle);
    const stored = isRecord(value) && isRecord(value.scope) ? value.scope : undefined;
    if (!isRecord(value) || value.pairingId !== ref.pairingId || !stored
      || Object.entries(scope).some(([key, field]) => stored[key] !== field)
      || !isRecord(value.peer) || value.peer.handle !== ref.handle || value.peer.courierDid !== ref.peerDid) throw new Error("Courier stored pairing mismatch");
    return value;
  });
}

export async function acceptPairing(ctx: CourierContext, artifactA: string): Promise<PairPending> {
  const accept = library("acceptPairing");
  const pending = await accept(context(ctx), artifactA);
  // The library bounds expiry to 15 minutes from creation and the signed B expiry; never extend it here.
  if (!(pending.expiresAt > Date.now() && pending.expiresAt <= pending.createdAt + 15 * 60_000)) throw new Error("invalid Courier pending pairing");
  return { handle: pending.handle, peerDid: pending.peerDid, pairingId: pending.pairingId, artifactB: pending.artifactB, createdAt: pending.createdAt, expiresAt: pending.expiresAt };
}

/** Signature verification, single-use challenge consumption and durable grant checkpoints are library-owned. */
export async function finalizePairing(ctx: CourierContext, pending: PairPending, artifactC: string): Promise<PairedPeer> {
  const finalize = library("finalizePairing");
  const value = context(ctx);
  const ref = { handle: pending.handle, peerDid: pending.peerDid, pairingId: pending.pairingId };
  const paired = await finalize(value, ref, artifactC);
  const saved = await record(value, paired);
  const peer = saved.peer as Record<string, unknown>;
  if (!isRecord(peer.inbound) || peer.inbound.cid !== paired.delegationCid || typeof peer.inbound.delegation !== "string"
    || paired.delegationExpiresAt <= Date.now() || paired.delegationExpiresAt - Date.now() > 7 * 86_400_000) throw new Error("invalid verified Courier peer");
  const proof: PairedPeer["proof"] = { cid: paired.delegationCid };
  const parts = deserializeDelegation(peer.inbound.delegation).delegationHeader.Authorization.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length === 3) {
    const signed: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (isRecord(signed)) {
      if (typeof signed.iat === "number" && Number.isFinite(signed.iat)) proof.issuedAt = signed.iat * 1000;
      if (typeof signed.nbf === "number" && Number.isFinite(signed.nbf)) proof.notBefore = signed.nbf * 1000;
    }
  }
  return {
    handle: paired.handle, peerDid: paired.peerDid, delegationExpiresAt: paired.delegationExpiresAt, proof,
    delegation: { ref: { handle: paired.handle, peerDid: paired.peerDid, pairingId: paired.pairingId }, record: saved },
  };
}

export async function unpair(ctx: CourierContext, peer: PairedPeer): Promise<void> {
  await library("unpair")(context(ctx), reference(peer));
}

export async function listInbound(ctx: CourierContext, peer: PairedPeer): Promise<CourierInbound[]> {
  return library("listInbound")(context(ctx), reference(peer));
}

/** Call only after the intake service's local durable claim; never acknowledge speculative reads. */
export async function acknowledgeInbound(ctx: CourierContext, peer: PairedPeer, ids: CourierReceipt[]): Promise<void> {
  await library("acknowledgeInbound")(context(ctx), reference(peer), ids);
}

export async function sendMessage(ctx: CourierContext, peer: PairedPeer, threadId: string, text: string, reply: CourierReply): Promise<{ messageId: string }> {
  const expected = createHash("sha256").update(JSON.stringify([peer.peerDid, threadId, reply.inReplyTo])).digest("hex");
  if (reply.idempotencyKey !== expected) throw new Error("invalid Courier reply binding");
  return library("sendMessage")(context(ctx), reference(peer), threadId, text, reply);
}

/** Finite seven-day pairing is v1; successor renewal is the explicitly deferred P1 library feature. */
export async function renewPeer(_ctx: CourierContext, _peer: PairedPeer): Promise<PairedPeer> {
  throw new RenewalUnavailable();
}
