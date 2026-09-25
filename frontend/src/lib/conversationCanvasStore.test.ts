import { describe, expect, test } from "bun:test";
import { getCanvas, isLocalCanvasStorage, saveCanvas, sanitizeCanvas, useLocalCanvasStorage } from "./conversationCanvasStore";

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
});
