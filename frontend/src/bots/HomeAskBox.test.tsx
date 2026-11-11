import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import type { BotsApi } from "./botsApi";
import { HomeAskBox } from "./HomeAskBox";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
// Unmount before removing the DOM: a live root keeps React scheduling against a window that later tests no longer have.
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

function api(status: () => Promise<{ enabled: boolean }>): BotsApi {
  return {
    getBotsStatus: status,
    listMainMessages: async () => [],
    sendToMain: async () => {},
  };
}

async function render(client: BotsApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<HomeAskBox api={client} />));
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  return host;
}

test("the ask box renders nothing for an account without tiny bots", async () => {
  expect((await render(api(async () => ({ enabled: false })))).innerHTML).toBe("");
});

test("the ask box renders nothing when the status call fails", async () => {
  expect((await render(api(async () => { throw new Error("offline"); }))).innerHTML).toBe("");
});

test("an enabled account sees the ask box with Main's chip", async () => {
  const host = await render(api(async () => ({ enabled: true })));
  expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe("What do you want done?");
  expect(host.querySelector('button[aria-label="Open Main\'s chat"]')).not.toBeNull();
});
