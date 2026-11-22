import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { MAIN_BOT_NAME } from "./botsStrings";
import type { AskRequest, BotsApi, SendOptions } from "./botsApi";
import { AskCards } from "./AskCards";
import type { Asks } from "./useAsks";

// Radix portals do not attach in happy-dom: the sheet's chrome is an inline stand-in; everything inside is real.
// bun's mock.module is process-wide, so the real module is put back when this file is done.
const actualSheet = { ...(await import("../components/ui/responsive-sheet")) };
afterAll(() => { mock.module("../components/ui/responsive-sheet", () => actualSheet); });
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" {...props.contentProps}><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
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

const EXPIRED_LINE = "TrustBot’s question expired without an answer.";
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };

const pending = (over: Partial<AskRequest> = {}): AskRequest => ({
  id: "r1",
  kind: "ask",
  state: "pending",
  askedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  question: "Which colour?",
  outside: false,
  undelivered: false,
  ...over,
});

const asksWith = (outcomes: Asks["outcomes"]): Asks => ({
  support: "yes", enabled: true, stopped: false, pending: [], outcomes, webOn: false,
  setEnabled: async () => "ok", stop: async () => "ok", decide: async () => "ok", refresh: () => {},
});

test("the line is exactly Monica's words with the curly apostrophe and the Main constant", () => {
  expect(MAIN_BOT_NAME).toBe("TrustBot");
  expect(EXPIRED_LINE).toBe(`${MAIN_BOT_NAME}’s question expired without an answer.`);
});

test("an expired question shows the card text and, once, the app-originated line; a declined one shows no expired line", async () => {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<AskCards asks={asksWith([{ id: "a", kind: "expired" }, { id: "b", kind: "declined" }, { id: "c", kind: "expired" }])} outcomes />));
  expect([...host.querySelectorAll("[data-ask-outcome]")].map((node) => node.textContent)).toEqual(["This question expired.", "You said not now.", "This question expired."]);
  const lines = [...host.querySelectorAll('[data-app-line="expired"]')];
  expect(lines.map((node) => node.textContent)).toEqual([EXPIRED_LINE, EXPIRED_LINE]);
  expect(lines[0]!.className).toContain("text-muted-foreground");
});

test("Home shows neither the outcome nor the line for an expired question", async () => {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<AskCards asks={asksWith([{ id: "a", kind: "expired" }])} />));
  expect(host.querySelector("[data-ask-outcome], [data-app-line]")).toBeNull();
});

test("a question that expires under the owner in Main's chat gets the line once, stays once on later reads, and nothing goes to Main", async () => {
  const sends: (SendOptions | undefined)[] = [];
  let requests = [pending()];
  let listed = 0;
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    getMainWeb: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
    setMainWeb: async () => { throw new Error("unused"); },
    getAsks: async () => ({ enabled: true }),
    setAsks: async () => ({ enabled: true }),
    listRequests: async () => { listed++; return requests; },
    answerRequest: async () => { throw new Error("unused"); },
    sendToMain: async (_text, onEvent, _signal, options) => {
      sends.push(options);
      onEvent({ type: "done", messageId: `m${sends.length}` });
    },
  };
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<HomeAskBox api={api} />));
  await flush();
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Open TrustBot\'s chat"]')!.click(); });
  await flush();
  expect(document.querySelectorAll("[data-ask-card]")).toHaveLength(1);
  expect(document.querySelector("[data-app-line]")).toBeNull();

  requests = [pending({ state: "expired", question: undefined, resolvedAt: new Date().toISOString() })];
  // A turn ending is one of the triggers for reading the requests again: send a message.
  const box = document.querySelector<HTMLTextAreaElement>('[data-bots-main-chat] textarea[placeholder="Message TrustBot"]')!;
  await act(async () => {
    box.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hi");
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-bots-main-chat] button[aria-label="Send to TrustBot"]')!.click(); });
  await flush();
  const chat = document.querySelector("[data-bots-main-chat]")!;
  expect(document.querySelectorAll("[data-ask-card]")).toHaveLength(0);
  expect(chat.querySelector("[data-ask-outcome]")!.textContent).toBe("This question expired.");
  expect([...chat.querySelectorAll('[data-app-line="expired"]')].map((node) => node.textContent)).toEqual([EXPIRED_LINE]);

  // Reading the requests again does not add the line a second time.
  const before = listed;
  await act(async () => { box.focus(); Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "again"); box.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true })); });
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-bots-main-chat] button[aria-label="Send to TrustBot"]')!.click(); });
  await flush();
  expect(listed).toBeGreaterThan(before);
  expect(chat.querySelectorAll('[data-app-line="expired"]')).toHaveLength(1);
  // Only the owner's own two messages were sent: nothing for the expiry.
  expect(sends).toEqual([undefined, undefined]);
});
