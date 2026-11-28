// TrustBot asks for a read area in the conversation, under the reply that needed it: the card is the settings' own
// section for that area, it goes on "Not now" or once access is on, and access given there asks the question again.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { ASK_STRINGS } from "./askStrings";
import type { BotsApi, MainEvent } from "./botsApi";
import { BOTS_STRINGS, FEED_CHATS_ACCESS_STRINGS, MEETINGS_ACCESS_STRINGS } from "./botsStrings";
import type { MeetingsAccessApi } from "./MeetingsAccess";
import type { ReadArea } from "./trustbotReadAreas";
import type { ReadAreaState, ReadSettings } from "./trustbotReadGrant";
import { useMainChat } from "./useMainChat";

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

const DID = "did:pkh:eip155:1:0x" + "11".repeat(20);
type Turn = { text: string; emit: (event: MainEvent) => void; end: { resolve: () => void } };

/** One stored settings value that each PUT changes, as the backend does, and a bots client whose replies the test sends. */
function services(areas: Record<Exclude<ReadArea, "telegram">, ReadAreaState>) {
  let current: ReadSettings = { serviceDid: DID, expiresAt: null, grantCid: null, areas: { ...areas } };
  const log = { loads: 0, puts: [] as { area: ReadArea; enabled: boolean }[] };
  const meetings: MeetingsAccessApi = {
    readSettings: async () => { log.loads++; return current; },
    signReadGrant: async () => ({ serialized: "s", siwe: "w", signature: "g" }),
    setReadArea: async (area, enabled) => {
      log.puts.push({ area, enabled });
      current = { ...current, expiresAt: Date.UTC(2026, 11, 4), grantCid: `cid-${log.puts.length}`, areas: { ...current.areas, [area]: enabled ? "on" : "off" } };
      return current;
    },
    revokeReadGrant: async () => {},
    chatReadAccess: {
      listChats: async () => [{ id: "chat-1", title: "Reading group" }],
      readDeniedChatIds: async () => new Set<string>(),
      setChatDenied: async () => {},
    },
  };
  const turns: Turn[] = [];
  const bots: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    sendToMain: (text, emit) => {
      const end = Promise.withResolvers<void>();
      turns.push({ text, emit, end });
      return end.promise;
    },
  };
  return { meetings, bots, turns, log };
}

const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });

async function show(areas: Record<Exclude<ReadArea, "telegram">, ReadAreaState>) {
  restore = installDom();
  const service = services(areas);
  let chat!: ReturnType<typeof useMainChat>;
  function Sheet() {
    chat = useMainChat(service.bots, undefined, undefined, true);
    return <MainChat open onOpenChange={() => {}} state={chat.state} onSend={(text) => void chat.send(text)} onRetry={chat.retry} onRetryHistory={() => {}}
      meetings={service.meetings} newChat={{ start: async () => {}, onStarted: chat.clear }} onNotNow={chat.notNow} onAskAgain={chat.askAgain} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<Sheet />));
  await flush();
  const ask = async (text: string) => { await act(async () => { void chat.send(text); }); await flush(); };
  const reply = async (steps: MainEvent[], text: string, messageId: string) => {
    const turn = service.turns.at(-1)!;
    await act(async () => {
      for (const step of steps) turn.emit(step);
      turn.emit({ type: "delta", text });
      turn.emit({ type: "done", messageId });
      turn.end.resolve();
    });
    await flush();
  };
  return { ...service, chat: () => chat, ask, reply };
}

const card = (area: ReadArea) => document.querySelector(`[data-bots-access-card=${area}]`);
const settings = () => document.querySelector("[data-bots-main-settings]")!;
const button = (scope: Element | null | undefined, text: string) => [...(scope?.querySelectorAll("button") ?? [])].find((node) => node.textContent === text);
const click = async (node: HTMLElement | undefined) => { expect(node).toBeDefined(); await act(async () => { node!.click(); }); await flush(); };
const meetingsStep: MainEvent = { type: "step", step: "meetings" };

async function grantInCard(area: ReadArea, copy: { allow: string; confirm: string }) {
  await click(button(card(area), copy.allow));
  await click(button(card(area), copy.confirm));
}

test("an off area the reply tried shows its card under the newest reply only, in the chat view", async () => {
  const chat = await show({ meetings: "off", feed_chats: "on" });
  await chat.ask("What did we decide on Monday?");
  await chat.reply([meetingsStep], "I need access to your meetings.", "m-1");
  const shown = card("meetings")!;
  expect(shown).not.toBeNull();
  expect(shown.closest(".hidden")).toBeNull();
  expect(shown.previousElementSibling?.textContent).toBe("I need access to your meetings.");
  expect(button(shown, MEETINGS_ACCESS_STRINGS.allow)).toBeDefined();
  expect(card("feed_chats")).toBeNull();

  // The owner writes again: the card goes while the turn runs, and does not come back under the older reply.
  await chat.ask("Never mind, what is on today?");
  expect(card("meetings")).toBeNull();
  await chat.reply([], "Nothing today.", "m-2");
  expect(card("meetings")).toBeNull();
});

test("no card when the area is already on", async () => {
  const chat = await show({ meetings: "on", feed_chats: "off" });
  await chat.ask("Monday?");
  await chat.reply([meetingsStep], "You decided on Friday.", "m-1");
  expect(card("meetings")).toBeNull();
});

test("an ended area shows its card too", async () => {
  const chat = await show({ meetings: "ended", feed_chats: "off" });
  await chat.ask("Monday?");
  await chat.reply([meetingsStep], "I need access to your meetings.", "m-1");
  expect(card("meetings")?.textContent).toContain(MEETINGS_ACCESS_STRINGS.ended);
});

test("Not now hides the card", async () => {
  const chat = await show({ meetings: "off", feed_chats: "off" });
  await chat.ask("Monday?");
  await chat.reply([meetingsStep, { type: "step", step: "feed" }], "I need access.", "m-1");
  await click(button(card("meetings"), ASK_STRINGS.notNow));
  expect(card("meetings")).toBeNull();
  expect(card("feed_chats")).not.toBeNull();
  expect(chat.turns).toHaveLength(1);
});

test("the feed and chats card leaves out the list of chats the settings view shows", async () => {
  const chat = await show({ meetings: "off", feed_chats: "off" });
  await chat.ask("What did the team say?");
  await chat.reply([{ type: "step", step: "chats" }], "I need access to your chats.", "m-1");
  expect(button(card("feed_chats"), FEED_CHATS_ACCESS_STRINGS.allow)).toBeDefined();
  expect(card("feed_chats")!.querySelector("li")).toBeNull();
  expect(settings().querySelector("[data-bots-read-area=feed_chats] li")).not.toBeNull();
});

test("access given in the card hides it and asks the question again, once; the settings view shows it on", async () => {
  const chat = await show({ meetings: "off", feed_chats: "off" });
  await chat.ask("What did we decide on Monday?");
  await chat.reply([meetingsStep], "I need access to your meetings.", "m-1");
  const before = settings().querySelector("[data-bots-read-area=meetings]")!;
  expect(button(before, MEETINGS_ACCESS_STRINGS.allow)).toBeDefined();

  await grantInCard("meetings", MEETINGS_ACCESS_STRINGS);
  expect(chat.log.puts).toEqual([{ area: "meetings", enabled: true }]);
  expect(card("meetings")).toBeNull();
  expect(chat.turns.map((turn) => turn.text)).toEqual(["What did we decide on Monday?", "What did we decide on Monday?"]);

  await click(document.querySelector<HTMLButtonElement>(`button[aria-label="${BOTS_STRINGS.mainSettings}"]`)!);
  const after = settings().querySelector("[data-bots-read-area=meetings]")!;
  expect(button(after, MEETINGS_ACCESS_STRINGS.turnOff)).toBeDefined();
  expect(button(after, MEETINGS_ACCESS_STRINGS.allow)).toBeUndefined();

  await chat.reply([meetingsStep], "You decided on Friday.", "m-2");
  expect(chat.turns).toHaveLength(2);
});

test("access turned off in the settings view shows in the card's place", async () => {
  const chat = await show({ meetings: "on", feed_chats: "off" });
  await chat.ask("Monday?");
  await chat.reply([meetingsStep], "You decided on Friday.", "m-1");
  expect(card("meetings")).toBeNull();
  await click(button(settings().querySelector("[data-bots-read-area=meetings]"), MEETINGS_ACCESS_STRINGS.turnOff));
  expect(button(card("meetings"), MEETINGS_ACCESS_STRINGS.allow)).toBeDefined();
});

test("no extra settings reads while nothing changes", async () => {
  const chat = await show({ meetings: "off", feed_chats: "off" });
  await chat.ask("Monday?");
  await chat.reply([meetingsStep], "I need access.", "m-1");
  const loads = chat.log.loads;
  await flush();
  await flush();
  expect(chat.log.loads).toBe(loads);
});

test("no question goes again after a new chat", async () => {
  const chat = await show({ meetings: "off", feed_chats: "off" });
  await chat.ask("Monday?");
  await chat.reply([meetingsStep], "I need access.", "m-1");
  await act(async () => { chat.chat().clear(); });
  await flush();
  expect(card("meetings")).toBeNull();
  await act(async () => { chat.chat().askAgain("m-1"); });
  expect(chat.turns).toHaveLength(1);
});
