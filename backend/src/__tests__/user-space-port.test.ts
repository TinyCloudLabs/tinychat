import { describe, expect, it } from "bun:test";
import type { DelegatedAccess } from "@tinyboilerplate/server";
import { writeTranscriberMeeting, type NormalizedTranscriberMeeting } from "@tinyboilerplate/core";
import { delegatedConnectorPort } from "../services/user-space-port.js";

const normalized: NormalizedTranscriberMeeting = {
  meeting: {
    id: "3b11ee35-a938-830f-82b9-5f2f3be6dac8",
    source: "tinycloud-transcriber", sourceId: "mtg_no_ddl", title: "No DDL",
    startedAt: null, durationSecs: null, organizerEmail: null, participants: [],
    summaryOverview: null, summaryActionItems: null, keywords: null, meetingType: null, metadata: {},
  },
  body: "[]",
};

describe("backend delegated connector writer", () => {
  it("writes a row and body in a pre-existing schema without issuing DDL or PRAGMA", async () => {
    const sqlCalls: string[] = [];
    const bodies = new Map<string, string>();
    const access = {
      sql: { db: () => ({
        query: async (sql: string) => {
          sqlCalls.push(sql);
          if (!/^\s*SELECT\b/i.test(sql)) throw new Error("Non-read SQL reached the node");
          return { ok: true, data: { rows: [] } };
        },
        execute: async (sql: string) => {
          sqlCalls.push(sql);
          if (/\b(CREATE|ALTER|DROP|PRAGMA)\b/i.test(sql)) throw new Error("DDL reached the node");
          return { ok: true, data: {} };
        },
      }) },
      kv: { put: async (key: string, body: string) => {
        bodies.set(key, body);
        return { ok: true, data: {} };
      } },
    } as unknown as DelegatedAccess;
    let writes = 0;
    const port = delegatedConnectorPort(access, async (operation) => { writes++; return operation(); });
    const result = await writeTranscriberMeeting(port, normalized, { ensureSchema: false });
    expect(result).toEqual({ ok: true, data: { id: normalized.meeting.id, row: "inserted", body: "written" } });
    expect(sqlCalls.map((sql) => sql.trim().split(/\s+/, 1)[0]!.toUpperCase())).toEqual(["SELECT", "INSERT"]);
    expect([...bodies.values()]).toEqual(["[]"]);
    expect(writes).toBe(2);
  });

  it("rejects any attempted DDL before it reaches the delegated node", async () => {
    let nodeCalls = 0;
    const access = {
      sql: { db: () => ({
        query: async () => { nodeCalls++; return { ok: true, data: { rows: [] } }; },
        execute: async () => { nodeCalls++; return { ok: true, data: {} }; },
      }) },
      kv: {},
    } as unknown as DelegatedAccess;
    const port = delegatedConnectorPort(access, async (operation) => operation());
    for (const statement of ["CREATE TABLE x (id INT)", "ALTER TABLE x ADD y INT", "DROP TABLE x", "PRAGMA writable_schema=ON"]) {
      await expect(port.execute(statement)).rejects.toThrow("must be INSERT");
      await expect(port.query(statement, [])).rejects.toThrow("must be SELECT");
    }
    await expect(port.execute("INSERT INTO connector_meeting VALUES (1); DROP TABLE connector_meeting")).rejects.toThrow("must be INSERT");
    await expect(port.query("SELECT id FROM connector_meeting; PRAGMA writable_schema=ON", [])).rejects.toThrow("must be SELECT");
    expect(nodeCalls).toBe(0);
  });
});
