import { describe, expect, test } from "bun:test";
import {
  appendLine,
  hasNote,
  momentLine,
  parseMoments,
  removeLine,
  replaceLine,
} from "./momentLines";

describe("momentLine", () => {
  test("is a bold time then the text", () => {
    expect(momentLine(20_000, "Hunter mentions the TTL")).toBe(
      "- **0:20** Hunter mentions the TTL",
    );
  });
  test("an empty label is a bare timestamp", () => {
    expect(momentLine(42_900, "")).toBe("- **0:42**");
    expect(momentLine(42_900, "   ")).toBe("- **0:42**");
  });
  test("goes to h:mm:ss past an hour", () => {
    expect(momentLine(3_725_000, "x")).toBe("- **1:02:05** x");
  });
});

describe("parseMoments", () => {
  test("reads m:ss and h:mm:ss lines, in order, and ignores the rest", () => {
    const md = [
      "# Standup",
      "- **0:20** first",
      "some prose",
      "- **1:02:05** late",
      "- **0:42**",
      "- **soon** not a time",
      "- **0:99** not a time",
    ].join("\n");
    expect(parseMoments(md)).toEqual([
      { atMs: 20_000, label: "first" },
      { atMs: 3_725_000, label: "late" },
      { atMs: 42_000, label: "" },
    ]);
  });
  test("round-trips what the UI writes", () => {
    expect(parseMoments(momentLine(754_000, "a b"))).toEqual([
      { atMs: 754_000, label: "a b" },
    ]);
  });
});

describe("line edits", () => {
  test("append puts the line on its own row", () => {
    expect(appendLine("", "- **0:01**")).toEqual({
      md: "- **0:01**",
      index: 0,
    });
    expect(appendLine("hello\n\n", "- **0:01**")).toEqual({
      md: "hello\n- **0:01**",
      index: 1,
    });
  });
  test("replace and remove address a line", () => {
    expect(replaceLine("a\nb\nc", 1, "B")).toBe("a\nB\nc");
    expect(removeLine("a\nb\nc", 1)).toBe("a\nc");
    expect(removeLine("a", 0)).toBe("");
  });
  test("hasNote ignores whitespace", () => {
    expect(hasNote(null)).toBe(false);
    expect(hasNote(" \n ")).toBe(false);
    expect(hasNote("x")).toBe(true);
  });
});
