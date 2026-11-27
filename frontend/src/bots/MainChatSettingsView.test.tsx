// Main's chat sheet keeps talking and settings apart: the conversation shows on its own, and the settings (web access,
// read areas, questions, new chat) are one header button away, in a second view of the same sheet.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BOTS_STRINGS } from "./botsStrings";
import type { ReadAreaApi, ReadSettings } from "./trustbotReadGrant";
import type { Asks } from "./useAsks";
import type { MainChatState } from "./useMainChat";

// Radix portals do not attach in happy-dom: the sheet's chrome is an inline stand-in with the header actions; the body
// and footer are real. bun's mock.module is process-wide, so the real module is put back when this file is done.
const actualSheet = { ...(await import("../components/ui/responsive-sheet")) };
afterAll(() => { mock.module("../components/ui/responsive-sheet", () => actualSheet); });
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; headerActions?: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" {...props.contentProps}><h2>{props.title}</h2>{props.headerActions}{props.children}<div data-footer="">{props.footer}</div></div> : null,
}));
const { MainChat } = await import("./MainChat");

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const STATE: MainChatState = {
  history: "loaded",
  lines: [
    { id: "m1", role: "user", text: "Give me three names for a reading group." },
    { id: "m2", role: "bot", text: "Margins, Second Chapter, and The Long Shelf." },
  ],
  turn: null,
};

const READS: ReadSettings = { serviceDid: "did:key:test", expiresAt: Date.now() + 86_400_000, grantCid: "grant", areas: { meetings: "off", feed_chats: "on" } };

function reads(log: { loads: number }): ReadAreaApi {
  return {
    readSettings: async () => { log.loads++; return READS; },
    setReadArea: async () => READS,
    signReadGrant: async () => { throw new Error("unused"); },
    revokeReadGrant: async () => {},
  };
}

const ASKS: Asks = {
  support: "yes", enabled: true, stopped: false, pending: [], outcomes: [], secrets: [], saved: new Set(),
  owner: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001", webOn: false,
  noteWeb: () => {}, markSaved: () => {}, dismiss: () => {}, setEnabled: async () => "ok", stop: async () => "ok", decide: async () => "ok", refresh: () => {},
};

const WEB = { getMainWeb: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }) as const, setMainWeb: async () => { throw new Error("unused"); } };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

async function show() {
  restore = installDom();
  const log = { loads: 0 };
  const meetings = reads(log);
  const newChat = { start: () => new Promise<never>(() => {}) };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  const render = (open: boolean) => root.render(
    <MainChat open={open} onOpenChange={() => {}} state={STATE} onSend={() => {}} onRetry={() => {}} onRetryHistory={() => {}}
      webAccess={WEB} meetings={meetings} asks={ASKS} newChat={newChat} />,
  );
  await act(async () => render(true));
  await flush();
  return { log, render: async (open: boolean) => { await act(async () => render(open)); await flush(); } };
}

const shown = (node: Element | null | undefined) => !!node && !node.closest(".hidden");
const buttonNamed = (name: string) => document.querySelector<HTMLButtonElement>(`[data-bots-main-chat] button[aria-label="${name}"]`);
const textNode = (text: string) => [...document.querySelectorAll("p, button, h2, span")].find((node) => node.textContent === text);
const settingsControls = () => [
  textNode(BOTS_STRINGS.modelLine),
  textNode("Web access"),
  document.querySelector("[data-bots-read-area=meetings]"),
  document.querySelector("[data-bots-read-area=feed_chats]"),
  document.querySelector("[data-bots-asks]"),
  document.querySelector("[data-bots-new-chat]"),
];
const lines = () => STATE.lines.map((line) => textNode(line.text));
const composer = () => document.querySelector(`[data-footer] textarea`);

test("the chat view shows the conversation and composer, and none of the settings", async () => {
  await show();
  expect(lines().every(shown)).toBe(true);
  expect(composer()).not.toBeNull();
  const controls = settingsControls();
  expect(controls.every((node) => node !== undefined && node !== null)).toBe(true);
  expect(controls.some(shown)).toBe(false);
  expect(buttonNamed(BOTS_STRINGS.mainSettings)).not.toBeNull();
  expect(buttonNamed(BOTS_STRINGS.backToChat)).toBeNull();
});

test("the settings button opens every setting; Back returns to the conversation with its lines intact", async () => {
  await show();
  const toggle = buttonNamed(BOTS_STRINGS.mainSettings)!;
  await act(async () => { toggle.click(); });
  expect(settingsControls().every(shown)).toBe(true);
  expect(lines().some(shown)).toBe(false);
  expect(composer()).toBeNull();
  // The same header button turns into Back, so focus stays where the owner pressed.
  expect(buttonNamed(BOTS_STRINGS.backToChat)).toBe(toggle);
  expect(document.querySelector("[data-bots-main-chat] h2")!.textContent).toBe("TrustBot");

  await act(async () => { toggle.click(); });
  expect(buttonNamed(BOTS_STRINGS.mainSettings)).toBe(toggle);
  expect(lines().every(shown)).toBe(true);
  expect(lines().map((node) => node?.textContent)).toEqual(STATE.lines.map((line) => line.text));
  expect(composer()).not.toBeNull();
  expect(settingsControls().some(shown)).toBe(false);
});

test("the sheet opens in the chat view again after it closed in the settings view", async () => {
  const { render } = await show();
  await act(async () => { buttonNamed(BOTS_STRINGS.mainSettings)!.click(); });
  await render(false);
  await render(true);
  expect(buttonNamed(BOTS_STRINGS.mainSettings)).not.toBeNull();
  expect(lines().every(shown)).toBe(true);
  expect(settingsControls().some(shown)).toBe(false);
});

test("read settings load when the sheet opens, before the settings view is shown, and show in it", async () => {
  const { log } = await show();
  expect(log.loads).toBeGreaterThan(0);
  const loads = log.loads;
  await act(async () => { buttonNamed(BOTS_STRINGS.mainSettings)!.click(); });
  await flush();
  expect(log.loads).toBe(loads);
  const feedChats = document.querySelector("[data-bots-read-area=feed_chats]")!;
  expect(shown(feedChats)).toBe(true);
  expect([...feedChats.querySelectorAll("button")].some((node) => node.textContent === "Turn off")).toBe(true);
});
