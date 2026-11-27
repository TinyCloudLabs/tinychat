// A turn's read steps mark the reply it ends with (memory only), so the chat can ask for that access under it; access
// given there sends the question again once, and never for history, while a turn runs, or after a new chat.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import type { BotMessage, BotsApi, MainEvent } from "./botsApi";
import { disposeMainChats } from "./mainChatStore";
import { useMainChat, type MainChatScope } from "./useMainChat";

let roots: Root[] = [];
let restore: (() => void) | undefined;
afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots = [];
  disposeMainChats();
  restore?.();
  restore = undefined;
});

type Chat = ReturnType<typeof useMainChat>;
type Turn = { text: string; emit: (event: MainEvent) => void; end: { resolve: () => void } };

function streamingApi(history: BotMessage[] = []) {
  const turns: Turn[] = [];
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => history,
    sendToMain: (text, emit, signal) => {
      const end = Promise.withResolvers<void>();
      signal?.addEventListener("abort", () => end.reject(signal.reason));
      turns.push({ text, emit, end });
      return end.promise;
    },
  };
  return { api, turns };
}

async function mount(api: BotsApi, scope?: MainChatScope) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  let chat!: Chat;
  function Probe() { chat = useMainChat(api, undefined, undefined, true, scope); return null; }
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Probe />));
  return { chat: () => chat, leave: () => { act(() => root.unmount()); roots = roots.filter(other => other !== root); } };
}

const reply = (turn: Turn, steps: MainEvent[], text: string, messageId: string) => act(async () => {
  for (const step of steps) turn.emit(step);
  turn.emit({ type: "delta", text });
  turn.emit({ type: "done", messageId });
  turn.end.resolve();
});
const step = (name: "meetings" | "feed" | "chats" | "telegram" | "search"): MainEvent => ({ type: "step", step: name });

test("the read steps of a turn mark its reply with their areas, each once", async () => {
  const { api, turns } = streamingApi();
  const { chat } = await mount(api);
  await act(async () => { void chat().send("What did we decide on Monday?"); });
  await reply(turns[0]!, [step("search"), step("meetings"), step("feed"), step("chats"), step("meetings"), step("telegram")], "I need access.", "m-1");
  const lines = chat().state.lines;
  expect(lines.map(line => line.role)).toEqual(["user", "bot"]);
  expect(lines[0]!.areas).toBeUndefined();
  expect(lines[1]!.areas).toEqual(["meetings", "feed_chats", "telegram"]);
});

test("a reply whose turn read nothing carries no areas", async () => {
  const { api, turns } = streamingApi();
  const { chat } = await mount(api);
  await act(async () => { void chat().send("hi"); });
  await reply(turns[0]!, [step("search")], "Hello.", "m-1");
  expect(chat().state.lines[1]!.areas).toBeUndefined();
});

test("lines read from history never carry areas", async () => {
  const { api } = streamingApi([
    { id: "h-1", role: "user", text: "Monday?", at: "2026-11-13T00:00:00Z" },
    { id: "h-2", role: "bot", text: "I need access to your meetings.", at: "2026-11-13T00:00:01Z" },
  ]);
  const { chat } = await mount(api);
  await act(async () => { await chat().loadHistory(); });
  expect(chat().state.lines.map(line => line.id)).toEqual(["h-1", "h-2"]);
  expect(chat().state.lines.every(line => line.areas === undefined)).toBe(true);
  await act(async () => { chat().askAgain("h-2"); });
  expect(chat().state.turn).toBeNull();
});

test("Not now drops that area from its reply only", async () => {
  const { api, turns } = streamingApi();
  const { chat } = await mount(api);
  await act(async () => { void chat().send("Monday?"); });
  await reply(turns[0]!, [step("meetings"), step("feed")], "I need access.", "m-1");
  await act(async () => { chat().notNow("m-1", "meetings"); });
  expect(chat().state.lines[1]!.areas).toEqual(["feed_chats"]);
  await act(async () => { chat().notNow("m-1", "feed_chats"); });
  expect(chat().state.lines[1]!.areas).toBeUndefined();
});

test("access given sends the question before the reply again, exactly once", async () => {
  const { api, turns } = streamingApi();
  const { chat } = await mount(api);
  await act(async () => { void chat().send("What did we decide on Monday?"); });
  await reply(turns[0]!, [step("meetings")], "I need access.", "m-1");
  await act(async () => { chat().askAgain("m-1"); chat().askAgain("m-1"); });
  expect(turns.map(turn => turn.text)).toEqual(["What did we decide on Monday?", "What did we decide on Monday?"]);
  expect(chat().state.lines[1]!.areas).toBeUndefined();
  await reply(turns[1]!, [step("meetings")], "You decided on Friday.", "m-2");
  await act(async () => { chat().askAgain("m-1"); });
  expect(turns).toHaveLength(2);
});

test("no question goes again while a turn runs", async () => {
  const { api, turns } = streamingApi();
  const { chat } = await mount(api);
  await act(async () => { void chat().send("Monday?"); });
  await reply(turns[0]!, [step("meetings")], "I need access.", "m-1");
  await act(async () => { void chat().send("And Tuesday?"); });
  await act(async () => { chat().askAgain("m-1"); });
  expect(turns.map(turn => turn.text)).toEqual(["Monday?", "And Tuesday?"]);
});

test("no question goes again after a new chat", async () => {
  const { api, turns } = streamingApi();
  const { chat } = await mount(api);
  await act(async () => { void chat().send("Monday?"); });
  await reply(turns[0]!, [step("meetings")], "I need access.", "m-1");
  await act(async () => { chat().clear(); });
  await act(async () => { chat().askAgain("m-1"); });
  expect(turns).toHaveLength(1);
  expect(chat().state.turn).toBeNull();
});

test("a kept chat keeps the areas across leaving the Feed, and access given on return asks once", async () => {
  const { api, turns } = streamingApi();
  const scope = { owner: api, account: "did:example:a:space-a" };
  const first = await mount(api, scope);
  await act(async () => { void first.chat().send("Monday?"); });
  await reply(turns[0]!, [step("chats")], "I need access.", "m-1");
  first.leave();
  const back = await mount(api, scope);
  expect(back.chat().state.lines[1]!.areas).toEqual(["feed_chats"]);
  await act(async () => { back.chat().askAgain("m-1"); });
  expect(turns.map(turn => turn.text)).toEqual(["Monday?", "Monday?"]);
});
