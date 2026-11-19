import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { installDom } from "@/test/dom";
import { MAIN_BOT } from "./BotAvatar";
import { botsNavStore } from "./botsNav";
import { preloadBotNav, RailBotAvatars, SidebarBotRows } from "./lazyBotNav";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  botsNavStore.set(null);
  restore?.();
  restore = undefined;
});

test("once loaded, the sidebar and the rail show the bots while the Bots view is mounted, and drop them after", async () => {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter><SidebarBotRows /><RailBotAvatars /></MemoryRouter>));
  expect(host.querySelector("[data-bot-rows]")).toBeNull();

  // The Chat slot starts the load when the account picks Bots, before the Bots view publishes the bots.
  await preloadBotNav();
  await act(async () => botsNavStore.set({
    bots: [{ key: "main", name: "Main", face: MAIN_BOT }],
    selected: "main",
    chatShown: true,
    chats: null,
    newBot: { enabled: true, counter: null, reason: null, open: () => {} },
  }));
  expect([...host.querySelectorAll("[data-bot-rows]")].map((rows) => rows.getAttribute("data-bot-rows"))).toEqual(["sidebar", "rail"]);
  expect(host.querySelector('[data-bot-rows="sidebar"] a')?.getAttribute("href")).toBe("/chat/bot/main");

  await act(async () => botsNavStore.set(null));
  expect(host.querySelector("[data-bot-rows]")).toBeNull();
});
