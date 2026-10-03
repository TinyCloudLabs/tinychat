import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { appendMessage, getThread, setSetting, useLocalThreadStorage } from "../lib/threadStore";
import { getCanvas, promoteLegacyThread, useLocalCanvasStorage } from "../lib/conversationCanvasStore";
import { appendCanvasMessage, branchAt, normalizeLegacyMessages } from "./canvas/model";
import { createMeetingMessageRegistry } from "./pendingHandoff";

test("a chat switched to Canvas records each message in its Canvas and in the chat history every reader uses", async () => {
  globalThis.HTMLElement ??= class {} as never;
  globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
  const { createHistoryAdapter, repositoryFromCanvas } = await import("./runtime");
  const tcw = {} as TinyCloudWeb;
  useLocalThreadStorage(tcw);
  useLocalCanvasStorage(tcw);
  const legacy = { message: { id: "u1", role: "user", content: [{ type: "text", text: "first" }] } } as never;
  await appendMessage(tcw, "thread-1", legacy);
  await setSetting(tcw, "conversation-canvas-enabled", "true");
  await promoteLegacyThread(tcw, "thread-1");
  const origin = { tcw, threadId: "thread-1", model: "model", turnId: "u2", activation: 1, space: "test", signal: new AbortController().signal };
  const selection = {
    beginTurn: async () => origin,
    beginActiveTurn: async () => origin,
    assertActive: () => {},
    needsFirstInsert: () => false,
    markFirstAppend: () => {},
    isAppendSaved: () => true,
    confirmAppend: () => {},
  } as never;
  const history = createHistoryAdapter(tcw, "thread-1", selection, () => {}, undefined, createMeetingMessageRegistry());
  await history.append({ parentId: "u1", message: { id: "u2", role: "user", content: [{ type: "text", text: "selected branch" }] } } as never);
  expect((await getThread(tcw, "thread-1"))?.messages.map((item) => item.message.id)).toEqual(["u1", "u2"]);
  const canvas = await getCanvas(tcw, "thread-1");
  expect(canvas?.nodes.map((node) => [node.id, node.parentId])).toEqual([["u1", null], ["u2", "u1"]]);
  expect(canvas && repositoryFromCanvas(canvas).messages.map((item) => item.message.id)).toEqual(["u1", "u2"]);
});

test("repository hydration follows selected ancestry and excludes sibling", async () => {
  globalThis.HTMLElement ??= class {} as never;
  globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
  const { repositoryFromCanvas } = await import("./runtime");
  const { INTERNAL } = await import("@assistant-ui/react");
  let canvas = normalizeLegacyMessages([{ id: "u1", role: "user", content: "first" }, { id: "a1", role: "assistant", content: "original" }], "thread-2");
  canvas = branchAt(canvas, "u1");
  canvas = appendCanvasMessage(canvas, { id: "u2", role: "user", content: "alternate", createdAt: "3" });
  expect(repositoryFromCanvas(canvas).messages.map((item) => item.message.id)).toEqual(["u1", "u2"]);
  expect(repositoryFromCanvas(canvas).messages.map((item) => item.parentId)).toEqual([null, "u1"]);
  const assistantRepository = repositoryFromCanvas(normalizeLegacyMessages([
    { id: "u1", role: "user", content: "first" },
    { id: "a1", role: "assistant", content: "original" },
  ], "thread-2"));
  expect((assistantRepository.messages[1]?.message as { status?: unknown }).status).toEqual({
    type: "complete",
    reason: "stop",
  });
  expect((assistantRepository.messages[1]?.message as { metadata?: unknown }).metadata).toMatchObject({
    unstable_state: null,
    custom: {},
  });
  expect(() => new INTERNAL.MessageRepository().import(assistantRepository)).not.toThrow();
});

test("a Canvas outage on a switched chat fails the send before anything is saved", async () => {
  globalThis.HTMLElement ??= class {} as never;
  globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
  const { createHistoryAdapter } = await import("./runtime");
  const writes: string[] = [];
  const db = {
    async batch(operations: Array<{ sql: string }>) {
      writes.push(...operations.map((operation) => operation.sql));
      if (operations.some((operation) => operation.sql.includes("canvas_threads"))) throw new Error("Canvas unavailable");
      return { ok: true, data: { rows: [] } };
    },
    async query(sql: string) {
      if (sql.includes("FROM settings")) return { ok: true, data: { rows: [["conversation-canvas-promoted:promoted", "true"]] } };
      return { ok: true, data: { rows: [] } };
    },
    async execute(sql: string) { writes.push(sql); return { ok: true, data: { rows: [] } }; },
  };
  const tcw = { did: "did:test:canvas-failure", sql: { db: () => db }, requestPermissions: async () => ({ approved: true }) } as unknown as TinyCloudWeb;
  const origin = { tcw, threadId: "promoted", model: "model", turnId: "u2", activation: 1, space: "test", signal: new AbortController().signal };
  const selection = { beginTurn: async () => origin, assertActive: () => {}, needsFirstInsert: () => false, markFirstAppend: () => {}, isAppendSaved: () => true, confirmAppend: () => {} } as never;
  const history = createHistoryAdapter(tcw, "promoted", selection, () => {}, undefined, createMeetingMessageRegistry());
  await expect(history.append({ message: { id: "u2", role: "user", content: [{ type: "text", text: "must fail" }] } } as never)).rejects.toThrow("Canvas unavailable");
  expect(writes.some((sql) => sql.includes("INSERT INTO messages"))).toBe(false);
});

test("an ordinary chat's send never touches Canvas storage", async () => {
  globalThis.HTMLElement ??= class {} as never;
  globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
  const { createHistoryAdapter } = await import("./runtime");
  const databases: string[] = [];
  const writes: string[] = [];
  const db = (name: string) => ({
    async batch(operations: Array<{ sql: string }>) { databases.push(name); writes.push(...operations.map((operation) => operation.sql)); return { ok: true, data: { rows: [] } }; },
    async query(sql: string) {
      databases.push(name);
      if (sql.includes("FROM settings")) return { ok: true, data: { rows: [["conversation-canvas-enabled", "true"], ["conversation-canvas-promoted:other", "true"]] } };
      return { ok: true, data: { rows: [] } };
    },
    async execute(sql: string) { databases.push(name); writes.push(sql); return { ok: true, data: { rows: [] } }; },
  });
  const tcw = { did: "did:test:ordinary-chat", sql: { db } } as unknown as TinyCloudWeb;
  const origin = { tcw, threadId: "ordinary", model: "model", turnId: "u1", activation: 1, space: "test", signal: new AbortController().signal };
  const selection = { beginTurn: async () => origin, assertActive: () => {}, needsFirstInsert: () => false, markFirstAppend: () => {}, isAppendSaved: () => true, confirmAppend: () => {} } as never;
  const history = createHistoryAdapter(tcw, "ordinary", selection, () => {}, undefined, createMeetingMessageRegistry());
  await history.append({ message: { id: "u1", role: "user", content: [{ type: "text", text: "hello" }] } } as never);
  expect(writes.some((sql) => sql.includes("INSERT INTO messages"))).toBe(true);
  expect(databases).not.toContain("xyz.tinycloud.tinychat/canvas");
});
