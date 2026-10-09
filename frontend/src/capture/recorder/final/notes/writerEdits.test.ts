import { describe, expect, test } from "bun:test";
import { applyEdit, continueEdit, keyEdit, toolEdit } from "./writerEdits";

const key = (
  k: string,
  extra: Partial<Parameters<typeof keyEdit>[0]> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  ...extra,
});

/** Enter at the caret, as the writer handles it: the text and caret after. */
function enter(value: string, caret = value.length) {
  const edit = keyEdit(key("Enter"), value, caret, caret);
  if (!edit) return null;
  return { value: applyEdit(value, edit), caret: edit.select[0] };
}

describe("Enter in the writer", () => {
  test("continues a bullet", () => {
    expect(enter("- one")).toEqual({ value: "- one\n- ", caret: 8 });
  });
  test("continues an indented bullet at its indent", () => {
    expect(enter("  - one")?.value).toBe("  - one\n  - ");
  });
  test("continues a checklist with an empty box", () => {
    expect(enter("- [x] done")?.value).toBe("- [x] done\n- [ ] ");
  });
  test("counts a numbered list on", () => {
    expect(enter("1. a\n2. b")?.value).toBe("1. a\n2. b\n3. ");
  });
  test("continues a quote", () => {
    expect(enter("> said")?.value).toBe("> said\n> ");
  });
  test("on an empty item ends the list", () => {
    expect(enter("- one\n- ")).toEqual({ value: "- one\n", caret: 6 });
    expect(enter("- [ ] ")?.value).toBe("");
  });
  test("leaves headings, plain lines, selections, Shift+Enter and composition alone", () => {
    expect(enter("## Title")).toBeNull();
    expect(enter("plain")).toBeNull();
    expect(continueEdit("- a", 0, 3)).toBeNull();
    expect(keyEdit(key("Enter", { shiftKey: true }), "- a", 3, 3)).toBeNull();
    expect(
      keyEdit(key("Enter", { isComposing: true }), "- a", 3, 3),
    ).toBeNull();
  });
});

describe("shortcuts and the formatting bar", () => {
  test("Cmd/Ctrl+B wraps the selection in bold", () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      const edit = keyEdit(key("b", mod), "say hi now", 4, 6)!;
      expect(applyEdit("say hi now", edit)).toBe("say **hi** now");
      expect(edit.select).toEqual([6, 8]);
    }
  });
  test("Cmd+I wraps in italics; a second press unwraps", () => {
    const wrapped = applyEdit(
      "a hi b",
      keyEdit(key("i", { metaKey: true }), "a hi b", 2, 4)!,
    );
    expect(wrapped).toBe("a *hi* b");
    expect(applyEdit(wrapped, toolEdit("italic", wrapped, 3, 5))).toBe(
      "a hi b",
    );
  });
  test("bold with nothing selected inserts a selected placeholder", () => {
    const edit = toolEdit("bold", "", 0, 0);
    expect(applyEdit("", edit)).toBe("**bold**");
    expect(edit.select).toEqual([2, 6]);
  });
  test("other keys are not the writer's", () => {
    expect(keyEdit(key("b"), "x", 0, 0)).toBeNull();
    expect(keyEdit(key("a", { metaKey: true }), "x", 0, 0)).toBeNull();
  });
  test("block tools prefix every touched line and toggle off", () => {
    const value = "one\ntwo\nthree";
    const bullets = applyEdit(value, toolEdit("bullets", value, 0, 6));
    expect(bullets).toBe("- one\n- two\nthree");
    expect(applyEdit(bullets, toolEdit("bullets", bullets, 0, 11))).toBe(
      "one\ntwo\nthree",
    );
    expect(applyEdit("a", toolEdit("checklist", "a", 0, 0))).toBe("- [ ] a");
    expect(applyEdit("a", toolEdit("quote", "a", 0, 0))).toBe("> a");
    expect(applyEdit("a", toolEdit("heading", "a", 1, 1))).toBe("## a");
  });
  test("switching list kinds replaces the old prefix", () => {
    expect(applyEdit("- a", toolEdit("checklist", "- a", 0, 0))).toBe(
      "- [ ] a",
    );
  });
});
