import { describe, expect, test } from "bun:test";
import { activeAncestry, appendCanvasMessage, branchAt, createDocument, moveDocumentPlacementTo, normalizeLegacyMessages, placeDocument, saveDocumentVersion } from "./model";

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
});
