import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import { calendarOutcomeLabel, createCalendarAutojoinClient, type CalendarAutojoinStatus } from "./calendarAutojoinApi";

const session = { getToken: () => "tinychat-session", isExpired: () => false } as SessionStore;
const off: CalendarAutojoinStatus = { state: "off", enabled: false, lastScanAt: null, errorCode: null, outcomes: [] };
const realFetch = globalThis.fetch;
const deadline = new AbortController();
let timeoutSpy: ReturnType<typeof spyOn<typeof AbortSignal, "timeout">> | undefined;

afterEach(() => {
  timeoutSpy?.mockRestore();
  timeoutSpy = undefined;
  globalThis.fetch = realFetch;
});

describe("Calendar autojoin read deadline", () => {
  test("status uses a 20-second abort signal but disable has no deadline", async () => {
    timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const requests: { method: string | undefined; signal: AbortSignal | null | undefined }[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push({ method: init?.method, signal: init?.signal });
      return Response.json(off);
    }) as typeof fetch;
    const client = createCalendarAutojoinClient("https://backend.example", session);
    expect(await client.status()).toEqual(off);
    expect(await client.disable()).toEqual(off);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
    expect(requests).toEqual([
      { method: "GET", signal: deadline.signal },
      { method: "POST", signal: undefined },
    ]);
  });

  for (const phase of ["headers", "body"] as const) {
    test(`status aborts a real fetch waiting for ${phase} and a later read can recover`, async () => {
      const controller = new AbortController();
      timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      let release!: () => void;
      const started = new Promise<void>(resolve => { release = resolve; });
      let finishResponse!: (response: Response) => void;
      const delayedResponse = new Promise<Response>(resolve => { finishResponse = resolve; });
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch() {
          if (phase === "headers") { release(); return delayedResponse; }
          return new Response(new ReadableStream({
            start(stream) { stream.enqueue(new TextEncoder().encode('{"state":')); },
          }), { headers: { "Content-Type": "application/json" } });
        },
      });
      globalThis.fetch = (async (url, init) => {
        const response = await realFetch(url, init);
        if (phase === "body") release();
        return response;
      }) as typeof fetch;
      try {
        const client = createCalendarAutojoinClient(server.url.origin, session);
        const result = client.status().then(() => "resolved", () => "rejected");
        await started;
        expect(timeoutSpy).toHaveBeenCalledWith(20_000);
        controller.abort(new DOMException("Timed out", "TimeoutError"));
        expect(await result).toBe("rejected");
        timeoutSpy.mockReturnValue(new AbortController().signal);
        globalThis.fetch = (async () => Response.json(off)) as typeof fetch;
        expect(await client.status()).toEqual(off);
      } finally {
        finishResponse(Response.json(off));
        await server.stop(true);
      }
    });
  }
});

describe("TC-581 shared capture outcome labels", () => {
  test("a capture pending on another account's bot is told without alarm", () => {
    expect(calendarOutcomeLabel("shared_capture_pending")).toBe(
      "Already being recorded by another TinyCloud account. If you accepted that account's calendar invite, the transcript will be added to your meetings after it ends.",
    );
  });
  test("an already-recorded meeting explains who gets the transcript", () => {
    expect(calendarOutcomeLabel("already_recorded")).toBe(
      "Already being recorded by another TinyCloud account. Its transcripts are shared only with people who accepted that account's calendar invite.",
    );
  });
  test("with sharing off, a capture in progress promises nothing", () => {
    expect(calendarOutcomeLabel("capture_in_progress")).toBe(
      "Already being recorded by another TinyCloud account. Only one notetaker can join a meeting.",
    );
  });
  test("an unverified capture says nothing it records will be added", () => {
    expect(calendarOutcomeLabel("unverified_capture")).toBe(
      "A TinyCloud notetaker from an account we couldn't match to your invite is already in this meeting, and only one can join. Nothing it records will be added to your meetings.",
    );
  });
  test("none reads as a failure", () => {
    for (const reason of ["shared_capture_pending", "already_recorded", "capture_in_progress", "unverified_capture"]) {
      expect(calendarOutcomeLabel(reason)).not.toMatch(/fail|could not|error/i);
    }
  });
});
