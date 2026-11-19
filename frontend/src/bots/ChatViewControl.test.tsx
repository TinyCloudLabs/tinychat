import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import type { BotsApi } from "./botsApi";
import { readChatView, saveChatView } from "./chatViewSetting";
import { ChatViewSetting } from "./ChatViewControl";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

const ACCOUNT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const HELPER = "Classic shows one chat. Bots gives each bot its own chat.";
const NOT_ADMITTED = "Bots aren't available on this account. Classic chat works as before.";

const api = (enabled: boolean): BotsApi => ({
  getBotsStatus: async () => ({ enabled }),
  listMainMessages: async () => [],
  sendToMain: async () => {},
});

async function render(admitted: boolean) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ChatViewSetting account={ACCOUNT} api={api(admitted)} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const radio = (label: string) => [...host.querySelectorAll("label")].find((node) => node.textContent === label)!.querySelector("input")!;
  return { host, radio };
}

test("an account the backend lets into bots can pick Bots, and the choice is kept for it", async () => {
  const { host, radio } = await render(true);
  expect(host.querySelector("h2")?.textContent).toBe("Chat view");
  expect(host.textContent).toContain(HELPER);
  expect(radio("Classic").checked).toBe(true);
  expect(radio("Bots").disabled).toBe(false);
  expect(host.textContent).not.toContain(NOT_ADMITTED);
  await act(async () => radio("Bots").click());
  expect(radio("Bots").checked).toBe(true);
  expect(readChatView(ACCOUNT)).toBe("bots");
});

test("for any other account Bots is off and says why, even with Bots saved", async () => {
  const { host, radio } = await render(false);
  await act(async () => saveChatView(ACCOUNT, "bots"));
  expect(readChatView(ACCOUNT)).toBe("bots");
  expect(radio("Bots").disabled).toBe(true);
  expect(radio("Classic").checked).toBe(true);
  expect(document.getElementById(radio("Bots").getAttribute("aria-describedby")!)?.textContent).toBe(NOT_ADMITTED);
  expect(host.textContent).toContain(HELPER);
});
