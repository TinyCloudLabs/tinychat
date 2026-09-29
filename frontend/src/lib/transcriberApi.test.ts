import { describe, expect, spyOn, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import { createTranscriberClient, type TranscriberClient } from "./transcriberApi";

const sessionStore = { getToken: () => "test-session", isExpired: () => false } as SessionStore;
const reads: [string, (client: TranscriberClient) => Promise<unknown>][] = [
  ["list", (client) => client.list()],
  ["get", (client) => client.get("test-recording")],
  ["transcript", (client) => client.transcript("test-recording")],
];

describe("transcriber read deadlines", () => {
  for (const [name, read] of reads) {
    test(`${name} settles as retryable when the request times out`, async () => {
      const controller = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      let observedSignal: AbortSignal | null | undefined;
      const client = createTranscriberClient("https://backend.example", {
        sessionStore,
        fetchImpl: (async (_url, init) => {
          observedSignal = init?.signal;
          if (!observedSignal) return Response.json({ meetings: [] });
          return await new Promise<Response>((_resolve, reject) => {
            observedSignal!.addEventListener("abort", () => reject(observedSignal!.reason), { once: true });
          });
        }) as typeof fetch,
      });
      const pending = read(client);
      try {
        expect(observedSignal).toBe(controller.signal);
        expect(timeout).toHaveBeenCalledWith(20_000);
        controller.abort(new DOMException("Timed out", "TimeoutError"));
        expect(await pending).toEqual({ status: "retryable", httpStatus: 504, code: "request_timeout" });
      } finally {
        controller.abort();
        await pending;
        timeout.mockRestore();
      }
    });
  }

  test("the deadline covers a stalled response body and a later read can recover", async () => {
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let readingBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { readingBody = resolve; });
    let calls = 0;
    const client = createTranscriberClient("https://backend.example", {
      sessionStore,
      fetchImpl: (async () => {
        if (++calls > 1) return Response.json({ meetings: [] });
        return {
          status: 200, ok: true,
          json: () => {
            readingBody();
            return new Promise((_resolve, reject) => {
              controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
            });
          },
        } as Response;
      }) as typeof fetch,
    });
    try {
      const pending = client.list();
      await bodyStarted;
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      expect(await pending).toEqual({ status: "retryable", httpStatus: 504, code: "request_timeout" });
      timeout.mockReturnValue(new AbortController().signal);
      expect(await client.list()).toEqual({ status: "ok", value: { meetings: [] } });
    } finally {
      timeout.mockRestore();
    }
  });

  test("bot mutations do not acquire a read deadline or retry", async () => {
    const requests: RequestInit[] = [];
    const client = createTranscriberClient("https://backend.example", {
      sessionStore,
      fetchImpl: (async (_url, init) => {
        requests.push(init ?? {});
        return Response.json({ id: "test-recording", status: "queued" });
      }) as typeof fetch,
    });
    await client.create({ meeting_url: "https://meet.google.com/aaa-bbbb-ccc" });
    await client.stop("test-recording");
    await client.remove("test-recording");
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(requests.every((request) => request.signal === undefined)).toBe(true);
  });
});
