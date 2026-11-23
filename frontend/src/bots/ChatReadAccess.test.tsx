import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsRouteMissing } from "./botsApi";
import { ChatReadAccess } from "./ChatReadAccess";
import type { ChatReadAccessApi, ChatReadChat } from "./chatReadAccessApi";
import { FeedChatsAccess, MeetingsAccess, type MeetingsAccessApi } from "./MeetingsAccess";
import type { ReadSettings } from "./trustbotReadGrant";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const deferred = <T,>() => Promise.withResolvers<T>();
function service(): ChatReadAccessApi {
  let denied = new Set(["private"]);
  return {
    listChats: async () => [{ id: "private", title: "Private notes" }, { id: "open", title: "Project" }],
    readDeniedChatIds: async () => new Set(denied),
    setChatDenied: async (id, value) => {
      denied = new Set(denied);
      if (value) denied.add(id); else denied.delete(id);
      return new Set(denied);
    },
  };
}

const settings: ReadSettings = {
  serviceDid: "did:key:service", expiresAt: null, grantCid: null,
  areas: { meetings: "off", feed_chats: "off" },
};
function areaApi(chatReadAccess?: ChatReadAccessApi): MeetingsAccessApi {
  return {
    readSettings: async () => settings,
    setReadArea: async () => settings,
    signReadGrant: async () => ({ serialized: "s", siwe: "w", signature: "g" }),
    revokeReadGrant: async () => {},
    chatReadAccess,
  };
}

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
async function render(node: React.ReactNode) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(node));
  await flush();
  return host;
}
const switches = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
const click = async (button: HTMLButtonElement) => { await act(async () => button.click()); await flush(); };

test("persisted denials render off, save both directions and survive remount while the area is off", async () => {
  const api = service();
  const host = await render(<FeedChatsAccess api={areaApi(api)} />);
  expect(host.textContent).toContain("Chats TrustBot can read");
  expect(host.textContent).toContain("TrustBot can read the chats switched on here when it answers you or your paired agents. Switch a chat off to keep it out.");
  expect(switches(host).map(button => button.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  expect(switches(host).every(button => button.getAttribute("aria-label") === "TrustBot can read this chat")).toBe(true);
  await click(switches(host)[0]!);
  await click(switches(host)[1]!);
  expect(switches(host).map(button => button.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  await act(async () => mounted!.render(null));
  await act(async () => mounted!.render(<FeedChatsAccess api={areaApi(api)} />));
  await flush();
  expect(switches(host).map(button => button.getAttribute("aria-checked"))).toEqual(["true", "false"]);
});

test("a pending save disables switches without optimistic changes and a failure preserves saved state", async () => {
  const api = service();
  const save = deferred<Set<string>>();
  api.setChatDenied = () => save.promise;
  const host = await render(<ChatReadAccess api={api} />);
  await click(switches(host)[1]!);
  expect(switches(host).every(button => button.disabled)).toBe(true);
  expect(switches(host)[1]!.getAttribute("aria-checked")).toBe("true");
  await act(async () => save.reject(new Error("offline")));
  expect(host.textContent).toContain("This change wasn't saved. Try again.");
  expect(switches(host)[1]!.getAttribute("aria-checked")).toBe("true");
  expect(switches(host).every(button => !button.disabled)).toBe(true);
  api.setChatDenied = async () => new Set(["private", "open"]);
  await click(switches(host)[1]!);
  expect(switches(host)[1]!.getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("loading waits for chats and denials, then empty has useful copy", async () => {
  const api = service();
  const chats = deferred<ChatReadChat[]>();
  const denied = deferred<Set<string>>();
  api.listChats = () => chats.promise;
  api.readDeniedChatIds = () => denied.promise;
  const host = await render(<ChatReadAccess api={api} />);
  expect(host.textContent).toContain("Loading chats…");
  await act(async () => chats.resolve([]));
  expect(host.textContent).toContain("Loading chats…");
  await act(async () => denied.resolve(new Set()));
  expect(host.textContent).toContain("No chats to show.");
  expect(switches(host)).toHaveLength(0);
});

test("a failed load is not presented as an empty or allowed chat list", async () => {
  const api = service();
  api.readDeniedChatIds = async () => { throw new Error("offline"); };
  const host = await render(<ChatReadAccess api={api} />);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Your chats couldn't be loaded. Try again.");
  expect(host.textContent).not.toContain("No chats to show.");
  expect(switches(host)).toHaveLength(0);
});

test("all owner chats are rendered, including past fifty and unnamed chats", async () => {
  const api = service();
  api.listChats = async () => Array.from({ length: 61 }, (_, index) => ({ id: `chat-${index}`, title: index ? `Chat ${index}` : "" }));
  const host = await render(<ChatReadAccess api={api} />);
  expect(switches(host)).toHaveLength(61);
  expect(host.textContent).toContain("Untitled chat");
  expect(host.textContent).toContain("Chat 60");
});

test("the nested list waits for the settings service and stays absent on 404", async () => {
  const chatApi = service();
  let listed = 0;
  chatApi.listChats = async () => { listed++; return []; };
  const api = areaApi(chatApi);
  const load = deferred<ReadSettings>();
  api.readSettings = () => load.promise;
  const host = await render(<FeedChatsAccess api={api} />);
  expect(listed).toBe(0);
  expect(host.textContent).toBe("");
  await act(async () => load.reject(new BotsRouteMissing()));
  expect(listed).toBe(0);
  expect(host.textContent).toBe("");
});

test("old area APIs and the meetings area do not render chat settings", async () => {
  const host = await render(<FeedChatsAccess api={areaApi()} />);
  expect(host.textContent).not.toContain("Chats TrustBot can read");
  await act(async () => mounted!.render(<MeetingsAccess api={areaApi(service())} />));
  await flush();
  expect(host.textContent).not.toContain("Chats TrustBot can read");
});

test("an old load cannot replace chats after the API changes", async () => {
  const old = service();
  const load = deferred<ChatReadChat[]>();
  old.listChats = () => load.promise;
  const host = await render(<ChatReadAccess api={old} />);
  const next = service();
  next.listChats = async () => [{ id: "next", title: "Next account" }];
  await act(async () => mounted!.render(<ChatReadAccess api={next} />));
  await flush();
  await act(async () => load.resolve([{ id: "old", title: "Old account" }]));
  expect(host.textContent).toContain("Next account");
  expect(host.textContent).not.toContain("Old account");
});

test("an old save cannot overwrite a new API's denied set", async () => {
  const old = service();
  const save = deferred<Set<string>>();
  old.setChatDenied = () => save.promise;
  const host = await render(<ChatReadAccess api={old} />);
  await click(switches(host)[1]!);
  await act(async () => mounted!.render(<ChatReadAccess api={service()} />));
  await flush();
  await act(async () => save.resolve(new Set(["open"])));
  expect(switches(host).map(button => button.getAttribute("aria-checked"))).toEqual(["false", "true"]);
});

test("pending work can settle after unmount without rendering", async () => {
  const api = service();
  const save = deferred<Set<string>>();
  api.setChatDenied = () => save.promise;
  const host = await render(<ChatReadAccess api={api} />);
  await click(switches(host)[1]!);
  act(() => mounted!.unmount());
  mounted = undefined;
  await act(async () => save.reject(new Error("offline")));
  expect(host.textContent).toBe("");
});
