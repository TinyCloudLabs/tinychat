import { describe, expect, test } from "bun:test";
import { assembleRequestContext, getRequestAttempt, publishRequestAttempt, resetRequestAttempt } from "./requestContext";
import { createDocument, normalizeLegacyMessages, placeDocument, saveDocumentVersion, setDocumentPlacementSlot } from "./model";

describe("canvas request context", () => {
  test("orders memory, meeting, active branch, pinned v1, and new user", () => {
    let canvas = normalizeLegacyMessages([
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "reply" },
      { id: "u-sibling", role: "user", content: "sibling" },
    ], "t1");
    canvas.activeHeadId = "a1";
    canvas = createDocument(canvas, { id: "d1", title: "Brief", markdown: "UNIQUE-V1", now: "1" });
    canvas = placeDocument(canvas, "d1", "d1:v1", 0);
    canvas = saveDocumentVersion(canvas, "d1", "UNIQUE-V2", "2");
    const result = assembleRequestContext({ canvas, memoryPrelude: "memory", meetingSystemBlock: "meeting", newUserMessage: "next" });
    expect(result.payload.map((message) => message.content)).toEqual(["memory", "meeting", "first", "reply", "[Pinned document: Brief — version 1]\nUNIQUE-V1\n[/Pinned document]", "next"]);
    expect(JSON.stringify(result.payload)).not.toContain("UNIQUE-V2");
    expect(JSON.stringify(result.payload)).not.toContain("sibling");
  });

  test("rejects a sibling compaction checkpoint and falls back to active branch", () => {
    const canvas = normalizeLegacyMessages([{ id: "u1", role: "user", content: "first" }, { id: "a1", role: "assistant", content: "reply" }], "t1");
    const result = assembleRequestContext({ canvas, compaction: { summary: "wrong sibling", coversThroughMessageId: "missing" }, newUserMessage: "next" });
    expect(result.messages.map((message) => message.content)).toEqual(["first", "reply", "next"]);
  });

  test("does not duplicate a user message already mirrored into the graph", () => {
    const canvas = normalizeLegacyMessages([{ id: "u1", role: "user", content: "already saved" }], "t1");
    const result = assembleRequestContext({ canvas, newUserMessage: "already saved", newUserMessageId: "u1" });
    expect(result.messages.map((message) => message.content)).toEqual(["already saved"]);
  });

  test("attempt payload is memory-only and replaced for retry", () => {
    expect(getRequestAttempt("thread-a")).toBe(getRequestAttempt("thread-a"));
    publishRequestAttempt("thread-a", "preparing", [{ role: "user", content: "draft" }]);
    expect(getRequestAttempt("thread-a")).toEqual({ threadId: "thread-a", state: "preparing", payload: [{ role: "user", content: "draft" }] });
    publishRequestAttempt("thread-a", "sent", [{ role: "user", content: "retry payload" }]);
    expect(getRequestAttempt("thread-a").payload?.[0].content).toBe("retry payload");
    expect(getRequestAttempt("thread-b").state).toBe("draft");
    resetRequestAttempt("thread-a");
    expect(getRequestAttempt("thread-a").state).toBe("draft");
  });

  test("honors a document insertion anchor instead of appending by geometry", () => {
    let canvas = normalizeLegacyMessages([{ id: "u1", role: "user", content: "first" }, { id: "a1", role: "assistant", content: "answer" }], "t1");
    canvas = createDocument(canvas, { id: "d1", title: "Context", markdown: "anchored", now: "1" });
    canvas = placeDocument(canvas, "d1", "d1:v1", { order: 99, beforeMessageId: "a1", slot: "before" });
    const result = assembleRequestContext({ canvas, newUserMessage: "next" });
    expect(result.messages.map((message) => message.content)).toEqual(["first", "[Pinned document: Context — version 1]\nanchored\n[/Pinned document]", "answer", "next"]);
  });

  test("changing a pinned slot changes request order", () => {
    let canvas = createDocument(normalizeLegacyMessages([{ id: "u1", role: "user", content: "first" }, { id: "a1", role: "assistant", content: "answer" }], "t1"), { id: "d1", title: "Context", markdown: "slot", now: "1" });
    canvas = placeDocument(canvas, "d1", "d1:v1", { slot: "next-user" });
    expect(assembleRequestContext({ canvas, newUserMessage: "next" }).messages.at(-2)?.content).toContain("Pinned document");
    canvas = setDocumentPlacementSlot(canvas, "d1:d1:v1", { beforeMessageId: "a1", slot: "before" });
    expect(assembleRequestContext({ canvas, newUserMessage: "next" }).messages.map((message) => message.content)).toEqual(["first", "[Pinned document: Context — version 1]\nslot\n[/Pinned document]", "answer", "next"]);
  });

  test("exposes stable document and message identities for drag ordering", () => {
    let canvas = normalizeLegacyMessages([{ id: "u1", role: "user", content: "first" }], "t1");
    canvas = createDocument(canvas, { id: "d1", title: "Context", markdown: "drag me", now: "1" });
    canvas = placeDocument(canvas, "d1", "d1:v1", { slot: "next-user" });
    const result = assembleRequestContext({ canvas, newUserMessage: "next" });
    expect(result.entries.map(({ kind, sourceId, placementId }) => ({ kind, sourceId, placementId }))).toEqual([
      { kind: "message", sourceId: "u1", placementId: undefined },
      { kind: "document", sourceId: undefined, placementId: "d1:d1:v1" },
      { kind: "new-user", sourceId: undefined, placementId: undefined },
    ]);
  });
});
