// TC-4382: the working line in the two chats. On a bot's page it stays for the whole turn under the reply text as it
// streams and it follows the steps. In the main bot's chat over Home a card waiting on the owner comes first and
// the icon is the one the owner picked.
import { afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { installDom } from "@/test/dom";
import type { BotChatApi } from "./botChatApi";
import type { BotRoster } from "./botRosterApi";
import type { AskRequest, BotsApi, MainEvent, SecretRequest } from "./botsApi";
import { BotShape } from "./botShapes";
import type { Asks } from "./useAsks";
import type { MainChatState } from "./useMainChat";

// Radix portals do not attach in happy-dom: only the dialog shell is an inline stand-in; the real body and footer stay.
// The views are imported after the stand-in is in place, so they take it.
const actualSheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
}));
const { MainChat } = await import("./MainChat");
const { BotsChat } = await import("./BotsChat");
const { HomeAskBox } = await import("./HomeAskBox");

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(node: ReactNode) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(node));
  await flush();
  return host;
}

async function send(host: HTMLElement, value: string) {
  const field = host.querySelector("textarea")!;
  await act(async () => {
    // happy-dom has no native `input` support, so React reads the change of the focused field on key events.
    field.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await flush();
}

const row = (host: ParentNode) => host.querySelector("[data-bot-working-row]");
const line = (host: ParentNode) => row(host)?.querySelector('[role="status"]')?.textContent;
/** The comet's outline as the shared shape draws it, whatever the size. */
const COMET = /<path d="[^"]+"/.exec(renderToStaticMarkup(<BotShape shape="comet" size={21} />))![0];

test("on a bot's page the line stays under the reply text for the whole turn and follows the steps", async () => {
  let emit!: (event: MainEvent) => void;
  const turn = Promise.withResolvers<void>();
  const api: BotChatApi = {
    listMessages: async () => [],
    send: (_key, _text, onEvent) => {
      emit = onEvent;
      return turn.promise;
    },
    readNotice: async () => null,
    acknowledgeNotice: async (_key, notice) => notice,
  };
  const picked = { key: "main", name: "TrustBot", shape: "comet", colour: "purple" } as const;
  const host = await render(
    <BotsChat controller={{ status: "ready", roster: { bots: [{ key: "main", name: "TrustBot", environment: "private", state: "active" }] } }}
      selected="main" faceOf={() => picked} history={null} active chatApi={api} />,
  );
  expect(row(host)).toBeNull();

  await send(host, "When is high tide?");
  await act(async () => emit({ type: "status", state: "working" }));
  expect(line(host)).toBe("Working on it…");
  expect(host.querySelector("h1 [data-bot-working]")).not.toBeNull();
  expect(row(host)!.innerHTML).toContain(COMET);
  expect(host.querySelector("h1")!.innerHTML).toContain(COMET);

  // The bot's one short line arrives; the row stays under it.
  await act(async () => emit({ type: "delta", text: "Checking the tide tables." }));
  const reply = host.querySelector("[data-bot-reply]")!;
  expect(reply.textContent).toContain("Checking the tide tables.");
  expect(line(host)).toBe("Writing the reply…");
  expect(reply.compareDocumentPosition(row(host)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await act(async () => emit({ type: "step", step: "thinking" }));
  expect(line(host)).toBe("Working on it…");
  const status = row(host)!.querySelector('[role="status"]');
  await act(async () => emit({ type: "step", step: "search" }));
  expect(line(host)).toBe("Searching the web…");
  await act(async () => emit({ type: "step", step: "read_page", host: "www.tides.example" }));
  expect(line(host)).toBe("Reading tides.example…");
  await act(async () => emit({ type: "step", step: "commands" }));
  expect(line(host)).toBe("Running a command…");
  // One status element through every change, so a screen reader hears each line once.
  expect(row(host)!.querySelector('[role="status"]')).toBe(status);
  expect(host.querySelectorAll("[data-bot-working-row]")).toHaveLength(1);

  await act(async () => { emit({ type: "delta", text: " High tide is at 14:05." }); emit({ type: "done", messageId: "m1" }); turn.resolve(); });
  await flush();
  expect(row(host)).toBeNull();
  expect(host.querySelector("h1 [data-bot-working]")).toBeNull();
  expect(host.textContent).toContain("High tide is at 14:05.");
  expect(host.textContent).not.toContain("Working on it…");
});

test("a failed turn shows no working line", async () => {
  const api: BotChatApi = {
    listMessages: async () => [],
    send: async (_key, _text, onEvent) => { onEvent({ type: "status", state: "working" }); onEvent({ type: "error", code: "model_unavailable" }); },
    readNotice: async () => null,
    acknowledgeNotice: async (_key, notice) => notice,
  };
  const host = await render(
    <BotsChat controller={{ status: "ready", roster: { bots: [{ key: "main", name: "TrustBot", environment: "private", state: "active" }] } }}
      selected="main" faceOf={(bot) => ({ name: bot.name, shape: "comet", colour: "purple" })} history={null} active chatApi={api} />,
  );
  await send(host, "When is high tide?");
  expect(row(host)).toBeNull();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

const WORKING: MainChatState = { lines: [], history: "loaded", turn: { text: "Post the weekly report.", reply: "", state: "working", step: { step: "search" } } };
const ok = async () => "ok" as const;
const asks = (pending: Asks["pending"], secrets: SecretRequest[]): Asks => ({
  support: "yes", enabled: true, stopped: false, pending, outcomes: [], secrets, saved: new Set(),
  webOn: false, noteWeb: () => {}, markSaved: () => {}, dismiss: () => {}, setEnabled: ok, stop: ok, decide: ok, refresh: () => {},
});
const SECRET: SecretRequest = { id: "s1", state: "pending", name: "ACME_REPORTS_TOKEN", sites: ["api.acme.example"], why: "To post the weekly report.", askedAt: "2026-11-25T10:00:00.000Z" } as SecretRequest;
const QUESTION = { id: "q1", kind: "ask", state: "pending", question: "Post it to the team channel?", choices: ["Yes", "No"], askedAt: "2026-11-25T10:00:00.000Z" } as unknown as AskRequest;

const chat = (state: MainChatState, extra: { asks?: Asks; face?: { key: string; name: string; shape: "comet"; colour: "purple" } } = {}) =>
  <MainChat open onOpenChange={() => {}} state={state} onSend={() => {}} onRetry={() => {}} onRetryHistory={() => {}} {...extra} />;

test("in the main bot's chat the line names the step, and a card the owner has not decided comes first", async () => {
  const host = await render(chat(WORKING));
  expect(line(host)).toBe("Searching the web…");
  await act(async () => mounted!.render(chat(WORKING, { asks: asks([], []) })));
  expect(line(host)).toBe("Searching the web…");
  await act(async () => mounted!.render(chat(WORKING, { asks: asks([], [SECRET]) })));
  expect(line(host)).toBe("Waiting for your approval");
  await act(async () => mounted!.render(chat(WORKING, { asks: asks([QUESTION], []) })));
  expect(line(host)).toBe("Waiting for your approval");
  // A decided secret's card may stay on screen; it waits on nobody.
  await act(async () => mounted!.render(chat(WORKING, { asks: asks([], [{ ...SECRET, state: "approved" }]) })));
  expect(line(host)).toBe("Searching the web…");
});

test("the main bot's chat keeps the line under streamed text, and shows the first icon until a picked one is given", async () => {
  const streaming: MainChatState = { ...WORKING, turn: { ...WORKING.turn!, reply: "Checking the report.", step: { step: "writing" } } };
  const host = await render(chat(streaming));
  expect(host.textContent).toContain("Checking the report.");
  expect(line(host)).toBe("Writing the reply…");
  expect(host.innerHTML).toContain("lucide-sparkles");
  expect(host.innerHTML).not.toContain(COMET);
  await act(async () => mounted!.render(chat(streaming, { face: { key: "main", name: "TrustBot", shape: "comet", colour: "purple" } })));
  expect(row(host)!.innerHTML).toContain(COMET);
  expect(host.querySelector("h2")!.innerHTML).toContain(COMET);
  expect(host.innerHTML).not.toContain("lucide-sparkles");
});

test("Home's chat with the main bot reads the picked icon from the roster", async () => {
  const client: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    sendToMain: async (_text, onEvent) => { onEvent({ type: "status", state: "working" }); await new Promise<void>(() => {}); },
  };
  const roster: BotRoster = {
    bots: [{ key: "main", name: "TrustBot", shape: "comet", colour: "purple", environment: "private", state: "active", createdAt: "2026-11-01T00:00:00.000Z" }],
    deleted: [], capMode: "flat3", limits: null, canCreate: { private: false, regular: false },
  };
  const host = await render(<HomeAskBox api={client} roster={{ list: async () => roster }} />);
  await send(host, "When is high tide?");
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(line(dialog)).toBe("Working on it…");
  expect(row(dialog)!.innerHTML).toContain(COMET);
});

test("with no roster to read, Home's chat with the main bot shows the first icon", async () => {
  const client: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    sendToMain: async (_text, onEvent) => { onEvent({ type: "status", state: "working" }); await new Promise<void>(() => {}); },
  };
  const host = await render(<HomeAskBox api={client} roster={{ list: async () => { throw new Error("no roster"); } }} />);
  await send(host, "When is high tide?");
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(line(dialog)).toBe("Working on it…");
  expect(row(dialog)!.innerHTML).toContain("lucide-sparkles");
});
