import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsRouteMissing } from "./botsApi";
import { BOTS_STRINGS } from "./botsStrings";
import type { DeleteChatsOutcome } from "./mainDeleteChats";
import { DeleteChats, type DeleteChatsApi } from "./DeleteChats";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const BOT = BOTS_STRINGS.mainName;

function fake(answer: () => Promise<DeleteChatsOutcome>) {
  const calls = { run: 0, cleared: 0, working: [] as boolean[] };
  const api: DeleteChatsApi = {
    run: async () => { calls.run += 1; return answer(); },
    onCleared: () => { calls.cleared += 1; },
  };
  return { api, calls };
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function render(api: DeleteChatsApi, working?: (value: boolean) => void) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<DeleteChats api={api} onWorking={working} />));
  await flush();
  return host;
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const click = async (host: HTMLElement, label: string) => { await act(async () => { button(host, label)!.click(); }); await flush(); };

test("the button asks first, says what is deleted and kept, and Cancel deletes nothing", async () => {
  const { api, calls } = fake(async () => "deleted");
  const host = await render(api);
  await click(host, "Delete chats");
  const sheet = host.querySelector('[role="alertdialog"]')!;
  expect(sheet.textContent).toContain(`Delete your chats with ${BOT}?`);
  expect(sheet.textContent).toContain(`${BOT} forgets this conversation, and your saved chat history with ${BOT} is deleted from your TinyCloud. This can't be undone. Your settings stay, and other bots and Courier conversations aren't affected.`);
  await click(host, "Cancel");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(calls.run).toBe(0);
});

test("confirming deletes, says so, tells the chat to read again, and holds sending while it runs", async () => {
  const gate = Promise.withResolvers<DeleteChatsOutcome>();
  const { api, calls } = fake(() => gate.promise);
  const working: boolean[] = [];
  const host = await render(api, (value) => working.push(value));
  await click(host, "Delete chats");
  await click(host, "Delete chats");
  expect(calls.run).toBe(1);
  expect(working).toEqual([true]);
  expect(button(host, "Deleting…")?.hasAttribute("disabled")).toBe(true);
  expect(button(host, "Cancel")?.hasAttribute("disabled")).toBe(true);
  gate.resolve("deleted");
  await flush();
  expect(working).toEqual([true, false]);
  expect(calls.cleared).toBe(1);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Chats deleted.");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

test("each refusal and failure gets its line; only a cleared conversation tells the chat to read again", async () => {
  const cases: [DeleteChatsOutcome, string, number][] = [
    ["busy", `${BOT} is busy. Try again in a moment. Nothing was deleted.`, 0],
    ["archive_pending", `${BOT} is saving this chat to your history. Try again in a moment. Nothing was deleted.`, 0],
    ["history_incomplete", "This conversation was cleared, but some saved history couldn't be deleted. Try again to delete the rest.", 1],
    ["signed_out", "Your sign-in has ended. Sign in to delete your chats. Nothing was deleted.", 0],
    ["failed", "Couldn't delete your chats. Nothing was deleted. Try again.", 0],
  ];
  for (const [outcome, line, cleared] of cases) {
    const { api, calls } = fake(async () => outcome);
    const host = await render(api);
    await click(host, "Delete chats");
    await click(host, "Delete chats");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(line);
    expect(calls.cleared).toBe(cleared);
    act(() => mounted!.unmount());
    mounted = undefined;
    restore?.();
    restore = undefined;
  }
});

test("a 404 removes the control", async () => {
  const { api } = fake(async () => { throw new BotsRouteMissing(); });
  const host = await render(api);
  await click(host, "Delete chats");
  await click(host, "Delete chats");
  expect(host.innerHTML).toBe("");
});
