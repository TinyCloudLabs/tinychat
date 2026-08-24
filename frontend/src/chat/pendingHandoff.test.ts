import { describe, expect, test } from "bun:test";

import {
  setPendingCompletion,
  createMeetingMessageRegistry,
  setPendingReceipt,
  takePendingCompletion,
  takePendingReceipt,
} from "./pendingHandoff";

describe("pendingHandoff per-message keying (ST4)", () => {
  test("two interleaved thread finishes do NOT cross-contaminate", () => {
    // Thread A's assistant message finishes, then thread B's assistant message
    // finishes while A's append is still pending — the classic race the single
    // module-level slot lost. Keyed by the (globally-unique) assistant message id.
    setPendingCompletion("msg-A", { completionId: "cmpl-A", model: "phala/a" });
    setPendingCompletion("msg-B", { completionId: "cmpl-B", model: "phala/b" });

    // Each append reads ITS OWN message's entry — no cross-keying.
    expect(takePendingCompletion("msg-A")).toEqual({
      completionId: "cmpl-A",
      model: "phala/a",
    });
    expect(takePendingCompletion("msg-B")).toEqual({
      completionId: "cmpl-B",
      model: "phala/b",
    });
  });

  test("take is read-and-clear (consumed once)", () => {
    setPendingCompletion("m1", { completionId: "x", model: "m" });
    expect(takePendingCompletion("m1")).not.toBeNull();
    expect(takePendingCompletion("m1")).toBeNull();
  });

  test("an unknown message yields null (no badge, never a wrong one)", () => {
    expect(takePendingCompletion("never-set")).toBeNull();
    expect(takePendingReceipt("never-set")).toBeNull();
  });

  test("receipts are keyed per message too", () => {
    setPendingReceipt("msg-A", {
      usage: { promptTokens: 1, completionTokens: 2 },
      modelId: "phala/a",
    });
    setPendingReceipt("msg-B", {
      usage: { promptTokens: 3, completionTokens: 4 },
      modelId: "phala/b",
    });
    expect(takePendingReceipt("msg-B")?.modelId).toBe("phala/b");
    expect(takePendingReceipt("msg-A")?.modelId).toBe("phala/a");
    expect(takePendingReceipt("msg-A")).toBeNull();
  });

  test("meeting classifications are thread-qualified and retained", () => {
    const registry = createMeetingMessageRegistry();
    registry.classify({ threadId: "thread-a", assistantMessageId: "same-id" });
    expect(registry.isClassified("thread-a", "same-id")).toBe(true);
    expect(registry.isClassified("thread-b", "same-id")).toBe(false);
    expect(registry.isClassified("thread-a", "same-id")).toBe(true);
  });

  test("uses a thread/user correlation when assistant-ui omits its optional assistant message id", () => {
    const registry = createMeetingMessageRegistry();
    registry.classify({ threadId: "meeting-thread", userMessageId: "user-1" });
    expect(registry.resolveAssistant({ threadId: "other-thread", userMessageId: "user-1", assistantMessageId: "ordinary" })).toBe(false);
    expect(registry.resolveAssistant({ threadId: "meeting-thread", userMessageId: "user-1", assistantMessageId: "append-provided-id" })).toBe(true);
    expect(registry.isClassified("meeting-thread", "append-provided-id")).toBe(true);
  });

  test("does not evict a live meeting classification under capacity pressure", () => {
    const registry = createMeetingMessageRegistry();
    registry.classify({ threadId: "t", assistantMessageId: "old-meeting" });
    for (let index = 0; index < 1_100; index += 1) registry.classify({ threadId: "t", assistantMessageId: `meeting-${index}` });
    expect(registry.isClassified("t", "old-meeting")).toBe(true);
  });

  test("meeting classification can be checked without consuming it for an append retry", () => {
    const registry = createMeetingMessageRegistry();
    registry.classify({ threadId: "t", userMessageId: "u" });
    expect(registry.resolveAssistant({ threadId: "t", userMessageId: "u", assistantMessageId: "retry-message" })).toBe(true);
    expect(registry.resolveAssistant({ threadId: "t", userMessageId: "u", assistantMessageId: "retry-message" })).toBe(true);
  });

  test("meeting classification survives a slow stream and delayed append beyond five minutes", () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const registry = createMeetingMessageRegistry();
      registry.classify({ threadId: "t", assistantMessageId: "slow-message" });
      now = 10 * 60_000;
      expect(registry.isClassified("t", "slow-message")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  test("meeting-turn handoffs coexist with receipt and completion handoffs", () => {
    const registry = createMeetingMessageRegistry();
    registry.classify({ threadId: "t", assistantMessageId: "same-message" });
    setPendingReceipt("same-message", {
      usage: { promptTokens: 1, completionTokens: 2 },
      modelId: "phala/a",
    });
    setPendingCompletion("same-message", { completionId: "cmpl", model: "phala/a" });

    expect(registry.isClassified("t", "same-message")).toBe(true);
    expect(takePendingReceipt("same-message")?.modelId).toBe("phala/a");
    expect(takePendingCompletion("same-message")?.completionId).toBe("cmpl");
  });

  test("a newly mounted workspace registry is empty", () => {
    const existing = createMeetingMessageRegistry();
    existing.classify({ threadId: "t", assistantMessageId: "m" });
    expect(createMeetingMessageRegistry().isClassified("t", "m")).toBe(false);
  });
});
