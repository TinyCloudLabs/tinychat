import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import type { BotsApi } from "./botsApi";

// Radix portals do not attach in happy-dom: only the sheet shell is an inline stand-in; MainChat's body and footer stay.
const actualSheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; onOpenChange: (open: boolean) => void; children?: ReactNode; footer?: ReactNode; contentProps?: object }) =>
    props.open ? <div role="dialog" {...props.contentProps}>
      <button type="button" aria-label="Close" onClick={() => props.onOpenChange(false)} />
      {props.children}<div>{props.footer}</div>
    </div> : null,
}));
const { HomeAskBox } = await import("./HomeAskBox");

let restore: (() => void) | undefined;
let mounted: Root | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  restore?.();
  restore = undefined;
});

const ADDRESS = "0x00000000000000000000000000000000000a11ce";
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const api: BotsApi = { getBotsStatus: async () => ({ enabled: true }), listMainMessages: async () => [], sendToMain: async () => {} } as unknown as BotsApi;
// A session and a space with no saved records: only the service call matters here.
const tcw = {
  session: () => ({ address: ADDRESS, chainId: 1, sessionKey: "k", siwe: "s" }),
  kvForSpace: () => ({ list: async () => ({ ok: true, data: { keys: [], truncated: false } }) }),
  hasPermissions: () => false,
} as unknown as TinyCloudWeb;

const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent === text);

// React decides at import time whether the DOM has a native input event; without one it watches focus and key events.
async function type(text: string) {
  const box = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="What do you want done?"]')!;
  box.focus();
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
  await act(async () => {
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  });
}

test("the Home ask box cannot send while the chats are being deleted, even once the sheet is closed", async () => {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, ADDRESS);
  const gate = Promise.withResolvers<Response>();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.endsWith("/api/bots/main/new-chat") ? gate.promise : new Response(null, { status: 404 });
  }) as typeof fetch);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<HomeAskBox api={api} tcw={tcw} />));
  await flush();

  await type("hello");
  expect(byLabel("Send")!.disabled).toBe(false);

  await act(async () => { byLabel("Open TrustBot's chat")!.click(); });
  await flush();
  await act(async () => { byText("Delete chats")!.click(); });
  await act(async () => { byText("Delete chats")!.click(); });
  await flush();
  expect(byText("Deleting…")).toBeDefined();
  expect(byLabel("Send")!.disabled).toBe(true);

  // The owner closes the sheet mid-run: the ask box still waits.
  await act(async () => { byLabel("Close")!.click(); });
  await flush();
  expect(document.querySelector("[data-bots-main-chat]")).toBeNull();
  expect(byLabel("Send")!.disabled).toBe(true);

  await act(async () => { gate.resolve(Response.json({ outcome: "cleared" })); });
  await flush();
  expect(byLabel("Send")!.disabled).toBe(false);
});
