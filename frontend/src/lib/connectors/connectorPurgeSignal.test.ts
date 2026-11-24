import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { _resetConnectorSchemaMemoForTests, purgeConnectorVerified } from "./connectorStore";
import { announceConnectorPurged, onConnectorPurged } from "./connectorPurgeSignal";

let cleanDom: (() => void) | undefined;
beforeAll(() => { cleanDom = installDom(); });
afterAll(() => { cleanDom?.(); });
beforeEach(() => { _resetConnectorSchemaMemoForTests(); });

const sqlOk = async () => ({ ok: true, data: { rows: [] } });
function space(listFails: boolean): TinyCloudWeb {
  return {
    did: undefined,
    spaceId: undefined,
    sql: { db: () => ({ execute: sqlOk, batch: sqlOk, query: sqlOk }) },
    kv: {
      list: async () => (listFails
        ? { ok: false, error: { code: "KV_UNAVAILABLE", message: "down" } }
        : { ok: true, data: { keys: [], truncated: false } }),
      delete: async () => ({ ok: true, data: undefined }),
      get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "no such key" } }),
    },
  } as unknown as TinyCloudWeb;
}

describe("connector purge signal", () => {
  test("a list hears the purge of its own source only, and stops after it unsubscribes", () => {
    let heard = 0;
    const off = onConnectorPurged("fireflies", () => { heard += 1; });
    announceConnectorPurged("granola");
    expect(heard).toBe(0);
    announceConnectorPurged("fireflies");
    expect(heard).toBe(1);
    off();
    announceConnectorPurged("fireflies");
    expect(heard).toBe(1);
  });

  test("the verified purge announces when it finishes, and when it could not finish", async () => {
    let heard = 0;
    const off = onConnectorPurged("fireflies", () => { heard += 1; });
    expect((await purgeConnectorVerified(space(false), "fireflies")).ok).toBe(true);
    expect(heard).toBe(1);
    expect((await purgeConnectorVerified(space(true), "fireflies")).ok).toBe(false);
    expect(heard).toBe(2);
    off();
  });
});
