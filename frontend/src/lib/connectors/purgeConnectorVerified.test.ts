import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  _resetConnectorSchemaMemoForTests,
  meetingKvKey,
  purgeConnectorVerified,
  transcriptKvKey,
} from "./connectorStore";

type Ok<T> = { ok: true; data: T };
type NotFound = { ok: false; error: { code: string; message: string } };

/** A space whose KV can be made to take a record while a delete is in flight, as the server import can. */
function makeSpace(onDelete?: (entries: Set<string>, key: string) => void) {
  const entries = new Set<string>();
  const sqlOk = async () => ({ ok: true, data: { rows: [] } });
  const tcw = {
    did: undefined,
    spaceId: undefined,
    sql: { db: () => ({ execute: sqlOk, batch: sqlOk, query: sqlOk }) },
    kv: {
      async list(options: { path: string }): Promise<Ok<{ keys: string[]; truncated: boolean }>> {
        return { ok: true, data: { keys: [...entries].filter((key) => key.startsWith(options.path)).sort(), truncated: false } };
      },
      async delete(key: string): Promise<Ok<void> | NotFound> {
        if (!entries.delete(key)) return { ok: false, error: { code: "KV_NOT_FOUND", message: "no such key" } };
        onDelete?.(entries, key);
        return { ok: true, data: undefined };
      },
      async get(): Promise<NotFound> {
        return { ok: false, error: { code: "KV_NOT_FOUND", message: "no such key" } };
      },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, entries };
}

beforeEach(() => {
  _resetConnectorSchemaMemoForTests();
});

describe("purgeConnectorVerified", () => {
  test("purges again a record that appeared while the first purge ran", async () => {
    let injected = false;
    const space = makeSpace((entries) => {
      if (injected) return;
      injected = true;
      entries.add(meetingKvKey("fireflies", "late"));
    });
    space.entries.add(meetingKvKey("fireflies", "a"));
    space.entries.add(transcriptKvKey("fireflies", "a"));

    const result = await purgeConnectorVerified(space.tcw, "fireflies");

    expect(result.ok).toBe(true);
    expect([...space.entries]).toEqual([]);
  });

  test("fails instead of reporting a delete when records keep coming back", async () => {
    const space = makeSpace((entries, key) => {
      entries.add(key);
    });
    space.entries.add(meetingKvKey("fireflies", "a"));

    const result = await purgeConnectorVerified(space.tcw, "fireflies");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KV_PURGE_INCOMPLETE");
  });
});
