// The SDK fails every space call with NODE_NOT_RESPONDING while the TinyCloud node is down. That is a lost
// connection: the note waits and is saved later, and the user reads words, never the SDK's code.
import { describe, expect, test } from "bun:test";

import { classifyNoteFailure, isTinyCloudUnreachable, messageOf, pendingSaveMessage, TINYCLOUD_NETWORK_FAILURE_MESSAGE } from "./recorderSaves";

const NODE_DOWN = { code: "NODE_NOT_RESPONDING", message: "The place your data is stored isn't responding right now. Please try again.",
  meta: { hosts: ["https://node.example"] } };

describe("a space the SDK cannot reach", () => {
  test("is a lost connection, whether the SDK's error is the failure itself or its cause", () => {
    const wrapped = Object.assign(new Error("NODE_NOT_RESPONDING: ensureSchema probe"), { code: "retry", cause: NODE_DOWN });
    for (const failure of [NODE_DOWN, wrapped, { code: "DECRYPTION_DEPENDENCY_UNAVAILABLE", message: "The decryption service isn't responding right now." }]) {
      expect(isTinyCloudUnreachable(failure)).toBe(true);
      expect(classifyNoteFailure(failure)).toBe("offline");
    }
  });

  test("is told in words on Capture and in the pending card, never with its code", () => {
    const wrapped = Object.assign(new Error("NODE_NOT_RESPONDING: ensureSchema probe"), { code: "retry", cause: NODE_DOWN });
    for (const text of [messageOf(NODE_DOWN), messageOf(wrapped), pendingSaveMessage(NODE_DOWN), pendingSaveMessage(wrapped)]) {
      expect(text).toBe(TINYCLOUD_NETWORK_FAILURE_MESSAGE);
      expect(text).not.toContain("NODE_NOT_RESPONDING");
    }
  });

  test("other space failures keep their own kind and words", () => {
    expect(isTinyCloudUnreachable({ code: "SQL_ERROR", message: "no such table" })).toBe(false);
    expect(classifyNoteFailure({ code: "AUTH_UNAUTHORIZED", message: "expired", meta: { status: 401 } })).toBe("auth");
    expect(classifyNoteFailure({ code: "SQL_ERROR", message: "Failed to execute query: 500 - internal error" })).toBe("server");
    expect(messageOf({ code: "SQL_ERROR", message: "no such table" })).not.toBe(TINYCLOUD_NETWORK_FAILURE_MESSAGE);
  });
});
