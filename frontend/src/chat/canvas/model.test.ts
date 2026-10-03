import { describe, expect, test } from "bun:test";
import { activeAncestry, alignActivePath, appendCanvasMessage, branchAt, createDocument, moveDocumentPlacementTo, normalizeLegacyMessages, placeDocument, saveDocumentVersion } from "./model";
import { assembleRequestContext } from "./requestContext";

const message = (id: string, role: "user" | "assistant", content: string) => ({ id, role, content });

describe("conversation canvas model", () => {
  test("normalizes legacy linear messages and branches without changing ancestry", () => {
    let canvas = normalizeLegacyMessages([message("u1", "user", "one"), message("a1", "assistant", "answer")], "t1");
    expect(canvas.nodes.map((node) => node.parentId)).toEqual([null, "u1"]);
    canvas = branchAt(canvas, "u1");
    canvas = appendCanvasMessage(canvas, { ...message("u2", "user", "alternate"), createdAt: "now" });
    expect(canvas.activeHeadId).toBe("u2");
    expect(activeAncestry(canvas)).toEqual(new Set(["u1", "u2"]));
    expect(canvas.nodes.find((node) => node.id === "a1")?.parentId).toBe("u1");
  });

  test("pins an immutable version while later versions remain available", () => {
    let canvas = normalizeLegacyMessages([], "t1");
    canvas = createDocument(canvas, { id: "d1", title: "Notes", markdown: "marker v1", now: "1" });
    canvas = placeDocument(canvas, "d1", "d1:v1", 0);
    canvas = saveDocumentVersion(canvas, "d1", "marker v2", "2");
    expect(canvas.placements[0].versionId).toBe("d1:v1");
    expect(canvas.documents[0].versions.map((version) => version.markdown)).toEqual(["marker v1", "marker v2"]);
  });

  test("moves a document to an exact message anchor and normalizes placement order", () => {
    let canvas = normalizeLegacyMessages([message("u1", "user", "one"), message("a1", "assistant", "answer")], "t1");
    canvas = createDocument(canvas, { id: "d1", title: "First", markdown: "first", now: "1" });
    canvas = createDocument(canvas, { id: "d2", title: "Second", markdown: "second", now: "2" });
    canvas = placeDocument(canvas, "d1", "d1:v1", { slot: "next-user" });
    canvas = placeDocument(canvas, "d2", "d2:v1", { slot: "next-user" });
    canvas = moveDocumentPlacementTo(canvas, "d2:d2:v1", { beforeMessageId: "a1", slot: "before" }, 0);
    expect(canvas.placements.map(({ id, order }) => [id, order])).toEqual([["d2:d2:v1", 0], ["d1:d1:v1", 1]]);
    expect(canvas.placements[0]).toMatchObject({ beforeMessageId: "a1", slot: "before" });
  });

  test("aligning to the chat history adds unseen messages, follows the chat's parents and keeps other branches", () => {
    let canvas = normalizeLegacyMessages([message("u1", "user", "one"), message("a1", "assistant", "answer")], "t1");
    canvas = appendCanvasMessage(branchAt(canvas, "u1"), { ...message("a2", "assistant", "alternate"), createdAt: "2" });
    const aligned = alignActivePath(canvas, [message("u1", "user", "one"), message("a1", "assistant", "answer"), message("u2", "user", "from elsewhere")]);
    expect(aligned.changed).toBe(true);
    expect(aligned.canvas.activeHeadId).toBe("u2");
    expect(aligned.canvas.nodes.map((node) => [node.id, node.parentId])).toEqual([["u1", null], ["a1", "u1"], ["a2", "u1"], ["u2", "a1"]]);
    expect(alignActivePath(aligned.canvas, [message("u1", "user", "one"), message("a1", "assistant", "answer"), message("u2", "user", "from elsewhere")]).changed).toBe(false);
  });

  test("a request in a switched chat carries exactly the chat history plus the pinned documents", () => {
    let canvas = normalizeLegacyMessages([message("u1", "user", "one"), message("a1", "assistant", "answer")], "t1");
    canvas = createDocument(canvas, { id: "d1", title: "Brief", markdown: "brief body", now: "1" });
    canvas = placeDocument(canvas, "d1", "d1:v1", { slot: "next-user" });
    // The chat gained u2/a2 on another device; this turn sends u3.
    const chat = [message("u1", "user", "one"), message("a1", "assistant", "answer"), message("u2", "user", "elsewhere"), message("a2", "assistant", "reply"), message("u3", "user", "now")];
    const request = assembleRequestContext({ canvas: alignActivePath(canvas, chat).canvas, newUserMessage: "now", newUserMessageId: "u3" });
    expect(request.messages.map((entry) => entry.content)).toEqual(["one", "answer", "elsewhere", "reply", "[Pinned document: Brief — version 1]\nbrief body\n[/Pinned document]", "now"]);
  });
});
