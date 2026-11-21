import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { installDom } from "@/test/dom";
import { MAIN_BOT } from "./BotAvatar";
import { PhoneBotStrip, RailBotAvatars, SidebarBotRows } from "./BotNav";
import { botsNavStore, type BotsNavState } from "./botsNav";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  botsNavStore.set(null);
  restore?.();
  restore = undefined;
});

const RESEARCH = "0123456789abcdef0123456789abcdef";
const AT_CAP = "You have 3 bots, the most your account can have. Delete a bot other than Main to make a new one.";

function state(overrides: Partial<BotsNavState> = {}, newBot: Partial<BotsNavState["newBot"]> = {}): BotsNavState {
  return {
    bots: [
      { key: "main", name: "Main", face: MAIN_BOT },
      { key: RESEARCH, name: "Research", face: { key: RESEARCH, name: "Research", shape: "comet", colour: "teal" } },
    ],
    selected: RESEARCH,
    chatShown: true,
    chats: null,
    newBot: { enabled: true, counter: "2 of 3 bots", reason: null, open: () => {}, ...newBot },
    ...overrides,
  };
}

async function render(node: React.ReactNode) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter>{node}</MemoryRouter>));
  return host;
}

test("with the classic chat the navigation shows no bots", async () => {
  const host = await render(<><SidebarBotRows /><RailBotAvatars /><PhoneBotStrip /></>);
  expect(host.querySelector("[data-bot-rows]")).toBeNull();
});

test("the sidebar lists every bot with its address, marks the one on screen, and counts toward the cap", async () => {
  const host = await render(<SidebarBotRows />);
  let opened = 0;
  await act(async () => botsNavStore.set(state({}, { open: () => { opened++; } })));
  const links = [...host.querySelectorAll("a")];
  expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-current")])).toEqual([
    ["Main", "/chat/bot/main", null],
    ["Research", `/chat/bot/${RESEARCH}`, "page"],
  ]);
  expect(host.textContent).toContain("2 of 3 bots");
  const newBot = [...host.querySelectorAll("button")].find((button) => button.textContent === "New bot")!;
  expect(newBot.disabled).toBe(false);
  await act(async () => newBot.click());
  expect(opened).toBe(1);

  // Another screen is showing: no bot row is the current page.
  await act(async () => botsNavStore.set(state({ chatShown: false })));
  expect(host.querySelector('[aria-current="page"]')).toBeNull();
});

test("at the cap New bot is off everywhere and says why", async () => {
  const host = await render(<><SidebarBotRows /><RailBotAvatars /><PhoneBotStrip /></>);
  await act(async () => botsNavStore.set(state({}, { enabled: false, reason: AT_CAP })));
  const buttons = [...host.querySelectorAll("button")];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) {
    expect(button.disabled).toBe(true);
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(AT_CAP);
  }
  // The rail has room for avatars only: each bot's name is its link's accessible name.
  const rail = host.querySelector('[data-bot-rows="rail"]')!;
  expect([...rail.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Main", "Research"]);
});
