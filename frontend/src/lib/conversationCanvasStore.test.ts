import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  mutateCanvas,
  promotedCanvasForTurn,
  recordPromotedChatMessage,
  sanitizeCanvas,
  selectCanvasBranch,
  setCanvasEnabled,
  useLocalCanvasStorage,
} from "./conversationCanvasStore";
import { activeAncestry, createDocument, placeDocument } from "../chat/canvas/model";

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
      if (/FROM sqlite_master/i.test(sql)) {
        return { ok: true, data: { rows: params.map((table) => [table]) } };
      }
      if (sql.includes("FROM settings")) {
        if (failSettingsReads > 0) {
          failSettingsReads--;
          return { ok: false, error: { code: "UNAVAILABLE", message: "settings unavailable" } };
        }
        const [from, to] = params;
        return { ok: true, data: { rows: [...settings].filter(([key]) => key >= from && key < to) } };
      }
      if (sql.includes("UNION ALL")) {
        return { ok: true, data: { rows: canvasThreads.has(params[0]) ? [["h", null, null, null, null, null, null]] : [] } };
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

const settingsReads = (statements: string[]) => statements.filter((sql) => /^SELECT key, value FROM settings/i.test(sql.trim())).length;

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
    await mutateCanvas(tcw, value.threadId, () => value);
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
    await mutateCanvas(tcw, value.threadId, () => value);
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
    await promoteLegacyThread(tcw, "chat");
    await selectCanvasBranch(tcw, "chat", "a1");
    expect(await chatIds(tcw, "chat")).toEqual(["u1", "a1"]);
    expect((await getThread(tcw, "chat"))?.messages[1]).toMatchObject({ receipt });
    // The other branch is kept in Canvas and can be picked back, intact.
    const reopened = await openCanvas(tcw, "chat");
    expect(reopened.canvas.nodes.map((node) => node.id)).toEqual(["u1", "a1", "u2", "a2"]);
    await selectCanvasBranch(tcw, "chat", "a2");
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

// ── Real SQLite, run the way the node runs a batch ──────────────────────────

/**
 * One shared "space" backed by real SQLite. Like the TinyCloud node, a batch
 * runs statement by statement and stops at the first error with the earlier
 * statements applied (not a transaction). Every client made by `device()`
 * is a separate tab or device with its own in-memory state.
 */
let spaces = 0;

class SharedSpace {
  private readonly did = `did:test:shared-space-${++spaces}`;
  private readonly databases = new Map<string, Database>();
  private devices = 0;
  /** Runs once, right before the next batch whose first statement matches. */
  private interleave: { match: string; run: () => Promise<void> } | null = null;

  private database(name: string): Database {
    let database = this.databases.get(name);
    if (!database) {
      database = new Database(":memory:");
      this.databases.set(name, database);
    }
    return database;
  }

  beforeNextBatch(match: string, run: () => Promise<void>): void {
    this.interleave = { match, run };
  }

  rows(name: string, sql: string, ...params: (string | number | null)[]): unknown[][] {
    return this.database(name).query(sql).values(...params) as unknown[][];
  }

  device(): Client {
    const handle = (name: string) => ({
      query: async (sql: string, params: (string | number | null)[] = []) => {
        try {
          return { ok: true as const, data: { rows: this.database(name).query(sql).values(...params) } };
        } catch (error) {
          return { ok: false as const, error: { code: "SQL", message: String(error) } };
        }
      },
      execute: async (sql: string, params: (string | number | null)[] = []) => {
        try {
          this.database(name).query(sql).run(...params);
          return { ok: true as const, data: { rows: [] } };
        } catch (error) {
          return { ok: false as const, error: { code: "SQL", message: String(error) } };
        }
      },
      batch: async (operations: Array<{ sql: string; params?: (string | number | null)[] }>) => {
        const interleave = this.interleave;
        if (interleave && operations[0]?.sql.includes(interleave.match)) {
          this.interleave = null;
          await interleave.run();
        }
        for (const operation of operations) {
          try {
            this.database(name).query(operation.sql).run(...(operation.params ?? []));
          } catch (error) {
            return { ok: false as const, error: { code: "SQL", message: String(error) } };
          }
        }
        return { ok: true as const, data: { rows: [] } };
      },
    });
    return {
      did: this.did,
      // Another tab or device is another process: give it its own per-chat
      // write queues (threadStore keys them by spaceId first).
      spaceId: `${this.did}#device-${++this.devices}`,
      sql: { db: handle },
      requestPermissions: async () => ({ approved: true }),
    } as unknown as Client;
  }
}

/** A space whose chat `chat` holds `messages` and is switched to Canvas by device A. */
async function sharedSwitchedChat(messages: StoredMessageItem[]) {
  const space = new SharedSpace();
  const a = space.device();
  for (const message of messages) await appendMessage(a, "chat", message);
  await setCanvasEnabled(a, true);
  await promoteLegacyThread(a, "chat");
  return { space, a };
}

/** How the chat runtime saves a sent message: Canvas record first, then the chat history. */
async function send(tcw: Client, message: StoredMessageItem) {
  await recordPromotedChatMessage(tcw, "chat", message);
  await appendMessage(tcw, "chat", message);
}

const childOf = (parentId: string, message: StoredMessageItem) => ({ ...message, parentId }) as StoredMessageItem;
const nodeIds = (canvas: { nodes: Array<{ id: string }> } | null) => (canvas?.nodes ?? []).map((node) => node.id).sort();

describe("Canvas never loses messages or edits made elsewhere", () => {
  test("regression: messages sent while the Canvas view is open survive picking an earlier branch", async () => {
    const { a } = await sharedSwitchedChat([item("u0", "user", "zero"), item("a0", "assistant", "zero reply")]);
    const view = await openCanvas(a, "chat"); // the view's copy: [u0, a0]
    expect(view.canvas.nodes.map((node) => node.id)).toEqual(["u0", "a0"]);
    await send(a, childOf("a0", item("u1", "user", "one")));
    await send(a, childOf("u1", item("a1", "assistant", "one reply")));

    await selectCanvasBranch(a, "chat", "u0"); // "Continue after" u0

    expect(await chatIds(a, "chat")).toEqual(["u0"]);
    const canvas = await getCanvas(a, "chat");
    expect(nodeIds(canvas)).toEqual(["a0", "a1", "u0", "u1"]);
    expect(canvas?.nodes.find((node) => node.id === "a1")?.parentId).toBe("u1");
    await selectCanvasBranch(a, "chat", "a1");
    expect(await chatIds(a, "chat")).toEqual(["u0", "a0", "u1", "a1"]);
  });

  test("a message only an older app wrote to the chat is kept as a branch when another branch is picked", async () => {
    const { a } = await sharedSwitchedChat([item("u0", "user", "zero"), item("a0", "assistant", "zero reply")]);
    await openCanvas(a, "chat");
    await appendMessage(a, "chat", item("u1", "user", "from an older app")); // no Canvas record
    await selectCanvasBranch(a, "chat", "u0");
    expect(await chatIds(a, "chat")).toEqual(["u0"]);
    const canvas = await getCanvas(a, "chat");
    expect(canvas?.nodes.find((node) => node.id === "u1")).toMatchObject({ parentId: "a0", content: "from an older app" });
  });

  test("two devices: a send landing between a branch switch's read and write is kept, never erased", async () => {
    const { space, a } = await sharedSwitchedChat([item("u0", "user", "zero"), item("a0", "assistant", "zero reply")]);
    const b = space.device();
    // Device B, an older Exo build that only knows the chat history, sends right
    // after device A read the chat for its switch and before A writes.
    space.beforeNextBatch("SELECT NULL, NULL, NULL, NULL", () => appendMessage(b, "chat", childOf("a0", item("u1", "user", "from device B"))));

    await selectCanvasBranch(a, "chat", "u0");

    expect(await chatIds(a, "chat")).toEqual(["u0"]);
    const canvas = await getCanvas(b, "chat");
    expect(canvas?.nodes.find((node) => node.id === "u1")).toMatchObject({ parentId: "a0", content: "from device B" });
    expect(canvas?.activeHeadId).toBe("u0");
    // Device B can bring its message back.
    await selectCanvasBranch(b, "chat", "u1");
    expect(await chatIds(b, "chat")).toEqual(["u0", "a0", "u1"]);
  });

  test("two tabs: concurrent Canvas edits keep both sides' documents and branches", async () => {
    const { space, a } = await sharedSwitchedChat([item("u0", "user", "zero"), item("a0", "assistant", "zero reply")]);
    const b = space.device();
    await openCanvas(a, "chat");
    await openCanvas(b, "chat"); // both tabs hold a copy now

    // Tab B adds a branch and a document; tab A's document write is interleaved with B's.
    await selectCanvasBranch(b, "chat", "u0");
    await send(b, childOf("u0", item("u1", "user", "tab B branch")));
    space.beforeNextBatch("INSERT INTO canvas_revisions (thread_id, revision) SELECT", () =>
      mutateCanvas(b, "chat", (current) => placeDocument(createDocument(current!, { id: "doc-b", title: "B", markdown: "from B", now: "2" }), "doc-b", "doc-b:v1", { slot: "next-user" })).then(() => undefined));
    await mutateCanvas(a, "chat", (current) => placeDocument(createDocument(current!, { id: "doc-a", title: "A", markdown: "from A", now: "1" }), "doc-a", "doc-a:v1", { slot: "next-user" }));

    const canvas = await getCanvas(a, "chat");
    expect(canvas?.documents.map((doc) => doc.id).sort()).toEqual(["doc-a", "doc-b"]);
    expect(canvas?.placements.map((placement) => placement.id).sort()).toEqual(["doc-a:doc-a:v1", "doc-b:doc-b:v1"]);
    expect(nodeIds(canvas)).toEqual(["a0", "u0", "u1"]);
    expect(activeAncestry(canvas!)).toEqual(new Set(["u0", "u1"]));
    // Nothing was written over: each row exists once.
    expect(space.rows(CANVAS_SQL_DB_NAME, "SELECT COUNT(*) FROM canvas_document_versions")).toEqual([[2]]);
  });
});
