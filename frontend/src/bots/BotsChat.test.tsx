import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { MAIN_BOT } from "./BotAvatar";
import type { BotChatApi } from "./botChatApi";
import type { MainEvent } from "./botsApi";
import { BotsChat, type BotsController, type ControllerBot } from "./BotsChat";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const RESEARCH = "0123456789abcdef0123456789abcdef";
const bot = (key: string, name: string, extra: Partial<ControllerBot> = {}): ControllerBot =>
  ({ key, name, environment: "private", state: "active", ...extra });
const ready = (...bots: ControllerBot[]): BotsController => ({ status: "ready", roster: { bots } });

/** A chat API whose replies the test finishes by hand. */
function fakeChatApi(earlier: Record<string, { id: string; role: "user" | "bot"; text: string }[]> = {}) {
  const turns: { key: string; text: string; emit: (event: MainEvent) => void; finish: () => void }[] = [];
  const api: BotChatApi = {
    listMessages: async (key) => (earlier[key] ?? []).map((message) => ({ ...message, at: "" })),
    send: (key, text, onEvent) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      turns.push({ key, text, emit: onEvent, finish: resolve });
      return promise;
    },
    readNotice: async () => null,
    acknowledgeNotice: async (_key, notice) => notice,
  };
  return { api, turns };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(props: { controller: BotsController; selected: string; api: BotChatApi }) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  const draw = (selected: string, controller = props.controller) => act(async () => mounted!.render(
    <BotsChat controller={controller} selected={selected} faceOf={(b) => ({ ...MAIN_BOT, name: b.name })} history={null} active chatApi={props.api} />,
  ));
  await draw(props.selected);
  await flush();
  return { host, draw };
}

const title = (host: HTMLElement) => host.querySelector("h1")?.textContent;
const composer = (host: HTMLElement) => host.querySelector("textarea")!;

async function type(node: HTMLTextAreaElement, value: string) {
  await act(async () => {
    // happy-dom has no native `input` support, so React reads the change of the focused field on key events (as
    // ChatTitleEditor.test.tsx does).
    node.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
}

async function sendMessage(host: HTMLElement, text: string) {
  await type(composer(host), text);
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await flush();
}

test("Main is shown when the list of bots could not be read, and for a bot the list does not have", async () => {
  const { api } = fakeChatApi();
  const { host, draw } = await render({ controller: { status: "failed", roster: null }, selected: RESEARCH, api });
  expect(title(host)).toBe("TrustBot");
  await draw("main", ready(bot("main", "Main"), bot(RESEARCH, "Research", { state: "deleting" })));
  await draw(RESEARCH);
  expect(title(host)).toBe("TrustBot");
});

test("the confidential-model line shows for a private bot only", async () => {
  const { api } = fakeChatApi();
  const controller = ready(bot("main", "Main"), bot(RESEARCH, "Research", { environment: "regular" }));
  const { host, draw } = await render({ controller, selected: "main", api });
  expect(host.textContent).toContain("Runs on a confidential model.");
  await draw(RESEARCH);
  await flush();
  expect(title(host)).toBe("Research");
  expect(host.textContent).not.toContain("Runs on a confidential model.");
  expect(composer(host).getAttribute("placeholder")).toBe("Message Research");
});

test("a reply is shown as Markdown, never as HTML", async () => {
  const { api } = fakeChatApi({ main: [{ id: "1", role: "bot", text: "**Done** <img src=x onerror=alert(1)>" }] });
  const { host } = await render({ controller: ready(bot("main", "Main")), selected: "main", api });
  const reply = host.querySelector("[data-bot-reply]")!;
  expect(reply.querySelector("strong")?.textContent).toBe("Done");
  expect(reply.querySelector("img")).toBeNull();
  expect(reply.textContent).toContain("<img src=x onerror=alert(1)>");
});

test("a turn survives switching bots: the reply is there on coming back, and each bot keeps its draft", async () => {
  const { api, turns } = fakeChatApi();
  const controller = ready(bot("main", "Main"), bot(RESEARCH, "Research"));
  const { host, draw } = await render({ controller, selected: RESEARCH, api });
  await sendMessage(host, "Find three sources");
  expect(turns.map((turn) => [turn.key, turn.text])).toEqual([[RESEARCH, "Find three sources"]]);
  turns[0]!.emit({ type: "delta", text: "Working on it" });
  await flush();

  await draw("main");
  await flush();
  await type(composer(host), "A note for Main");
  turns[0]!.emit({ type: "delta", text: ": three found." });
  turns[0]!.emit({ type: "done", messageId: "r1" });
  turns[0]!.finish();
  await flush();
  expect(host.textContent).not.toContain("three found");

  await draw(RESEARCH);
  await flush();
  expect(host.textContent).toContain("Find three sources");
  expect(host.textContent).toContain("Working on it: three found.");
  expect(composer(host).value).toBe("");

  await draw("main");
  await flush();
  expect(composer(host).value).toBe("A note for Main");
});

test("a failed reply has a Try again row that sends the same message again", async () => {
  const { api, turns } = fakeChatApi();
  const { host } = await render({ controller: ready(bot("main", "Main"), bot(RESEARCH, "Research")), selected: RESEARCH, api });
  await sendMessage(host, "Hello");
  turns[0]!.emit({ type: "error", code: "model_unavailable" });
  turns[0]!.finish();
  await flush();
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Research's model isn't answering. Try again later.");
  await act(async () => alert.querySelector("button")!.click());
  await flush();
  expect(turns.map((turn) => turn.text)).toEqual(["Hello", "Hello"]);
});

test("the expiry notice names the bot on screen and offers Reconnect", async () => {
  const { api } = fakeChatApi();
  api.readNotice = async (key) => (key === RESEARCH ? { id: "n1", expiresAt: Date.UTC(2026, 10, 1), firstAttemptAt: Date.UTC(2026, 10, 1), deliveredAt: 1, deleteAt: Date.UTC(2026, 11, 1) } : null);
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  let reconnected = 0;
  await act(async () => mounted!.render(
    <BotsChat controller={ready(bot("main", "Main"), bot(RESEARCH, "Research"))} selected={RESEARCH} faceOf={() => MAIN_BOT}
      history={{ enabled: async () => false, authorize: async () => {}, grant: async () => {}, read: async () => [] }} active chatApi={api} onReconnect={() => reconnected++} />,
  ));
  await flush();
  const notice = host.querySelector("[data-history-expiry-notice]");
  expect(notice?.textContent).toContain("Research's chat history on our server will be deleted on");
  await act(async () => notice!.querySelector("button")!.click());
  expect(reconnected).toBe(1);
});
