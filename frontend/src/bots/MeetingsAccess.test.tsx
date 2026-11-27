import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsError, BotsRouteMissing } from "./botsApi";
import { BOTS_STRINGS } from "./botsStrings";
import { MeetingsAccess, type MeetingsAccessApi } from "./MeetingsAccess";
import type { ReadArea } from "./trustbotReadAreas";
import type { ReadGrant, ReadSettings } from "./trustbotReadGrant";

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
const OLD_CID = "bafy-old-grant";
const NEW_CID = "bafy-new-grant";
const settings = (meetings: "off" | "on" | "ended", expiresAt: number | null = null, extra: Record<string, string> = {}, grantCid: string | null = null) =>
  ({ serviceDid: DID, expiresAt, grantCid, areas: { meetings, ...extra } }) as ReadSettings;

function fake(initial: ReadSettings | Error, options: { sign?: () => Promise<ReadGrant>; set?: () => Promise<ReadSettings>; revoke?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const puts: { area: ReadArea; enabled: boolean; grant?: ReadGrant }[] = [];
  const signed: { did: string; areas: ReadArea[] }[] = [];
  const revoked: string[] = [];
  const api: MeetingsAccessApi = {
    readSettings: async () => { if (initial instanceof Error) throw initial; return initial; },
    signReadGrant: async (did, areas) => { signed.push({ did, areas }); return options.sign ? options.sign() : GRANT; },
    setReadArea: async (area, enabled, grant) => {
      calls.push(`put ${enabled ? "on" : "off"}`);
      puts.push({ area, enabled, grant });
      if (options.set) return options.set();
      return enabled ? settings("on", UNTIL, {}, NEW_CID) : settings("off");
    },
    revokeReadGrant: async (cid) => {
      calls.push(`revoke ${cid}`);
      revoked.push(cid);
      if (options.revoke) await options.revoke();
    },
  };
  return { api, puts, signed, revoked, calls };
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function render(api: MeetingsAccessApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<MeetingsAccess api={api} />));
  await flush();
  return host;
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const click = async (host: HTMLElement, label: string) => { await act(async () => { button(host, label)!.click(); }); await flush(); };
const date = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });

test("a 404 renders nothing", async () => {
  const host = await render(fake(new BotsRouteMissing()).api);
  expect(host.innerHTML).toBe("");
});

test("off shows the line and the button, and the sheet shows the confirmation with the bot's name", async () => {
  const { api, puts } = fake(settings("off"));
  const host = await render(api);
  expect(host.textContent).toContain("Meetings");
  expect(host.textContent).toContain(`${BOT} can't read your meetings.`);
  await click(host, `Let ${BOT} read them`);
  const sheet = host.querySelector('[role="alertdialog"]')!;
  expect(sheet.textContent).toContain(`Let ${BOT} read your meetings?`);
  expect(sheet.textContent).toContain(`${BOT} can read your recordings, transcripts and meeting notes for 7 days, then it stops. It can't change them. What it reads goes to the AI model service to write its answer. Once ${BOT} reads a meeting, web and secret-backed calls stay paused in this chat.`);
  expect(sheet.textContent).toContain("sends only the exact message and recipients you approve");
  expect(button(host, "Allow for 7 days")).toBeDefined();
  await click(host, "Not now");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(puts).toHaveLength(0);
});

test("Allow signs over the areas already on plus meetings and sends the grant", async () => {
  const { api, puts, signed } = fake(settings("off", UNTIL, { feed: "on", chats: "ended" }));
  const host = await render(api);
  await click(host, `Let ${BOT} read them`);
  await click(host, "Allow for 7 days");
  expect(signed).toEqual([{ did: DID, areas: ["meetings", "feed"] }]);
  expect(puts).toEqual([{ area: "meetings", enabled: true, grant: GRANT }]);
  expect(host.textContent).toContain(`${BOT} can read your meetings until ${date(UNTIL)}.`);
});

test("on shows the end date and Turn off sends enabled false", async () => {
  const { api, puts, signed } = fake(settings("on", UNTIL));
  const host = await render(api);
  expect(host.textContent).toContain(`${BOT} can read your meetings until ${date(UNTIL)}.`);
  await click(host, "Turn off");
  expect(puts).toEqual([{ area: "meetings", enabled: false, grant: undefined }]);
  expect(signed).toHaveLength(0);
  expect(host.textContent).toContain(`${BOT} can't read your meetings.`);
});

test("ended shows its line and offers the same sheet", async () => {
  const host = await render(fake(settings("ended")).api);
  expect(host.textContent).toContain(`${BOT}'s access to your meetings has ended.`);
  await click(host, `Let ${BOT} read them`);
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
});

test("a failed save shows the failure line", async () => {
  const { api } = fake(settings("on", UNTIL), { set: async () => { throw new BotsError("failed"); } });
  const host = await render(api);
  await click(host, "Turn off");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change this. Try again.");
});

test("a failed load shows the failure line", async () => {
  const host = await render(fake(new BotsError("failed")).api);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change this. Try again.");
});

test("a refused signature sends nothing and shows the failure line", async () => {
  const { api, puts } = fake(settings("off"), { sign: async () => { throw new Error("read_authority_missing"); } });
  const host = await render(api);
  await click(host, `Let ${BOT} read them`);
  await click(host, "Allow for 7 days");
  expect(puts).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change this. Try again.");
});

test("Turn off revokes the stored grant as the owner, then turns meetings off", async () => {
  const { api, revoked, calls } = fake(settings("on", UNTIL, {}, OLD_CID));
  const host = await render(api);
  await click(host, "Turn off");
  expect(revoked).toEqual([OLD_CID]);
  expect(calls).toEqual([`revoke ${OLD_CID}`, "put off"]);
  expect(host.textContent).toContain(`${BOT} can't read your meetings.`);
});

test("Turn off completes when the revoke fails", async () => {
  const { api, calls } = fake(settings("on", UNTIL, {}, OLD_CID), { revoke: async () => { throw new Error("read_revoke_failed"); } });
  const host = await render(api);
  await click(host, "Turn off");
  expect(calls).toEqual([`revoke ${OLD_CID}`, "put off"]);
  expect(host.textContent).toContain(`${BOT} can't read your meetings.`);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("Turn off keeps the grant while another area stays on with it", async () => {
  const { api, revoked, puts } = fake(settings("on", UNTIL, { feed: "on" }, OLD_CID));
  const host = await render(api);
  await click(host, "Turn off");
  expect(revoked).toEqual([]);
  expect(puts).toEqual([{ area: "meetings", enabled: false, grant: undefined }]);
});

test("a new grant revokes the one it replaced, after the new one is stored", async () => {
  const { api, calls } = fake(settings("ended", UNTIL, {}, OLD_CID));
  const host = await render(api);
  await click(host, `Let ${BOT} read them`);
  await click(host, "Allow for 7 days");
  expect(calls).toEqual(["put on", `revoke ${OLD_CID}`]);
  expect(host.textContent).toContain(`${BOT} can read your meetings until ${date(UNTIL)}.`);
});

test("a refused new grant revokes nothing", async () => {
  const { api, calls } = fake(settings("ended", UNTIL, {}, OLD_CID), { set: async () => { throw new BotsError("failed"); } });
  const host = await render(api);
  await click(host, `Let ${BOT} read them`);
  await click(host, "Allow for 7 days");
  expect(calls).toEqual(["put on"]);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change this. Try again.");
});
