import { describe, expect, test } from "bun:test";
import {
  CANVAS_SQL_DB_NAME,
  getCanvas,
  getCanvasEnabled,
  isCanvasPromoted,
  isLocalCanvasStorage,
  promoteLegacyThread,
  saveCanvas,
  sanitizeCanvas,
  setCanvasEnabled,
  useLocalCanvasStorage,
} from "./conversationCanvasStore";

/** A remote-shaped client that records which SQL databases and statements are touched. */
function recordingClient(did: string, settings: Map<string, string>) {
  const databases: string[] = [];
  const statements: string[] = [];
  const db = (name: string) => ({
    async batch(operations: Array<{ sql: string }>) {
      databases.push(name);
      statements.push(...operations.map((operation) => operation.sql));
      return { ok: true, data: { rows: [] } };
    },
    async query(sql: string, params: string[] = []) {
      databases.push(name);
      statements.push(sql);
      if (sql.includes("FROM settings")) {
        const value = settings.get(params[0]);
        return { ok: true, data: { rows: value === undefined ? [] : [[value]] } };
      }
      return { ok: true, data: { rows: [] } };
    },
    async execute(sql: string, params: string[] = []) {
      databases.push(name);
      statements.push(sql);
      if (sql.startsWith("INSERT INTO settings")) settings.set(params[0], params[1]);
      return { ok: true, data: { rows: [] } };
    },
  });
  const tcw = { did, sql: { db } } as unknown as Parameters<typeof useLocalCanvasStorage>[0];
  return { tcw, databases, statements };
}

describe("conversation canvas store", () => {
  test("uses a separate browser-owned local store and round-trips branches/docs", async () => {
    const tcw = {} as Parameters<typeof useLocalCanvasStorage>[0];
    useLocalCanvasStorage(tcw);
    const value = {
      version: 1 as const,
      threadId: "thread-1",
      nodes: [{ id: "u1", parentId: null, role: "user" as const, content: "hello", createdAt: "1" }],
      activeHeadId: "u1",
      documents: [],
      placements: [],
    };
    await saveCanvas(tcw, value);
    expect(isLocalCanvasStorage(tcw)).toBe(true);
    expect(await getCanvas(tcw, "thread-1")).toEqual(value);
  });

  test("sanitizes transient nodes at the persistence boundary and reparents durable children", async () => {
    const tcw = {} as Parameters<typeof useLocalCanvasStorage>[0];
    useLocalCanvasStorage(tcw);
    const value = {
      version: 1 as const, threadId: "thread-transient", activeHeadId: "meeting",
      nodes: [
        { id: "u1", parentId: null, role: "user" as const, content: "question", createdAt: "1" },
        { id: "meeting", parentId: "u1", role: "assistant" as const, content: "secret", createdAt: "2", transient: true },
        { id: "a1", parentId: "meeting", role: "assistant" as const, content: "durable", createdAt: "3" },
      ], documents: [], placements: [],
    };
    await saveCanvas(tcw, value);
    expect(await getCanvas(tcw, "thread-transient")).toMatchObject({ activeHeadId: "u1", nodes: [{ id: "u1", parentId: null }, { id: "a1", parentId: "u1" }] });
    expect(sanitizeCanvas(value).nodes.map((node) => node.id)).toEqual(["u1", "a1"]);
  });

  test("an account that never opted in never touches Canvas storage", async () => {
    const { tcw, databases, statements } = recordingClient("did:test:never-opted-in", new Map());
    expect(await getCanvasEnabled(tcw)).toBe(false);
    expect(await getCanvas(tcw, "thread-1")).toBeNull();
    expect(await isCanvasPromoted(tcw, "thread-1")).toBe(false);
    expect(await getCanvas(tcw, "thread-2")).toBeNull();
    await expect(promoteLegacyThread(tcw, "thread-1")).rejects.toThrow("Turn on Conversation Canvas");
    expect(databases).not.toContain(CANVAS_SQL_DB_NAME);
    // One memoized flag read, not one per chat load/append.
    expect(statements.filter((sql) => sql.includes("FROM settings"))).toHaveLength(1);
  });

  test("opting in stores the flag with the cross-device settings and opens the gate", async () => {
    const settings = new Map<string, string>();
    const { tcw, databases } = recordingClient("did:test:opted-in", settings);
    expect(await getCanvasEnabled(tcw)).toBe(false);
    await setCanvasEnabled(tcw, true);
    expect(settings.get("conversation-canvas-enabled")).toBe("true");
    expect(await getCanvasEnabled(tcw)).toBe(true);
    expect(databases).not.toContain(CANVAS_SQL_DB_NAME);
    expect(await getCanvas(tcw, "thread-1")).toBeNull();
    expect(databases).toContain(CANVAS_SQL_DB_NAME);
  });

  test("turning Canvas off keeps promoted chats graph-backed", async () => {
    const settings = new Map([
      ["conversation-canvas-enabled", "false"],
      ["conversation-canvas-promoted:thread-1", "true"],
    ]);
    const { tcw } = recordingClient("did:test:opted-out", settings);
    expect(await getCanvasEnabled(tcw)).toBe(false);
    expect(await isCanvasPromoted(tcw, "thread-1")).toBe(true);
  });
});
