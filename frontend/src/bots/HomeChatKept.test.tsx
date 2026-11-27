// The owner leaves the Feed while TrustBot answers, then comes back: Home's chat shows the same lines, and the turn as
// it is now, without reading saved history (mainChatStore.ts).
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import type { BotsApi, MainEvent } from "./botsApi";
import { botsErrorText } from "./botsStrings";
import * as authorization from "./historyAuthorization";
import * as grants from "./historyGrant";
import { disposeMainChats } from "./mainChatStore";
import * as historyRead from "./historyRead";

// Radix portals do not attach in happy-dom: only the dialog shell is an inline stand-in; the real body and footer stay.
const actualSheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
}));
const { HomeAskBox } = await import("./HomeAskBox");

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  disposeMainChats();
  restore?.();
  restore = undefined;
  mock.restore();
});

type Turn = { emit: (event: MainEvent) => void; signal?: AbortSignal; end: { resolve: () => void; reject: (reason: unknown) => void } };

/** A bots client whose replies the test sends, event by event. A stopped stream rejects, as the real one does. */
function streamingApi() {
  const turns: Turn[] = [];
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    sendToMain: (_text, emit, signal) => {
      const end = Promise.withResolvers<void>();
      signal?.addEventListener("abort", () => end.reject(signal.reason));
      turns.push({ emit, signal, end });
      return end.promise;
    },
  };
  return { api, turns };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Shows the Feed's ask box: the first time, and again when the owner comes back. */
async function showFeed(api: BotsApi, tcw?: TinyCloudWeb) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<HomeAskBox api={api} tcw={tcw} />));
  await flush();
  return host;
}

function leaveFeed() {
  act(() => mounted!.unmount());
  mounted = undefined;
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

const openChat = (host: HTMLElement) => act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open TrustBot\'s chat"]')!.click());
const dialog = () => document.querySelector('[role="dialog"]')!;
const said = () => [...dialog().querySelectorAll("p")].map((node) => node.textContent);
const workingRow = () => dialog().querySelector("[data-bot-working-row]");
const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === label);

test("leaving the Feed while TrustBot answers keeps the turn going, and the reply is there on return", async () => {
  const { api, turns } = streamingApi();
  await send(await showFeed(api), "When is high tide?");
  await act(async () => turns[0]!.emit({ type: "status", state: "working" }));
  leaveFeed();
  expect(turns[0]!.signal!.aborted).toBe(false);
  await act(async () => {
    turns[0]!.emit({ type: "delta", text: "At six." });
    turns[0]!.emit({ type: "done", messageId: "m-1" });
    turns[0]!.end.resolve();
  });
  const host = await showFeed(api);
  await openChat(host);
  expect(said().filter((text) => text === "When is high tide?" || text === "At six.")).toEqual(["When is high tide?", "At six."]);
  expect(workingRow()).toBeNull();
});

test("a turn still running on return shows its working line and the text so far, and goes on live", async () => {
  const { api, turns } = streamingApi();
  await send(await showFeed(api), "When is high tide?");
  await act(async () => turns[0]!.emit({ type: "delta", text: "At " }));
  leaveFeed();
  const host = await showFeed(api);
  await openChat(host);
  expect(workingRow()).not.toBeNull();
  expect(said()).toContain("At ");
  await act(async () => turns[0]!.emit({ type: "delta", text: "six." }));
  expect(said()).toContain("At six.");
  await act(async () => { turns[0]!.emit({ type: "done", messageId: "m-1" }); turns[0]!.end.resolve(); });
  expect(workingRow()).toBeNull();
  expect(said().filter((text) => text === "When is high tide?" || text === "At six.")).toEqual(["When is high tide?", "At six."]);
});

test("a turn that fails while the Feed is away shows the same failure on return", async () => {
  const { api, turns } = streamingApi();
  await send(await showFeed(api), "When is high tide?");
  leaveFeed();
  await act(async () => { turns[0]!.emit({ type: "error", code: "at_capacity" }); turns[0]!.end.resolve(); });
  const host = await showFeed(api);
  await openChat(host);
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(botsErrorText("at_capacity"));
  expect(button("Try again")).toBeDefined();
});

test("coming back reads no saved history: it stays hidden until the owner presses Show older messages", async () => {
  let asks = 0;
  let reads = 0;
  spyOn(authorization, "authorizeBotHistory").mockImplementation(async () => { asks++; });
  spyOn(grants, "botHistoryEnabled").mockResolvedValue(true);
  spyOn(grants, "ensureBotHistoryGrant").mockResolvedValue();
  spyOn(historyRead, "readBotHistory").mockImplementation(async () => { reads++; return []; });
  const { api, turns } = streamingApi();
  const tcw = { did: "owner" } as unknown as TinyCloudWeb;
  await send(await showFeed(api, tcw), "When is high tide?");
  leaveFeed();
  await act(async () => { turns[0]!.emit({ type: "delta", text: "At six." }); turns[0]!.emit({ type: "done", messageId: "m-1" }); turns[0]!.end.resolve(); });
  const host = await showFeed(api, tcw);
  await openChat(host);
  expect(said()).toContain("At six.");
  expect({ asks, reads }).toEqual({ asks: 0, reads: 0 });
  await act(async () => { button("Show older messages")!.click(); });
  await flush();
  expect({ asks, reads }).toEqual({ asks: 1, reads: 1 });
});
