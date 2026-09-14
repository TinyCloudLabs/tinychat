import { expect, test } from "bun:test";
import { prepareGeneralMessages } from "../transcripts/general-preparation.js";
test("general preparation preserves ordinary memory and checkpoint after classification", async () => {
  const params: any = {
    model: "synthetic",
    messages: [
      { id: "a", role: "user", content: "old" },
      { id: "private-user", role: "user", content: "PRIVATE QUESTION" },
      { id: "b", role: "assistant", content: "PRIVATE", private: true },
      { id: "c", role: "user", content: "hello" },
    ],
    preparation: {
      memory: "Remember concise answers",
      checkpoint: {
        id: "ordinary-v3:cp",
        threadId: "t",
        coversThroughMessageId: "a",
        summary: "Prior public context",
        createdAt: "",
      },
    },
    config: {},
    remainingMs: () => 120000,
  };
  const result = await prepareGeneralMessages(params, async () => {
    throw new Error("unexpected provider");
  });
  expect(JSON.stringify(result.messages)).not.toContain("PRIVATE");
  expect(JSON.stringify(result.messages)).toContain("Prior public context");
  expect(result.messages[0].content).toContain("Remember concise answers");
});
test("compaction never promotes private prose and returns an append-only checkpoint", async () => {
  const requests: any[] = [];
  const params: any = {
    model: "synthetic",
    messages: Array.from({ length: 24 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? "assistant" : "user",
      content: i === 3 ? "PRIVATE SENTINEL" : "x".repeat(30000),
      private: i === 3,
    })),
    preparation: { memory: "Preference", checkpoint: null },
    config: {},
    remainingMs: () => 120000,
  };
  const result = await prepareGeneralMessages(params, async (req: any) => {
    requests.push(req);
    return {
      content: "Public summary",
      calls: [],
      complete: true,
      promptTokens: 10,
      completionTokens: 2,
      completionId: "cp",
    };
  });
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain("PRIVATE SENTINEL");
  expect(result.checkpoint?.summary).toBe("Public summary");
  expect(result.promptTokens).toBe(10);
});

test("malformed checkpoints are rejected before any general provider call", async () => {
  const params: any = {
    model: "synthetic",
    messages: [{ id: "a", role: "user", content: "Hello" }],
    preparation: {
      memory: "",
      checkpoint: {
        coversThroughMessageId: "a",
        summary: { private: "sentinel" },
      },
    },
    config: {},
  };
  await expect(
    prepareGeneralMessages(params, async () => {
      throw new Error("unexpected model");
    }),
  ).rejects.toThrow("invalid_checkpoint");
});
test("legacy checkpoint rows cannot promote unknown private summary provenance", async () => {
  const params: any = {
    model: "synthetic",
    messages: [
      { id: "a", role: "user", content: "Ordinary preserved history" },
    ],
    preparation: {
      memory: "",
      checkpoint: {
        id: "legacy-cp",
        coversThroughMessageId: "a",
        summary: "PRIVATE LEGACY SENTINEL",
      },
    },
    config: {},
  };
  const result = await prepareGeneralMessages(params, async () => {
    throw new Error("unexpected model");
  });
  expect(JSON.stringify(result.messages)).not.toContain(
    "PRIVATE LEGACY SENTINEL",
  );
  expect(JSON.stringify(result.messages)).toContain(
    "Ordinary preserved history",
  );
});
