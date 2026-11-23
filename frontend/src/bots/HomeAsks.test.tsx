import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { ASK_STRINGS } from "./askStrings";
import { BotsNoReply, BotsRouteMissing, type AskDecision, type AskRequest, type BotsApi, type SendOptions } from "./botsApi";

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

const pending = (over: Partial<AskRequest> = {}): AskRequest => ({
  id: "r1",
  kind: "ask",
  state: "pending",
  askedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(),
  question: "Which colour?",
  outside: false,
  undelivered: false,
  ...over,
});

/** A service with one request that moves from pending to what the owner decided, as the real one does. */
function service(options: { enabled?: boolean; missing?: boolean; requests?: AskRequest[]; web?: "off" | "any" } = {}) {
  const log = {
    listed: 0,
    decisions: [] as { id: string; decision: AskDecision }[],
    sends: [] as { text: string; options?: SendOptions }[],
    asks: [] as boolean[],
  };
  let enabled = options.enabled ?? true;
  let requests = options.requests ?? [pending()];
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    getMainWeb: async () => ({ mode: options.web ?? "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
    setMainWeb: async () => { throw new Error("unused"); },
    getAsks: async () => { if (options.missing) throw new BotsRouteMissing(); return { enabled }; },
    setAsks: async (settings) => { enabled = settings.enabled; log.asks.push(settings.enabled); return { enabled }; },
    listRequests: async () => { log.listed++; return requests; },
    answerRequest: async (id, decision) => {
      log.decisions.push({ id, decision });
      requests = requests.map((request) => request.id === id
        ? { ...request, state: decision.decision === "decline" ? "declined" : "answered", question: undefined, choices: undefined }
        : request);
      return requests.find((request) => request.id === id)!;
    },
    sendToMain: async (text, onEvent, _signal, sendOptions) => {
      log.sends.push({ text, options: sendOptions });
      onEvent({ type: "delta", text: "Thanks." });
      onEvent({ type: "done", messageId: `m${log.sends.length}` });
    },
  };
  return { api, log };
}

async function flush() {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

async function render(api: BotsApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<HomeAskBox api={api} />));
  await flush();
  return host;
}

const cards = () => [...document.querySelectorAll("[data-ask-card]")];
const inHome = (host: Element) => [...host.querySelectorAll("[data-home-asks] [data-ask-card]")];
const inChat = () => [...document.querySelectorAll("[data-bots-main-chat] [data-ask-card]")];
const press = async (label: string, scope: ParentNode = document) => {
  await act(async () => { [...scope.querySelectorAll("button")].find((node) => node.textContent === label)!.click(); });
  await flush();
};
const openChat = async () => {
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Open TrustBot\'s chat"]')!.click(); });
  await flush();
};
const typeAnswer = async (value: string) => {
  const area = document.querySelector<HTMLTextAreaElement>("[data-ask-card] textarea")!;
  await act(async () => {
    area.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
};

test("one request is one card: on Home while the chat is closed, in the chat while it is open, never both", async () => {
  const { api } = service();
  const host = await render(api);
  expect(inHome(host)).toHaveLength(1);
  expect(cards()).toHaveLength(1);
  await openChat();
  expect(inChat()).toHaveLength(1);
  expect(cards()).toHaveLength(1);
  expect(inHome(host)).toHaveLength(0);
});

test("answering in the chat resolves it for Home too; Main gets an app-originated reply with the request id and no free text", async () => {
  const { api, log } = service();
  const host = await render(api);
  await openChat();
  await typeAnswer("green");
  await press("Answer", document.querySelector("[data-ask-card]")!);
  expect(log.decisions).toEqual([{ id: "r1", decision: { decision: "answer", answer: "green" } }]);
  expect(log.sends).toHaveLength(1);
  expect(log.sends[0]!.options).toEqual({ appReply: { requestId: "r1" } });
  expect(log.sends[0]!.text).toBe("");
  expect(document.querySelector("[data-bots-main-chat]")!.textContent).not.toContain("green");
  expect(cards()).toHaveLength(0);
  expect(document.querySelector("[data-app-line]")!.textContent).toBe(ASK_STRINGS.lineAnswered);
  expect(document.querySelector("[data-bots-main-chat]")!.textContent).toContain("Thanks.");
  // Closing the chat afterwards brings nothing back to Home.
  await press("Close");
  expect(inHome(host)).toHaveLength(0);
});

test("saying not now on Home resolves the chat's card too: the chat shows the collapsed outcome, and Main is told once", async () => {
  const { api, log } = service();
  const host = await render(api);
  await press("Not now", inHome(host)[0]);
  expect(log.decisions).toEqual([{ id: "r1", decision: { decision: "decline" } }]);
  expect(log.sends.map((send) => send.options)).toEqual([{ appReply: { requestId: "r1" } }]);
  expect(inHome(host)).toHaveLength(0);
  await openChat();
  expect(cards()).toHaveLength(0);
  expect(document.querySelector("[data-ask-outcome]")!.textContent).toBe("You said not now.");
  expect(document.querySelector("[data-app-line]")).toBeNull();
});

test("the decision is held for Main while a turn is still running, then sent once", async () => {
  const { api, log } = service();
  let finish!: () => void;
  const base = api.sendToMain;
  api.sendToMain = async (text, onEvent, signal, options) => {
    if (!options) { await new Promise<void>((resolve) => { finish = resolve; }); }
    return base(text, onEvent, signal, options);
  };
  await render(api);
  const box = document.querySelector<HTMLTextAreaElement>("[data-bots-ask] textarea")!;
  await act(async () => {
    box.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hello");
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-bots-ask] button[type="submit"]')!.click(); });
  await flush();
  await openChat();
  await press("Not now", document.querySelector("[data-ask-card]")!);
  expect(log.decisions).toHaveLength(1);
  expect(log.sends.filter((send) => send.options)).toHaveLength(0);
  await act(async () => { finish(); });
  await flush();
  expect(log.sends.filter((send) => send.options).map((send) => send.options)).toEqual([{ appReply: { requestId: "r1" } }]);
});

test("a decision recorded but never delivered (the page was closed) is delivered once on the next load, answer or not now", async () => {
  const { api, log } = service({ requests: [
    pending({ id: "r1", state: "answered", undelivered: true, question: undefined }),
    pending({ id: "r2", state: "declined", undelivered: true, question: undefined }),
    pending({ id: "r3", state: "answered", undelivered: false, question: undefined }),
  ] });
  await render(api);
  await flush();
  expect(log.sends.map((send) => send.options)).toEqual([{ appReply: { requestId: "r1" } }, { appReply: { requestId: "r2" } }]);
});

test("a question that expires while the chat is open collapses to the expired line and Main is not told", async () => {
  const { api, log } = service();
  await render(api);
  await openChat();
  expect(cards()).toHaveLength(1);
  const expired = { ...pending(), state: "expired" as const, question: undefined };
  api.listRequests = async () => [expired];
  // The chat polls every few seconds while open; a turn ending is the other trigger, so send one.
  const box = document.querySelector<HTMLTextAreaElement>('[data-bots-main-chat] textarea[placeholder="Message TrustBot"]');
  expect(box).not.toBeNull();
  await act(async () => {
    box!.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hi");
    box!.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-bots-main-chat] button[aria-label="Send to TrustBot"]')!.click(); });
  await flush();
  expect(cards()).toHaveLength(0);
  expect(document.querySelector("[data-ask-outcome]")!.textContent).toBe("This question expired.");
  expect(log.sends.filter((send) => send.options)).toHaveLength(0);
});

test("Stop Main from asking turns the setting off, collapses the card and says so; the toggle shows it off", async () => {
  const { api, log } = service();
  await render(api);
  await openChat();
  await press("Stop TrustBot from asking", document.querySelector("[data-ask-card]")!);
  expect(log.asks).toEqual([false]);
  expect(cards()).toHaveLength(0);
  expect(document.querySelector("[data-ask-stopped]")!.textContent).toBe(ASK_STRINGS.stopped);
  expect(document.querySelector<HTMLInputElement>("[data-bots-asks] input")!.checked).toBe(false);
});

test("with the setting off (the default) nothing is asked of the service and the toggle shows off", async () => {
  const { api, log } = service({ enabled: false });
  const host = await render(api);
  await openChat();
  expect(log.listed).toBe(0);
  expect(inHome(host)).toHaveLength(0);
  expect(document.querySelector<HTMLInputElement>("[data-bots-asks] input")!.checked).toBe(false);
  await act(async () => { document.querySelector<HTMLInputElement>("[data-bots-asks] input")!.click(); });
  await flush();
  expect(log.asks).toEqual([true]);
});

test("a service without the route (404) shows no toggle, no card and no polling", async () => {
  const { api, log } = service({ missing: true });
  const host = await render(api);
  await openChat();
  expect(document.querySelector("[data-bots-asks]")).toBeNull();
  expect(cards()).toHaveLength(0);
  expect(inHome(host)).toHaveLength(0);
  expect(log.listed).toBe(0);
});

test("the Web access line shows on the card when Web access is on", async () => {
  const { api } = service({ web: "any" });
  const host = await render(api);
  expect(inHome(host)[0]!.querySelector("[data-ask-web]")).not.toBeNull();
});

test("earlier app-originated messages show as muted lines, never as words the owner typed, and never with the answer text", async () => {
  const { api } = service({ requests: [] });
  api.listMainMessages = async () => [
    { id: "a", role: "user", text: "The person answered your question: hunter2", at: "", origin: "app", decision: "answered" },
    { id: "b", role: "bot", text: "Noted.", at: "" },
    { id: "c", role: "user", text: "Any words at all", at: "", origin: "app", decision: "declined" },
    { id: "d", role: "user", text: "typed by me", at: "" },
    { id: "e", role: "user", text: "The person chose not to answer now. Carry on without it.", at: "", origin: "app" },
  ];
  await render(api);
  await openChat();
  const chat = document.querySelector("[data-bots-main-chat]")!;
  expect([...chat.querySelectorAll("[data-app-line]")].map((node) => node.textContent)).toEqual([ASK_STRINGS.lineAnswered, ASK_STRINGS.lineDeclined, ASK_STRINGS.lineDeclined]);
  expect(chat.textContent).not.toContain("hunter2");
  expect(chat.textContent).not.toContain("Any words at all");
  expect(chat.textContent).toContain("typed by me");
});

test("a refused app reply (409 no_reply) is quiet: no error, no retry, and the requests are read again", async () => {
  const { api, log } = service();
  api.sendToMain = async (_text, _onEvent, _signal, options) => { if (options) throw new BotsNoReply(); };
  const host = await render(api);
  const before = log.listed;
  await press("Not now", inHome(host)[0]);
  expect(log.decisions).toHaveLength(1);
  expect(log.listed).toBe(before + 1);
  await openChat();
  const chat = document.querySelector("[data-bots-main-chat]")!;
  expect(chat.querySelector('[role="alert"]')).toBeNull();
  expect(chat.textContent).not.toContain("Try again");
});
