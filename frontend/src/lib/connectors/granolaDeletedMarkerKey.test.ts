import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_KV_PREFIX, deleteGranolaMeeting, granolaDeletedKvKey, isGranolaMeetingDeleted } from "./connectorStore";

describe("Granola deleted-meeting marker key", () => {
  test("is the SHA-256 hex of the source id under the deleted prefix", async () => {
    expect(await granolaDeletedKvKey("abc")).toBe(
      `${CONNECTORS_KV_PREFIX}/granola/deleted/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`,
    );
  });

  test("differs per id and carries no part of the id", async () => {
    const id = "csv-0123456789abcdef0123456789abcdef";
    const a = await granolaDeletedKvKey(id);
    const b = await granolaDeletedKvKey(`${id}x`);
    expect(a).not.toBe(b);
    expect(a.includes(id)).toBe(false);
    expect(a.slice(`${CONNECTORS_KV_PREFIX}/granola/deleted/`.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a delete writes only the hashed key and the marker reads back under it", async () => {
    const entries = new Map<string, string>();
    const kv = {
      async get(key: string) {
        return entries.has(key)
          ? { ok: true as const, data: { data: entries.get(key) } }
          : { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } };
      },
      async put(key: string, value: unknown) { entries.set(key, String(value)); return { ok: true as const, data: undefined }; },
      async delete(key: string) { return entries.delete(key) ? { ok: true as const, data: undefined } : { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } }; },
      async list() { return { ok: true as const, data: { keys: [...entries.keys()] } }; },
    };
    const db = {
      async query(sql: string) {
        if (sql.includes("sqlite_master")) return { ok: true as const, data: { rows: [["connector_meeting"], ["connector_state"]] } };
        return { ok: true as const, data: { rows: [] } };
      },
      async execute() { return { ok: true as const, data: { changes: 0 } }; },
      async batch() { return { ok: true as const, data: [] }; },
    };
    const tcw = { kv, sql: { db: () => db }, spaces: {} } as unknown as TinyCloudWeb;
    const result = await deleteGranolaMeeting(tcw, "granola", "granola-note-id-1");
    expect(result.ok).toBe(true);
    const markers = [...entries.keys()].filter((key) => key.startsWith(`${CONNECTORS_KV_PREFIX}/granola/deleted/`));
    expect(markers).toEqual([await granolaDeletedKvKey("granola-note-id-1")]);
    expect([...entries.keys()].some((key) => key.includes("granola-note-id-1"))).toBe(false);
    expect(JSON.parse(entries.get(markers[0]!)!)).toEqual({ v: 1, deleted_at: expect.any(String) });
    expect(await isGranolaMeetingDeleted(tcw, "granola-note-id-1")).toEqual({ ok: true, data: true });
    expect(await isGranolaMeetingDeleted(tcw, "granola-note-id-2")).toEqual({ ok: true, data: false });
  });
});
