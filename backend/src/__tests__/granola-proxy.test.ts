import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import {
  createGranolaProxyRouter,
  granolaProxyEnabled,
  GRANOLA_API_BASE_URL,
  GRANOLA_KEY_HEADER,
} from "../routes/granola-proxy.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(calls: FetchCall[], response: (url: string) => globalThis.Response) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response(String(url));
  }) as typeof fetch;
}

function makeApp(fetchImpl?: typeof fetch): express.Express {
  const app = express();
  app.use("/api/connectors/granola", createGranolaProxyRouter({ fetchImpl }));
  return app;
}

async function request(
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<globalThis.Response> {
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, () => listening.resolve(server));
  await listening.promise;
  const { port } = server.address() as { port: number };
  try {
    return await realFetch(`http://localhost:${port}${path}`, init);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
  }
}

const KEY = "grn_testkey_00000000";
const NOTES_PAGE = JSON.stringify({ notes: [{ id: "not_abc" }], hasMore: false, cursor: null });

describe("granola proxy flag", () => {
  it("is exact-match 'true' only", () => {
    expect(granolaProxyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(granolaProxyEnabled({ GRANOLA_PROXY_ENABLED: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(granolaProxyEnabled({ GRANOLA_PROXY_ENABLED: "yes" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(granolaProxyEnabled({ GRANOLA_PROXY_ENABLED: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("granola proxy routes", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  });

  it("forwards GET /v1/notes with the caller's key as Bearer, pinned host, allowlisted query", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response(NOTES_PAGE, { status: 200, headers: { "content-type": "application/json" } }));
    const res = await request(
      makeApp(),
      "/api/connectors/granola/v1/notes?page_size=30&updated_after=2026-11-01T00:00:00Z&cursor=cur_1",
      { headers: { [GRANOLA_KEY_HEADER]: KEY } },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(NOTES_PAGE);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://public-api.granola.ai");
    expect(url.pathname).toBe("/v1/notes");
    expect(url.searchParams.get("page_size")).toBe("30");
    expect(url.searchParams.get("updated_after")).toBe("2026-11-01T00:00:00Z");
    expect(url.searchParams.get("cursor")).toBe("cur_1");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("forwards GET /v1/notes/:id and /transcript, keeping the id in the pinned path", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("{}", { status: 200 }));
    const app = makeApp();
    const headers = { [GRANOLA_KEY_HEADER]: KEY };
    expect((await request(app, "/api/connectors/granola/v1/notes/not_abc123", { headers })).status).toBe(200);
    expect((await request(app, "/api/connectors/granola/v1/notes/not_abc123/transcript?page_size=100", { headers })).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://public-api.granola.ai/v1/notes/not_abc123",
      "https://public-api.granola.ai/v1/notes/not_abc123/transcript?page_size=100",
    ]);
  });

  it("rejects a missing or malformed key WITHOUT calling upstream, and never echoes it", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("{}", { status: 200 }));
    const app = makeApp();
    const missing = await request(app, "/api/connectors/granola/v1/notes");
    expect(missing.status).toBe(401);
    const bad = await request(app, "/api/connectors/granola/v1/notes", {
      headers: { [GRANOLA_KEY_HEADER]: "not-a-key" },
    });
    expect(bad.status).toBe(401);
    const body = await bad.text();
    expect(body).not.toContain("not-a-key");
    expect(calls).toHaveLength(0);
  });

  it("refuses non-allowlisted paths: no other Granola route is forwarded", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("{}", { status: 200 }));
    const app = makeApp();
    const headers = { [GRANOLA_KEY_HEADER]: KEY };
    for (const path of [
      "/api/connectors/granola/v1/users",
      "/api/connectors/granola/v1/notes/../users",
      "/api/connectors/granola/v2/notes",
      "/api/connectors/granola/",
    ]) {
      const res = await request(app, path, { headers });
      expect([400, 404]).toContain(res.status);
    }
    // A non-GET on a known path is refused by the router too.
    expect((await request(app, "/api/connectors/granola/v1/notes", { method: "POST", headers })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("refuses non-allowlisted query parameters rather than forwarding them", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("{}", { status: 200 }));
    const res = await request(
      makeApp(),
      "/api/connectors/granola/v1/notes?admin=true",
      { headers: { [GRANOLA_KEY_HEADER]: KEY } },
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a note id that fails the not_ shape with 404 and no upstream call", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("{}", { status: 200 }));
    const res = await request(
      makeApp(),
      "/api/connectors/granola/v1/notes/not_%2e%2e%2fadmin",
      { headers: { [GRANOLA_KEY_HEADER]: KEY } },
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("relays upstream error bodies and Retry-After on 429 verbatim", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () =>
      new Response(JSON.stringify({ code: "RATE_LIMITED", message: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "7" },
      }),
    );
    const res = await request(
      makeApp(),
      "/api/connectors/granola/v1/notes",
      { headers: { [GRANOLA_KEY_HEADER]: KEY } },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.json()).toEqual({ code: "RATE_LIMITED", message: "slow down" });
  });

  it("answers 502 when the upstream is unreachable, with no key material in the response", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => {
      throw new Error(`dial failed ${KEY}`); // even a key-bearing error message must not propagate
    });
    const res = await request(
      makeApp(),
      "/api/connectors/granola/v1/notes",
      { headers: { [GRANOLA_KEY_HEADER]: KEY } },
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(KEY);
    expect(body).not.toContain("dial failed");
  });

  it("the key never reaches a log line: only shape tokens and statuses are logged", async () => {
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    const calls: FetchCall[] = [];
    mockFetch(calls, () => {
      throw new Error(`upstream blew up carrying ${KEY} and not_abc123`);
    });
    await request(makeApp(), "/api/connectors/granola/v1/notes/not_abc123", {
      headers: { [GRANOLA_KEY_HEADER]: KEY },
    });
    mockFetch(calls, () => new Response("{}", { status: 200 }));
    await request(makeApp(), "/api/connectors/granola/v1/notes?cursor=cur_secret", {
      headers: { [GRANOLA_KEY_HEADER]: KEY },
    });
    const all = lines.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("not_abc123");
    expect(all).not.toContain("cur_secret");
    expect(all).toContain("[granola-proxy]");
  });
});
