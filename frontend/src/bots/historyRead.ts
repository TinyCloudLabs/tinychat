import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { InlineEncryptedEnvelope } from "@tinycloud/sdk-services";
import type { KeyDescriptor, NamedKeyEnvelope } from "@tinycloud/sdk-services/encryption/named-keys";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import {
  BOT_HISTORY_KEY_PATH,
  isCurrentHistorySession,
  publishBotHistoryKeyDescriptor,
} from "./botHistoryKey";
import { botHistoryOwnerPermissions } from "./historyAuthorization";
import { earlierHistoryPermissions, recordHeldEarlierHistory } from "./earlierHistory";
import { BOT_HISTORY_RECORD_PREFIX, BOT_HISTORY_RECORD_SUFFIX, botHistoryDirectory } from "./botHistoryPath";
import { isAppDecision, toSecretLine, type BotMessage } from "./botsApi";
import { BOTS_STRINGS } from "./botsStrings";
import { bindBotHistoryContext, checkBotHistoryContext, isContextBindingOf } from "./historyContext";

/** Records of one page fetched and decrypted at once. Each decrypt is a round trip to the node (TC-3054). */
export const HISTORY_READ_CONCURRENCY = 4;

export interface BotHistoryContextReport {
  /** Records whose full record context was present and matched. */
  bound: number;
  /** Stored keys of legacy records: opened by the earlier rule, no full record context. */
  legacy: string[];
}

export type ResealFailureReason =
  | "exact_key_unavailable"
  | "descriptor_unavailable"
  | "encrypt_failed"
  | "missing_etag"
  | "write_failed"
  | "readback_failed"
  | "commit_failed";

export interface BotHistoryResealFailure {
  reason: ResealFailureReason;
}

export interface BotHistoryResealReport {
  resealed: number;
  failed: BotHistoryResealFailure[];
}

export interface ReadBotHistoryOptions {
  /**
   * Foreground-only: reseal any v1 records read to the exact named key
   * (write v2, read back with exact-key grant, then retire v1; keep v1 on any failure).
   */
  reseal?: boolean;
  /** Receives counts and failure codes when reseal runs. Never includes plaintext or keys. */
  onResealReport?: (report: BotHistoryResealReport) => void;
  /**
   * Receives the stored keys of records that carry no full record context (written earlier) and the count of
   * records whose context was verified. Called after a read that returned. Never includes plaintext.
   */
  onContextReport?: (report: BotHistoryContextReport) => void;
}

/** Earlier records one foreground read rewrites with their context added (one decrypt and a few writes each). */
export const HISTORY_REBIND_PER_READ = 20;

/** Owner-authorized reads remain separate from the backend's write-only encryption role. */
export async function readBotHistory(
  tcw: TinyCloudWeb,
  signal?: AbortSignal,
  options?: ReadBotHistoryOptions,
): Promise<BotMessage[]> {
  return readHistory(tcw, signal, undefined, options);
}

/** For callers selecting a bot from the roster, including Main. */
export async function readHistoryForBot(
  tcw: TinyCloudWeb,
  botKey: string,
  signal?: AbortSignal,
  options?: ReadBotHistoryOptions,
): Promise<BotMessage[]> {
  return readHistory(tcw, signal, botKey, options);
}

type StoredHistoryEnvelope = (InlineEncryptedEnvelope | NamedKeyEnvelope) & {
  v?: number;
  keyPath?: unknown;
  networkId?: string;
  aad?: string;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function isUnreadableKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "KEY_UNAVAILABLE" ||
    code === "KEY_NOT_FOUND" ||
    code === "KEY_BLOCKED" ||
    code === "KEY_UNWRAP_FAILED" ||
    code === "DECRYPT_FAILED"
  );
}

async function readHistory(
  tcw: TinyCloudWeb,
  signal?: AbortSignal,
  botKey?: string,
  options?: ReadBotHistoryOptions,
): Promise<BotMessage[]> {
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const address = session.address.toLowerCase();
  const chainId = session.chainId ?? 1;
  const owner = `did:pkh:eip155:1:${address}`;
  const networkId = encryptionNetworkId(session.address, chainId);
  const spaceId = makePkhSpaceId(session.address, chainId, "applications");
  const kv = tcw.kvForSpace(spaceId);
  const prefix = await botHistoryDirectory(address, botKey ?? "main");

  const resealEnabled = options?.reseal === true;
  const resealReport: BotHistoryResealReport = { resealed: 0, failed: [] };
  let sawV1 = false;
  // v1 records are sealed to the whole encryption network. Without that grant they are held back, not failed: the
  // chat reads on its own key and the owner moves the earlier ones separately (earlierHistory.ts).
  let heldBack = 0;
  let boundCount = 0;
  const legacyKeys: string[] = [];
  let rebindsLeft = HISTORY_REBIND_PER_READ;
  let cachedDescriptor: Promise<KeyDescriptor> | null = null;

  const ensureActiveDescriptor = async (): Promise<KeyDescriptor> => {
    if (!cachedDescriptor) {
      cachedDescriptor = (async () => {
        const descriptor = await tcw.keys.ensureKey(BOT_HISTORY_KEY_PATH, { networkId });
        if (descriptor.state !== "active" || descriptor.kind !== "deletable") {
          throw new Error("history_key_descriptor_invalid");
        }
        if (!isCurrentHistorySession(tcw, session)) throw new Error("history_session_changed");
        await publishBotHistoryKeyDescriptor(tcw, descriptor);
        return descriptor;
      })();
    }
    return cachedDescriptor;
  };

  const rewriteRecord = async (
    key: string,
    etag: string | undefined,
    plaintext: Uint8Array,
    expectedAad: string,
    expectedAadBytes: Uint8Array,
    recordSignal: AbortSignal,
    verifyOpened?: (opened: Uint8Array) => boolean,
  ): Promise<void> => {
    const fail = (reason: ResealFailureReason) => { resealReport.failed.push({ reason }); };
    const current = () => {
      recordSignal.throwIfAborted();
      if (!isCurrentHistorySession(tcw, session)) throw new Error("history_session_changed");
    };
    if (!tcw.hasPermissions(botHistoryOwnerPermissions(session.address))) return fail("exact_key_unavailable");
    if (!etag) return fail("missing_etag");

    let descriptor: KeyDescriptor;
    try {
      current();
      descriptor = await ensureActiveDescriptor();
    } catch {
      return fail("descriptor_unavailable");
    }

    let v2Envelope: NamedKeyEnvelope;
    try {
      current();
      v2Envelope = await tcw.keys.encrypt(BOT_HISTORY_KEY_PATH, plaintext, {
        networkId, aad: expectedAadBytes, descriptor,
      });
    } catch {
      return fail("encrypt_failed");
    }

    // Only the canonical path is listed as history. Stage a separate encrypted copy
    // with the canonical AAD so readback failure leaves v1 intact.
    const stagedKey = `xyz.tinycloud.tinychat/threads/bots/reseal/${key.slice(BOT_HISTORY_RECORD_PREFIX.length)}-${crypto.randomUUID()}`;
    const options = { prefix: "", signal: recordSignal };
    let stageWritten = false;
    let reason: ResealFailureReason = "write_failed";
    try {
      current();
      const written = await kv.put(stagedKey, v2Envelope, { ...options, ifNoneMatch: "*" });
      if (!written.ok) return fail(reason);
      stageWritten = true;
      reason = "readback_failed";
      current();
      const readback = await kv.get<NamedKeyEnvelope>(stagedKey, { ...options, source: "network" });
      if (!readback.ok) return fail(reason);
      const stored = readback.data.data;
      if (
        stored?.v !== 2 || stored.keyPath !== BOT_HISTORY_KEY_PATH ||
        stored.keyVersion !== descriptor.keyVersion || stored.networkId !== networkId || stored.aad !== expectedAad
      ) return fail(reason);
      const opened = await tcw.keys.decrypt(stored);
      if (!bytesEqual(opened, plaintext) || (verifyOpened && !verifyOpened(opened))) return fail(reason);

      reason = "commit_failed";
      current();
      const replaced = await kv.put(key, stored, { ...options, ifMatch: etag });
      if (!replaced.ok) return fail(reason);
      resealReport.resealed++;
    } catch {
      fail(reason);
    } finally {
      if (stageWritten && isCurrentHistorySession(tcw, session)) {
        await kv.delete(stagedKey, { prefix: "" }).catch(() => {});
      }
    }
  };

  const readRecord = async (key: string, recordSignal: AbortSignal): Promise<BotMessage | null> => {
    const stored = await kv.get<StoredHistoryEnvelope>(key, { prefix: "", signal: recordSignal });
    if (!stored.ok) throw new Error("history_read_unavailable");
    const envelope = stored.data.data;
    const expectedAadJson = JSON.stringify({ owner, spaceId, path: key });
    const expectedAad = btoa(expectedAadJson);
    if (!envelope || typeof envelope !== "object" || envelope.aad !== expectedAad) {
      throw new Error("history_binding_mismatch");
    }
    recordSignal.throwIfAborted();

    // Choose decrypt path strictly by the envelope's own `keyPath` — never by KV metadata.
    let plaintext: Uint8Array;
    let isV1 = false;
    if (envelope.keyPath !== undefined) {
      if (
        envelope.v !== 2 ||
        typeof envelope.keyPath !== "string" ||
        envelope.keyPath !== BOT_HISTORY_KEY_PATH ||
        envelope.networkId !== networkId
      ) {
        throw new Error("history_binding_mismatch");
      }
      try {
        plaintext = await tcw.keys.decrypt(envelope as NamedKeyEnvelope);
      } catch (error) {
        if (isUnreadableKeyError(error)) {
          return { id: `unreadable-${key.slice(prefix.length)}`, role: "bot", text: BOTS_STRINGS.historyUnreadable, at: "", unreadableHistory: true };
        }
        throw new Error("history_decrypt_unavailable", { cause: error });
      }
    } else {
      if (envelope.v !== undefined && envelope.v !== 1) {
        throw new Error("history_binding_mismatch");
      }
      isV1 = true;
      sawV1 = true;
      // v1 records open only with decrypt on the whole encryption network. Without that grant the record is held back
      // before any node call (the owner has not chosen to move earlier history yet). With it, a failed decrypt fails the read.
      if (!tcw.hasPermissions(earlierHistoryPermissions(session.address, chainId))) { heldBack++; return null; }
      const opened = await tcw.encryption.decryptEnvelope(envelope as InlineEncryptedEnvelope, { proofs: [] });
      if (!opened.ok) throw new Error("history_decrypt_unavailable");
      plaintext = opened.data;
    }

    const batch = JSON.parse(new TextDecoder().decode(plaintext));
    // Every record: exact version and field types before the stored key is compared with them, and the bot it names.
    if (
      batch?.v !== 1 ||
      typeof batch.generation !== "string" ||
      typeof batch.challenge !== "string" ||
      !Number.isSafeInteger(batch.seq) ||
      batch.bot !== (botKey === undefined || botKey === "main" ? undefined : botKey)
    ) {
      throw new Error("history_binding_mismatch");
    }
    if (key !== `${prefix}${batch.generation}/${batch.seq}-${batch.challenge}`) {
      throw new Error("history_binding_mismatch");
    }
    // Before anything is returned or resealed: a ctx that is present must match; no ctx is a legacy record.
    const scope = { owner, spaceId, path: key, bot: botKey ?? "main" };
    const legacy = checkBotHistoryContext(batch, scope) === "legacy";
    if (legacy) legacyKeys.push(key);
    else boundCount++;

    const etag = stored.data.headers?.etag;
    const aadBytes = new TextEncoder().encode(expectedAadJson);
    if (isV1 && resealEnabled) {
      await rewriteRecord(key, etag, plaintext, expectedAad, aadBytes, recordSignal);
    } else if (legacy && resealEnabled && rebindsLeft > 0) {
      // An owner-side rewrite of an earlier record that is already sealed to the exact key: the same batch with its
      // context added. Foreground reads only, a few records per read; every failure leaves the stored record as it is.
      rebindsLeft--;
      const bound = bindBotHistoryContext(batch, scope);
      await rewriteRecord(key, etag, bound, expectedAad, aadBytes, recordSignal, (opened) => isContextBindingOf(opened, batch, scope));
    }

    const record = batch.record;
    if ((record?.type === "user" || record?.type === "assistant") && typeof record.text === "string") {
      // A message the app sent for the owner (a decision on a request or proposal) keeps its mark, as the service's own listing does.
      const app = record.type === "user" && record.origin === "app";
      const decision = app && isAppDecision(record.decision) ? record.decision : undefined;
      const secret = decision ? toSecretLine(record.secret) : undefined;
      return {
        id: record.type === "assistant" && typeof record.outcome?.messageId === "string" ? record.outcome.messageId : `history-${batch.generation}-${batch.seq}`,
        role: record.type === "user" ? "user" : "bot", text: record.text, at: record.at ?? "",
        ...(app ? { origin: "app" as const } : {}),
        ...(decision ? { decision } : {}),
        ...(secret ? { secret } : {}),
      };
    }
    return null;
  };

  const messages: BotMessage[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const listed = await kv.list({ prefix, cursor, signal });
    if (!listed.ok) throw new Error("history_read_unavailable");
    for (const key of listed.data.keys) {
      if (!key.startsWith(prefix) || (botKey !== undefined && !BOT_HISTORY_RECORD_SUFFIX.test(key.slice(prefix.length)))) throw new Error("history_path_mismatch");
    }
    for (const message of await readEach(listed.data.keys, HISTORY_READ_CONCURRENCY, signal, readRecord)) {
      if (message) messages.push(message);
    }
    cursor = listed.data.nextCursor;
    if (listed.data.truncated && !cursor) throw new Error("history_pagination_unavailable");
  } while (cursor);

  if (resealEnabled && sawV1) {
    if (resealReport.failed.length > 0) {
      console.warn("[bots] bot history reseal did not complete", {
        resealed: resealReport.resealed,
        failedCount: resealReport.failed.length,
        reasons: [...new Set(resealReport.failed.map((f) => f.reason))],
      });
    }
    options?.onResealReport?.(resealReport);
  }
  options?.onContextReport?.({ bound: boundCount, legacy: legacyKeys });
  recordHeldEarlierHistory(address, botKey ?? "main", heldBack);

  return messages.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * `read` for every key, at most `limit` at a time. The first failure fails the whole read: nothing new starts
 * and the reads in flight are aborted (a decrypt already sent runs to its end, unused).
 */
async function readEach<T>(
  keys: readonly string[],
  limit: number,
  signal: AbortSignal | undefined,
  read: (key: string, signal: AbortSignal) => Promise<T>,
): Promise<T[]> {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const results: T[] = [];
  let failure: { error: unknown } | null = null;
  let next = 0;
  const worker = async () => {
    while (next < keys.length && !failure && !controller.signal.aborted) {
      const index = next++;
      try {
        results[index] = await read(keys[index]!, controller.signal);
      } catch (error) {
        if (!failure) {
          failure = { error };
          controller.abort(error);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, keys.length) }, worker));
  } finally {
    signal?.removeEventListener("abort", forward);
  }
  if (failure) throw (failure as { error: unknown }).error;
  signal?.throwIfAborted();
  return results;
}
