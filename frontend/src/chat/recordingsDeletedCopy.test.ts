import { expect, test } from "bun:test";
import { doneText, pendingText } from "./recordingsDeletedCopy";

// TC-3136: a shared recording that was only dropped from the list must never be reported as deleted,
// and nothing is called "deleted" while any of the account's own deletes is unconfirmed.

const SHARED = "Recordings others shared with you are removed from your list; the people who shared them still have them.";

test("(1) own only: one line for one or many, no counts", () => {
  expect(doneText(3, 0)).toBe("Your recordings are deleted.");
  expect(doneText(2, 0)).toBe("Your recordings are deleted.");
  expect(doneText(1, 0)).toBe("Your recordings are deleted.");
});

test("(2) own and shared: the shared sentence says the people who shared them still have them", () => {
  expect(doneText(2, 1)).toBe(`Your recordings are deleted. ${SHARED}`);
  expect(doneText(5, 3)).toBe(`Your recordings are deleted. ${SHARED}`);
  expect(doneText(1, 4)).toBe(`Your recordings are deleted. ${SHARED}`);
});

test("(3) shared only: nothing of theirs was deleted, and it does not claim otherwise", () => {
  const text = doneText(0, 2);
  expect(text).toBe(`You had no recordings of your own to delete. ${SHARED}`);
  expect(text).not.toContain("are deleted");
  expect(doneText(0, 1)).toBe(text);
});

test("(4) nothing at all", () => {
  expect(doneText(0, 0)).toBe("You have no recordings to delete.");
});

test("an own delete still pending never says it is deleted; a shared removal may be said", () => {
  expect(pendingText(0)).toBe("Your recordings are being deleted. We keep trying until each one is gone.");
  expect(pendingText(0)).not.toMatch(/\b(is|are) deleted\b/);
  expect(pendingText(2)).toBe(`Your recordings are being deleted. We keep trying until each one is gone. ${SHARED}`);
});
