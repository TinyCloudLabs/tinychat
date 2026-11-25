import { expect, test } from "bun:test";
import { holdScreenSensitive, isSensitiveScreen, screenSensitiveHeld } from "./config";

test("sensitive screens: account settings, a framed app, a share link by token or by its /s/<id> address", () => {
  expect(isSensitiveScreen({ id: "settings" }, "/chat/settings", null)).toBe(true);
  expect(isSensitiveScreen({ id: "apps", appId: "secrets" }, "/chat/apps/secrets", null)).toBe(true);
  expect(isSensitiveScreen({ id: "feed" }, "/chat/feed", "token")).toBe(true);
  // A /s/<id> link falls through to the chat screen before its token is read.
  expect(isSensitiveScreen({ id: "chat" }, "/s/AbC123", null)).toBe(true);
  expect(isSensitiveScreen({ id: "feed" }, "/chat/feed", null)).toBe(false);
  expect(isSensitiveScreen({ id: "apps" }, "/chat/apps", null)).toBe(false);
});

test("a hold keeps the screen sensitive until every holder releases; a second release is a no-op", () => {
  expect(screenSensitiveHeld()).toBe(false);
  const first = holdScreenSensitive();
  const second = holdScreenSensitive();
  first();
  first();
  expect(screenSensitiveHeld()).toBe(true);
  second();
  expect(screenSensitiveHeld()).toBe(false);
});
