import { beforeEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { _resetConnectorSchemaMemoForTests, ensureSchema, getConnection } from "./connectorStore";

beforeEach(_resetConnectorSchemaMemoForTests);

function fixture() {
  const sqls: string[] = [];
  const tcw = {
    did: "did:pkh:eip155:1:0xdddd",
    sql: {
      db: () => ({
        query: async (sql: string, params: unknown[] = []) => {
          sqls.push(sql);
          // Every connector table exists; connector_state holds one connected row.
          if (/FROM sqlite_master/i.test(sql)) return { ok: true, data: { rows: params.map((name) => [name]) } };
          return { ok: true, data: { rows: [["fireflies", "connected", null, null, null, 3]] } };
        },
        execute: async () => ({ ok: true, data: { rows: [] } }),
      }),
    },
  } as unknown as TinyCloudWeb;
  return { tcw, sqls };
}

test("getConnection probes the schema until ensureSchema has proved it, then reads the row directly", async () => {
  const { tcw, sqls } = fixture();

  const before = await getConnection(tcw, "fireflies");
  expect(before.ok && before.data?.itemCount).toBe(3);
  expect(sqls.filter((sql) => /FROM sqlite_master/i.test(sql))).toHaveLength(1);

  expect((await ensureSchema(tcw)).ok).toBe(true);
  sqls.length = 0;

  const after = await getConnection(tcw, "fireflies");
  expect(after.ok && after.data?.itemCount).toBe(3);
  expect(sqls).toHaveLength(1);
  expect(sqls[0]).toMatch(/FROM connector_state/i);
});
