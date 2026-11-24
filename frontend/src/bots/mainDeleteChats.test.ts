import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { BotsError, BotsRouteMissing } from "./botsApi";
import { deleteMainChats, type DeleteChatsSteps } from "./mainDeleteChats";
import type { NewChatOutcome } from "./mainNewChat";

const TCW = { session: () => ({ address: "0x0" }) } as unknown as TinyCloudWeb;

function steps(options: { clear?: () => Promise<NewChatOutcome>; remove?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const value: DeleteChatsSteps = {
    clearConversation: async () => { calls.push("clear"); return (options.clear ?? (async () => "cleared"))(); },
    deleteHistory: async () => { calls.push("delete"); return (options.remove ?? (async () => 3))(); },
  };
  return { value, calls };
}

test("the service clears first, then the saved history goes", async () => {
  const { value, calls } = steps();
  expect(await deleteMainChats(TCW, value)).toBe("deleted");
  expect(calls).toEqual(["clear", "delete"]);
});

test("a reply in progress or unsaved messages delete nothing, not even the saved history", async () => {
  for (const outcome of ["busy", "archive_pending"] as const) {
    const { value, calls } = steps({ clear: async () => outcome });
    expect(await deleteMainChats(TCW, value)).toBe(outcome);
    expect(calls).not.toContain("delete");
  }
});

test("a history that fails to delete says the conversation is cleared and what is left", async () => {
  const { value } = steps({ remove: async () => { throw new Error("history_delete_incomplete"); } });
  expect(await deleteMainChats(TCW, value)).toBe("history_incomplete");
});

test("a failed service call deletes nothing; signed out and a missing route are told apart", async () => {
  const down = steps({ clear: async () => { throw new BotsError("failed"); } });
  expect(await deleteMainChats(TCW, down.value)).toBe("failed");
  expect(down.calls).toEqual(["clear"]);
  const out = steps({ clear: async () => { throw new BotsError("signed_out"); } });
  expect(await deleteMainChats(TCW, out.value)).toBe("signed_out");
  const missing = steps({ clear: async () => { throw new BotsRouteMissing(); } });
  expect(await deleteMainChats(TCW, missing.value).catch(cause => cause)).toBeInstanceOf(BotsRouteMissing);
});

test("the saved history is deleted whenever the owner has a session, whatever the history status says", async () => {
  // The status route answers 404 for some accounts that saved records earlier: no step reads it.
  const { value, calls } = steps();
  expect(await deleteMainChats(TCW, value)).toBe("deleted");
  expect(calls).toEqual(["clear", "delete"]);
});

test("without an owner session nothing is cleared or deleted, and it says signed out", async () => {
  for (const tcw of [undefined, { session: () => null } as unknown as TinyCloudWeb]) {
    const { value, calls } = steps();
    expect(await deleteMainChats(tcw, value)).toBe("signed_out");
    expect(calls).toEqual([]);
  }
});
