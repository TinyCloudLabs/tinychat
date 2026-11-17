import { expect, test } from "bun:test";
import { doneLines } from "./recordingsDeletedCopy";

// TC-3136: a shared recording that was only dropped from the list must never be reported as deleted.

test("only own recordings: counted, singular for one", () => {
  expect(doneLines(1, 0)).toEqual(["Your recording is deleted."]);
  expect(doneLines(3, 0)).toEqual(["Your 3 recordings are deleted."]);
});

test("own and shared: the shared line says the owner still has it", () => {
  expect(doneLines(2, 1)).toEqual([
    "Your 2 recordings are deleted.",
    "1 recording shared with you is removed from your list; the person who shared it still has it.",
  ]);
  expect(doneLines(1, 4)).toEqual([
    "Your recording is deleted.",
    "4 recordings shared with you are removed from your list; the people who shared them still have them.",
  ]);
});

test("only shared: nothing of theirs was deleted, and it does not claim otherwise", () => {
  const lines = doneLines(0, 2);
  expect(lines).toEqual([
    "You had no recordings of your own to delete.",
    "2 recordings shared with you are removed from your list; the people who shared them still have them.",
  ]);
  expect(lines.join(" ")).not.toContain("are deleted");
  expect(doneLines(0, 1)[1]).toBe("1 recording shared with you is removed from your list; the person who shared it still has it.");
});

test("nothing at all", () => {
  expect(doneLines(0, 0)).toEqual(["You have no recordings to delete."]);
});
