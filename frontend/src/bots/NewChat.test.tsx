import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsError, BotsRouteMissing } from "./botsApi";
import { BOTS_STRINGS } from "./botsStrings";
import type { NewChatOutcome } from "./mainNewChat";
import { NewChat, type NewChatApi } from "./NewChat";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const BOT = BOTS_STRINGS.mainName;

function fake(answer: () => Promise<NewChatOutcome>) {
  const calls = { start: 0, started: 0 };
  const api: NewChatApi = {
    start: async () => { calls.start += 1; return answer(); },
    onStarted: () => { calls.started += 1; },
  };
  return { api, calls };
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function render(api: NewChatApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<NewChat api={api} />));
  await flush();
  return host;
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const click = async (host: HTMLElement, label: string) => { await act(async () => { button(host, label)!.click(); }); await flush(); };

test("the button asks first, says what is cleared and kept, and Cancel sends nothing", async () => {
  const { api, calls } = fake(async () => "cleared");
  const host = await render(api);
  await click(host, "Start a new chat");
  const sheet = host.querySelector('[role="alertdialog"]')!;
  expect(sheet.textContent).toContain(`Start a new chat with ${BOT}?`);
  expect(sheet.textContent).toContain(`${BOT} forgets this conversation, and any questions it's waiting on are closed. If web access or messages to other bots were paused here, the new chat lifts that pause. Earlier messages leave this view, and those saved in your TinyCloud show here when you next open the page, though ${BOT} doesn't remember them. Your settings stay.`);
  await click(host, "Cancel");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(calls.start).toBe(0);
});

test("confirming starts the new chat, says so and reads the questions again", async () => {
  const { api, calls } = fake(async () => "cleared");
  const host = await render(api);
  await click(host, "Start a new chat");
  await click(host, "Start new chat");
  expect(calls).toEqual({ start: 1, started: 1 });
  expect(host.querySelector('[role="status"]')?.textContent).toBe("New chat started.");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

test("a reply in progress, unsaved history or a failure each get their line and start nothing", async () => {
  const cases: [() => Promise<NewChatOutcome>, string][] = [
    [async () => "busy", `${BOT} is busy. Try again in a moment.`],
    [async () => "archive_pending", `${BOT} is saving this chat to your history. Try again in a moment.`],
    [async () => { throw new BotsError("failed"); }, "Couldn't change this. Try again."],
  ];
  for (const [answer, line] of cases) {
    const { api, calls } = fake(answer);
    const host = await render(api);
    await click(host, "Start a new chat");
    await click(host, "Start new chat");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(line);
    expect(calls.started).toBe(0);
    act(() => mounted!.unmount());
    mounted = undefined;
    restore?.();
    restore = undefined;
  }
});

test("a 404 removes the control", async () => {
  const { api } = fake(async () => { throw new BotsRouteMissing(); });
  const host = await render(api);
  await click(host, "Start a new chat");
  await click(host, "Start new chat");
  expect(host.innerHTML).toBe("");
});
