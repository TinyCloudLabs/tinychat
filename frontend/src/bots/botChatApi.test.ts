import { expect, test } from "bun:test";

import { createBotChatApi } from "./botChatApi";
import type { MainEvent } from "./botsApi";

function recorder(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const api = createBotChatApi({
    baseUrl: "https://api.example/",
    getToken: () => "token",
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body });
      return respond(String(input), init);
    },
  });
  return { api, calls };
}

const KEY = "0123456789abcdef0123456789abcdef";

test("a bot's messages and replies use its own key; Main's use today's addresses", async () => {
  const { api, calls } = recorder(() => Response.json({ messages: [{ id: "1", role: "bot", text: "Hi", at: "2026-11-18T00:00:00Z" }] }));
  expect(await api.listMessages(KEY)).toEqual([{ id: "1", role: "bot", text: "Hi", at: "2026-11-18T00:00:00Z" }]);
  await api.listMessages("main");
  expect(calls.map((call) => call.url)).toEqual([
    `https://api.example/api/bots/${KEY}/messages`,
    "https://api.example/api/bots/main/messages",
  ]);
});

test("a malformed key never reaches the network", async () => {
  const { api, calls } = recorder(() => Response.json({ messages: [] }));
  for (const key of ["MAIN", "../main", `${KEY}/x`, KEY.toUpperCase(), "abc"]) {
    await expect(api.listMessages(key)).rejects.toMatchObject({ code: "failed" });
    await expect(api.send(key, "Hi", () => {})).rejects.toMatchObject({ code: "failed" });
    await expect(api.readNotice(key)).rejects.toMatchObject({ code: "failed" });
  }
  expect(calls).toEqual([]);
});

test("a reply streams to the bot's events and ends at done", async () => {
  const body = "event: status\ndata: {\"state\":\"working\"}\n\nevent: delta\ndata: {\"text\":\"Hel\"}\n\nevent: delta\ndata: {\"text\":\"lo\"}\n\nevent: done\ndata: {\"messageId\":\"m2\"}\n\n";
  const { api, calls } = recorder(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const events: MainEvent[] = [];
  await api.send(KEY, "Hi", (event) => events.push(event));
  expect(calls[0]).toMatchObject({ url: `https://api.example/api/bots/${KEY}/messages`, method: "POST" });
  expect(JSON.parse(String(calls[0]?.body))).toEqual({ text: "Hi", clientContext: { localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), timeZone: expect.any(String) } });
  expect(events).toEqual([
    { type: "status", state: "working" },
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
    { type: "done", messageId: "m2" },
  ]);
});

test("a refused or too-long message and a lost session each fail with their own code", async () => {
  await expect(recorder(() => new Response(null, { status: 400 })).api.send(KEY, "x", () => {})).rejects.toMatchObject({ code: "invalid" });
  await expect(recorder(() => new Response(null, { status: 401 })).api.send(KEY, "x", () => {})).rejects.toMatchObject({ code: "signed_out" });
  await expect(recorder(() => Response.json({ error: "bot_not_active" }, { status: 409 })).api.send(KEY, "x", () => {})).rejects.toMatchObject({ code: "failed" });
});

test("the expiry notice: Main's keeps its address, another bot's carries its key, and none is null", async () => {
  const notice = { id: "n1", expiresAt: 1, firstAttemptAt: 2 };
  const { api, calls } = recorder((url) => (url.includes(KEY) ? new Response(null, { status: 404 }) : Response.json({ notice })));
  expect(await api.readNotice("main")).toMatchObject(notice);
  expect(await api.readNotice(KEY)).toBeNull();
  expect(calls.map((call) => call.url)).toEqual([
    "https://api.example/api/bots/history/notice",
    `https://api.example/api/bots/${KEY}/history/notice`,
  ]);
});

test("acknowledging a notice posts its id to that bot's address", async () => {
  const { api, calls } = recorder(() => Response.json({ notice: { id: "n1", expiresAt: 1, firstAttemptAt: 2, deliveredAt: 3, deleteAt: 4 } }));
  expect(await api.acknowledgeNotice(KEY, { id: "n1", expiresAt: 1, firstAttemptAt: 2 }, 5)).toEqual({ id: "n1", expiresAt: 1, firstAttemptAt: 2, deliveredAt: 3, deleteAt: 4 });
  expect(calls[0]).toMatchObject({ url: `https://api.example/api/bots/${KEY}/history/notice/ack`, method: "POST", body: JSON.stringify({ id: "n1", renderedAt: 5 }) });
});

test("a malformed notice fails the read instead of showing a broken date", async () => {
  const { api } = recorder(() => Response.json({ notice: { id: "n1", expiresAt: "soon" } }));
  await expect(api.readNotice("main")).rejects.toMatchObject({ code: "failed" });
});

test("an unreachable bot fails with its code, and the backend's own wording is never used", async () => {
  const unreachable = Response.json({ error: "bot_unavailable", message: "This bot isn't available. Try again later." }, { status: 502 });
  const failure = await recorder(() => unreachable).api.send(KEY, "x", () => {}).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "bot_unavailable" });
  expect(String((failure as Error).message)).not.toContain("isn't available");
  await expect(recorder(() => new Response("upstream", { status: 502 })).api.send(KEY, "x", () => {})).rejects.toMatchObject({ code: "failed" });
});
