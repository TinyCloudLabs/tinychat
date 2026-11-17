import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  adoptStoredHistory,
  isConversationMarked,
  markOutsideContent,
  notePastedText,
  resetImageGateForTests,
  stampProvenance,
  takePastedText,
} from "./imageGate";

// Other files in the same run may have marked chats of their own: start from nothing.
beforeEach(resetImageGateForTests);
afterEach(resetImageGateForTests);

const text = (role: "user" | "assistant", body: string) => ({ message: { id: `${role}-${body}`, role, content: [{ type: "text", text: body }] } });
/** What the history adapter stores: the message plus the stamp the conversation had at that moment. */
const stored = (item: object, threadId: string) => JSON.parse(JSON.stringify(stampProvenance(item, threadId))) as object;

test("a new chat and a chat of only typed text and replies stay unmarked, across a reload", () => {
  expect(isConversationMarked("new")).toBe(false);
  adoptStoredHistory("new", []);
  expect(isConversationMarked("new")).toBe(false);

  const history = [stored(text("user", "hi"), "t1"), stored(text("assistant", "hello"), "t1")];
  resetImageGateForTests();
  adoptStoredHistory("t1", history);
  expect(isConversationMarked("t1")).toBe(false);
});

test("a conversation marked while it ran is derived as marked from its stored history after a reload", () => {
  const before = stored(text("user", "find the news"), "t2");
  markOutsideContent("t2"); // a search result entered
  const history = [before, stored(text("assistant", "here is an image"), "t2")];

  resetImageGateForTests(); // a reload: nothing is remembered but the stored messages
  expect(isConversationMarked("t2")).toBe(false);
  adoptStoredHistory("t2", history);
  expect(isConversationMarked("t2")).toBe(true);
});

test("a later message in a marked conversation stays marked, and the mark never clears", () => {
  markOutsideContent("t3");
  const later = stored(text("user", "thanks"), "t3");
  expect(later).toMatchObject({ provenance: { v: 1, outside: true } });
  adoptStoredHistory("t3", [stored(text("user", "x"), "t3-clean")]); // clean history adopted afterwards changes nothing
  expect(isConversationMarked("t3")).toBe(true);
});

test("history that does not vouch for itself counts as marked: no provenance, an outside part, an unknown part, an attachment", () => {
  const clean = stored(text("user", "hi"), "x");
  const cases: Record<string, object[]> = {
    "an older or imported message with no provenance": [text("user", "hi")],
    "provenance that says outside": [{ ...clean, provenance: { v: 1, outside: true } }],
    "a provenance version it does not know": [{ ...clean, provenance: { v: 2, outside: false } }],
    "a tool-call part": [{ ...clean, message: { role: "assistant", content: [{ type: "tool-call", toolName: "web_search" }] } }],
    "a part of a type it does not know": [{ ...clean, message: { role: "assistant", content: [{ type: "hologram" }] } }],
    "a part with no type": [{ ...clean, message: { role: "assistant", content: [{}] } }],
    "an attachment": [{ ...clean, message: { role: "user", content: [{ type: "text", text: "see" }], attachments: [{ id: "a" }] } }],
    "a message with no content list": [{ ...clean, message: { role: "user" } }],
    "one unknown message among clean ones": [clean, text("assistant", "legacy")],
  };
  for (const [name, history] of Object.entries(cases)) {
    resetImageGateForTests();
    adoptStoredHistory("t4", history);
    expect([name, isConversationMarked("t4")]).toEqual([name, true]);
  }
});

test("a conversation with no known id cannot be vouched for", () => {
  expect(isConversationMarked(undefined)).toBe(true);
  expect(isConversationMarked(null)).toBe(true);
});

test("pasted text marks the next turn once", () => {
  expect(takePastedText()).toBe(false);
  notePastedText();
  expect(takePastedText()).toBe(true);
  expect(takePastedText()).toBe(false);
});
