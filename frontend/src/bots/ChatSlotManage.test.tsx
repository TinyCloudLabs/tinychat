import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { initSizeClass } from "@/lib/sizeClass";
import { installDom } from "@/test/dom";
import type { BotChatApi } from "./botChatApi";
import type { BotRoster, BotRosterApi, CreateBotInput, RosterBot } from "./botRosterApi";
import type { BotsApi } from "./botsApi";
import { botPath } from "./botPath";

// Radix portals do not attach in happy-dom: the dialogs' chrome is an inline stand-in; everything inside is real.
// A dynamic import keeps the mock in place before ChatSlot loads.
// bun's mock.module is process-wide: each stand-in keeps every other export of the real module, and the real
// modules are put back when this file is done.
const actualSheet = { ...(await import("../components/ui/responsive-sheet")) };
const actualAlert = { ...(await import("../components/ui/alert-dialog")) };
afterAll(() => {
  mock.module("../components/ui/responsive-sheet", () => actualSheet);
  mock.module("../components/ui/alert-dialog", () => actualAlert);
});
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" {...props.contentProps}><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
mock.module("../components/ui/alert-dialog", () => ({
  ...actualAlert,
  AlertDialog: (props: { open: boolean; children?: ReactNode }) => (props.open ? <div role="alertdialog">{props.children}</div> : null),
  AlertDialogContent: (props: { children?: ReactNode } & Record<string, unknown>) => <div {...{ "data-delete-bot-confirm": props["data-delete-bot-confirm"] }}>{props.children}</div>,
  AlertDialogHeader: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  AlertDialogTitle: (props: { children?: ReactNode }) => <h2>{props.children}</h2>,
  AlertDialogDescription: (props: { children?: ReactNode }) => <p>{props.children}</p>,
  AlertDialogFooter: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { ChatSlot } = await import("./ChatSlot");

const ACCOUNT = "did:pkh:eip155:1:0xabc";
const RESEARCH = "0123456789abcdef0123456789abcdef";

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

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const labelled = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find((button) => button.textContent === text);

function fakeRoster() {
  const bot = (key: string, name: string, shape: RosterBot["shape"], colour: RosterBot["colour"]): RosterBot =>
    ({ key, name, shape, colour, environment: "private", state: "active", createdAt: "2026-11-01T00:00:00.000Z" });
  let bots: RosterBot[] = [bot("main", "Main", "pebble", "blue"), bot(RESEARCH, "Research", "sprout", "green")];
  const calls: string[] = [];
  const api: BotRosterApi = {
    list: async () => {
      calls.push("list");
      return { bots, deleted: [], capMode: "flat3", limits: null, canCreate: { private: false, regular: false } } satisfies BotRoster;
    },
    create: async () => { throw new Error("not used"); },
    update: async (key: string, input: Partial<CreateBotInput>) => {
      calls.push(`update ${key} ${JSON.stringify(input)}`);
      bots = bots.map((entry) => (entry.key === key ? { ...entry, ...input } : entry));
      return bots.find((entry) => entry.key === key)!;
    },
    remove: async (key: string) => {
      calls.push(`remove ${key}`);
      bots = bots.map((entry) => (entry.key === key ? { ...entry, state: "deleting", deletingSince: "2026-11-19T00:00:00.000Z" } : entry));
      return bots.find((entry) => entry.key === key)!;
    },
  };
  return { api, calls };
}

async function render() {
  await import("./BotsSurface");
  restore = installDom();
  window.innerWidth = 1280;
  window.innerHeight = 900;
  stopSize = initSizeClass(window);
  window.localStorage.setItem(`tinychat:chat-view:v1:${ACCOUNT}`, "bots");
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  const roster = fakeRoster();
  const api = { getBotsStatus: async () => ({ enabled: true }), listMainMessages: async () => [] } as unknown as BotsApi;
  const chatApi: BotChatApi = {
    listMessages: async () => [],
    send: () => new Promise<void>(() => {}),
    readNotice: async () => null,
    acknowledgeNotice: async (_key, notice) => notice,
  };
  await act(async () => mounted!.render(
    <MemoryRouter initialEntries={[botPath(RESEARCH)]}>
      <ChatSlot classic={<div />} account={ACCOUNT} tcw={{} as TinyCloudWeb} active api={api} rosterApi={roster.api} chatApi={chatApi} history={null} />
    </MemoryRouter>,
  ));
  await flush();
  await flush();
  return { host, ...roster };
}

test("the bot the address names is shown with the look the roster holds, and Edit renames it and reads the list again", async () => {
  const { host, calls } = await render();
  expect(host.querySelector("[data-bot-view]")?.getAttribute("data-bot-view")).toBe(RESEARCH);
  expect(host.querySelector("h1")?.textContent).toContain("Research");

  await act(async () => host.querySelector<HTMLButtonElement>("h1 button")!.click());
  await act(async () => labelled(host, "Edit")!.click());
  const dialog = document.body.querySelector("[data-edit-bot-dialog]")!;
  const input = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "Notes");
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => labelled(dialog, "Save")!.click());
  await flush();
  await flush();

  expect(calls).toEqual(["list", `update ${RESEARCH} {"name":"Notes"}`, "list"]);
  expect(host.querySelector("h1")?.textContent).toContain("Notes");
});

test("Delete bot removes it, reads the list again, and the view falls back to Main", async () => {
  const { host, calls } = await render();
  await act(async () => host.querySelector<HTMLButtonElement>("h1 button")!.click());
  await act(async () => labelled(host, "Delete bot")!.click());
  const confirm = document.body.querySelector("[data-delete-bot-confirm]")!;
  await act(async () => labelled(confirm, "Delete bot")!.click());
  await flush();
  await flush();

  expect(calls).toEqual(["list", `remove ${RESEARCH}`, "list"]);
  expect(host.querySelector("[data-bot-view]")?.getAttribute("data-bot-view")).toBe("main");
});
