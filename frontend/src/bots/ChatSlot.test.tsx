import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import type { BotChatApi } from "./botChatApi";
import type { BotRoster, BotRosterApi, RosterBot } from "./botRosterApi";
import type { BotsApi } from "./botsApi";
import { botsNavStore } from "./botsNav";
import { saveChatView } from "./chatViewSetting";
import { ChatSlot } from "./ChatSlot";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

const ACCOUNT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const RESEARCH = "0123456789abcdef0123456789abcdef";
const bot = (key: string, name: string): RosterBot => ({
  key, name, shape: key === "main" ? "pebble" : "comet", colour: key === "main" ? "blue" : "teal",
  environment: "private", state: "active", createdAt: "2026-11-18T00:00:00.000Z",
});

function fakes(roster: BotRoster, admitted = true) {
  const calls: string[] = [];
  const api: BotsApi = {
    getBotsStatus: async () => { calls.push("status"); return { enabled: admitted }; },
    listMainMessages: async () => { calls.push("main"); return []; },
    sendToMain: async () => {},
  };
  const chatApi: BotChatApi = {
    listMessages: async (key) => { calls.push(`messages ${key}`); return []; },
    send: async () => {},
    readNotice: async () => null,
    acknowledgeNotice: async (_key, notice) => notice,
  };
  const rosterApi: BotRosterApi = {
    list: async () => { calls.push("roster"); return roster; },
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
    remove: async () => { throw new Error("unused"); },
  };
  return { calls, props: { api, chatApi, rosterApi, history: null } };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(path: string, node: ReactNode) {
  await import("./BotsSurface");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>));
  await flush();
  await flush();
  return host;
}

const roster = (overrides: Partial<BotRoster> = {}): BotRoster => ({
  bots: [bot("main", "Main"), bot(RESEARCH, "Research")],
  deleted: [],
  capMode: "flat3",
  limits: { private: { max: 3, used: 2 }, regular: { max: 0, used: 0 } },
  canCreate: { private: true, regular: false },
  ...overrides,
});

const slot = (props: ReturnType<typeof fakes>["props"]) => (
  <ChatSlot account={ACCOUNT} tcw={{} as TinyCloudWeb} active classic={<p data-classic="">Classic chat</p>} {...props} />
);

test("an account explicitly on Classic sees the classic chat and makes no bots calls", async () => {
  restore = installDom();
  saveChatView(ACCOUNT, "classic");
  const { calls, props } = fakes(roster());
  const host = await render("/chat", slot(props));
  expect(host.querySelector('[data-chat-view="classic"]')!.className).not.toContain("hidden");
  expect(host.querySelector('[data-chat-view="bots"]')).toBeNull();
  expect(calls).toEqual([]);
  expect(botsNavStore.snapshot()).toBeNull();
});

test("an admitted account with no saved preference defaults to Bots", async () => {
  restore = installDom();
  const { props } = fakes(roster());
  const host = await render(`/chat/bot/${RESEARCH}`, slot(props));
  expect(host.querySelector("h1")?.textContent).toContain("Research");
  expect(host.querySelector('[data-chat-view="classic"]')!.className).toContain("hidden");
  expect(host.querySelector('[data-chat-view="bots"]')).not.toBeNull();
});

test("Bots shows the bot the address names, keeps the classic chat mounted, and lists the bots for the navigation", async () => {
  restore = installDom();
  saveChatView(ACCOUNT, "bots");
  const { props } = fakes(roster());
  const host = await render(`/chat/bot/${RESEARCH}`, slot(props));
  expect(host.querySelector("h1")?.textContent).toContain("Research");
  expect(host.querySelector('[data-chat-view="classic"]')!.className).toContain("hidden");
  expect(host.querySelector("[data-classic]")).not.toBeNull();
  const nav = botsNavStore.snapshot()!;
  expect(nav.bots.map((entry) => entry.name)).toEqual(["Main", "Research"]);
  expect(nav.selected).toBe(RESEARCH);
  expect(nav.newBot).toMatchObject({ enabled: true, counter: "2 of 3 bots", reason: null });
  // Leaving the Bots view takes the bots out of the navigation.
  await act(async () => root!.unmount());
  root = undefined;
  expect(botsNavStore.snapshot()).toBeNull();
});

test("at the cap New bot is off, with the reason built from the backend's numbers", async () => {
  restore = installDom();
  saveChatView(ACCOUNT, "bots");
  const { props } = fakes(roster({
    bots: [bot("main", "Main"), bot(RESEARCH, "Research"), bot("fedcba9876543210fedcba9876543210", "Notes"), bot("00112233445566778899aabbccddeeff", "Trips")],
    limits: { private: { max: 4, used: 4 }, regular: { max: 0, used: 0 } },
    canCreate: { private: false, regular: false },
  }));
  await render("/chat", slot(props));
  expect(botsNavStore.snapshot()!.newBot).toMatchObject({
    enabled: false,
    counter: "4 of 4 bots",
    reason: "You have 4 bots, the most your account can have. Delete a bot other than Main to make a new one.",
  });
});

test("an account the backend doesn't let into bots gets the classic chat even with Bots saved", async () => {
  restore = installDom();
  saveChatView(ACCOUNT, "bots");
  const { calls, props } = fakes(roster(), false);
  const host = await render("/chat", slot(props));
  expect(host.querySelector('[data-chat-view="bots"]')).toBeNull();
  expect(host.querySelector('[data-chat-view="classic"]')!.className).not.toContain("hidden");
  expect(calls).toEqual(["status"]);
});
