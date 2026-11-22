import { describe, expect, test } from "bun:test";

import { BotsError, BotsNoReply, BotsRouteMissing, createBotsApi } from "./botsApi";

type Seen = { url: string; init: RequestInit };

const REQUEST = { id: "r1", kind: "ask", state: "pending", askedAt: "2026-11-21T00:00:00.000Z", expiresAt: "2026-11-22T00:00:00.000Z", question: "Which one?", choices: ["a", "b"], outside: true };

function apiReturning(response: Response | (() => Response), seen: Seen[] = []) {
  return createBotsApi({
    baseUrl: "https://backend.test/",
    getToken: () => "session-token",
    fetch: async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return typeof response === "function" ? response() : response;
    },
  });
}

describe("main questions", () => {
  test("getAsks and setAsks use /api/bots/main/asks; setAsks sends only enabled", async () => {
    const seen: Seen[] = [];
    expect(await apiReturning(Response.json({ enabled: false, extra: 1 }), seen).getAsks()).toEqual({ enabled: false });
    expect(await apiReturning(Response.json({ enabled: true }), seen).setAsks({ enabled: true, other: 1 } as never)).toEqual({ enabled: true });
    expect(seen.map((call) => [call.init.method, call.url])).toEqual([["GET", "https://backend.test/api/bots/main/asks"], ["PUT", "https://backend.test/api/bots/main/asks"]]);
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ enabled: true });
  });

  test("a 404 from the asks route is a missing route, and a malformed answer is a failure", async () => {
    await expect(apiReturning(new Response("", { status: 404 })).getAsks()).rejects.toBeInstanceOf(BotsRouteMissing);
    await expect(apiReturning(Response.json({ enabled: "yes" })).getAsks()).rejects.toMatchObject({ code: "failed" });
  });

  test("listRequests keeps well-formed requests with outside as a boolean and drops the rest", async () => {
    const list = await apiReturning(Response.json({ requests: [REQUEST, { ...REQUEST, id: "r2", outside: undefined }, { id: "bad" }, { ...REQUEST, id: "r3", state: "later" }] })).listRequests();
    expect(list.map((request) => [request.id, request.outside])).toEqual([["r1", true], ["r2", false]]);
    expect(list[0]!.choices).toEqual(["a", "b"]);
    await expect(apiReturning(Response.json({})).listRequests()).rejects.toBeInstanceOf(BotsError);
  });

  test("answerRequest posts the decision to the request's own path", async () => {
    const seen: Seen[] = [];
    const stored = await apiReturning(Response.json({ ...REQUEST, state: "answered" }), seen).answerRequest("a/b c", { decision: "answer", choice: 1 });
    expect(stored.state).toBe("answered");
    expect(seen[0]!.url).toBe("https://backend.test/api/bots/main/requests/a%2Fb%20c/answer");
    expect(seen[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ decision: "answer", choice: 1 });
  });

  test("an appReply send carries the request id and no text", async () => {
    const seen: Seen[] = [];
    const events: string[] = [];
    const done = new Response("event: done\ndata: {\"messageId\":\"m1\"}\n\n");
    await apiReturning(done, seen).sendToMain("typed words", (event) => events.push(event.type), undefined, { appReply: { requestId: "r1", text: "x" } as never });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ appReply: { requestId: "r1" } });
    expect(events).toEqual(["done"]);
  });

  test("an ordinary send is unchanged", async () => {
    const seen: Seen[] = [];
    await apiReturning(new Response("event: done\ndata: {\"messageId\":\"m1\"}\n\n"), seen).sendToMain("hello", () => {});
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ text: "hello", clientContext: { localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), timeZone: expect.any(String) } });
  });

  test("a message from the app keeps the origin mark and the decision; others do not get one", async () => {
    const list = await apiReturning(Response.json({ messages: [
      { id: "a", role: "user", text: "t", at: "", origin: "app", decision: "declined" },
      { id: "b", role: "user", text: "t", at: "", origin: "other", decision: "answered" },
      { id: "c", role: "user", text: "t", at: "", origin: "app", decision: "maybe" },
      { id: "d", role: "user", text: "t", at: "", from: "app" },
    ] })).listMainMessages();
    expect(list.map((message) => [message.origin, message.decision])).toEqual([["app", "declined"], [undefined, undefined], ["app", undefined], [undefined, undefined]]);
  });

  test("a request says whether its decision is still undelivered", async () => {
    const list = await apiReturning(Response.json({ requests: [{ ...REQUEST, id: "a", state: "answered", undelivered: true }, { ...REQUEST, id: "b", state: "answered" }, { ...REQUEST, id: "c", state: "answered", answer: "x" }] })).listRequests();
    expect(list.map((request) => request.undelivered)).toEqual([true, false, true]);
  });

  test("409 no_reply on an app reply is a BotsNoReply; any other 409 is a plain failure", async () => {
    const reply = { appReply: { requestId: "r1" } };
    await expect(apiReturning(Response.json({ error: "no_reply" }, { status: 409 })).sendToMain("", () => {}, undefined, reply)).rejects.toBeInstanceOf(BotsNoReply);
    const other = apiReturning(Response.json({ error: "busy" }, { status: 409 })).sendToMain("hi", () => {});
    await expect(other).rejects.toMatchObject({ name: "BotsError", code: "failed" });
  });
});
