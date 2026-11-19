// TC-2808: owner-scoped encrypted bot history. No storage operation accepts an owner from a bot payload.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import { projectBotHistoryGrant, type HistoryGrant } from "./bot-history-grant.js";

function resultData<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error("history_storage_unavailable");
  return result.data;
}
export const HISTORY_PREFIX = "xyz.tinycloud.tinychat/threads/bots/v1/";
export const HISTORY_DOMAIN = "tinychat.bot-history.storage/v1\n";
export const historyHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const historyOwner = (address: string) => `did:pkh:eip155:1:${address.toLowerCase()}`;
export const historyBotId = (address: string) => historyHash(historyOwner(address));
export interface StagedHistory { seq: number; challenge: string; batchHash: string; envelope: unknown }
export interface HistoryBatch {
  v: 1; generation: string; seq: number; challenge: string; record: unknown;
}
export function checkedBatch(value: unknown): HistoryBatch {
  const batch = value as HistoryBatch;
  if (!batch || batch.v !== 1 || !/^[a-f0-9]{32}$/.test(batch.generation) || !Number.isSafeInteger(batch.seq) || batch.seq < 1
    || !/^[a-f0-9]{64}$/.test(batch.challenge) || !batch.record || Buffer.byteLength(JSON.stringify(batch)) > 512 * 1024) throw new Error("invalid_history_batch");
  return { v: 1, generation: batch.generation, seq: batch.seq, challenge: batch.challenge, record: batch.record };
}
export function historyReceiptBody(owner: string, batch: HistoryBatch, spaceId: string, host: string, ciphertextHash: string) {
  return { v: 1, owner, botId: historyHash(owner), generation: batch.generation, seq: batch.seq, challenge: batch.challenge,
    batchHash: historyHash(JSON.stringify(batch)), spaceId, host, ciphertextHash };
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
  #keyFor(address: string) { return `bot-history/grants/${address.toLowerCase()}`; }
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
  async #verify(address: string, envelope: GrantEnvelope): Promise<HistoryGrant> {
    return projectBotHistoryGrant(this.node, this.host, address, envelope);
  }
  async #activate(grant: HistoryGrant) {
    const resource = grant.resources[0]!;
    return this.node.useDelegation({ cid: grant.cid, delegationHeader: { Authorization: grant.authorization }, spaceId: grant.spaceId,
      path: resource.path, actions: resource.actions, resources: [resource], expiry: grant.expiresAt,
      delegateDID: grant.backendDid, ownerAddress: grant.ownerAddress, chainId: grant.chainId, host: this.host });
  }
  async accept(address: string, envelope: GrantEnvelope): Promise<number> {
    const grant = await this.#verify(address, envelope);
    await this.#activate(grant); // node verifies current authority before storage
    const key = this.#keyFor(address);
    await withSessionRefresh(this.node, async () => assertKvResult(await this.node.kv.put(key, this.#seal({ ...envelope, expiresAt: grant.expiresAt.getTime() }, key))));
    return grant.expiresAt.getTime();
  }
  async #grant(address: string) {
    const key = this.#keyFor(address);
    const stored = await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.get<string>(key);
      if (!isKvMissingKeyResult(result, key)) assertKvResult(result);
      return result;
    });
    if (isKvMissingKeyResult(stored, key)) throw new Error("history_grant_missing");
    const value = resultData(stored).data;
    const envelope = this.#open(value, key) as GrantEnvelope;
    if (typeof envelope.expiresAt === "number" && Date.now() >= envelope.expiresAt) throw new HistoryPermissionExpired(envelope.expiresAt);
    return this.#verify(address, envelope);
  }
  async owners(): Promise<string[]> {
    const owners: string[] = [];
    let cursor: string | undefined;
    do {
      const result = resultData(await withSessionRefresh(this.node, async () => assertKvResult(await this.node.kv.list({ prefix: "bot-history/grants/", cursor }))));
      owners.push(...result.keys.map(key => /(?:^|\/)grants\/(0x[a-f0-9]{40})$/.exec(key)?.[1]).filter((key): key is string => !!key));
      cursor = result.nextCursor;
      if (result.truncated && !cursor) throw new Error("history_owner_pagination_unavailable");
    } while (cursor);
    return owners;
  }
  async archive(address: string, input: unknown, stage: (staged: StagedHistory) => Promise<void>) {
    const batch = checkedBatch(input);
    const owner = historyOwner(address);
    const grant = await this.#grant(address);
    const access = await this.#activate(grant);
    const path = `${HISTORY_PREFIX}${historyBotId(address)}/${batch.generation}/${batch.seq}-${batch.challenge}`;
    const aad = Buffer.from(JSON.stringify({ owner, spaceId: grant.spaceId, path }));
    // Recipient is resolved exclusively from the verified owner's space, never from the batch.
    const network = this.node.getEncryptionNetworkIdForSpace(grant.spaceId);
    const descriptor = await this.node.encryption.discoverNetwork(network);
    if (!descriptor.ok || descriptor.data.ownerDid !== `did:pkh:eip155:1:${getAddress(address)}` || descriptor.data.state !== "active") throw new Error("history_recipient_unavailable");
    // The supervisor persists the randomized envelope beside the journal before first put.
    // It is removed by the same local retention path; the backend keeps no extra history copy.
    const batchHash = historyHash(JSON.stringify(batch));
    const staged = (input as { staged?: StagedHistory }).staged;
    let envelope: unknown;
    if (staged) {
      if (staged.batchHash !== batchHash || staged.seq !== batch.seq || staged.challenge !== batch.challenge) throw new Error("history_integrity_failure");
      envelope = staged.envelope;
    } else {
      const encrypted = await this.node.encryption.encryptToNetwork(network, Buffer.from(JSON.stringify(batch)), { aad });
      if (!encrypted.ok) throw new Error("history_encryption_failed");
      envelope = encrypted.data;
      await stage({ seq: batch.seq, challenge: batch.challenge, batchHash, envelope });
    }
    const saved = envelope as { networkId?: string; aad?: string };
    if (saved.networkId !== descriptor.data.networkId || saved.aad !== aad.toString("base64")) throw new Error("history_recipient_mismatch");
    const ciphertextHash = historyHash(JSON.stringify(envelope));
    // DelegatedAccess.kv is a raw KVService, not the frontend replica. Each get invokes a fresh
    // network POST /invoke with tinycloud.kv/get (SDK KVService.ts:248-274,726-758).
    // It never reads the owner replica or a local object cache.
    const before = await access.kv.get(path, { prefix: "" });
    if (isKvMissingKeyResult(before, path)) await access.kv.put(path, envelope, { ifNoneMatch: "*", prefix: "" });
    else if (historyHash(JSON.stringify(resultData(before).data)) !== ciphertextHash) throw new Error("history_integrity_failure");
    const readback = resultData(await access.kv.get(path, { prefix: "" }));
    if (historyHash(JSON.stringify(readback.data)) !== ciphertextHash) throw new Error("history_integrity_failure");
    const body = historyReceiptBody(owner, batch, grant.spaceId, this.host, ciphertextHash);
    const signature = await this.#account.signMessage({ message: HISTORY_DOMAIN + JSON.stringify(body) });
    return { body, signature };
  }
}
