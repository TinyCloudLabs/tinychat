// The owner's deletion of Main's saved chat history in their own space, with their own session (TC-4080). Everything
// under Main's history directory goes, and so does any copy a failed reseal left beside it. New chats save again
// under a new generation, so nothing here blocks the next save.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { isCurrentHistorySession } from "./botHistoryKey";
import { BOT_HISTORY_RECORD_PREFIX, botHistoryDirectory } from "./botHistoryPath";

/** Where a reseal stages its copy of a record: the record's path under the history directory, below this prefix. */
const RESEAL_PREFIX = "xyz.tinycloud.tinychat/threads/bots/reseal/";

/** Some saved records are still there. Nothing but a count leaves this error. */
export class HistoryDeleteIncomplete extends Error {
  constructor(readonly remaining: number) {
    super("history_delete_incomplete");
    this.name = "HistoryDeleteIncomplete";
  }
}

/**
 * Deletes every saved record of Main's history. A record that is already gone counts as deleted. Every record is tried
 * even when one fails; HistoryDeleteIncomplete says how many are left, and running it again deletes the rest.
 * Throws a plain Error (`history_session_missing`, `history_session_changed`, `history_read_unavailable`,
 * `history_path_mismatch`) when nothing could be listed or the session is not the one that started it.
 */
export async function deleteMainHistory(tcw: TinyCloudWeb): Promise<number> {
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const kv = tcw.kvForSpace(makePkhSpaceId(session.address, session.chainId ?? 1, "applications"));
  const directory = await botHistoryDirectory(session.address.toLowerCase(), "main");
  const prefixes = [directory, `${RESEAL_PREFIX}${directory.slice(BOT_HISTORY_RECORD_PREFIX.length)}`];

  // Listed completely before the first delete, so deleting never moves a cursor.
  const keys: string[] = [];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const listed = await kv.list({ prefix, cursor, source: "network" });
      if (!listed.ok || (listed.data.truncated && !listed.data.nextCursor)) throw new Error("history_read_unavailable");
      for (const key of listed.data.keys) {
        if (!key.startsWith(prefix)) throw new Error("history_path_mismatch");
        keys.push(key);
      }
      cursor = listed.data.nextCursor;
    } while (cursor);
  }

  let remaining = 0;
  for (const key of keys) {
    if (!isCurrentHistorySession(tcw, session)) throw new Error("history_session_changed");
    const deleted = await kv.delete(key, { prefix: "" }).catch(() => undefined);
    if (!deleted || (!deleted.ok && deleted.error.code !== "KV_NOT_FOUND")) remaining += 1;
  }
  if (remaining > 0) throw new HistoryDeleteIncomplete(remaining);
  return keys.length;
}
