import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { initSizeClass } from "@/lib/sizeClass";
import { installDom } from "@/test/dom";
import { MAIN_BOT } from "./BotAvatar";
import type { BotChatApi } from "./botChatApi";
import { BotRosterError, type CreateBotInput } from "./botRosterApi";
import type { ControllerBot } from "./BotsChat";

// Radix portals do not attach in happy-dom: the dialogs' chrome is an inline stand-in; everything inside is real.
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

const RESEARCH = "0123456789abcdef0123456789abcdef";
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const api: BotChatApi = {
  listMessages: async () => [],
  send: () => new Promise<void>(() => {}),
  readNotice: async () => null,
  acknowledgeNotice: async (_key, notice) => notice,
};
const bots: ControllerBot[] = [
  { key: "main", name: "Main", environment: "private", state: "active", shape: "pebble", colour: "blue" },
  { key: RESEARCH, name: "Research", environment: "private", state: "active", shape: "sprout", colour: "green" },
];

async function render(selected: string) {
  const calls: string[] = [];
  const failures: { update?: BotRosterError; remove?: Error } = {};
  restore = installDom();
  window.innerWidth = 1280;
  window.innerHeight = 900;
  stopSize = initSizeClass(window);
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  const manage = {
    update: async (key: string, input: Partial<CreateBotInput>) => {
      if (failures.update) throw failures.update;
      calls.push(`update ${key} ${JSON.stringify(input)}`);
    },
    remove: async (key: string) => {
      if (failures.remove) throw failures.remove;
      calls.push(`remove ${key}`);
    },
  };
  await act(async () => mounted!.render(
    <BotsChat controller={{ status: "ready", roster: { bots }, manage }} selected={selected} faceOf={() => MAIN_BOT} history={null} active chatApi={api} />,
  ));
  await flush();
  await act(async () => host.querySelector<HTMLButtonElement>("h1 button")!.click());
  return { host, calls, failures };
}

const labelled = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find((button) => button.textContent === text);
const field = (scope: ParentNode) => scope.querySelector<HTMLInputElement>('input[type="text"]')!;

async function typeName(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
}

test("Main's panel has Edit and no Delete bot; another bot's has both", async () => {
  const main = await render("main");
  expect(labelled(main.host, "Edit")).toBeDefined();
  expect(labelled(main.host, "Delete bot")).toBeUndefined();
  act(() => mounted!.unmount());
  mounted = undefined;
  stopSize?.();
  restore?.();

  const other = await render(RESEARCH);
  expect(labelled(other.host, "Edit")).toBeDefined();
  expect(labelled(other.host, "Delete bot")).toBeDefined();
});

test("Edit sends only what changed, and a name another bot has is refused before anything is sent", async () => {
  const { host, calls } = await render(RESEARCH);
  await act(async () => labelled(host, "Edit")!.click());
  const dialog = document.body.querySelector("[data-edit-bot-dialog]")!;
  const save = () => labelled(dialog, "Save")!;
  expect(save().disabled).toBe(true);

  await typeName(field(dialog), "main");
  expect(save().disabled).toBe(true);
  expect(dialog.textContent).toContain("You already have a bot with that name.");

  await typeName(field(dialog), "Notes");
  expect(save().disabled).toBe(false);
  await act(async () => save().click());
  await flush();
  expect(calls).toEqual([`update ${RESEARCH} {"name":"Notes"}`]);
  expect(document.body.querySelector("[data-edit-bot-dialog]")).toBeNull();
});

test("a refused save keeps the dialog open with the reason", async () => {
  const { host, calls, failures } = await render(RESEARCH);
  failures.update = new BotRosterError("name_taken");
  await act(async () => labelled(host, "Edit")!.click());
  const dialog = document.body.querySelector("[data-edit-bot-dialog]")!;
  await typeName(field(dialog), "Notes");
  await act(async () => labelled(dialog, "Save")!.click());
  await flush();
  expect(calls).toEqual([]);
  expect(dialog.textContent).toContain("You already have a bot with that name.");
});

test("Delete bot asks first: Cancel deletes nothing, and the confirm deletes that bot", async () => {
  const { host, calls } = await render(RESEARCH);
  await act(async () => labelled(host, "Delete bot")!.click());
  let confirm = document.body.querySelector("[data-delete-bot-confirm]")!;
  expect(confirm.textContent).toContain("Delete Research?");
  expect(calls).toEqual([]);
  await act(async () => labelled(confirm, "Cancel")!.click());
  expect(calls).toEqual([]);
  expect(document.body.querySelector("[data-delete-bot-confirm]")).toBeNull();

  await act(async () => labelled(host, "Delete bot")!.click());
  confirm = document.body.querySelector("[data-delete-bot-confirm]")!;
  await act(async () => labelled(confirm, "Delete bot")!.click());
  await flush();
  expect(calls).toEqual([`remove ${RESEARCH}`]);
});

test("a delete that fails keeps the question open and says so", async () => {
  const { host, failures } = await render(RESEARCH);
  failures.remove = new Error("down");
  await act(async () => labelled(host, "Delete bot")!.click());
  const confirm = document.body.querySelector("[data-delete-bot-confirm]")!;
  await act(async () => labelled(confirm, "Delete bot")!.click());
  await flush();
  expect(document.body.querySelector("[data-delete-bot-confirm] [role=alert]")?.textContent).toBe("Couldn't delete your bot. Try again.");
});
