import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BOTS_STRINGS } from "./botsStrings";
import { FeedChatsAccess, MeetingsAccess, type MeetingsAccessApi } from "./MeetingsAccess";
import type { ReadArea } from "./trustbotReadAreas";
import type { ReadAreaState, ReadGrant, ReadSettings } from "./trustbotReadGrant";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const BOT = BOTS_STRINGS.mainName;
const DID = "did:pkh:eip155:1:0x" + "11".repeat(20);
const UNTIL = Date.UTC(2026, 10, 29, 12);
const GRANT: ReadGrant = { serialized: "s", siwe: "w", signature: "g" };

/** A service holding one settings value: each PUT changes it, as the backend does. */
function service(areas: Record<ReadArea, ReadAreaState>) {
  let current: ReadSettings = { serviceDid: DID, expiresAt: null, areas: { ...areas } };
  const signed: ReadArea[][] = [];
  const puts: { area: ReadArea; enabled: boolean }[] = [];
  const api: MeetingsAccessApi = {
    readSettings: async () => current,
    signReadGrant: async (_did, signedAreas) => { signed.push(signedAreas); return GRANT; },
    setReadArea: async (area, enabled) => {
      puts.push({ area, enabled });
      current = { serviceDid: DID, expiresAt: enabled ? UNTIL : current.expiresAt, areas: { ...current.areas, [area]: enabled ? "on" : "off" } };
      return current;
    },
  };
  return { api, signed, puts };
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function render(node: React.ReactNode) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(node));
  await flush();
  return host;
}

const section = (host: HTMLElement, area: ReadArea) => host.querySelector<HTMLElement>(`[data-bots-read-area="${area}"]`)!;
const click = async (scope: HTMLElement, label: string) => {
  await act(async () => { [...scope.querySelectorAll("button")].find((node) => node.textContent === label)!.click(); });
  await flush();
};

test("off by default: the section shows its own words with the bot's name and the confirmation", async () => {
  const { api, puts } = service({ meetings: "off", feed_chats: "off" });
  const host = await render(<FeedChatsAccess api={api} />);
  expect(host.textContent).toContain("Feed and chats");
  expect(host.textContent).toContain(`${BOT} can't read your feed or your chats.`);
  await click(host, `Let ${BOT} read them`);
  const sheet = host.querySelector('[role="alertdialog"]')!;
  expect(sheet.textContent).toContain(`Let ${BOT} read your feed and chats?`);
  expect(sheet.textContent).toContain(`Once ${BOT} reads a card or a chat, it can't use the web in this chat`);
  await click(host, "Not now");
  expect(puts).toHaveLength(0);
});

test("Allow signs over feed_chats plus the areas on now, even when another section turned one on after this one loaded", async () => {
  const { api, signed, puts } = service({ meetings: "off", feed_chats: "off" });
  const host = await render(<><MeetingsAccess api={api} /><FeedChatsAccess api={api} /></>);
  await click(section(host, "meetings"), `Let ${BOT} read them`);
  await click(section(host, "meetings"), "Allow for 7 days");
  await click(section(host, "feed_chats"), `Let ${BOT} read them`);
  await click(section(host, "feed_chats"), "Allow for 7 days");
  expect(signed).toEqual([["meetings"], ["meetings", "feed_chats"]]);
  expect(puts).toEqual([{ area: "meetings", enabled: true }, { area: "feed_chats", enabled: true }]);
  const date = new Date(UNTIL).toLocaleDateString(undefined, { dateStyle: "medium" });
  expect(section(host, "feed_chats").textContent).toContain(`${BOT} can read your feed and chats until ${date}.`);
});

test("ended shows its own line", async () => {
  const host = await render(<FeedChatsAccess api={service({ meetings: "off", feed_chats: "ended" }).api} />);
  expect(host.textContent).toContain(`${BOT}'s access to your feed and chats has ended.`);
});
