import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { initSizeClass } from "@/lib/sizeClass";
import { installDom } from "@/test/dom";
import { MAIN_BOT } from "./BotAvatar";
import type { BotChatApi } from "./botChatApi";
import type { MainEvent } from "./botsApi";
import type { ControllerBot } from "./BotsChat";

// Radix portals do not attach in happy-dom: the sheet's chrome is an inline stand-in (a dynamic import so the mock
// is in place first); everything inside it is real.
// bun's mock.module is process-wide: the stand-in keeps every other export of the real module, and the real module
// is put back when this file is done.
const actualSheet = { ...(await import("../components/ui/responsive-sheet")) };
afterAll(() => {
  mock.module("../components/ui/responsive-sheet", () => actualSheet);
});
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" {...props.contentProps}><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { BotsChat } = await import("./BotsChat");

let restore: (() => void) | undefined;
let stopSize: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  stopSize?.();
  stopSize = undefined;
  restore?.();
  restore = undefined;
});

const ID = (n: number) => n.toString(16).padStart(32, "0");
const AT = (seconds: number) => `2026-11-18T23:00:${String(seconds).padStart(2, "0")}.000Z`;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const MESSAGES = [
  { id: "u1", role: "user" as const, text: "Fix the build", at: AT(0) },
  { id: "b1", role: "bot" as const, text: "Fixed.", at: AT(20) },
];
const ACTIVITY = [
  { id: ID(1), verb: "ran_commands" as const, count: 3, at: AT(5) },
  { id: ID(2), verb: "changed_files" as const, count: 1, at: AT(10) },
  { id: ID(3), verb: "ran_commands" as const, count: 1, at: AT(15) },
  { id: ID(4), verb: "changed_files" as const, count: 2, at: AT(18) },
];

function fakeApi() {
  const turns: { emit: (event: MainEvent) => void; finish: () => void }[] = [];
  const api: BotChatApi = {
    listMessages: async () => MESSAGES,
    listConversation: async () => ({ messages: MESSAGES, activity: ACTIVITY }),
    send: (_key, _text, onEvent) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      turns.push({ emit: onEvent, finish: resolve });
      return promise;
    },
    readNotice: async () => null,
    acknowledgeNotice: async (_key, notice) => notice,
  };
  return { api, turns };
}

async function render(api: BotChatApi, options: { width?: number; environment?: ControllerBot["environment"] } = {}) {
  restore = installDom();
  if (options.width) {
    window.innerWidth = options.width;
    window.innerHeight = 900;
    stopSize = initSizeClass(window);
  }
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  const main: ControllerBot = { key: "main", name: "Main", environment: options.environment ?? "private", state: "active" };
  await act(async () => mounted!.render(
    <BotsChat controller={{ status: "ready", roster: { bots: [main] } }} selected="main" faceOf={() => MAIN_BOT} history={null} active chatApi={api} />,
  ));
  await flush();
  return host;
}

const activityLines = (host: HTMLElement) => [...host.querySelectorAll("[data-bot-activity]")].map((node) => node.textContent);
const pill = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("h1 button")!;

test("each activity line is shown between the messages, with its plural right, and the same lines are there after a reload", async () => {
  const host = await render(fakeApi().api);
  expect(activityLines(host)).toEqual(["Ran 3 commands", "Changed 1 file", "Ran 1 command", "Changed 2 files"]);
  const order = [...host.querySelectorAll("[data-bot-activity], p, [data-bot-reply]")].map((node) => node.textContent);
  expect(order.indexOf("Fix the build")).toBeLessThan(order.indexOf("Ran 3 commands"));
  expect(order.indexOf("Changed 2 files")).toBeLessThan(order.indexOf("Fixed."));
});

test("an activity line arriving during a turn is shown before the reply and stays after it", async () => {
  const { api, turns } = fakeApi();
  const host = await render(api);
  const box = host.querySelector("textarea")!;
  await act(async () => {
    box.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Run it");
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await flush();
  await act(async () => turns[0]!.emit({ type: "activity", activity: { id: ID(9), verb: "ran_commands", count: 2, at: AT(40) } }));
  expect(activityLines(host).at(-1)).toBe("Ran 2 commands");
  await act(async () => {
    turns[0]!.emit({ type: "delta", text: "Ran them." });
    turns[0]!.emit({ type: "done", messageId: "b2" });
    turns[0]!.finish();
  });
  await flush();
  expect(activityLines(host).at(-1)).toBe("Ran 2 commands");
  expect(host.textContent).toContain("Ran them.");
});

test("on a wide screen the pill opens a column with the activity newest first, and Private · asleep", async () => {
  const host = await render(fakeApi().api, { width: 1280 });
  expect(host.querySelector("[data-bot-panel]")).toBeNull();
  await act(async () => pill(host).click());
  const panel = host.querySelector("aside [data-bot-panel]")!;
  expect(panel).not.toBeNull();
  expect([...panel.querySelectorAll("[data-bot-activity-row]")].map((row) => row.querySelector("span")!.textContent))
    .toEqual(["Changed 2 files", "Ran 1 command", "Changed 1 file", "Ran 3 commands"]);
  expect(panel.querySelector("[data-bot-environment]")!.textContent).toBe("Private · asleep");
  expect(pill(host).getAttribute("aria-expanded")).toBe("true");
  await act(async () => panel.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector("[data-bot-panel]")).toBeNull();
});

test("the panel says Regular only for a bot whose environment is regular, and awake while a turn runs", async () => {
  const { api, turns } = fakeApi();
  const host = await render(api, { width: 1280, environment: "regular" });
  await act(async () => pill(host).click());
  expect(host.querySelector("[data-bot-environment]")!.textContent).toBe("Regular · asleep");
  const box = host.querySelector("textarea")!;
  await act(async () => {
    box.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Go");
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await flush();
  expect(host.querySelector("[data-bot-environment]")!.textContent).toBe("Regular · awake");
  await act(async () => { turns[0]!.emit({ type: "done", messageId: "b2" }); turns[0]!.finish(); });
});

test("below 1024 px the panel is a sheet, not a column", async () => {
  const host = await render(fakeApi().api, { width: 390 });
  await act(async () => pill(host).click());
  await flush();
  expect(host.querySelector("aside")).toBeNull();
  expect(document.body.querySelector("[data-bot-panel-sheet] [data-bot-panel]")).not.toBeNull();
});
