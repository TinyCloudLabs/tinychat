import { describe, expect, test } from "bun:test";

import { BotsError, createBotsApi, type MainEvent } from "./botsApi";

const encoder = new TextEncoder();

/** A reply stream cut at the given byte offsets: mid-line, mid-event and inside a multi-byte character. */
function streamed(body: string, cuts: number[]): Response {
  const bytes = encoder.encode(body);
  const edges = [0, ...cuts, bytes.length];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < edges.length - 1; i++) controller.enqueue(bytes.slice(edges[i], edges[i + 1]));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function apiReturning(response: Response, seen: RequestInit[] = []) {
  return createBotsApi({
    baseUrl: "https://backend.test/",
    getToken: () => "session-token",
    fetch: async (_input, init) => {
      seen.push(init ?? {});
      return response;
    },
  });
}

async function collect(response: Response) {
  const events: MainEvent[] = [];
  await apiReturning(response).sendToMain("hi", (event) => events.push(event));
  return events;
}

describe("sendToMain", () => {
  test("parses status, delta and done across arbitrary chunk splits and skips unknown events", async () => {
    const body = [
      "event: status\ndata: {\"state\":\"starting\"}\n\n",
      ": keep-alive\n\n",
      "event: status\r\ndata: {\"state\":\"working\"}\r\n\r\n",
      "event: delta\ndata: {\"text\":\"po\"}\n\n",
      "event: tool\ndata: {\"name\":\"x\"}\n\n",
      "event: delta\ndata: {\"text\":\"ng ✓ é\"}\n\n",
      "event: done\ndata: {\"messageId\":\"m-1\"}\n\n",
    ].join("");
    const bytes = encoder.encode(body).length;
    const tick = encoder.encode(body).indexOf(0xe2); // first byte of "✓"
    const expected: MainEvent[] = [
      { type: "status", state: "starting" },
      { type: "status", state: "working" },
      { type: "delta", text: "po" },
      { type: "delta", text: "ng ✓ é" },
      { type: "done", messageId: "m-1" },
    ];
    for (const cuts of [[], [3, 20, 21, tick + 1, tick + 2, bytes - 1], Array.from({ length: bytes - 1 }, (_, i) => i + 1)]) {
      expect(await collect(streamed(body, cuts))).toEqual(expected);
    }
  });

  test("an error event ends the turn with the service's code, or failed for a code it does not know", async () => {
    expect(await collect(streamed("event: status\ndata: {\"state\":\"working\"}\n\nevent: error\ndata: {\"code\":\"busy\",\"message\":\"Main is busy.\"}\n\n", [30])))
      .toEqual([{ type: "status", state: "working" }, { type: "error", code: "busy" }]);
    expect(await collect(streamed("event: error\ndata: {\"code\":\"upstream_502\",\"message\":\"x\"}\n\n", [])))
      .toEqual([{ type: "error", code: "failed" }]);
  });

  test("a stream that stops before done or error fails instead of looking finished", async () => {
    const events: MainEvent[] = [];
    const sending = apiReturning(streamed("event: delta\ndata: {\"text\":\"half\"}\n\nevent: done\ndata: {\"messageId\"", [])).sendToMain("hi", (event) => events.push(event));
    await expect(sending).rejects.toBeInstanceOf(BotsError);
    expect(events).toEqual([{ type: "delta", text: "half" }]);
  });

  test("sends the session bearer and the text to the backend route, never an owner", async () => {
    const seen: RequestInit[] = [];
    await apiReturning(streamed("event: done\ndata: {\"messageId\":\"m\"}\n\n", []), seen).sendToMain("Reply with exactly: pong", () => {});
    const headers = new Headers(seen[0]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer session-token");
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ text: "Reply with exactly: pong" });
  });
});
