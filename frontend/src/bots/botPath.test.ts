import { afterEach, expect, test } from "bun:test";

import { installDom } from "@/test/dom";
import { botForPath, botKeyFromPath, botPath, readLastBot, saveLastBot } from "./botPath";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const KEY = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const ACCOUNT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000A1";

test("an address names a bot only by `main` or 32 lower-case hex digits", () => {
  expect(botKeyFromPath(`/chat/bot/${KEY}`)).toBe(KEY);
  expect(botKeyFromPath(`/chat/bot/${KEY}/`)).toBe(KEY);
  expect(botKeyFromPath("/chat/bot/main")).toBe("main");
  for (const path of ["/chat", "/chat/bot/", `/chat/bot/${KEY.toUpperCase()}`, `/chat/bot/${KEY}0`, `/chat/bot/${KEY}/x`,
    "/chat/bot/..%2Fsettings", "/chat/settings", `/feed/bot/${KEY}`]) {
    expect(botKeyFromPath(path)).toBeNull();
  }
  expect(botPath(KEY)).toBe(`/chat/bot/${KEY}`);
  expect(() => botPath("../settings")).toThrow();
});

test("/chat and an address naming no bot of the account open the bot shown last, else Main", () => {
  restore = installDom();
  const has = (key: string) => key === "main" || key === KEY;
  expect(botForPath("/chat", ACCOUNT, has)).toBe("main");
  saveLastBot(ACCOUNT, KEY);
  expect(readLastBot(ACCOUNT.toLowerCase())).toBe(KEY);
  expect(botForPath("/chat", ACCOUNT, has)).toBe(KEY);
  expect(botForPath(`/chat/bot/${OTHER}`, ACCOUNT, has)).toBe(KEY);
  expect(botForPath("/chat/bot/main", ACCOUNT, has)).toBe("main");
  // The bot shown last was deleted: Main.
  expect(botForPath("/chat", ACCOUNT, (key) => key === "main")).toBe("main");
  expect(botForPath("/chat", null, has)).toBe("main");
});
