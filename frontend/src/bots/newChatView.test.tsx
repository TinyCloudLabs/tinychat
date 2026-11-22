// TC-3808: after the owner starts a new chat, the earlier conversation leaves Main's chat view and stays out.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { useMainChat } from "./useMainChat";
import type { BotMessage, BotsApi } from "./botsApi";

let root: Root | undefined;
let restore: (() => void) | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; restore?.(); restore = undefined; });
async function mount(api: BotsApi) {
  restore = installDom();
  const host = document.createElement("div"); document.body.append(host);
  let chat!: ReturnType<typeof useMainChat>;
  function Probe() { chat = useMainChat(api); return null; }
  root = createRoot(host);
  await act(async () => root!.render(<Probe />));
  return () => chat;
}
const message = (id: string, role: "user" | "bot", text: string): BotMessage => ({ id, role, text, at: "2026-11-13T00:00:00Z" });
const texts = (chat: ReturnType<typeof useMainChat>) => chat.state.lines.map(line => line.text);

test("a new chat empties the view, and the next turn shows only itself without reading the old history", async () => {
  let reads = 0;
  const chat = await mount({ getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => { reads++; return [message("old", "bot", "earlier answer")]; },
    sendToMain: async (text, event) => { event({ type: "delta", text: `re: ${text}` }); event({ type: "done", messageId: `reply-${text}` }); } });
  await act(async () => { await chat().send("first"); await chat().ensureHistory(); });
  expect(texts(chat())).toEqual(["earlier answer", "first", "re: first"]);
  act(() => chat().clear());
  expect(chat().state.lines).toEqual([]);
  expect(chat().state.history).toBe("loaded");
  await act(async () => { await chat().send("second"); });
  expect(texts(chat())).toEqual(["second", "re: second"]);
  expect(reads).toBe(1);
});

test("a history read in flight when the new chat starts does not bring the old lines back", async () => {
  const pending = Promise.withResolvers<BotMessage[]>();
  const chat = await mount({ getBotsStatus: async () => ({ enabled: true }), listMainMessages: () => pending.promise,
    sendToMain: async () => {} });
  let reading!: Promise<void>;
  act(() => { reading = chat().ensureHistory(); });
  act(() => chat().clear());
  await act(async () => { pending.resolve([message("old", "bot", "earlier answer")]); await reading; });
  expect(chat().state.lines).toEqual([]);
  expect(chat().state.history).toBe("loaded");
});
