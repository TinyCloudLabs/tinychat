// A is an unsigned invitation, not a peer. Only a verified C can promote it to the intake store.
import { createHash } from "node:crypto";
import { parseArtifact, validateArtifactIdentity, type PairArtifact } from "@tinycloud/courier";
import { isRecord } from "../guards";
import type { CourierGrant, CourierGrantStore } from "./grant-store";
import type { CourierContext, CourierPeerReference, PairedPeer, PairPending } from "./lib-adapter";
import { COURIER_HANDLE, type CourierPeer, type CourierPeerStore, type PendingPairing, type RetiredCourierPeer } from "./peer-store";

export const COURIER_PAIRING_TTL_MS = 15 * 60_000;
export const COURIER_PEER_MAX_MS = 7 * 86_400_000;
export const COURIER_MAX_ARTIFACT = 64 * 1024;
export interface PairingAdapter {
  context(owner: string, grant: CourierGrant, store: CourierPeerStore): Promise<CourierContext>;
  acceptPairing(ctx: CourierContext, artifact: string): Promise<PairPending>;
  finalizePairing(ctx: CourierContext, pending: PairPending, artifact: string): Promise<PairedPeer>;
  unpair(ctx: CourierContext, peer: RetiredCourierPeer): Promise<void>;
  renewPeer(ctx: CourierContext, peer: PairedPeer): Promise<PairedPeer>;
}
export type CourierPairResult = { pending: true; handle: string; acceptArtifact: string; pendingExpiresAt: number } | { peer: CourierPeer };
export interface CourierPairing {
  list(owner: string): Promise<CourierPeer[]>;
  pair(owner: string, artifact: string): Promise<CourierPairResult>;
  unpair(owner: string, handle: string): Promise<void>;
  maintain(owner: string): Promise<void>;
}
class PairingError extends Error {
  constructor(readonly code: "invalid" | "duplicate" | "pending_expired" | "courier_unavailable" | "courier_update_required", readonly status: number) { super(code); }
}

function pairingFailure(error: unknown): PairingError {
  return isRecord(error) && error.code === "courier_update_required"
    ? new PairingError("courier_update_required", 426) : new PairingError("invalid", 400);
}

/** C1's typed refusal when the SDK saved a pending attempt whose node grant never activated. */
function pendingReference(error: unknown): CourierPeerReference | undefined {
  if (!isRecord(error) || error.code !== "pair_pending" || !isRecord(error.reference)) return undefined;
  const ref = error.reference;
  return typeof ref.handle === "string" && typeof ref.peerDid === "string" && typeof ref.pairingId === "string"
    ? { handle: ref.handle, peerDid: ref.peerDid, pairingId: ref.pairingId } : undefined;
}

function checkedArtifact(input: string): PairArtifact {
  if (typeof input !== "string" || input.length === 0 || input.length > COURIER_MAX_ARTIFACT) throw new PairingError("invalid", 400);
  const artifact = parseArtifact(input);
  validateArtifactIdentity(artifact);
  const common = ["type", "v", "step", "from", "spaceId", "peer", "callMe", "issuedAt"];
  const allowed = artifact.step === "A" ? [...common, "challengeVersion"] : [...common, "delegation", "delegationExpiresAt", "completion"];
  if ((artifact.step !== "A" && artifact.step !== "C") || Object.keys(artifact).some(key => !allowed.includes(key))
    || Object.keys(artifact.from).some(key => !["owner", "courier", "label"].includes(key))
    || !COURIER_HANDLE.test(artifact.peer) || !COURIER_HANDLE.test(artifact.callMe)
    || typeof artifact.issuedAt !== "string" || !Number.isFinite(Date.parse(artifact.issuedAt))
    || (artifact.from.label !== undefined && (typeof artifact.from.label !== "string" || artifact.from.label.length > 256))
    || (artifact.step === "C" && (typeof artifact.delegation !== "string" || !artifact.delegation))) throw new PairingError("invalid", 400);
  // Signed-challenge pairing only, decided here as well as in the library: an older Courier's A is told to update,
  // and a C without its signed completion is never sent for verification.
  if (artifact.step === "A" && !("challengeVersion" in artifact)) throw new PairingError("courier_update_required", 426);
  if ("challengeVersion" in artifact && artifact.challengeVersion !== 1) throw new PairingError("invalid", 400);
  if (artifact.step === "C" && !("completion" in artifact)) throw new PairingError("invalid", 400);
  if ("completion" in artifact) {
    const completion = artifact.completion;
    if (!isRecord(completion) || Object.keys(completion).length !== 2
      || typeof completion.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(completion.x)
      || typeof completion.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(completion.signature)) throw new PairingError("invalid", 400);
  }
  return artifact;
}

export function createCourierPairing(options: { store: CourierPeerStore; grants: CourierGrantStore; adapter?: PairingAdapter; now?: () => number }): CourierPairing {
  const { store, grants } = options;
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<void>>();
  async function serial<T>(owner: string, run: () => Promise<T>): Promise<T> {
    const key = owner.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    const settled = next.then(() => {}, () => {});
    queues.set(key, settled);
    try { return await next; } finally { if (queues.get(key) === settled) queues.delete(key); }
  }
  async function adapter(): Promise<PairingAdapter> {
    if (options.adapter) return options.adapter;
    // C1's current integration checkpoint declares this boundary; load implementations only for live operations.
    const lib = await import("./lib-adapter");
    return { context: lib.courierContext, acceptPairing: lib.acceptPairing, finalizePairing: lib.finalizePairing, unpair: lib.unpair, renewPeer: lib.renewPeer };
  }
  async function context(api: PairingAdapter, owner: string) {
    const grant = await grants.get(owner);
    if (!grant || grant.expiresAt <= now()) throw new PairingError("courier_unavailable", 503);
    return api.context(owner, grant, store);
  }
  async function cleanRetired(owner: string) {
    const retired = await store.listRetired(owner);
    if (!retired.length) return;
    try {
      const api = await adapter();
      const ctx = await context(api, owner);
      for (const peer of retired) {
        try { await api.unpair(ctx, peer); await store.clearRetired(owner, peer.handle); }
        catch { /* The sealed inactive record is the retry proof; never restore it to intake. */ }
      }
    } catch { /* A disconnected owner still has no active peers after unpair. */ }
  }
  /** Revokes a peer the library verified but the gateway refused, by the pending row's exact SDK reference. */
  async function revokeVerified(owner: string, saved: PendingPairing) {
    const ref = { handle: saved.pending.handle, peerDid: saved.pending.peerDid, pairingId: saved.pending.pairingId };
    const local = await store.getPending(owner, ref.handle);
    if (local?.pending.pairingId === ref.pairingId) await store.retire(owner, ref.handle);
    else await store.retireReference(owner, { handle: ref.handle, peerDid: ref.peerDid, delegation: { pending: ref } });
    await cleanRetired(owner);
  }
  return {
    list: owner => store.list(owner),
    pair(owner, input) {
      return serial(owner, async () => {
        let artifact: PairArtifact;
        try { artifact = checkedArtifact(input); } catch (error) { throw error instanceof PairingError ? error : new PairingError("invalid", 400); }
        const handle = artifact.callMe;
        if (artifact.step === "A") await cleanRetired(owner);
        const current = await store.getRuntime(owner, handle);
        if (artifact.step === "A" && current && current.delegationExpiresAt <= now()) {
          await store.retire(owner, handle);
          await cleanRetired(owner);
        } else if (current) throw new PairingError("duplicate", 409);
        if ((await store.listRetired(owner)).some(peer => peer.handle === handle)) throw new PairingError("duplicate", 409);
        const api = await adapter();
        const ctx = await context(api, owner);
        if (ctx.identity?.did === artifact.from.courier) throw new PairingError("invalid", 400);
        if (artifact.step === "A") {
          const previous = await store.getPending(owner, handle);
          if (previous && previous.pending.expiresAt > now()) throw new PairingError("duplicate", 409);
          if (previous) {
            await store.retire(owner, handle);
            await cleanRetired(owner);
            if ((await store.listRetired(owner)).some(peer => peer.handle === handle)) throw new PairingError("courier_unavailable", 503);
          }
          const startedAt = now();
          let pending: PairPending;
          try { pending = await api.acceptPairing(ctx, input); } catch (error) {
            const ref = pendingReference(error);
            if (!ref) throw pairingFailure(error);
            if (ref.handle !== handle || ref.peerDid !== artifact.from.courier) throw new PairingError("invalid", 400);
            // Revoke that exact attempt before accepting once more. If revocation stays pending, the sealed reference
            // is retried unchanged by cleanup and maintenance; the handle stays unavailable until it succeeds.
            await store.retireReference(owner, { handle, peerDid: ref.peerDid, delegation: { pending: ref } });
            await cleanRetired(owner);
            if ((await store.listRetired(owner)).some(peer => peer.handle === handle)) throw new PairingError("courier_unavailable", 503);
            try { pending = await api.acceptPairing(ctx, input); } catch (retry) { throw pairingFailure(retry); }
          }
          // createdAt is the SDK's own pending checkpoint time; finalize verifies it unchanged.
          if (pending.handle !== handle || pending.peerDid !== artifact.from.courier || pending.expiresAt <= now()
            || !Number.isSafeInteger(pending.createdAt) || pending.createdAt < startedAt - 60_000 || pending.createdAt > now()
            || pending.expiresAt > pending.createdAt + COURIER_PAIRING_TTL_MS
            || !pending.artifactB || pending.artifactB.length > COURIER_MAX_ARTIFACT) throw new PairingError("invalid", 400);
          await store.putPending(owner, { pending, artifactA: input, startedAt: pending.createdAt });
          return { pending: true, handle, acceptArtifact: pending.artifactB, pendingExpiresAt: pending.expiresAt };
        }
        const saved = await store.getPending(owner, handle);
        if (!saved) throw new PairingError("invalid", 400);
        if (saved.pending.expiresAt <= now()) {
          await store.retire(owner, handle);
          throw new PairingError("pending_expired", 410);
        }
        const start = checkedArtifact(saved.artifactA);
        if (artifact.from.owner !== start.from.owner || artifact.from.courier !== start.from.courier
          || artifact.spaceId !== start.spaceId || artifact.peer !== start.peer || artifact.callMe !== start.callMe) throw new PairingError("invalid", 400);
        let peer: PairedPeer;
        try { peer = await api.finalizePairing(ctx, saved.pending, input); } catch (error) {
          // The peer's grant could not be confirmed yet: keep the pending row so the same C can be retried.
          if (pendingReference(error)) throw new PairingError("courier_unavailable", 503);
          throw pairingFailure(error);
        }
        // From here the library has verified C and activated the peer: every local refusal must also revoke it.
        if (peer.handle !== handle || peer.peerDid !== start.from.courier || !Number.isSafeInteger(peer.delegationExpiresAt)
          || peer.delegationExpiresAt <= now() || peer.delegationExpiresAt > now() + COURIER_PEER_MAX_MS) {
          await revokeVerified(owner, saved);
          throw new PairingError("invalid", 400);
        }
        // Verification can wait on the node; do not let its latency extend the pending window.
        if (saved.pending.expiresAt <= now()) { await revokeVerified(owner, saved); throw new PairingError("pending_expired", 410); }
        // A used proof CID or a changed pending row refuses the CAS; the activated grant is revoked either way.
        if (!await store.finalizePending(owner, saved, peer)) { await revokeVerified(owner, saved); throw new PairingError("invalid", 400); }
        const publicPeer = (await store.list(owner)).find(item => item.handle === handle)!;
        return { peer: publicPeer };
      });
    },
    unpair(owner, handle) {
      return serial(owner, async () => {
        if (!COURIER_HANDLE.test(handle)) throw new PairingError("invalid", 400);
        await store.retire(owner, handle);
        await cleanRetired(owner);
      });
    },
    maintain(owner) {
      return serial(owner, async () => {
        for (const pending of await store.listPending(owner)) {
          if (pending.pending.expiresAt <= now()) await store.retire(owner, pending.pending.handle);
        }
        await cleanRetired(owner);
        const peers = await store.listRuntime(owner);
        if (!peers.some(peer => peer.delegationExpiresAt > now())) return;
        let api: PairingAdapter;
        let ctx: CourierContext;
        try { api = await adapter(); ctx = await context(api, owner); } catch { return; }
        for (const peer of peers) {
          if (peer.delegationExpiresAt <= now()) continue;
          try {
            const renewed = await api.renewPeer(ctx, peer);
            if (renewed.delegationExpiresAt > now() + COURIER_PEER_MAX_MS) throw new Error("invalid_courier_successor");
            if (renewed.delegationExpiresAt > peer.delegationExpiresAt) await store.renewRuntime(owner, peer, renewed);
          } catch {
            console.log(JSON.stringify({ gateway: "courier", peer: createHash("sha256").update(peer.peerDid).digest("hex").slice(0, 12), outcome: "renewal_unavailable" }));
          }
        }
      });
    },
  };
}

/** Called only on the supervisor-authenticated gateway control socket, never a sandbox's socket. */
export async function courierPeerControl(req: Request, owner: string, suffix: string, pairing: CourierPairing): Promise<Response | undefined> {
  const handle = /^\/peers\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(suffix)?.[1];
  if (suffix !== "/peers" && !handle) return undefined;
  try {
    if (suffix === "/peers" && req.method === "GET") return Response.json({ peers: await pairing.list(owner) });
    if (suffix === "/peers" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.artifact !== "string") return Response.json({ error: "invalid" }, { status: 400 });
      return Response.json(await pairing.pair(owner, body.artifact));
    }
    if (handle && req.method === "DELETE") {
      if ((await req.text()).length) return Response.json({ error: "invalid" }, { status: 400 });
      await pairing.unpair(owner, handle);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  } catch (error) {
    return Response.json({ error: error instanceof PairingError ? error.code : "courier_unavailable" }, { status: error instanceof PairingError ? error.status : 503 });
  }
}
