// Paired-peer intake. Claims are sealed before a turn or send; an uncertain send is never retried.
// Details: TC-4058
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isRecord } from "../guards";
import { botIdFor, OWNER_DID } from "../owner";
import { sealedGrantStore } from "../secret-store";
import { COURIER_REFUSAL, type CourierReplyText, replyText } from "./guard";

const HOUR = 3_600_000;
/** One window for transcripts and for receipts of acknowledged messages. */
const RETENTION = 30 * 24 * HOUR;
const RATE_PER_HOUR = 100;
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
interface OwnerState { receipts: Record<string, Receipt>; rate: number[]; threads: Record<string, CourierThread> }
export interface IntakeStore { load(): Map<string, OwnerState>; save(ownerId: string, state: OwnerState): void }

function validState(value: unknown): value is OwnerState {
  if (!isRecord(value) || !isRecord(value.receipts) || !Array.isArray(value.rate) || !isRecord(value.threads)) return false;
  return Object.entries(value.receipts).every(([id, r]) => /^[0-9a-f]{64}$/.test(id) && isRecord(r) && typeof r.peer === "string" && /^[0-9a-f]{12}$/.test(r.peer) && ["claimed", "done", "lost"].includes(String(r.status)) && Number.isSafeInteger(r.at) && Number(r.at) > 0 && typeof r.acked === "boolean")
    && value.rate.length <= RATE_PER_HOUR && value.rate.every(t => Number.isSafeInteger(t) && t > 0)
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
  };
}

export interface CourierIntakeOptions {
  owners: readonly string[];
  grants: { get(owner: string): Promise<IntakeGrant | undefined> };
  peers: { list(owner: string): Promise<IntakePeer[]> };
  transport(owner: string, grant: IntakeGrant, peer: IntakePeer): Promise<CourierTransport>;
  turn(owner: string, peer: IntakePeer, message: CourierInbound): Promise<CourierReplyText>;
  store: IntakeStore;
  now?: () => number;
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
    if (!state) { state = { receipts: {}, rate: [], threads: {} }; this.#states.set(id, state); }
    return state;
  }
  #save(owner: string, state: OwnerState) { this.options.store.save(botIdFor(owner), state); }
  #expire(state: OwnerState): boolean {
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
      for (const [ownerId, state] of this.#states) if (this.#expire(state)) this.options.store.save(ownerId, state);
      for (const owner of this.options.owners) {
        if (!OWNER_DID.test(owner)) continue;
        const grant = await this.options.grants.get(owner);
        if (!grant || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.#now()) continue;
        for (const peer of await this.options.peers.list(owner)) {
          const peerHash = courierPeerHash(peer.peerDid);
          if (peer.status !== "paired" || !Number.isFinite(peer.delegationExpiresAt) || peer.delegationExpiresAt <= this.#now()) continue;
          try {
            if (!(await this.#authorized(owner, peer))) continue;
            const transport = await this.options.transport(owner, grant, peer);
            if (!(await this.#authorized(owner, peer))) continue;
            for (const message of (await transport.inbox()).slice(-200)) {
              if (!(await this.#authorized(owner, peer))) break;
              if (!message.id || !message.threadId || typeof message.text !== "string" || message.text.length > 8000) continue;
              const state = this.#state(owner);
              const receiptId = hash(`${peer.peerDid}\n${message.threadId}\n${message.id}`);
              const known = state.receipts[receiptId];
              if (known) {
                // A re-listed message is never answered again; retry telling the sender's inbox to drop it.
                if (!known.acked && await this.#acknowledged(transport, message, peerHash)) { known.acked = true; this.#save(owner, state); }
                continue;
              }
              // One cap for the owner across all peers, so pairing more agents cannot raise the answer rate.
              state.rate = state.rate.filter(t => t > this.#now() - HOUR);
              const limited = state.rate.length >= RATE_PER_HOUR;
              const receipt: Receipt = { peer: peerHash, status: limited || message.kind === "inform" ? "done" : "claimed", at: this.#now(), acked: false };
              state.receipts[receiptId] = receipt;
              if (!limited) state.rate.push(this.#now());
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
                const reply = message.kind === "ask" ? await this.options.turn(owner, peer, message) : COURIER_REFUSAL;
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
    } finally { this.#polling = false; }
  }
}
