import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BOTS_STRINGS } from "./botsStrings";
import { BotsNoReply, type ActionRequest, type AskDecision, type BotsApi } from "./botsApi";

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

const SCOUT = "a".repeat(32);
const LEDGER = "b".repeat(32);
const BINDING = "c".repeat(64);

const proposal: ActionRequest = {
  id: "p1",
  kind: "action",
  action: "message_bots",
  state: "pending",
  askedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  outside: false,
  undelivered: false,
  targets: [{ key: SCOUT, name: "Scout" }, { key: LEDGER, name: "Ledger" }],
  text: "Status by noon, please.",
  binding: BINDING,
};

/** A service holding one proposal: Don't send declines it at once; Send makes it sending until the test finishes it. */
function service() {
  const state = {
    request: proposal,
    decisions: [] as AskDecision[],
    sends: [] as string[],
  };
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    getMainWeb: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
    setMainWeb: async () => { throw new Error("unused"); },
    getAsks: async () => ({ enabled: true }),
    setAsks: async ({ enabled }) => ({ enabled }),
    listRequests: async () => [state.request],
    answerRequest: async (_id, decision) => {
      state.decisions.push(decision);
      const { text: _text, binding: _binding, ...rest } = state.request;
      state.request = decision.decision === "approve"
        ? { ...rest, state: "sending" }
        : { ...rest, state: "declined", undelivered: true };
      return state.request;
    },
    sendToMain: async (_text, onEvent, _signal, options) => {
      const id = options?.appReply?.requestId;
      if (!id || !state.request.undelivered) throw new BotsNoReply();
      state.sends.push(id);
      state.request = { ...state.request, undelivered: false };
      onEvent({ type: "done", messageId: `m${state.sends.length}` });
    },
  };
  return { api, state };
}

const flush = async () => { await act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); }); };
const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); await flush(); };
const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === label)!;
const openChat = () => click(document.querySelector(`button[aria-label="Open ${BOTS_STRINGS.mainName}'s chat"]`)!);
const chatLines = () => [...document.querySelectorAll("[data-bots-main-chat] [data-app-line]")].map((node) => node.textContent);
const outcomes = () => [...document.querySelectorAll("[data-action-outcome]")].map((node) => node.textContent);

async function render(api: BotsApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<HomeAskBox api={api} />));
  await flush();
}

test("Don't send closes the card and tells the bot once, with the recipients in the owner's line", async () => {
  const { api, state } = service();
  await render(api);
  await openChat();
  await click(button("Don’t send"));
  expect(state.decisions).toEqual([{ decision: "decline" }]);
  expect(document.querySelector("[data-action-card]")).toBeNull();
  expect(outcomes()).toEqual(["You chose not to send it."]);
  expect(state.sends).toEqual(["p1"]);
  expect(chatLines()).toEqual([`You chose not to send ${BOTS_STRINGS.mainName}’s message to Scout and Ledger.`]);
});

test("Send names the card's binding; the bot hears of it only once the service has sent it, and only once", async () => {
  const { api, state } = service();
  await render(api);
  await openChat();
  await click(button("Send"));
  expect(state.decisions).toEqual([{ decision: "approve", binding: BINDING }]);
  expect(outcomes()).toEqual(["Sending…"]);
  expect(state.sends).toEqual([]);

  state.request = { ...state.request, state: "done", undelivered: true, outcomes: [{ key: SCOUT, delivered: true }, { key: LEDGER, delivered: true }] };
  await click(button("Close"));
  await openChat();
  expect(state.sends).toEqual(["p1"]);
  expect(outcomes()).toEqual(["Sent to Scout and Ledger."]);
  expect(chatLines()).toEqual([`You sent ${BOTS_STRINGS.mainName}’s message to Scout and Ledger.`]);
  await click(button("Close"));
  await openChat();
  expect(state.sends).toEqual(["p1"]);
});
