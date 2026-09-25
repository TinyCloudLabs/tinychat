import { expect, test } from "bun:test";
import { normalizeLegacyMessages } from "./model";
import { toJsonCanvas } from "./jsonCanvas";

test("projects ancestry to JSON Canvas with integer geometry", () => {
  const canvas = normalizeLegacyMessages([{ id: "u", role: "user", content: "hello" }, { id: "a", role: "assistant", content: "world" }]);
  const exported = toJsonCanvas(canvas);
  expect(exported.nodes.every((node) => Number.isInteger(node.x) && Number.isInteger(node.y))).toBe(true);
  expect(exported.edges).toEqual([{ id: "u->a", fromNode: "u", toNode: "a" }]);
  expect(exported.nodes.find((node) => node.id === "u")?.text).toContain("hello");
});

test("transient meeting evidence is excluded from durable export", () => {
  const canvas = normalizeLegacyMessages([{ id: "u", role: "user", content: "hello" }]);
  canvas.nodes.push({ id: "meeting", parentId: "u", role: "assistant", content: "TRANSIENT-EVIDENCE", createdAt: "2", transient: true });
  const exported = toJsonCanvas(canvas);
  expect(JSON.stringify(exported)).not.toContain("TRANSIENT-EVIDENCE");
});
