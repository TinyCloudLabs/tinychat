// Paired-peer intake. Claims are sealed before a turn or send; an uncertain send is never retried.
// Details: TC-4058
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isRecord } from "../guards";
import { botIdFor, OWNER_DID } from "../owner";
import { sealedGrantStore } from "../secret-store";
import { COURIER_REFUSAL, type CourierReplyText, replyText } from "./guard";
import { courierLibraryReady } from "./lib-adapter";

const HOUR = 3_600_000;
/** One window for transcripts and for receipts of acknowledged messages. */
const RETENTION = 30 * 24 * HOUR;
const RATE_PER_HOUR = 100;
const PEER_RATE_PER_HOUR = 20;
/** Receipts kept per owner. */
const RECEIPT_CAP = 5000;
const TURN_TIMEOUT_MS = 90_000;
const OWNER_CONCURRENCY = 2;
const ID = /^[0-9A-Za-z_-]{1,64}$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const courierPeerHash = (did: string) => hash(did).slice(0, 12);

export interface CourierInbound { id: string; threadId: string; kind: string; text: string; raw?: unknown }
export interface IntakePeer { handle: string; peerDid: string; status: "paired" | "expired"; pairedAt: number; delegationExpiresAt: number }
export interface IntakeGrant { raw: unknown; expiresAt: number }
export interface CourierTransport {
  inbox(): Promise<CourierInbound[]>;
  reply(message: CourierInbound, text: CourierReplyText): Promise<void>;
  acknowledge?(message: CourierInbound): Promise<void>;
}
export interface CourierThread {
  id: string;
  threadId: string;
  peer: string;
  title: string;
  messages: Array<{ role: "peer" | "bot"; text: string; at: number }>;
}
/** `at` is when the message was claimed; `acked` is whether the sender's inbox no longer lists it. */
interface Receipt { peer: string; status: "claimed" | "done" | "lost"; at: number; acked: boolean }
/** `rate` holds the admission times of the last hour across every peer: the cap is per owner. */
interface OwnerState { receipts: Record<string, Receipt>; rate: number[]; peerRates: Record<string, number[]>; threads: Record<string, CourierThread> }
export interface IntakeStore { load(): Map<string, OwnerState>; save(ownerId: string, state: OwnerState): void; remove(ownerId: string): void }

function validState(value: unknown): value is OwnerState {
  if (!isRecord(value) || !isRecord(value.receipts) || !Array.isArray(value.rate) || !isRecord(value.peerRates) || !isRecord(value.threads)) return false;
  return Object.entries(value.receipts).every(([id, r]) => /^[0-9a-f]{64}$/.test(id) && isRecord(r) && typeof r.peer === "string" && /^[0-9a-f]{12}$/.test(r.peer) && ["claimed", "done", "lost"].includes(String(r.status)) && Number.isSafeInteger(r.at) && Number(r.at) > 0 && typeof r.acked === "boolean")
    && Object.keys(value.receipts).length <= RECEIPT_CAP
    && value.rate.length <= RATE_PER_HOUR && value.rate.every(t => Number.isSafeInteger(t) && t > 0)
    && Object.entries(value.peerRates).every(([id, times]) => /^[0-9a-f]{12}$/.test(id) && Array.isArray(times) && times.length <= PEER_RATE_PER_HOUR && times.every(t => Number.isSafeInteger(t) && t > 0))
    && Object.entries(value.threads).every(([id, t]) => /^[0-9a-f]{64}$/.test(id) && isRecord(t) && t.id === id && typeof t.threadId === "string" && typeof t.title === "string" && typeof t.peer === "string" && Array.isArray(t.messages) && t.messages.every(m => isRecord(m) && ["peer", "bot"].includes(String(m.role)) && typeof m.text === "string" && Number.isSafeInteger(m.at) && Number(m.at) > 0));
}

export function courierIntakeStore(dir: string, key: Uint8Array): IntakeStore {
  const sealed = sealedGrantStore(dir, key);
  return {
    load() {
      const entries = sealed.load();
      // The generic store skips malformed envelopes. Intake cannot: that could erase replay protection.
      const count = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).length : 0;
      if (count !== entries.length) throw new Error("courier_state_invalid");
      const states = new Map<string, OwnerState>();
      for (const entry of entries) {
        if (entry.id !== entry.botId || !validState(entry.record)) throw new Error("courier_state_invalid");
        states.set(entry.botId, entry.record);
      }
      return states;
    },
    save(ownerId, state) { sealed.save(ownerId, ownerId, state); },
    remove(ownerId) { sealed.remove(ownerId); },
  };
}

export interface CourierIntakeOptions {
  owners: readonly string[];
  grants: { get(owner: string): Promise<IntakeGrant | undefined> };
  peers: { list(owner: string): Promise<IntakePeer[]> };
  transport(owner: string, grant: IntakeGrant, peer: IntakePeer): Promise<CourierTransport>;
  turn(owner: string, peer: IntakePeer, message: CourierInbound, signal: AbortSignal): Promise<CourierReplyText>;
  store: IntakeStore;
  now?: () => number;
  /** Throws when the installed Courier library cannot run headless; the default is C1's `courierLibraryReady`. */
  libraryReady?: () => void;
  /** A deadline for one turn; the default is AbortSignal.timeout. Owners polled at once; default 2. */
  turnSignal?: (ms: number) => AbortSignal;
  concurrency?: number;
  log?: (entry: { gateway: "courier"; peer: string; outcome: string }) => void;
}

export class CourierIntake {
  readonly #states: Map<string, OwnerState>;
  readonly #now: () => number;
  #polling = false;
  constructor(readonly options: CourierIntakeOptions) {
    this.#now = options.now ?? Date.now;
    this.#states = options.store.load();
    for (const [ownerId, state] of this.#states) {
      for (const receipt of Object.values(state.receipts)) if (receipt.status === "claimed") {
        this.#log(receipt.peer, "reply_lost");
        receipt.status = "lost";
      }
      this.#expire(state);
      options.store.save(ownerId, state);
    }
  }

  #log(peer: string, outcome: string) {
    (this.options.log ?? (entry => console.log(JSON.stringify(entry))))({ gateway: "courier", peer, outcome });
  }
  #state(owner: string) {
    const id = botIdFor(owner);
    let state = this.#states.get(id);
    if (!state) { state = { receipts: {}, rate: [], peerRates: {}, threads: {} }; this.#states.set(id, state); }
    return state;
  }
  #save(owner: string, state: OwnerState) { this.options.store.save(botIdFor(owner), state); }
  #expire(state: OwnerState, reserve = 0): boolean {
    let changed = false;
    for (const thread of Object.values(state.threads)) {
      const kept = thread.messages.filter(message => message.at > this.#now() - RETENTION).slice(-200);
      if (kept.length !== thread.messages.length) { thread.messages = kept; changed = true; }
      if (!thread.messages.length) { delete state.threads[thread.id]; changed = true; }
    }
    const threads = Object.values(state.threads).sort((a, b) => (a.messages.at(-1)?.at ?? 0) - (b.messages.at(-1)?.at ?? 0));
    for (const thread of threads.slice(0, Math.max(0, threads.length - 50))) { delete state.threads[thread.id]; changed = true; }
    // A receipt is the replay guard. Drop it only after the sender's inbox was told to stop listing the message; an
    // unacknowledged receipt is kept, or a later re-listing would be answered twice.
    for (const [id, receipt] of Object.entries(state.receipts)) {
      if (receipt.acked && receipt.status !== "claimed" && receipt.at <= this.#now() - RETENTION) { delete state.receipts[id]; changed = true; }
    }
    // Over the bound, the oldest acknowledged receipts go first; unacknowledged and claimed ones never do.
    const ids = Object.keys(state.receipts);
    if (ids.length + reserve > RECEIPT_CAP) {
      const droppable = ids.filter(id => state.receipts[id]!.acked && state.receipts[id]!.status !== "claimed").sort((a, b) => state.receipts[a]!.at - state.receipts[b]!.at);
      for (const id of droppable.slice(0, ids.length + reserve - RECEIPT_CAP)) { delete state.receipts[id]; changed = true; }
    }
    for (const [peer, times] of Object.entries(state.peerRates)) {
      const recent = times.filter(t => t > this.#now() - HOUR);
      if (recent.length === times.length) continue;
      if (recent.length) state.peerRates[peer] = recent; else delete state.peerRates[peer];
      changed = true;
    }
    return changed;
  }
  threads(owner: string): CourierThread[] {
    const state = this.#state(owner); if (this.#expire(state)) this.#save(owner, state);
    return structuredClone(Object.values(state.threads));
  }
  threadSummaries(owner: string): Array<{ id: string; peer: string; title: string; updatedAt: number }> {
    const state = this.#state(owner); if (this.#expire(state)) this.#save(owner, state);
    return Object.values(state.threads).map(thread => ({ id: thread.id, peer: thread.peer, title: thread.title, updatedAt: thread.messages.at(-1)?.at ?? 0 }));
  }
  thread(owner: string, id: string): CourierThread | undefined {
    const state = this.#state(owner); if (this.#expire(state)) this.#save(owner, state);
    const thread = state.threads[id];
    return thread && structuredClone(thread);
  }
  deleteThread(owner: string, id: string): void {
    const state = this.#state(owner); delete state.threads[id]; this.#save(owner, state);
  }
  /**
   * Account erase: the owner's receipts, rates and threads go, in memory and on disk. Call it with no pass running (a
   * pass saves what it holds); the owner has no grant by then, so a later pass starts nothing for them.
   */
  eraseOwner(owner: string): void {
    const id = botIdFor(owner.toLowerCase());
    this.#states.delete(id);
    this.options.store.remove(id);
  }
  /** True when the sender's inbox will stop listing the message (or there is nothing to tell it). */
  async #acknowledged(transport: CourierTransport, message: CourierInbound, peerHash: string): Promise<boolean> {
    if (!transport.acknowledge) return true;
    try { await transport.acknowledge(message); return true; } catch { this.#log(peerHash, "receipt_unavailable"); return false; }
  }
  async #authorized(owner: string, peer: IntakePeer): Promise<boolean> {
    const grant = await this.options.grants.get(owner);
    return Boolean(grant && Number.isFinite(grant.expiresAt) && grant.expiresAt > this.#now()
      && (await this.options.peers.list(owner)).some(p => p.status === "paired" && p.peerDid === peer.peerDid && p.handle === peer.handle && p.delegationExpiresAt > this.#now()));
  }
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      // Before any grant lookup: a library without the headless API refuses here, and a grant lookup restores a session.
      (this.options.libraryReady ?? courierLibraryReady)();
      for (const [ownerId, state] of this.#states) if (this.#expire(state)) this.options.store.save(ownerId, state);
      // Owners are polled with a small concurrency; one owner's slow peer cannot hold the others for the whole tick.
      const queue = [...this.options.owners];
      const worker = async () => { for (let owner = queue.shift(); owner !== undefined; owner = queue.shift()) await this.#pollOwner(owner); };
      await Promise.all(Array.from({ length: this.options.concurrency ?? OWNER_CONCURRENCY }, worker));
    } finally { this.#polling = false; }
  }

  /** Settles when the turn does, or throws when its deadline passes; the late result is dropped and nothing is retried. */
  async #within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    const expired = Promise.withResolvers<never>();
    const onAbort = () => expired.reject(new Error("courier_turn_timeout"));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    work.catch(() => {});
    try { return await Promise.race([work, expired.promise]); } finally { signal.removeEventListener("abort", onAbort); }
  }

  async #pollOwner(owner: string): Promise<void> {
    if (!OWNER_DID.test(owner)) return;
    const grant = await this.options.grants.get(owner);
    if (!grant || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.#now()) return;
    for (const peer of await this.options.peers.list(owner)) {
      const peerHash = courierPeerHash(peer.peerDid);
      if (peer.status !== "paired" || !Number.isFinite(peer.delegationExpiresAt) || peer.delegationExpiresAt <= this.#now()) continue;
      try {
        if (!(await this.#authorized(owner, peer))) continue;
        const transport = await this.options.transport(owner, grant, peer);
        if (!(await this.#authorized(owner, peer))) continue;
        for (const message of (await transport.inbox()).slice(-200)) {
          if (!(await this.#authorized(owner, peer))) break;
          // The ids end up in a reply's thread and in-reply-to: only the library's own id alphabet gets as far as a turn.
          if (!ID.test(message.id) || !ID.test(message.threadId) || typeof message.text !== "string" || message.text.length > 8000) { this.#log(peerHash, "invalid"); continue; }
          const state = this.#state(owner);
          const receiptId = hash(`${peer.peerDid}\n${message.threadId}\n${message.id}`);
          const known = state.receipts[receiptId];
          if (known) {
            // A re-listed message is never answered again; retry telling the sender's inbox to drop it.
            if (!known.acked && await this.#acknowledged(transport, message, peerHash)) { known.acked = true; this.#save(owner, state); }
            continue;
          }
          this.#expire(state, 1);
          // Unacknowledged receipts are never dropped, so a full set of them refuses new intake instead of its replay guard.
          if (Object.keys(state.receipts).length >= RECEIPT_CAP) { this.#log(peerHash, "receipts_full"); continue; }
          // One cap for the owner across all peers, and a smaller one per peer inside it: pairing more agents cannot
          // raise the answer rate, and one peer cannot use all of it.
          const now = this.#now();
          state.rate = state.rate.filter(t => t > now - HOUR);
          const peerRate = (state.peerRates[peerHash] ?? []).filter(t => t > now - HOUR);
          const limited = state.rate.length >= RATE_PER_HOUR || peerRate.length >= PEER_RATE_PER_HOUR;
          const receipt: Receipt = { peer: peerHash, status: limited || message.kind === "inform" ? "done" : "claimed", at: now, acked: false };
          state.receipts[receiptId] = receipt;
          if (!limited) { state.rate.push(now); peerRate.push(now); }
          if (peerRate.length) state.peerRates[peerHash] = peerRate; else delete state.peerRates[peerHash];
          this.#expire(state);
          const threadId = hash(`${peer.peerDid}\n${message.threadId}`);
          if (!limited) {
            const thread = state.threads[threadId] ??= { id: threadId, threadId: message.threadId, peer: peer.handle, title: `${peer.handle} (Courier)`, messages: [] };
            thread.messages.push({ role: "peer", text: message.text, at: this.#now() });
            this.#expire(state);
          }
          // A save failure aborts this intake instance: no turn or send may run on an uncommitted claim.
          this.#save(owner, state);
          receipt.acked = await this.#acknowledged(transport, message, peerHash);
          if (limited || message.kind === "inform") {
            this.#save(owner, state);
            this.#log(peerHash, limited ? "rate_limited" : "stored");
            continue;
          }
          try {
            const signal = (this.options.turnSignal ?? AbortSignal.timeout)(TURN_TIMEOUT_MS);
            const reply = message.kind === "ask" ? await this.#within(this.options.turn(owner, peer, message, signal), signal) : COURIER_REFUSAL;
            if (!(await this.#authorized(owner, peer)) || !state.threads[threadId]) {
              receipt.status = "done"; this.#save(owner, state); this.#log(peerHash, "skipped"); continue;
            }
            await transport.reply(message, reply);
            state.threads[threadId]!.messages.push({ role: "bot", text: replyText(reply), at: this.#now() });
            this.#expire(state);
            receipt.status = "done";
            this.#save(owner, state);
            this.#log(peerHash, "replied");
          } catch {
            receipt.status = "lost";
            this.#log(peerHash, "reply_lost");
            this.#save(owner, state);
          }
        }
      } catch { this.#log(peerHash, "unavailable"); }
    }
  }
}
