import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
let asks = 0;
let sends = 0;
import * as authorization from "./historyAuthorization";
import * as grants from "./historyGrant";
import * as historyRead from "./historyRead";
const sheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({ ...sheet,
  ResponsiveSheet: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
}));
const { HomeAskBox } = await import("./HomeAskBox");
let root: Root | undefined;
let restore: (() => void) | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; restore?.(); restore = undefined; asks = 0; sends = 0; mock.restore(); });
const button = (label: string) => [...document.querySelectorAll("button")].find(node => node.textContent === label);
async function mount() {
  spyOn(authorization, "authorizeBotHistory").mockImplementation(async () => { asks++; throw new Error("history_approval_declined"); });
  spyOn(grants, "botHistoryEnabled").mockResolvedValue(true);
  spyOn(grants, "ensureBotHistoryGrant").mockResolvedValue();
  spyOn(historyRead, "readBotHistory").mockResolvedValue([]);
  restore = installDom();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<HomeAskBox api={{ getBotsStatus: async () => ({ enabled: true }), listMainMessages: async () => [], sendToMain: async (_text, event) => { sends++; event({ type: "done", messageId: `reply-${sends}` }); } }} tcw={{ did: "owner" } as unknown as TinyCloudWeb} />));
  const open = async () => { await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Open TrustBot\'s chat"]')!.click()); };
  await open(); return { open };
}
test("opening the chat leaves history approval untouched", async () => {
  await mount(); expect(asks).toBe(0); expect(button("Show older messages")).toBeDefined();
});
test("a history press makes one request", async () => {
  await mount(); await act(async () => { button("Show older messages")!.click(); }); expect(asks).toBe(1);
});
test("a decline keeps reopening and focus free of requests", async () => {
  const chat = await mount(); await act(async () => { button("Show older messages")!.click(); });
  expect(document.body.textContent).toContain("Older messages need your OK");
  await chat.open(); await act(async () => window.dispatchEvent(new Event("focus"))); expect(asks).toBe(1);
});
test("each deliberate history press permits one request", async () => {
  await mount(); for (let count = 1; count <= 3; count++) {
    await act(async () => { button("Show older messages")!.click(); }); expect(asks).toBe(count);
  }
});

test("send completes without history permission on entry and following a decline", async () => {
  await mount();
  const send = async () => {
    const input = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "hello");
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Send to TrustBot"]')!.click());
  };
  await send(); expect(sends).toBe(1); expect(asks).toBe(0);
  await act(async () => { button("Show older messages")!.click(); });
  await send(); expect(sends).toBe(2); expect(asks).toBe(1);
});
