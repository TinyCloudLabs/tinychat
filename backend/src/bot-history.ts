// TC-2808: owner-scoped encrypted bot history. No storage operation accepts an owner from a bot payload.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import { projectBotHistoryGrant, type HistoryGrant } from "./bot-history-grant.js";
import {
  assertDescriptorPinCompatible,
  BOT_HISTORY_KEY_PATH,
  botHistoryNetworkId,
  HistoryKeyDescriptorRejected,
  type SignedBotHistoryKeyEnvelope,
  type VerifiedBotHistoryKeyDescriptor,
  verifyBotHistoryKeyDescriptor,
} from "./bot-history-key.js";
import { sealBotHistoryBatch } from "./bot-history-seal.js";

function resultData<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error("history_storage_unavailable");
  return result.data;
}
export const HISTORY_PREFIX = "xyz.tinycloud.tinychat/threads/bots/v1/";
export const HISTORY_DOMAIN = "tinychat.bot-history.storage/v1\n";
/** Where the backend keeps each bot's history grant, in its own space. */
export const BOT_HISTORY_GRANT_KEY_PREFIX = "bot-history/grants/";
export const historyHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const historyOwner = (address: string) => `did:pkh:eip155:1:${address.toLowerCase()}`;
/** How a bot other than Main is named: 32 hex characters chosen by the backend. Checked before it enters any id, path or storage key. */
export const HISTORY_BOT_KEY = /^[0-9a-f]{32}$/;
/** An address is checked before it is hashed or becomes part of a storage key. */
function checkAddress(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("history_owner_invalid");
}
/** `main` and no key both mean Main; anything else must be a well-formed sibling key. */
function siblingKey(key: string | undefined): string | undefined {
  if (key === undefined || key === "main") return undefined;
  if (!HISTORY_BOT_KEY.test(key)) throw new Error("history_bot_key_invalid");
  return key;
}
/**
 * A bot's id, as the bots service derives it: sha256 of the owner DID for Main (unchanged), and of the DID, a newline
 * and the key for any other bot. The address is checked first, so nothing but a lower-case did:pkh is ever hashed.
 */
export function historyBotId(address: string, key?: string): string {
  checkAddress(address);
  const sibling = siblingKey(key);
  return historyHash(sibling ? `${historyOwner(address)}\n${sibling}` : historyOwner(address));
}
export interface StagedHistory { seq: number; challenge: string; batchHash: string; envelope: unknown }
export interface HistoryBatch {
  v: 1; generation: string; seq: number; challenge: string; record: unknown;
  /** A sibling's key, as the service put it inside the batch. Main's batches have none. */
  bot?: string;
}
/** The activity record emitted by the supervisor and stored in the owner's history. */
export type BotActivityRecord = {
  type: "activity";
  id: string;
  count: number;
  at: string;
} & ({ verb: "ran_commands" | "changed_files" } | { verb: "messaged_bot"; targetKey: string });
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function isBotActivityRecord(value: unknown): value is BotActivityRecord {
  return isObject(value) && value.type === "activity"
    && typeof value.id === "string" && value.id.length === 32 && /^[a-f0-9]{32}$/.test(value.id)
    && typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 1 && value.count <= 256
    && typeof value.at === "string" && value.at.length === 24
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at) && Number.isFinite(Date.parse(value.at))
    && (value.verb === "messaged_bot"
      ? Object.keys(value).length === 6 && typeof value.targetKey === "string"
        && (value.targetKey === "main" || (value.targetKey.length === 32 && HISTORY_BOT_KEY.test(value.targetKey)))
      : Object.keys(value).length === 5 && (value.verb === "ran_commands" || value.verb === "changed_files"));
}
export function checkedBatch(value: unknown): HistoryBatch {
  const batch = value as HistoryBatch;
  if (!batch || batch.v !== 1 || !/^[a-f0-9]{32}$/.test(batch.generation) || !Number.isSafeInteger(batch.seq) || batch.seq < 1
    || !/^[a-f0-9]{64}$/.test(batch.challenge) || !batch.record || (batch.bot !== undefined && !HISTORY_BOT_KEY.test(batch.bot))
    || (isObject(batch.record) && batch.record.type === "activity" && !isBotActivityRecord(batch.record))
    || Buffer.byteLength(JSON.stringify(batch)) > 512 * 1024) throw new Error("invalid_history_batch");
  // The same fields in the same order as the service's journal, so both sides hash the same bytes.
  return { v: 1, generation: batch.generation, seq: batch.seq, challenge: batch.challenge, record: batch.record, ...(batch.bot ? { bot: batch.bot } : {}) };
}
/** `sibling` is set for a bot other than Main: its receipt also names the bot and the exact path that was written. */
export function historyReceiptBody(owner: string, batch: HistoryBatch, spaceId: string, host: string, ciphertextHash: string, sibling?: { key: string; path: string }) {
  return { v: 1, owner, botId: historyHash(sibling ? `${owner}\n${sibling.key}` : owner), generation: batch.generation, seq: batch.seq, challenge: batch.challenge,
    batchHash: historyHash(JSON.stringify(batch)), spaceId, host, ciphertextHash, ...(sibling ?? {}) };
}
export class HistoryPermissionExpired extends Error {
  constructor(readonly expiresAt: number) { super("history_permission_expired"); }
}
interface GrantEnvelope { expiresAt?: number; serialized: string; siwe: string; signature: string }
/** AES-GCM at rest with a domain-separated key; the grant never leaves this module in plaintext storage. */
export class BotHistory {
  readonly #key: Buffer;
  readonly #account;
  constructor(readonly node: TinyCloudNode, privateKey: `0x${string}`, readonly host: string) {
    this.#key = Buffer.from(hkdfSync("sha256", Buffer.from(privateKey.slice(2), "hex"), Buffer.alloc(0), "tinychat.bot-history.grants/v1", 32));
    this.#account = privateKeyToAccount(privateKey);
  }
  /** Main's grant is stored under the address alone, as it always was, and never under `<address>/main`. */
  #keyFor(address: string, key?: string) {
    checkAddress(address);
    const sibling = siblingKey(key);
    return `${BOT_HISTORY_GRANT_KEY_PREFIX}${address.toLowerCase()}${sibling ? `/${sibling}` : ""}`;
  }
  #seal(value: unknown, aad: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(aad));
    return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  #open(value: string, aad: string): unknown {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString());
  }
  async #verify(address: string, envelope: GrantEnvelope, botKey?: string): Promise<HistoryGrant> {
    return projectBotHistoryGrant(this.node, this.host, address, envelope, botKey);
  }
  async #activate(grant: HistoryGrant) {
    const resource = grant.resources[0]!;
    return this.node.useDelegation({ cid: grant.cid, delegationHeader: { Authorization: grant.authorization }, spaceId: grant.spaceId,
      path: resource.path, actions: resource.actions, resources: [resource], expiry: grant.expiresAt,
      delegateDID: grant.backendDid, ownerAddress: grant.ownerAddress, chainId: grant.chainId, host: this.host });
  }
  /** Checks, activates and stores one bot's grant. `botKey` names a bot other than Main. */
  async accept(address: string, envelope: GrantEnvelope, botKey?: string): Promise<number> {
    const grant = await this.#verify(address, envelope, botKey);
    await this.#activate(grant); // node verifies current authority before storage
    const key = this.#keyFor(address, botKey);
    await withSessionRefresh(this.node, async () => assertKvResult(await this.node.kv.put(key, this.#seal({ ...envelope, expiresAt: grant.expiresAt.getTime() }, key))));
    return grant.expiresAt.getTime();
  }
  async #grant(address: string, botKey?: string) {
    const key = this.#keyFor(address, botKey);
    const stored = await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.get<string>(key);
      if (!isKvMissingKeyResult(result, key)) assertKvResult(result);
      return result;
    });
    if (isKvMissingKeyResult(stored, key)) throw new Error("history_grant_missing");
    const value = resultData(stored).data;
    const envelope = this.#open(value, key) as GrantEnvelope;
    if (typeof envelope.expiresAt === "number" && Date.now() >= envelope.expiresAt) throw new HistoryPermissionExpired(envelope.expiresAt);
    return this.#verify(address, envelope, botKey);
  }
  /** When a bot's stored grant ends, or undefined once it has. Any other failure is thrown. */
  async grantValidUntil(address: string, botKey?: string): Promise<number | undefined> {
    try { return (await this.#grant(address, botKey)).expiresAt.getTime(); }
    catch (error) { if (error instanceof HistoryPermissionExpired) return undefined; throw error; }
  }
  /** Every stored grant's key, page by page. A listing that ends without a cursor while truncated is refused. */
  async #grantKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const result = resultData(await withSessionRefresh(this.node, async () => assertKvResult(await this.node.kv.list({ prefix: BOT_HISTORY_GRANT_KEY_PREFIX, cursor }))));
      keys.push(...result.keys);
      cursor = result.nextCursor;
      if (result.truncated && !cursor) throw new Error("history_owner_pagination_unavailable");
    } while (cursor);
    return keys;
  }
  /** Owners with a stored grant for Main: the address alone, nothing after it. */
  async owners(): Promise<string[]> {
    return (await this.#grantKeys()).map(key => /(?:^|\/)grants\/(0x[a-f0-9]{40})$/.exec(key)?.[1]).filter((key): key is string => !!key);
  }
  /** Stored grants of bots other than Main: the address and exactly one 32 hex key after it, nothing else. */
  async siblings(): Promise<Array<{ address: string; key: string }>> {
    return (await this.#grantKeys()).flatMap(key => {
      const match = /(?:^|\/)grants\/(0x[a-f0-9]{40})\/([0-9a-f]{32})$/.exec(key);
      return match ? [{ address: match[1]!, key: match[2]! }] : [];
    });
  }
  /**
   * The delegation id of a bot's stored grant, so it can be revoked when the bot is deleted. Undefined when nothing is
   * stored. Read from the stored envelope as it was accepted: an expired grant still has an id.
   */
  async storedGrantCid(address: string, botKey: string): Promise<string | undefined> {
    const key = this.#deletableKeyFor(address, botKey);
    const stored = await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.get<string>(key);
      if (!isKvMissingKeyResult(result, key)) assertKvResult(result);
      return result;
    });
    if (isKvMissingKeyResult(stored, key)) return undefined;
    const value = resultData(stored).data;
    try {
      const bundle: unknown = JSON.parse((this.#open(value, key) as GrantEnvelope).serialized);
      const cid = typeof bundle === "object" && bundle !== null && "cid" in bundle ? bundle.cid : undefined;
      return typeof cid === "string" && cid !== "" ? cid : undefined;
    } catch {
      // What is stored cannot be opened or read, so there is no id to recover from it.
      return undefined;
    }
  }
  /** Removes a bot's stored grant. Never Main's: this is for a bot that is being deleted, and Main cannot be. */
  async forget(address: string, botKey: string): Promise<void> {
    const key = this.#deletableKeyFor(address, botKey);
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.delete(key);
      if (!isKvMissingKeyResult(result, key)) assertKvResult(result);
    });
  }
  /** Revokes a delegation at the node. */
  async revoke(cid: string): Promise<void> {
    const result = await this.node.revokeDelegation(cid);
    if (!result.ok) throw new Error("history_revoke_failed");
  }
  /** Where a bot other than Main keeps its grant. Main is refused by name, before any storage key is built. */
  #deletableKeyFor(address: string, botKey: string) {
    if (typeof botKey !== "string" || botKey === "main") throw new Error("history_main_grant_kept");
    return this.#keyFor(address, botKey);
  }
  /** Where an owner's signed named-key descriptor is stored, inside the existing grants root. */
  #descriptorKeyFor(address: string) {
    checkAddress(address);
    return `${BOT_HISTORY_GRANT_KEY_PREFIX}${address.toLowerCase()}/key-descriptor`;
  }
  /**
   * Verifies, pin-checks, and stores the owner-signed descriptor for the bot-history named key.
   * Refuses expired, mismatched, or downgraded descriptors. Returns the descriptor's expiry (ms).
   */
  async acceptKeyDescriptor(address: string, envelope: SignedBotHistoryKeyEnvelope): Promise<number> {
    const verified = await verifyBotHistoryKeyDescriptor(address, envelope);
    const key = this.#descriptorKeyFor(address);
    await withSessionRefresh(this.node, async () => {
      const stored = await this.node.kv.get<string>(key);
      const missing = isKvMissingKeyResult(stored, key);
      let etag: string | undefined;
      if (!missing) {
        const record = resultData(assertKvResult(stored));
        const existing = this.#open(record.data, key) as SignedBotHistoryKeyEnvelope;
        assertDescriptorPinCompatible(existing.descriptor, verified.descriptor);
        if (verified.descriptor.iat < existing.descriptor.iat) {
          throw new HistoryKeyDescriptorRejected("history_key_descriptor_stale");
        }
        etag = record.headers?.etag;
        if (!etag) throw new Error("history_key_descriptor_unavailable");
      }
      const written = await this.node.kv.put(key, this.#seal(envelope, key), etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
      if (!written.ok && written.error.code === "KV_PRECONDITION_FAILED") {
        throw new HistoryKeyDescriptorRejected("history_key_descriptor_conflict");
      }
      assertKvResult(written);
    });
    return verified.expiresAtMs;
  }
  async #keyDescriptor(address: string): Promise<VerifiedBotHistoryKeyDescriptor> {
    const key = this.#descriptorKeyFor(address);
    const stored = await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.get<string>(key);
      if (!isKvMissingKeyResult(result, key)) assertKvResult(result);
      return result;
    });
    if (isKvMissingKeyResult(stored, key)) throw new Error("history_recipient_unavailable");
    const envelope = this.#open(resultData(stored).data, key) as SignedBotHistoryKeyEnvelope;
    return verifyBotHistoryKeyDescriptor(address, envelope);
  }
  /** Saves one batch under the bot's own grant. A batch that names a different bot than the one asked for is refused. */
  async archive(address: string, input: unknown, stage: (staged: StagedHistory) => Promise<void>, botKey?: string) {
    const batch = checkedBatch(input);
    const sibling = siblingKey(botKey);
    if (batch.bot !== sibling) throw new Error("history_bot_mismatch");
    const owner = historyOwner(address);
    const grant = await this.#grant(address, sibling);
    const access = await this.#activate(grant);
    const path = `${HISTORY_PREFIX}${historyBotId(address, sibling)}/${batch.generation}/${batch.seq}-${batch.challenge}`;
    const aad = Buffer.from(JSON.stringify({ owner, spaceId: grant.spaceId, path }));
    // Recipient network and exact key path are derived exclusively from the verified owner, never from the batch.
    const network = botHistoryNetworkId(address);
    const batchJson = JSON.stringify(batch);
    const batchHash = historyHash(batchJson);
    const staged = (input as { staged?: StagedHistory }).staged;
    const saved = staged?.envelope;
    if (staged && (
      staged.batchHash !== batchHash || staged.seq !== batch.seq || staged.challenge !== batch.challenge ||
      !isObject(saved) || saved.networkId !== network || saved.aad !== aad.toString("base64") ||
      !((saved.v === 1 && saved.keyPath === undefined) || (saved.v === 2 && saved.keyPath === BOT_HISTORY_KEY_PATH))
    )) throw new Error("history_integrity_failure");

    const recipient = staged ? undefined : await this.#keyDescriptor(address);

    // This delegated KV client reads directly from the node. A previously committed
    // envelope can receive its original receipt without writing ciphertext again.
    const before = await access.kv.get(path, { prefix: "" });
    const missing = isKvMissingKeyResult(before, path);
    let envelope = saved;
    if (missing) {
      const { descriptor } = recipient ?? await this.#keyDescriptor(address);
      if (!isObject(saved) || saved.v === 1) {
        envelope = await sealBotHistoryBatch(this.node, {
          networkId: network,
          plaintext: Buffer.from(batchJson),
          aad,
          descriptor,
        });
        // Persist the randomized ciphertext before its first KV write so a crash
        // leaves the same envelope available for retry.
        await stage({ seq: batch.seq, challenge: batch.challenge, batchHash, envelope });
      } else if (saved.keyVersion !== descriptor.keyVersion) {
        throw new Error("history_recipient_mismatch");
      }
      await access.kv.put(path, envelope, { ifNoneMatch: "*", prefix: "" });
    }
    if (!envelope) throw new Error("history_integrity_failure");
    const ciphertextHash = historyHash(JSON.stringify(envelope));
    if (!missing && historyHash(JSON.stringify(resultData(before).data)) !== ciphertextHash) {
      throw new Error("history_integrity_failure");
    }
    const readback = resultData(await access.kv.get(path, { prefix: "" }));
    if (historyHash(JSON.stringify(readback.data)) !== ciphertextHash) throw new Error("history_integrity_failure");
    const body = historyReceiptBody(owner, batch, grant.spaceId, this.host, ciphertextHash, sibling ? { key: sibling, path } : undefined);
    const signature = await this.#account.signMessage({ message: HISTORY_DOMAIN + JSON.stringify(body) });
    return { body, signature };
  }
}
