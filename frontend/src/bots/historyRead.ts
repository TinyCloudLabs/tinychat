import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { InlineEncryptedEnvelope } from "@tinycloud/sdk-services";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import type { BotMessage } from "./botsApi";

/** Records of one page fetched and decrypted at once. Each decrypt is a round trip to the node (TC-3054). */
export const HISTORY_READ_CONCURRENCY = 4;

/** Owner-authorized reads remain separate from the backend's write-only encryption role. */
export async function readBotHistory(tcw: TinyCloudWeb, signal?: AbortSignal): Promise<BotMessage[]> {
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const address = session.address.toLowerCase();
  const owner = `did:pkh:eip155:1:${address}`;
  const spaceId = makePkhSpaceId(session.address, session.chainId, "applications");
  const kv = tcw.kvForSpace(spaceId);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`did:pkh:eip155:1:${address}`));
  const botId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const prefix = `xyz.tinycloud.tinychat/threads/bots/v1/${botId}/`;

  const readRecord = async (key: string, recordSignal: AbortSignal): Promise<BotMessage | null> => {
    const stored = await kv.get<InlineEncryptedEnvelope>(key, { prefix: "", signal: recordSignal });
    if (!stored.ok) throw new Error("history_read_unavailable");
    const expectedAad = btoa(JSON.stringify({ owner, spaceId, path: key }));
    if (stored.data.data.aad !== expectedAad) throw new Error("history_binding_mismatch");
    recordSignal.throwIfAborted();
    const opened = await tcw.encryption.decryptEnvelope(stored.data.data, { proofs: [] });
    if (!opened.ok) throw new Error("history_decrypt_unavailable");
    const batch = JSON.parse(new TextDecoder().decode(opened.data));
    if (key !== `${prefix}${batch.generation}/${batch.seq}-${batch.challenge}`) throw new Error("history_binding_mismatch");
    const record = batch.record;
    if ((record?.type === "user" || record?.type === "assistant") && typeof record.text === "string") {
      return { id: `history-${batch.generation}-${batch.seq}`, role: record.type === "user" ? "user" : "bot", text: record.text, at: record.at ?? "" };
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
      if (!key.startsWith(prefix)) throw new Error("history_path_mismatch");
    }
    for (const message of await readEach(listed.data.keys, HISTORY_READ_CONCURRENCY, signal, readRecord)) {
      if (message) messages.push(message);
    }
    cursor = listed.data.nextCursor;
    if (listed.data.truncated && !cursor) throw new Error("history_pagination_unavailable");
  } while (cursor);
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
