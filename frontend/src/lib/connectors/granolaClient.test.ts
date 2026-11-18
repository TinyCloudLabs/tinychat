import { describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";

import {
  GranolaClient,
  GRANOLA_KEY_HEADER,
  GRANOLA_PROXY_PATH,
  resolveGranolaClientDefaults,
  GRANOLA_TRANSCRIPT_PAGE_SIZE,
} from "./granolaClient";

// Fixtures shaped from docs.granola.ai's API reference (2026-11-18). No real
// key: "grn_…" strings are fixtures only.
const KEY = "grn_fixture_key_0000000000";

const sessionStore = {
  getToken: () => "session-jwt-fixture",
  isExpired: () => false,
} as unknown as SessionStore;

type Call = { url: string; init?: RequestInit };
function fakeFetch(calls: Call[], respond: (url: string) => Response | Promise<Response>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url));
  }) as typeof fetch;
}
const sleepImpl = async (_ms: number) => true;

function client(fetchImpl: typeof fetch) {
  return new GranolaClient({
    apiKey: KEY,
    backendUrl: "https://api.tinycloud.test",
    sessionStore,
    fetchImpl,
    delayMs: 0,
    sleepImpl,
  });
}

const LIST_PAGE = {
  notes: [
    {
      id: "not_0001",
      title: "Weekly sync",
      owner: { name: "Ada", email: "ada@example.com" },
      created_at: "2026-11-10T14:00:00Z",
      updated_at: "2026-11-10T15:00:00Z",
      deleted_at: null,
    },
  ],
  hasMore: false,
  cursor: null,
};

describe("resolveGranolaClientDefaults", () => {
  test("blank env falls back to the production defaults", () => {
    expect(resolveGranolaClientDefaults({}).proxyUrl).toBe("");
    expect(resolveGranolaClientDefaults({ VITE_GRANOLA_DELAY_MS: "junk" }).delayMs).toBeGreaterThan(0);
  });
});

describe("GranolaClient", () => {
  test("sends OUR session as Bearer and the user's key in x-granola-key, against the proxy", async () => {
    const calls: Call[] = [];
    const c = client(fakeFetch(calls, () => new Response(JSON.stringify(LIST_PAGE), { status: 200 })));
    const res = await c.listNotes({ pageSize: 5, updatedAfter: "2026-11-01T00:00:00Z" });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://api.tinycloud.test");
    expect(url.pathname).toBe(`${GRANOLA_PROXY_PATH}/v1/notes`);
    expect(url.searchParams.get("updated_after")).toBe("2026-11-01T00:00:00Z");
    expect(url.searchParams.get("page_size")).toBe("5");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-jwt-fixture");
    expect(headers[GRANOLA_KEY_HEADER]).toBe(KEY);
  });

  test("listNotes parses the page envelope", async () => {
    const calls: Call[] = [];
    const c = client(fakeFetch(calls, () => new Response(JSON.stringify(LIST_PAGE), { status: 200 })));
    const res = await c.listNotes({});
    expect(res.ok && res.data.notes[0]?.id).toBe("not_0001");
    expect(res.ok && res.data.hasMore).toBe(false);
  });

  test("getTranscript pages at 100 until hasMore is false", async () => {
    const calls: Call[] = [];
    const item = (i: number) => ({
      speaker: { source: "microphone", attribution: "me", name: "Ada" },
      text: `line ${i}`,
      start_time: "2026-11-10T14:00:00Z",
      end_time: "2026-11-10T14:00:05Z",
    });
    const c = client(fakeFetch(calls, (url) => {
      if (url.includes("cursor=page2")) {
        return new Response(JSON.stringify({ transcript: [item(2)], hasMore: false, cursor: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ transcript: [item(1)], hasMore: true, cursor: "page2" }), { status: 200 });
    }));
    const res = await c.getTranscript("not_0001");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items).toHaveLength(2);
      expect(res.data.truncated).toBe(false);
    }
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.searchParams.get("page_size")).toBe(String(GRANOLA_TRANSCRIPT_PAGE_SIZE));
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("page2");
  });

  test("an absent transcript (404) resolves as an empty page, not an error", async () => {
    const c = client(fakeFetch([], () =>
      new Response(JSON.stringify({ code: "NOTE_NOT_FOUND", message: "gone" }), { status: 404 })));
    const res = await c.getTranscript("not_dead");
    expect(res.ok && res.data.items).toEqual([]);
  });

  test("an admin-disabled transcript (403 FORBIDDEN) resolves as empty, not an error", async () => {
    const c = client(fakeFetch([], () =>
      new Response(JSON.stringify({ code: "FORBIDDEN", message: "transcripts disabled" }), { status: 403 })));
    const res = await c.getTranscript("not_0001");
    expect(res.ok && res.data.items).toEqual([]);
  });

  test("401 maps to invalid-key", async () => {
    const c = client(fakeFetch([], () =>
      new Response(JSON.stringify({ code: "INVALID_API_KEY", message: "bad key" }), { status: 401 })));
    const res = await c.listNotes({});
    expect(!res.ok && res.error.kind).toBe("invalid-key");
  });

  test("403 maps to forbidden with the upstream code kept", async () => {
    const c = client(fakeFetch([], () =>
      new Response(JSON.stringify({ code: "SUBSCRIPTION_INACTIVE", message: "plan inactive" }), { status: 403 })));
    const res = await c.listNotes({});
    expect(!res.ok && res.error.kind).toBe("forbidden");
    expect(!res.ok && res.error.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  test("429 retries within the cap then reports rate-limited with retryAfterMs", async () => {
    const calls: Call[] = [];
    const c = client(fakeFetch(calls, () => {
      return new Response(JSON.stringify({ code: "RATE_LIMITED", message: "slow" }), {
        status: 429, headers: { "retry-after": "1" },
      });
    }));
    const res = await c.listNotes({});
    expect(!res.ok && res.error.kind).toBe("rate-limited");
    expect(!res.ok && res.error.retryAfterMs).toBe(1000);
    expect(calls.length).toBeGreaterThan(1); // retried before giving up
  });

  test("a 429 followed by a 200 succeeds after the Retry-After wait", async () => {
    let n = 0;
    const c = client(fakeFetch([], () => {
      n++;
      return n === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify(LIST_PAGE), { status: 200 });
    }));
    const res = await c.listNotes({});
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  test("a signed-out session never issues a request", async () => {
    const calls: Call[] = [];
    const c = new GranolaClient({
      apiKey: KEY,
      backendUrl: "https://api.tinycloud.test",
      sessionStore: { getToken: () => null, isExpired: () => true } as unknown as SessionStore,
      fetchImpl: fakeFetch(calls, () => new Response("{}")),
      delayMs: 0,
    });
    const res = await c.listNotes({});
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
