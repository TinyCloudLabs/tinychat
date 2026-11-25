import { afterEach, expect, spyOn, test } from "bun:test";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import { installDom } from "@/test/dom";
import { BotsError, BotsRouteMissing } from "./botsApi";
import { readDeniedChatIds, setChatDenied } from "./chatReadAccessApi";

let restore: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; restore?.(); restore = undefined; });

function setup(response = Response.json({ deniedChatIds: ["private", "private"] })) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
}

test("GET loads denied ids as a Set using owner session auth and the request header", async () => {
  setup();
  expect(await readDeniedChatIds()).toEqual(new Set(["private"]));
  const [url, init] = fetchSpy!.mock.calls[0] as [string, RequestInit];
  expect(url.endsWith("/api/bots/main/reads/chats/denied")).toBe(true);
  expect(init.method).toBe("GET");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer fixture-token");
  expect((init.headers as Record<string, string>)[DEFAULT_REQUEST_HEADER_NAME]).toBe(DEFAULT_REQUEST_HEADER_VALUE);
  expect(init.cache).toBe("no-store");
});

test("PUT URL-encodes the chat id and sends denied in both directions", async () => {
  setup();
  const chat = "path/to a chat?#";
  await setChatDenied(chat, true);
  fetchSpy!.mockResolvedValue(Response.json({ deniedChatIds: [] }));
  expect(await setChatDenied(chat, false)).toEqual(new Set());
  const calls = fetchSpy!.mock.calls as [string, RequestInit][];
  expect(calls[0]![0].endsWith(`/api/bots/main/reads/chats/${encodeURIComponent(chat)}`)).toBe(true);
  expect(calls[0]![1].method).toBe("PUT");
  expect((calls[0]![1].headers as Record<string, string>)["content-type"]).toBe("application/json");
  expect(JSON.parse(calls[0]![1].body as string)).toEqual({ denied: true });
  expect(JSON.parse(calls[1]![1].body as string)).toEqual({ denied: false });
});

test("missing auth refuses without fetching", async () => {
  restore = installDom({});
  fetchSpy = spyOn(globalThis, "fetch");
  await expect(readDeniedChatIds()).rejects.toMatchObject({ code: "signed_out" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("failed saves reject instead of returning an allowed set", async () => {
  setup(new Response(null, { status: 500 }));
  await expect(setChatDenied("private", false)).rejects.toBeInstanceOf(BotsError);
});

test("404 remains a missing route", async () => {
  setup(new Response(null, { status: 404 }));
  await expect(readDeniedChatIds()).rejects.toBeInstanceOf(BotsRouteMissing);
});

test("malformed denied ids never silently become default allowed", async () => {
  setup(Response.json({ deniedChatIds: ["private", 42] }));
  await expect(readDeniedChatIds()).rejects.toBeInstanceOf(BotsError);
  fetchSpy!.mockResolvedValue(Response.json({}));
  await expect(readDeniedChatIds()).rejects.toBeInstanceOf(BotsError);
});
