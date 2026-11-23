import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { BotsError, BotsRouteMissing } from "./botsApi";
import { deleteMainChats, type DeleteChatsSteps } from "./mainDeleteChats";
import type { NewChatOutcome } from "./mainNewChat";

const TCW = {} as TinyCloudWeb;

function steps(options: { enabled?: () => Promise<boolean>; clear?: () => Promise<NewChatOutcome>; remove?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const value: DeleteChatsSteps = {
    historyEnabled: async () => { calls.push("enabled"); return (options.enabled ?? (async () => true))(); },
    clearConversation: async () => { calls.push("clear"); return (options.clear ?? (async () => "cleared"))(); },
    deleteHistory: async () => { calls.push("delete"); return (options.remove ?? (async () => 3))(); },
  };
  return { value, calls };
}

test("the service clears first, then the saved history goes", async () => {
  const { value, calls } = steps();
  expect(await deleteMainChats(TCW, value)).toBe("deleted");
  expect(calls).toEqual(["enabled", "clear", "delete"]);
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

test("a failed status read or service call deletes nothing; signed out and a missing route are told apart", async () => {
  const status = steps({ enabled: async () => { throw new Error("history_status_unavailable"); } });
  expect(await deleteMainChats(TCW, status.value)).toBe("failed");
  expect(status.calls).toEqual(["enabled"]);
  const down = steps({ clear: async () => { throw new BotsError("failed"); } });
  expect(await deleteMainChats(TCW, down.value)).toBe("failed");
  expect(down.calls).not.toContain("delete");
  const out = steps({ clear: async () => { throw new BotsError("signed_out"); } });
  expect(await deleteMainChats(TCW, out.value)).toBe("signed_out");
  const missing = steps({ clear: async () => { throw new BotsRouteMissing(); } });
  expect(await deleteMainChats(TCW, missing.value).catch(cause => cause)).toBeInstanceOf(BotsRouteMissing);
});

test("an account that saves no history only has its conversation cleared", async () => {
  const off = steps({ enabled: async () => false });
  expect(await deleteMainChats(TCW, off.value)).toBe("deleted");
  expect(off.calls).toEqual(["enabled", "clear"]);
  const none = steps();
  expect(await deleteMainChats(undefined, none.value)).toBe("deleted");
  expect(none.calls).toEqual(["clear"]);
});
