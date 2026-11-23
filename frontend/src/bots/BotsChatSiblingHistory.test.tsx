import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { MAIN_BOT } from "./BotAvatar";
import type { BotChatApi } from "./botChatApi";
import { BotsChat, type BotHistoryAccess, type BotsController, type ControllerBot } from "./BotsChat";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const RESEARCH = "0123456789abcdef0123456789abcdef";
const bot = (key: string, name: string): ControllerBot => ({ key, name, environment: "private", state: "active" });
const roster: BotsController = { status: "ready", roster: { bots: [bot("main", "Main"), bot(RESEARCH, "Research")] } };
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Every call the history layer and the chat API receive, by name and bot. */
function recorders() {
  const calls: string[] = [];
  const api: BotChatApi = {
    listMessages: async () => [],
    send: async () => {},
    readNotice: async (key) => { calls.push(`notice:${key}`); return null; },
    acknowledgeNotice: async (_key, notice) => notice,
  };
  const history: BotHistoryAccess = {
    enabled: async () => true,
    authorize: async () => { calls.push("authorize"); },
    grant: async (key) => { calls.push(`grant:${key}`); },
    saves: (key) => key === "main",
    read: async (key) => { calls.push(`read:${key}`); return []; },
  };
  return { api, history, calls };
}

async function show(selected: string, api: BotChatApi, history: BotHistoryAccess) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(
    <BotsChat controller={roster} selected={selected} faceOf={(b) => ({ ...MAIN_BOT, name: b.name })} history={history} active chatApi={api} />,
  ));
  await flush();
}

test("a bot that saves no history is never authorised, granted, read or asked for a notice", async () => {
  const { api, history, calls } = recorders();
  await show(RESEARCH, api, history);
  expect(calls).toEqual([]);
});

test("Main still gets its approval, grant, history and notice", async () => {
  const { api, history, calls } = recorders();
  await show("main", api, history);
  expect(calls).toContain("authorize");
  expect(calls).toContain("grant:main");
  expect(calls).toContain("read:main");
  expect(calls).toContain("notice:main");
  expect(calls.filter((call) => call.endsWith(RESEARCH))).toEqual([]);
});
