import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { ASK_STRINGS } from "./askStrings";
import type { AskRequest, BotsApi, MainWebMode } from "./botsApi";

// Radix portals do not attach in happy-dom: the sheet's chrome is an inline stand-in with a Close button; everything
// inside is real. bun's mock.module is process-wide, so the real module is put back when this file is done.
const actualSheet = { ...(await import("../components/ui/responsive-sheet")) };
afterAll(() => { mock.module("../components/ui/responsive-sheet", () => actualSheet); });
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" {...props.contentProps}><h2>{props.title}</h2><button type="button" onClick={() => props.onOpenChange(false)}>Close</button>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { HomeAskBox } = await import("./HomeAskBox");

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const pending = (id: string): AskRequest => ({
  id,
  kind: "ask",
  state: "pending",
  askedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  question: `Question ${id}?`,
  outside: false,
  undelivered: false,
});

function service(web: MainWebMode) {
  const state = { web, requests: [pending("r1")], webReads: 0 };
  const settings = () => ({ mode: state.web, hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } });
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    getMainWeb: async () => { state.webReads++; return settings(); },
    setMainWeb: async ({ mode }) => { state.web = mode; return settings(); },
    getAsks: async () => ({ enabled: true }),
    setAsks: async () => ({ enabled: true }),
    listRequests: async () => state.requests,
    answerRequest: async () => { throw new Error("unused"); },
    sendToMain: async () => {},
  };
  return { api, state };
}

const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); await flush(); };
const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === label)!;
const note = (scope: ParentNode = document) => scope.querySelector("[data-ask-web]");

async function render(api: BotsApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<HomeAskBox api={api} />));
  await flush();
}
const openChat = () => click(document.querySelector('button[aria-label="Open TrustBot\'s chat"]')!);

test("a card on screen follows Web access: turned on in the chat the same card gets the note, turned off it goes", async () => {
  const { api } = service("off");
  await render(api);
  await openChat();
  const card = document.querySelector("[data-ask-card]")!;
  expect(note(card)).toBeNull();

  await click(button("Web access"));
  await click(document.querySelector('input[type="radio"][value="any"]')!);
  await click(button("Save"));
  await click(button("Turn on"));
  expect(document.querySelector("[data-ask-card]")).toBe(card);
  expect(note(card)!.textContent).toBe(ASK_STRINGS.webAccessOn);

  await click(document.querySelector('input[type="radio"][value="off"]')!);
  await click(button("Save"));
  expect(document.querySelector("[data-ask-card]")).toBe(card);
  expect(note(card)).toBeNull();
});

test("a second card asked later shows the current Web access, not the value from when the first appeared", async () => {
  const { api, state } = service("off");
  await render(api);
  expect(note()).toBeNull();
  // Web access changes while the chat is closed (here, from another tab), then a second question arrives.
  state.web = "any";
  state.requests = [pending("r1"), pending("r2")];
  await openChat();
  const cards = [...document.querySelectorAll("[data-ask-card]")];
  expect(cards).toHaveLength(2);
  expect(cards.map((card) => note(card)?.textContent)).toEqual([ASK_STRINGS.webAccessOn, ASK_STRINGS.webAccessOn]);
});

test("a read of Web access that began before the owner saved a change does not undo it", async () => {
  const { api, state } = service("off");
  const { promise: stale, resolve: release } = Promise.withResolvers<void>();
  const read = api.getMainWeb;
  let reads = 0;
  // The cards read Web access when they appear (1) and when the chat opens (2): hold the second one back.
  api.getMainWeb = async (signal) => {
    if (++reads !== 2) return read(signal);
    const old = await read(signal);
    await stale;
    return old;
  };
  await render(api);
  await openChat();
  await click(button("Web access"));
  await click(document.querySelector('input[type="radio"][value="any"]')!);
  await click(button("Save"));
  await click(button("Turn on"));
  expect(state.web).toBe("any");
  await act(async () => { release(); });
  await flush();
  expect(note()).not.toBeNull();
});
