import { expect, test } from "bun:test";
import { doneText, NOT_DELETED, pendingText } from "./recordingsDeletedCopy";

const SHARED = "Recordings others shared with you are removed from your list; the people who shared them still have them.";
const none = { own: 0, shared: 0, notDeleted: 0 };

test("(1) own only: one line for one or many, no counts", () => {
  for (const own of [1, 2, 3]) expect(doneText({ ...none, own })).toBe("Your recordings are deleted.");
});

test("(2) own and shared: the shared sentence says the people who shared them still have them", () => {
  for (const [own, shared] of [[2, 1], [5, 3], [1, 4]] as const) {
    expect(doneText({ ...none, own, shared })).toBe(`Your recordings are deleted. ${SHARED}`);
  }
});

test("(3) shared only: nothing of theirs was deleted, and it does not claim otherwise", () => {
  const text = doneText({ ...none, shared: 2 });
  expect(text).toBe(`You had no recordings of your own to delete. ${SHARED}`);
  expect(text).not.toMatch(/\bare deleted\b/);
  expect(text).not.toMatch(/\d/);
});

test("(4) nothing at all", () => {
  expect(doneText(none)).toBe("You have no recordings to delete.");
});

test("an own entry the provider did not attribute to the account is never called deleted, shared, or absent", () => {
  // Only such entries: not "no recordings of your own", not "deleted".
  const only = doneText({ ...none, notDeleted: 2 });
  expect(only).toBe(NOT_DELETED);
  // Alongside confirmed deletes and shared ones: each is said once, in that order.
  expect(doneText({ own: 1, shared: 1, notDeleted: 1 })).toBe(`Your recordings are deleted. ${NOT_DELETED} ${SHARED}`);
  expect(doneText({ ...none, shared: 1, notDeleted: 1 })).toBe(`${NOT_DELETED} ${SHARED}`);
});

test("an own delete still pending never says it is deleted; the final removals may be said", () => {
  const pending = "Your recordings are being deleted. We keep trying until each one is gone.";
  expect(pendingText(none)).toBe(pending);
  expect(pendingText(none)).not.toMatch(/\b(is|are) deleted\b/);
  expect(pendingText({ shared: 2, notDeleted: 0 })).toBe(`${pending} ${SHARED}`);
  expect(pendingText({ shared: 0, notDeleted: 1 })).toBe(`${pending} ${NOT_DELETED}`);
});
