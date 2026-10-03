import { describe, expect, test } from "bun:test";
import type { StoredMessageItem } from "./threadStore";
import { appendMessage, getThread, setSetting, useLocalThreadStorage } from "./threadStore";
import {
  CANVAS_ACCESS_MESSAGE,
  CANVAS_DISABLED_MESSAGE,
  CANVAS_PERMISSIONS,
  CANVAS_SQL_DB_NAME,
  getCanvas,
  getCanvasEnabled,
  isCanvasPromoted,
  isLocalCanvasStorage,
  loadCanvasState,
  openCanvas,
  promoteLegacyThread,
  promotedCanvasForTurn,
  saveCanvas,
  sanitizeCanvas,
  selectCanvasBranch,
  setCanvasEnabled,
  useLocalCanvasStorage,
} from "./conversationCanvasStore";
import { branchAt } from "../chat/canvas/model";

type Client = Parameters<typeof useLocalCanvasStorage>[0];

/**
 * A remote-shaped client that records which SQL databases and statements are
 * touched. `settings` backs the cross-device settings table; `canvasThreads`
 * lists chats that have a Canvas row.
 */
function recordingClient(did: string, options: {
  settings?: Map<string, string>;
  canvasThreads?: Set<string>;
  approve?: boolean;
  failSettingsReads?: number;
} = {}) {
  const settings = options.settings ?? new Map<string, string>();
  const canvasThreads = options.canvasThreads ?? new Set<string>();
  let failSettingsReads = options.failSettingsReads ?? 0;
  const databases: string[] = [];
  const statements: string[] = [];
  const permissionRequests: unknown[] = [];
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
        if (failSettingsReads > 0) {
          failSettingsReads--;
          return { ok: false, error: { code: "UNAVAILABLE", message: "settings unavailable" } };
        }
        const [from, to] = params;
        return { ok: true, data: { rows: [...settings].filter(([key]) => key >= from && key < to) } };
      }
      if (sql.includes("FROM canvas_threads")) {
        return { ok: true, data: { rows: canvasThreads.has(params[0]) ? [[null]] : [] } };
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
  const tcw = {
    did,
    sql: { db },
    async requestPermissions(permissions: unknown) {
      permissionRequests.push(permissions);
      return { approved: options.approve ?? true };
    },
  } as unknown as Client;
  return { tcw, settings, databases, statements, permissionRequests };
}

const settingsReads = (statements: string[]) => statements.filter((sql) => sql.includes("FROM settings")).length;

const item = (id: string, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}): StoredMessageItem => ({
  parentId: null,
  message: { id, role, content: [{ type: "text", text }], createdAt: "2026-10-01T00:00:00.000Z" },
  ...extra,
} as unknown as StoredMessageItem);

/** A local (in-memory) client holding one chat with `messages`. */
async function localChat(threadId: string, messages: StoredMessageItem[], enabled = true) {
  const tcw = {} as Client;
  useLocalThreadStorage(tcw);
  useLocalCanvasStorage(tcw);
  for (const message of messages) await appendMessage(tcw, threadId, message);
  if (enabled) await setSetting(tcw, "conversation-canvas-enabled", "true");
  return tcw;
}

const chatIds = async (tcw: Client, threadId: string) =>
  (await getThread(tcw, threadId))?.messages.map((stored) => (stored.message as { id: string }).id);

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

  test("an account that never opted in never touches Canvas storage, even across many turns", async () => {
    const { tcw, databases, statements, permissionRequests } = recordingClient("did:test:never-opted-in");
    expect(await getCanvasEnabled(tcw)).toBe(false);
    for (const threadId of ["t1", "t2", "t1", "t3"]) expect(await promotedCanvasForTurn(tcw, threadId)).toBeNull();
    expect(await isCanvasPromoted(tcw, "t1")).toBe(false);
    expect(databases).not.toContain(CANVAS_SQL_DB_NAME);
    expect(permissionRequests).toHaveLength(0);
    // One account-state read for the session, not one per chat or turn.
    expect(settingsReads(statements)).toBe(1);
  });

  test("with Canvas turned off only chats switched to Canvas touch Canvas storage", async () => {
    const { tcw, databases, statements } = recordingClient("did:test:turned-off", {
      settings: new Map([
        ["conversation-canvas-enabled", "false"],
        ["conversation-canvas-promoted:switched", "true"],
        ["conversation-canvas-promoted:reverted", "false"],
      ]),
      canvasThreads: new Set(["switched"]),
    });
    expect(await getCanvasEnabled(tcw)).toBe(false);
    expect(await promotedCanvasForTurn(tcw, "ordinary")).toBeNull();
    expect(await promotedCanvasForTurn(tcw, "reverted")).toBeNull();
    expect(databases).not.toContain(CANVAS_SQL_DB_NAME);
    expect(await promotedCanvasForTurn(tcw, "switched")).toMatchObject({ threadId: "switched" });
    expect(databases).toContain(CANVAS_SQL_DB_NAME);
    expect(settingsReads(statements)).toBe(1);
  });

  test("turning Canvas on asks for the canvas grant first; a declined request leaves it off", async () => {
    const declined = recordingClient("did:test:declined", { approve: false });
    await expect(setCanvasEnabled(declined.tcw, true)).rejects.toThrow(CANVAS_ACCESS_MESSAGE);
    expect(declined.permissionRequests).toEqual([CANVAS_PERMISSIONS]);
    expect(declined.settings.has("conversation-canvas-enabled")).toBe(false);
    expect(await getCanvasEnabled(declined.tcw)).toBe(false);

    const approved = recordingClient("did:test:approved");
    await setCanvasEnabled(approved.tcw, true);
    expect(approved.permissionRequests).toEqual([CANVAS_PERMISSIONS]);
    expect(approved.settings.get("conversation-canvas-enabled")).toBe("true");
    expect(await getCanvasEnabled(approved.tcw)).toBe(true);
    // Turning it off never prompts.
    await setCanvasEnabled(approved.tcw, false);
    expect(approved.permissionRequests).toHaveLength(1);
  });

  test("a failed account-state read surfaces to the thread list but never fails a send, and is retried", async () => {
    const { tcw, statements } = recordingClient("did:test:state-outage", {
      settings: new Map([["conversation-canvas-promoted:switched", "true"]]),
      canvasThreads: new Set(["switched"]),
      failSettingsReads: 2,
    });
    await expect(loadCanvasState(tcw)).rejects.toThrow("settings unavailable");
    expect(await promotedCanvasForTurn(tcw, "switched")).toBeNull();
    expect((await loadCanvasState(tcw)).promoted.has("switched")).toBe(true);
    expect(settingsReads(statements)).toBe(3);
  });

  test("opening Canvas on a chat that was never switched is a preview that writes nothing", async () => {
    const tcw = await localChat("chat", [item("u1", "user", "one"), item("a1", "assistant", "two")]);
    const opened = await openCanvas(tcw, "chat");
    expect(opened.promoted).toBe(false);
    expect(opened.canvas.nodes.map((node) => node.id)).toEqual(["u1", "a1"]);
    expect(await getCanvas(tcw, "chat")).toBeNull();
    expect(await isCanvasPromoted(tcw, "chat")).toBe(false);
  });

  test("switching a chat to Canvas needs the Settings opt-in", async () => {
    const tcw = await localChat("chat", [item("u1", "user", "one")], false);
    await expect(promoteLegacyThread(tcw, "chat")).rejects.toThrow(CANVAS_DISABLED_MESSAGE);
    expect(await isCanvasPromoted(tcw, "chat")).toBe(false);
  });

  test("picking a branch rewrites the chat history to exactly that branch, keeping each message intact", async () => {
    const receipt = { input: 1, output: 2, total: 3, modelId: "m" };
    const tcw = await localChat("chat", [
      item("u1", "user", "one"),
      item("a1", "assistant", "two", { receipt }),
      item("u2", "user", "three"),
      item("a2", "assistant", "four"),
    ]);
    const canvas = await promoteLegacyThread(tcw, "chat");
    await selectCanvasBranch(tcw, branchAt(canvas, "a1"));
    expect(await chatIds(tcw, "chat")).toEqual(["u1", "a1"]);
    expect((await getThread(tcw, "chat"))?.messages[1]).toMatchObject({ receipt });
    // The other branch is kept in Canvas and can be picked back, intact.
    const reopened = await openCanvas(tcw, "chat");
    expect(reopened.canvas.nodes.map((node) => node.id)).toEqual(["u1", "a1", "u2", "a2"]);
    await selectCanvasBranch(tcw, branchAt(reopened.canvas, "a2"));
    expect(await chatIds(tcw, "chat")).toEqual(["u1", "a1", "u2", "a2"]);
    expect((await getThread(tcw, "chat"))?.messages[3]).toMatchObject({ message: { id: "a2", content: [{ type: "text", text: "four" }] } });
  });

  test("messages added to the chat elsewhere (e.g. an older app) are folded into its Canvas", async () => {
    const tcw = await localChat("chat", [item("u1", "user", "one"), item("a1", "assistant", "two")]);
    await promoteLegacyThread(tcw, "chat");
    await appendMessage(tcw, "chat", item("u2", "user", "from another device"));
    const opened = await openCanvas(tcw, "chat");
    expect(opened.canvas.activeHeadId).toBe("u2");
    expect(opened.canvas.nodes.find((node) => node.id === "u2")).toMatchObject({ parentId: "a1", content: "from another device" });
    expect(await chatIds(tcw, "chat")).toEqual(["u1", "a1", "u2"]);
  });
});
