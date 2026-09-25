import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { appendMessage, getThread, useLocalThreadStorage } from "../lib/threadStore";
import { getCanvas, saveCanvas, useLocalCanvasStorage } from "../lib/conversationCanvasStore";
import { appendCanvasMessage, branchAt, normalizeLegacyMessages } from "./canvas/model";
import { createMeetingMessageRegistry } from "./pendingHandoff";

test("promoted append writes Canvas only and leaves share-readable legacy messages unchanged", async () => {
  globalThis.HTMLElement ??= class {} as never;
  globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
  const { createHistoryAdapter, repositoryFromCanvas } = await import("./runtime");
  const tcw = {} as TinyCloudWeb;
  useLocalThreadStorage(tcw);
  useLocalCanvasStorage(tcw);
  const legacy = { message: { id: "u1", role: "user", content: [{ type: "text", text: "first" }] } } as never;
  await appendMessage(tcw, "thread-1", legacy);
  await saveCanvas(tcw, normalizeLegacyMessages([{ id: "u1", role: "user", content: "first" }], "thread-1"));
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
  await history.append({ message: { id: "u2", role: "user", content: [{ type: "text", text: "selected branch" }] } } as never);
  expect((await getThread(tcw, "thread-1"))?.messages).toHaveLength(1);
  expect((await getCanvas(tcw, "thread-1"))?.nodes.map((node) => node.id)).toEqual(["u1", "u2"]);
  const canvas = await getCanvas(tcw, "thread-1");
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

test("a promoted Canvas read failure fails closed without a legacy message insert", async () => {
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
      if (sql.includes("FROM settings")) return { ok: true, data: { rows: [["true"]] } };
      return { ok: true, data: { rows: [] } };
    },
    async execute(sql: string) { writes.push(sql); return { ok: true, data: { rows: [] } }; },
  };
  const tcw = { did: "did:test:canvas-failure", sql: { db: () => db } } as unknown as TinyCloudWeb;
  const origin = { tcw, threadId: "promoted", model: "model", turnId: "u2", activation: 1, space: "test", signal: new AbortController().signal };
  const selection = { beginTurn: async () => origin, assertActive: () => {}, needsFirstInsert: () => false, markFirstAppend: () => {}, isAppendSaved: () => true, confirmAppend: () => {} } as never;
  const history = createHistoryAdapter(tcw, "promoted", selection, () => {}, undefined, createMeetingMessageRegistry());
  await expect(history.append({ message: { id: "u2", role: "user", content: [{ type: "text", text: "must fail" }] } } as never)).rejects.toThrow("Canvas unavailable");
  expect(writes.some((sql) => sql.includes("INSERT INTO messages"))).toBe(false);
});
