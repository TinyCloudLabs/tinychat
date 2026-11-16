import { expect, test } from "bun:test";
import { connectErrorMessage } from "@/chat/useAgentEnablement";
import { authErrorMessage, SIGN_IN_FAILED_MESSAGE } from "./authErrors";
import { narrowedApprovalMessage } from "./narrowedApproval";

const narrowedError = (missing: { service: string }[]) => Object.assign(new Error("narrowed"), { name: "NarrowedApprovalError", missing });

test("the message names each missing kind of permission once, in plain words, and says how to try again", () => {
  const message = narrowedApprovalMessage([{ service: "tinycloud.sql" }, { service: "tinycloud.sql" }, { service: "tinycloud.kv" }]);
  expect(message).toBe("TinyCloud One needs permission to keep your library, feed and recordings and save your chats, notes and settings to work. Sign in again and keep every permission ticked.");
});

test("a permission it has no words for is still named, not dropped", () => {
  expect(narrowedApprovalMessage([{ service: "tinycloud.something-new" }])).toContain("use your TinyCloud space");
});

test("sign-in shows the specific message for a narrowed approval, and the generic one for anything else", () => {
  expect(authErrorMessage(narrowedError([{ service: "tinycloud.kv" }]))).toContain("save your chats, notes and settings");
  expect(authErrorMessage(new Error("boom"))).toBe(SIGN_IN_FAILED_MESSAGE);
});

test("connecting the agent shows the specific message for a narrowed approval", () => {
  const message = connectErrorMessage(narrowedError([{ service: "tinycloud.kv" }]));
  expect(message).toBe("Connecting the agent needs permission to save your chats, notes and settings to work. Connect again and keep every permission ticked.");
});
