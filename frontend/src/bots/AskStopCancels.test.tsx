import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { ASK_MAIN, ASK_STRINGS } from "./askStrings";
import { BotsNoReply, createBotsApi, type AskRequest, type BotMessage, type BotsApi } from "./botsApi";

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

const STOPPED_LINE = `You turned off questions from ${ASK_MAIN}, so its open questions were closed.`;

const pending = (id: string): AskRequest => ({
  id,
  kind: "ask",
  state: "pending",
  askedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  question: `Secret question ${id}?`,
  choices: ["yes", "no"],
  outside: false,
  undelivered: false,
});

/**
 * A service that does what the real one does when asks are turned off: every pending request becomes `stopped` and
 * undelivered, with its question gone. An app reply for it delivers once; a second one is refused (409 no_reply).
 */
function service() {
  const state = {
    enabled: true,
    requests: [pending("r1"), pending("r2"), pending("r3")],
    sends: [] as string[],
    asks: [] as boolean[],
    lists: 0,
    /** Makes one read of the requests (the nth) answer late with what it saw before the cancel. */
    hold: undefined as { nth: number; until: Promise<void> } | undefined,
  };
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    getMainWeb: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
    setMainWeb: async () => { throw new Error("unused"); },
    getAsks: async () => ({ enabled: state.enabled }),
    setAsks: async ({ enabled }) => {
      state.asks.push(enabled);
      state.enabled = enabled;
      if (!enabled) {
        state.requests = state.requests.map((request) => request.state === "pending"
          ? { ...request, state: "stopped" as const, undelivered: true, question: undefined, choices: undefined }
          : request);
      }
      return { enabled };
    },
    listRequests: async () => {
      const snapshot = state.requests;
      if (++state.lists === state.hold?.nth) await state.hold.until;
      return snapshot;
    },
    answerRequest: async () => { throw new Error("unused"); },
    sendToMain: async (_text, onEvent, _signal, options) => {
      const id = options?.appReply?.requestId;
      const request = state.requests.find((candidate) => candidate.id === id);
      if (!id || !request?.undelivered) throw new BotsNoReply();
      state.sends.push(id);
      // One switch-off is one message: delivering any stopped request delivers the whole batch.
      state.requests = state.requests.map((candidate) => candidate.id === id || (request.state === "stopped" && candidate.state === "stopped")
        ? { ...candidate, undelivered: false } : candidate);
      onEvent({ type: "done", messageId: `m${state.sends.length}` });
    },
  };
  return { api, state };
}

const flush = async () => { await act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); }); };
const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); await flush(); };
const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === label)!;
const openChat = () => click(document.querySelector('button[aria-label="Open Main\'s chat"]')!);
const cards = () => document.querySelectorAll("[data-ask-card]");
const chatLines = (kind: string) => [...document.querySelectorAll(`[data-bots-main-chat] [data-app-line="${kind}"]`)].map((node) => node.textContent);

async function render(api: BotsApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<HomeAskBox api={api} />));
  await flush();
}

test("Stop Main from asking on Home removes the cards now and sends Main ONE message for all stopped requests, once, and keeps the confirmation", async () => {
  const { api, state } = service();
  await render(api);
  expect(cards()).toHaveLength(3);
  await click(button("Stop Main from asking"));
  expect(state.asks).toEqual([false]);
  expect(cards()).toHaveLength(0);
  expect(document.querySelector("[data-ask-stopped]")!.textContent).toBe(ASK_STRINGS.stopped);
  expect([...state.sends]).toEqual(["r1"]);
  // Opening and closing the chat does not send again, and the confirmation stays.
  await openChat();
  await click(button("Close"));
  expect([...state.sends]).toEqual(["r1"]);
  expect(document.querySelector("[data-ask-stopped]")).not.toBeNull();
});

test("the chat says once that questions were turned off, however many were closed, and never the not-now line", async () => {
  const { api } = service();
  await render(api);
  await openChat();
  await click(button("Stop Main from asking"));
  expect(chatLines("stopped")).toEqual([STOPPED_LINE]);
  expect(chatLines("declined")).toEqual([]);
  expect(document.querySelector("[data-ask-outcome]")).toBeNull();
});

test("turning the setting off in the chat does the same, and turning it back on brings nothing back or sends nothing again", async () => {
  const { api, state } = service();
  await render(api);
  await openChat();
  expect(cards()).toHaveLength(3);
  const toggle = () => document.querySelector<HTMLInputElement>("[data-bots-asks] input")!;
  expect(toggle().checked).toBe(true);
  await click(toggle());
  expect(state.asks).toEqual([false]);
  expect(cards()).toHaveLength(0);
  expect([...state.sends]).toEqual(["r1"]);
  expect(chatLines("stopped")).toEqual([STOPPED_LINE]);

  await click(toggle());
  expect(state.asks).toEqual([false, true]);
  expect(cards()).toHaveLength(0);
  expect(document.querySelector("[data-ask-stopped]")).toBeNull();
  expect([...state.sends]).toEqual(["r1"]);
  expect(chatLines("stopped")).toEqual([STOPPED_LINE]);
  expect(chatLines("declined")).toEqual([]);
  await click(button("Close"));
  expect(document.querySelector("[data-home-asks]")).toBeNull();
});

test("a second switch-off later is a new batch: it sends again, once, and adds its own line", async () => {
  const { api, state } = service();
  await render(api);
  await openChat();
  const toggle = () => document.querySelector<HTMLInputElement>("[data-bots-asks] input")!;
  await click(toggle());
  expect(state.sends).toEqual(["r1"]);
  await click(toggle());
  expect(state.asks).toEqual([false, true]);
  state.requests = [...state.requests, pending("r4"), pending("r5")];
  await click(button("Close"));
  await openChat();
  expect(cards()).toHaveLength(2);
  await click(toggle());
  expect(state.asks).toEqual([false, true, false]);
  expect(cards()).toHaveLength(0);
  expect(state.sends).toEqual(["r1", "r4"]);
  expect(chatLines("stopped")).toEqual([STOPPED_LINE, STOPPED_LINE]);
  await click(button("Close"));
  await openChat();
  expect(state.sends).toEqual(["r1", "r4"]);
});

test("no question text from before the stop is shown after it, even when a read that began earlier lands late", async () => {
  const { api, state } = service();
  const { promise, resolve } = Promise.withResolvers<void>();
  await render(api);
  // The read made when the chat opens is the one held back; it saw both questions pending.
  state.hold = { nth: state.lists + 1, until: promise };
  await openChat();
  await click(button("Stop Main from asking"));
  expect(cards()).toHaveLength(0);
  await act(async () => { resolve(); });
  await flush();
  expect(cards()).toHaveLength(0);
  expect(document.body.textContent).not.toContain("Secret question");
  expect(document.querySelector("[data-ask-outcome]")).toBeNull();
  expect([...state.sends]).toEqual(["r1"]);
});

test("history lines with the decision stopped each show the line; the decision, not the text, decides", async () => {
  const { api } = service();
  api.getAsks = async () => ({ enabled: false });
  api.listMainMessages = async (): Promise<BotMessage[]> => [
    { id: "a", role: "user", text: "The person chose not to answer now. Carry on without it.", at: "", origin: "app", decision: "stopped" },
    { id: "b", role: "bot", text: "Understood.", at: "" },
    { id: "c", role: "user", text: "Any words at all", at: "", origin: "app", decision: "stopped" },
    { id: "d", role: "bot", text: "Okay.", at: "" },
    { id: "e", role: "user", text: "typed by me", at: "" },
    { id: "f", role: "user", text: "Other words", at: "", origin: "app", decision: "stopped" },
  ];
  await render(api);
  await openChat();
  expect(chatLines("stopped")).toEqual([STOPPED_LINE, STOPPED_LINE, STOPPED_LINE]);
  expect(chatLines("declined")).toEqual([]);
  expect(document.querySelector("[data-bots-main-chat]")!.textContent).not.toContain("Any words at all");
  expect(document.querySelector("[data-bots-main-chat]")!.textContent).toContain("typed by me");
});

test("the service state stopped and the decision stopped are kept by the client, and an unknown state is dropped", async () => {
  const seen = (body: unknown) => createBotsApi({ baseUrl: "https://backend.test/", getToken: () => "t", fetch: async () => Response.json(body) });
  const stopped = { id: "r1", kind: "ask", state: "stopped", askedAt: "2026-11-21T00:00:00.000Z", expiresAt: "2026-11-22T00:00:00.000Z", outside: false, undelivered: true };
  expect(await seen({ requests: [stopped] }).listRequests()).toEqual([expect.objectContaining({ id: "r1", state: "stopped", undelivered: true })]);
  expect(await seen({ requests: [{ ...stopped, state: "cancelled" }] }).listRequests()).toEqual([]);
  const messages = await seen({ messages: [{ id: "a", role: "user", text: "t", at: "", origin: "app", decision: "stopped" }] }).listMainMessages();
  expect(messages.map((message) => message.decision)).toEqual(["stopped"]);
});
