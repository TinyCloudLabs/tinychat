import { describe, expect, test } from "bun:test";

import {
  setPendingCompletion,
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
});
