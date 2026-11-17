import { expect, test } from "bun:test";
import { doneText, NOT_DELETED, pendingText } from "./recordingsDeletedCopy";

const SHARED = "Recordings others shared with you are removed from your list; the people who shared them still have them.";
const none = { own: 0, shared: 0, notDeleted: 0, voiceNotes: 0 };
const OWN = "Your meeting recordings, voice notes and uploads are deleted from the notetaker service and TinyCloud Private Transcription.";

test("(1) own only: one line for one or many, no counts", () => {
  for (const own of [1, 2, 3]) expect(doneText({ ...none, own })).toBe(OWN);
});

test("(2) own and shared: the shared sentence says the people who shared them still have them", () => {
  for (const [own, shared] of [[2, 1], [5, 3], [1, 4]] as const) {
    expect(doneText({ ...none, own, shared })).toBe(`${OWN} ${SHARED}`);
  }
});

test("(3) shared only: nothing of theirs was deleted, and it does not claim otherwise", () => {
  const text = doneText({ ...none, shared: 2 });
  expect(text).toBe(`You had no recordings, voice notes or uploads of your own to delete. ${SHARED}`);
  expect(text).not.toMatch(/\bare deleted\b/);
  expect(text).not.toMatch(/\d/);
});

test("(4) nothing at all", () => {
  expect(doneText(none)).toBe("You have no recordings, voice notes or uploads to delete.");
});

test("an own entry the provider did not attribute to the account is never called deleted, shared, or absent", () => {
  // Only such entries: not "no recordings of your own", not "deleted".
  const only = doneText({ ...none, notDeleted: 2 });
  expect(only).toBe("Some recordings were removed from your list but are still with the notetaker service. To have them deleted, email team@tinycloud.xyz.");
  // Alongside confirmed deletes and shared ones: each is said once, in that order.
  expect(doneText({ ...none, own: 1, shared: 1, notDeleted: 1 })).toBe(`${OWN} ${NOT_DELETED} ${SHARED}`);
  expect(doneText({ ...none, shared: 1, notDeleted: 1 })).toBe(`${NOT_DELETED} ${SHARED}`);
});

test("voice notes and uploads deleted with no meeting recording of their own still say deleted, never 'nothing of yours'", () => {
  expect(doneText({ ...none, voiceNotes: 2 })).toBe(OWN);
  expect(doneText({ ...none, voiceNotes: 1, shared: 1 })).toBe(`${OWN} ${SHARED}`);
});

test("an own delete still pending never says everything is deleted; the final removals may be said", () => {
  const pending = "Your voice notes and uploads are deleted. Your meeting recordings are being deleted; we keep trying until each one is gone.";
  expect(pendingText(none)).toBe(pending);
  expect(pendingText(none)).not.toContain("Your meeting recordings, voice notes and uploads are deleted");
  expect(pendingText({ shared: 2, notDeleted: 0 })).toBe(`${pending} ${SHARED}`);
  expect(pendingText({ shared: 0, notDeleted: 1 })).toBe(`${pending} ${NOT_DELETED}`);
});
