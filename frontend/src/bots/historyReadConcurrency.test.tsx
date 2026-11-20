import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { useMainChat } from "./useMainChat";
import type { BotMessage, BotsApi } from "./botsApi";

let root: Root | undefined;
let restore: (() => void) | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; restore?.(); restore = undefined; });
async function mount(api: BotsApi, prepare?: () => Promise<void>) {
  restore = installDom();
  const host = document.createElement("div"); document.body.append(host);
  let chat!: ReturnType<typeof useMainChat>;
  function Probe() { chat = useMainChat(api, prepare); return null; }
  root = createRoot(host);
  await act(async () => root!.render(<Probe />));
  return () => chat;
}
const message = (id: string, role: "user" | "bot", text: string): BotMessage => ({ id, role, text, at: "2026-11-13T00:00:00Z" });

test("send completes while history is pending; late history keeps the completed turn", async () => {
  const history = Promise.withResolvers<BotMessage[]>();
  const authorization = Promise.withResolvers<void>();
  let sent = 0;
  const chat = await mount({ getBotsStatus: async () => ({ enabled: true }), listMainMessages: () => history.promise,
    sendToMain: async (_text, event) => { sent++; event({ type: "delta", text: "answer" }); event({ type: "done", messageId: "reply-new" }); } }, () => authorization.promise);
  let sending!: Promise<void>;
  await act(async () => { sending = chat().send("new question"); });
  expect(sent).toBe(0);
  await act(async () => { authorization.resolve(); await sending; });
  expect(sent).toBe(1);
  expect(chat().state.history).toBe("loading");
  expect(chat().state.lines.map(line => line.text)).toEqual(["new question", "answer"]);
  await act(async () => { history.resolve([message("old", "bot", "earlier answer")]); await chat().ensureHistory(); });
  expect(chat().state.lines.map(line => line.text)).toEqual(["earlier answer", "new question", "answer"]);
});

test("history containing the completed turn does not duplicate it; failure is retryable", async () => {
  const pending = Promise.withResolvers<BotMessage[]>();
  let reads = 0;
  const chat = await mount({ getBotsStatus: async () => ({ enabled: true }), listMainMessages: () => ++reads === 1 ? pending.promise : Promise.resolve([
    message("user-server", "user", "question"), message("reply", "bot", "answer")]),
    sendToMain: async (_text, event) => { event({ type: "delta", text: "answer" }); event({ type: "done", messageId: "reply" }); } });
  await act(async () => { await chat().send("question"); });
  await act(async () => { pending.reject(new Error("timeout")); await chat().ensureHistory(); });
  expect(chat().state.history).toBe("failed");
  expect(chat().state.lines).toHaveLength(2);
  await act(async () => { await chat().loadHistory(); });
  expect(reads).toBe(2);
  expect(chat().state.history).toBe("loaded");
  expect(chat().state.lines.map(line => line.id)).toEqual(["user-server", "reply"]);
});

test("a history snapshot arriving before SSE done does not duplicate that turn", async () => {
  const pending = Promise.withResolvers<BotMessage[]>();
  const finish = Promise.withResolvers<void>();
  const chat = await mount({ getBotsStatus: async () => ({ enabled: true }), listMainMessages: () => pending.promise,
    sendToMain: async (_text, event) => { event({ type: "delta", text: "answer" }); await finish.promise; event({ type: "done", messageId: "reply" }); } });
  let sending!: Promise<void>;
  await act(async () => { sending = chat().send("question"); });
  await act(async () => { pending.resolve([message("user-server", "user", "question"), message("reply", "bot", "answer")]); await chat().ensureHistory(); });
  await act(async () => { finish.resolve(); await sending; });
  expect(chat().state.turn).toBeNull();
  expect(chat().state.lines.map(line => line.id)).toEqual(["user-server", "reply"]);
});
