// Main's chat with a scope is the signed-in account's for the page session (mainChatStore.ts): a view that goes takes
// neither the lines nor the running turn with it; another account, or sign-out, drops both and stops the stream.
import { afterEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { __resetStorageStatusForTests, beginStorageAccountSession, endStorageAccountSession } from "@/lib/storageStatus";
import { BotsNoReply, type BotMessage, type BotsApi, type MainEvent } from "./botsApi";
import { disposeMainChats, MAX_MAIN_CHAT_LINES } from "./mainChatStore";
import { isWorking, useMainChat, type MainChatScope } from "./useMainChat";

let roots: Root[] = [];
let restore: (() => void) | undefined;
afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots = [];
  disposeMainChats();
  __resetStorageStatusForTests();
  restore?.();
  restore = undefined;
});

type Chat = ReturnType<typeof useMainChat>;
type Turn = { text: string; emit: (event: MainEvent) => void; signal?: AbortSignal; end: { resolve: () => void; reject: (reason: unknown) => void } };

/** A bots client whose replies the test sends, event by event. A stopped stream rejects, as the real one does. */
function streamingApi(history: () => Promise<BotMessage[]> = async () => []) {
  const turns: Turn[] = [];
  let lists = 0;
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: () => { lists++; return history(); },
    sendToMain: (text, emit, signal) => {
      const end = Promise.withResolvers<void>();
      signal?.addEventListener("abort", () => end.reject(signal.reason));
      turns.push({ text, emit, signal, end });
      return end.promise;
    },
  };
  return { api, turns, lists: () => lists };
}

async function mount(api: BotsApi, scope: MainChatScope | undefined, options: { onNoReply?: () => void; strict?: boolean } = {}) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  let chat!: Chat;
  function Probe({ scope }: { scope?: MainChatScope }) { chat = useMainChat(api, undefined, options.onNoReply, true, scope); return null; }
  const root = createRoot(host);
  roots.push(root);
  const render = (next = scope) => act(async () => root.render(options.strict ? <StrictMode><Probe scope={next} /></StrictMode> : <Probe scope={next} />));
  await render();
  return { chat: () => chat, render, leave: () => { act(() => root.unmount()); roots = roots.filter(other => other !== root); } };
}

const texts = (chat: Chat) => chat.state.lines.map(line => line.text);
const answer = (turn: Turn, text: string, messageId: string) => act(async () => {
  turn.emit({ type: "delta", text });
  turn.emit({ type: "done", messageId });
  turn.end.resolve();
});
const message = (id: string, role: "user" | "bot", text: string): BotMessage => ({ id, role, text, at: "2026-11-13T00:00:00Z" });
const ACCOUNT_A = "did:example:a:space-a";
const ACCOUNT_B = "did:example:b:space-b";

test("callbacks retained after sign-out cannot send or read through the retired account", async () => {
  const { api, turns, lists } = streamingApi();
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  const retired = first.chat();
  first.leave();
  act(() => disposeMainChats());
  await act(async () => {
    void retired.send("late callback");
    retired.sendAppReply({ requestId: "old-request", decision: "answered" });
    await retired.requestHistory();
    await retired.loadHistory();
  });
  expect(turns).toEqual([]);
  expect(lists()).toBe(0);
  const back = await mount(api, { owner: api, account: ACCOUNT_B });
  expect(back.chat().state.lines).toEqual([]);
});

test("the lines stay, in order, when the view goes and comes back", async () => {
  const { api, turns } = streamingApi();
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void first.chat().send("first"); });
  await answer(turns[0]!, "re: first", "m-1");
  await act(async () => { void first.chat().send("second"); });
  await answer(turns[1]!, "re: second", "m-2");
  first.leave();
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(texts(back.chat())).toEqual(["first", "re: first", "second", "re: second"]);
});

test("a turn in flight when the view goes runs on, and its reply is there on return", async () => {
  const { api, turns } = streamingApi();
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void first.chat().send("question"); });
  first.leave();
  expect(turns[0]!.signal!.aborted).toBe(false);
  await answer(turns[0]!, "the answer", "m-1");
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(back.chat().state.turn).toBeNull();
  expect(texts(back.chat())).toEqual(["question", "the answer"]);
});

test("a turn still streaming on return shows as running and goes on live", async () => {
  const { api, turns } = streamingApi();
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void first.chat().send("question"); });
  await act(async () => { turns[0]!.emit({ type: "status", state: "working" }); turns[0]!.emit({ type: "delta", text: "the " }); });
  first.leave();
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(isWorking(back.chat().state.turn)).toBe(true);
  expect(back.chat().state.turn).toMatchObject({ text: "question", reply: "the ", state: "working" });
  await act(async () => { turns[0]!.emit({ type: "delta", text: "answer" }); });
  expect(back.chat().state.turn?.reply).toBe("the answer");
  await answer(turns[0]!, "", "m-1");
  expect(back.chat().state.turn).toBeNull();
  expect(texts(back.chat())).toEqual(["question", "the answer"]);
});

test("a turn that fails while the view is gone shows the same failure on return, and Try again sends it again", async () => {
  const { api, turns } = streamingApi();
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void first.chat().send("question"); });
  first.leave();
  await act(async () => { turns[0]!.emit({ type: "error", code: "at_capacity" }); turns[0]!.end.resolve(); });
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(back.chat().state.turn).toMatchObject({ text: "question", state: "error", error: "at_capacity" });
  await act(async () => back.chat().retry());
  await answer(turns[1]!, "the answer", "m-1");
  expect(turns[1]!.text).toBe("question");
  expect(texts(back.chat())).toEqual(["question", "the answer"]);
});

test("a new chat clears the lines for good: a history read in flight does not bring them back, on return either", async () => {
  const pending = Promise.withResolvers<BotMessage[]>();
  const { api, turns, lists } = streamingApi(() => pending.promise);
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void first.chat().send("question"); });
  await answer(turns[0]!, "the answer", "m-1");
  let reading!: Promise<void>;
  act(() => { reading = first.chat().requestHistory(); });
  act(() => first.chat().clear());
  expect(first.chat().state.lines).toEqual([]);
  first.leave();
  await act(async () => { pending.resolve([message("old", "bot", "earlier answer")]); await reading; });
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(back.chat().state.lines).toEqual([]);
  expect(back.chat().state.history).toBe("idle");
  // Only the owner's press on this visit brings the saved lines back.
  await act(async () => { await back.chat().requestHistory(); });
  expect(lists()).toBe(2);
  expect(texts(back.chat())).toEqual(["earlier answer"]);
});

test("after a new chat, the next visit offers saved history again: the new chat's lines stay and nothing is read by itself", async () => {
  const { api, turns, lists } = streamingApi(async () => [message("old", "bot", "earlier answer")]);
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void first.chat().send("before"); });
  await answer(turns[0]!, "re: before", "m-1");
  act(() => first.chat().clear());
  await act(async () => { void first.chat().send("fresh"); });
  await answer(turns[1]!, "re: fresh", "m-2");
  expect(first.chat().state.history).toBe("loaded");
  first.leave();
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(back.chat().state.history).toBe("idle");
  expect(texts(back.chat())).toEqual(["fresh", "re: fresh"]);
  await act(async () => { await back.chat().ensureHistory(); });
  expect(lists()).toBe(0);
  await act(async () => { await back.chat().requestHistory(); });
  expect(lists()).toBe(1);
  expect(back.chat().state.history).toBe("loaded");
  expect(texts(back.chat())).toEqual(["earlier answer", "fresh", "re: fresh"]);
});

test("a new chat that starts after its view went (its request outlived it) is offered saved history on return", async () => {
  const { api, lists } = streamingApi();
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  const late = first.chat().clear;
  first.leave();
  act(() => late());
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(back.chat().state).toMatchObject({ lines: [], history: "idle" });
  expect(lists()).toBe(0);
});

test("saved history the owner loaded stays loaded across visits, and is not read again", async () => {
  const { api, lists } = streamingApi(async () => [message("old", "bot", "earlier answer")]);
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { await first.chat().requestHistory(); });
  expect(lists()).toBe(1);
  first.leave();
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(back.chat().state.history).toBe("loaded");
  expect(texts(back.chat())).toEqual(["earlier answer"]);
  await act(async () => { await back.chat().ensureHistory(); });
  expect(lists()).toBe(1);
});

test("under StrictMode a view's own remount is not the end of a visit; leaving after a new chat still is", async () => {
  const { api, turns, lists } = streamingApi(async () => [message("old", "bot", "earlier answer")]);
  // Loaded saved history survives StrictMode's remount of the returning view.
  const loaded = await mount(api, { owner: api, account: ACCOUNT_A }, { strict: true });
  await act(async () => { await loaded.chat().requestHistory(); });
  loaded.leave();
  const again = await mount(api, { owner: api, account: ACCOUNT_A }, { strict: true });
  expect(again.chat().state.history).toBe("loaded");
  expect(texts(again.chat())).toEqual(["earlier answer"]);
  // A new chat in a StrictMode visit stays "loaded" while the view is there, and the next StrictMode visit offers history.
  act(() => again.chat().clear());
  await act(async () => { void again.chat().send("fresh"); });
  await answer(turns[0]!, "re: fresh", "m-1");
  expect(again.chat().state.history).toBe("loaded");
  again.leave();
  const back = await mount(api, { owner: api, account: ACCOUNT_A }, { strict: true });
  expect(back.chat().state.history).toBe("idle");
  expect(texts(back.chat())).toEqual(["fresh", "re: fresh"]);
  expect(lists()).toBe(1);
  await act(async () => { await back.chat().requestHistory(); });
  expect(lists()).toBe(2);
  expect(texts(back.chat())).toEqual(["earlier answer", "fresh", "re: fresh"]);
});

test("another account on the same client never sees the first one's lines, and the first one's stream stops", async () => {
  const { api, turns } = streamingApi();
  const done = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void done.chat().send("finished"); });
  await answer(turns[0]!, "kept for a", "m-1");
  done.leave();
  const view = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void view.chat().send("still going"); });
  await act(async () => { turns[1]!.emit({ type: "delta", text: "partial" }); });
  await view.render({ owner: api, account: ACCOUNT_B });
  expect(view.chat().state).toEqual({ lines: [], history: "idle", turn: null });
  expect(turns[1]!.signal!.aborted).toBe(true);
  // The stopped turn's late events write nowhere, and the first account's chat does not come back.
  await act(async () => { turns[1]!.emit({ type: "delta", text: " more" }); turns[1]!.emit({ type: "done", messageId: "m-2" }); });
  expect(view.chat().state.lines).toEqual([]);
  await view.render({ owner: api, account: ACCOUNT_A });
  expect(view.chat().state.lines).toEqual([]);
});

test("dropping the kept chats stops their stream, whether a view is mounted or not", async () => {
  const { api, turns } = streamingApi();
  const view = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void view.chat().send("question"); });
  act(() => disposeMainChats());
  expect(turns[0]!.signal!.aborted).toBe(true);
  expect(view.chat().state).toEqual({ lines: [], history: "idle", turn: null });
  await act(async () => { void view.chat().send("again"); });
  view.leave();
  act(() => disposeMainChats());
  expect(turns[1]!.signal!.aborted).toBe(true);
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  expect(back.chat().state).toEqual({ lines: [], history: "idle", turn: null });
});

test("the end of the account's storage session at sign-out, and a new one at sign-in, drop the kept chat", async () => {
  const { api, turns } = streamingApi();
  const view = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void view.chat().send("question"); });
  await answer(turns[0]!, "the answer", "m-1");
  await act(async () => { void view.chat().send("next"); });
  act(() => endStorageAccountSession());
  expect(turns[1]!.signal!.aborted).toBe(true);
  expect(view.chat().state).toEqual({ lines: [], history: "idle", turn: null });
  await act(async () => { void view.chat().send("again"); });
  act(() => { beginStorageAccountSession({}, "did:example:b", "space-b"); });
  expect(turns[2]!.signal!.aborted).toBe(true);
  expect(view.chat().state.turn).toBeNull();
});

test("saved history is not read on send, on leaving or on return: only when the owner asks", async () => {
  const { api, turns, lists } = streamingApi();
  const first = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void first.chat().send("question"); await first.chat().ensureHistory(); });
  first.leave();
  await answer(turns[0]!, "the answer", "m-1");
  const back = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { await back.chat().ensureHistory(); });
  expect(lists()).toBe(0);
  expect(back.chat().state.history).toBe("idle");
  await act(async () => { await back.chat().requestHistory(); });
  expect(lists()).toBe(1);
});

test("two views of one account see one chat", async () => {
  const { api, turns } = streamingApi();
  const one = await mount(api, { owner: api, account: ACCOUNT_A });
  const two = await mount(api, { owner: api, account: ACCOUNT_A });
  await act(async () => { void one.chat().send("question"); });
  expect(two.chat().state.turn?.text).toBe("question");
  await act(async () => { void two.chat().send("ignored while a turn runs"); });
  expect(turns).toHaveLength(1);
  await answer(turns[0]!, "the answer", "m-1");
  expect(two.chat().state).toBe(one.chat().state);
  expect(texts(two.chat())).toEqual(["question", "the answer"]);
});

test("a turn reports no reply to the view mounted now, and to no one once every view is gone", async () => {
  const { api, turns } = streamingApi();
  const calls: string[] = [];
  const first = await mount(api, { owner: api, account: ACCOUNT_A }, { onNoReply: () => calls.push("first") });
  await act(async () => { void first.chat().send("question"); });
  first.leave();
  const back = await mount(api, { owner: api, account: ACCOUNT_A }, { onNoReply: () => calls.push("back") });
  await act(async () => { turns[0]!.end.reject(new BotsNoReply()); });
  expect(calls).toEqual(["back"]);
  expect(back.chat().state.turn).toBeNull();
  await act(async () => { void back.chat().send("again"); });
  back.leave();
  await act(async () => { turns[1]!.end.reject(new BotsNoReply()); });
  expect(calls).toEqual(["back"]);
});

test(`the chat keeps at most ${MAX_MAIN_CHAT_LINES} lines, the oldest going first`, async () => {
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    sendToMain: async (text, emit) => { emit({ type: "delta", text: `re: ${text}` }); emit({ type: "done", messageId: `reply-${text}` }); },
  };
  const view = await mount(api, { owner: api, account: ACCOUNT_A });
  for (let i = 0; i <= MAX_MAIN_CHAT_LINES / 2; i++) await act(async () => { await view.chat().send(`m${i}`); });
  const lines = texts(view.chat());
  expect(lines).toHaveLength(MAX_MAIN_CHAT_LINES);
  expect(lines[0]).toBe("m1");
  expect(lines.at(-1)).toBe(`re: m${MAX_MAIN_CHAT_LINES / 2}`);
});

test("under StrictMode the kept chat still reports to its view and keeps the turn past the view", async () => {
  const { api, turns } = streamingApi();
  const calls: string[] = [];
  const first = await mount(api, { owner: api, account: ACCOUNT_A }, { strict: true, onNoReply: () => calls.push("view") });
  await act(async () => { void first.chat().send("question"); });
  await act(async () => { turns[0]!.end.reject(new BotsNoReply()); });
  expect(calls).toEqual(["view"]);
  await act(async () => { void first.chat().send("next"); });
  first.leave();
  expect(turns[1]!.signal!.aborted).toBe(false);
  await answer(turns[1]!, "the answer", "m-1");
  const back = await mount(api, { owner: api, account: ACCOUNT_A }, { strict: true });
  expect(texts(back.chat())).toEqual(["next", "the answer"]);
});

test("without a scope the chat is the view's own, as before: it works under StrictMode and stops with the view", async () => {
  const { api, turns } = streamingApi();
  const view = await mount(api, undefined, { strict: true });
  await act(async () => { void view.chat().send("question"); });
  await answer(turns[0]!, "the answer", "m-1");
  expect(texts(view.chat())).toEqual(["question", "the answer"]);
  await act(async () => { void view.chat().send("next"); });
  view.leave();
  expect(turns[1]!.signal!.aborted).toBe(true);
  const other = await mount(api, undefined);
  expect(other.chat().state.lines).toEqual([]);
});
