import { expect, test } from "bun:test";
import { canvasDraftHoldsMove, holdsTypedWords, importHoldsMove, uploadHoldsMove } from "./unsavedWork";

test("a Canvas document draft holds the move only while it has words", () => {
  expect(canvasDraftHoldsMove("")).toBe(false);
  expect(canvasDraftHoldsMove("  \n ")).toBe(false);
  expect(canvasDraftHoldsMove("# Plan")).toBe(true);
  expect(holdsTypedWords("# Plan")).toBe(true);
});

test("the import dialog holds the move while it reads, shows what it found or writes, and only while open", () => {
  for (const phase of ["parsing", "ready", "importing"] as const) {
    expect(importHoldsMove(true, phase)).toBe(true);
    expect(importHoldsMove(false, phase)).toBe(false);
  }
  for (const phase of ["idle", "done", "error"] as const) expect(importHoldsMove(true, phase)).toBe(false);
});

test("the Upload sheet holds the move for a pasted transcript or a picked audio file, not for an empty sheet", () => {
  expect(uploadHoldsMove({ pastedText: "", pickedFile: false })).toBe(false);
  expect(uploadHoldsMove({ pastedText: "   ", pickedFile: false })).toBe(false);
  expect(uploadHoldsMove({ pastedText: "Me: hello", pickedFile: false })).toBe(true);
  expect(uploadHoldsMove({ pastedText: "", pickedFile: true })).toBe(true);
});
