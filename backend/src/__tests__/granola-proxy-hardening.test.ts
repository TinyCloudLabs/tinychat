import { afterEach, beforeAll, afterAll, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { applyRateLimiters, SESSION_LIMITS } from "../rate-limits.js";
import {
  createGranolaProxyRouter,
  GRANOLA_KEY_HEADER,
  GRANOLA_MAX_RESPONSE_BYTES,
  type GranolaProxyOptions,
} from "../routes/granola-proxy.js";
import { createRequestContextMiddleware, recordMountTemplates } from "../request-context.js";

// Real backend pieces (session auth, per-owner limiter, request record, the proxy router) in one
// express app, talking over loopback to a fake Granola upstream. No real Granola host or key.

const KEY = "grn_hardeningkey_0123456789";
const NOTE = "not_abc123";
const CURSOR = "cursor_value_zz9";
const SESSION_KEY = "0x" + "07".repeat(32);
const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";
const MOUNT = "/api/connectors/granola";

type Seen = { path: string; headers: Headers };
type UpstreamHandler = (req: Request) => Response | Promise<Response>;

let upstreamServer: ReturnType<typeof Bun.serve>;
let handler: UpstreamHandler = () => Response.json({});
let seen: Seen[] = [];
let evilHits = 0;
let evilServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  upstreamServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push({ path: new URL(req.url).pathname + new URL(req.url).search, headers: req.headers });
      return handler(req);
    },
  });
  evilServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      evilHits++;
      return Response.json({ evil: true });
    },
  });
});

afterAll(() => {
  upstreamServer.stop(true);
  evilServer.stop(true);
});

const realLog = console.log;
const realError = console.error;
const realWarn = console.warn;
const realInfo = console.info;
afterEach(() => {
  console.log = realLog;
  console.error = realError;
  console.warn = realWarn;
  console.info = realInfo;
  handler = () => Response.json({});
  seen = [];
  evilHits = 0;
});

function captureLogs(): string[] {
  const lines: string[] = [];
  const grab = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = grab;
  console.error = grab;
  console.warn = grab;
  console.info = grab;
  return lines;
}

async function token(address: string): Promise<string> {
  return (await issueSessionToken(address, SESSION_KEY)).token;
}

type Harness = { port: number; events: Record<string, unknown>[]; close: () => Promise<void> };

async function startApp(options: GranolaProxyOptions = {}): Promise<Harness> {
  const events: Record<string, unknown>[] = [];
  const app = express();
  app.use(createRequestContextMiddleware((event) => events.push(event as Record<string, unknown>)));
  recordMountTemplates(app);
  applyRateLimiters(app, { sessionKey: SESSION_KEY });
  app.use(
    MOUNT,
    createAuthMiddleware(SESSION_KEY),
    createGranolaProxyRouter({ baseUrl: `http://127.0.0.1:${upstreamServer.port}`, ...options }),
  );
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  await listening.promise;
  const { port } = server.address() as { port: number };
  return {
    port,
    events,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function withApp<T>(options: GranolaProxyOptions, fn: (h: Harness) => Promise<T>): Promise<T> {
  const harness = await startApp(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

async function call(
  h: Harness,
  path: string,
  { method = "GET", owner = ALICE, headers = {} }: { method?: string; owner?: string; headers?: Record<string, string> } = {},
): Promise<globalThis.Response> {
  return fetch(`http://127.0.0.1:${h.port}${MOUNT}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(owner)}`, [GRANOLA_KEY_HEADER]: KEY, ...headers },
  });
}

describe("granola proxy: key never leaves in a log, error body or header", () => {
  const scenarios: [string, UpstreamHandler, GranolaProxyOptions?][] = [
    ["success", () => Response.json({ notes: [] })],
    ["success that echoes the key", () => Response.json({ echo: KEY })],
    ["401 that echoes the key", () => Response.json({ code: "BAD", message: `bad key ${KEY}` }, { status: 401 })],
    ["429 that echoes the key", () => Response.json({ code: "SLOW", message: KEY }, { status: 429, headers: { "retry-after": "5" } })],
    ["500 that echoes the key", () => new Response(`boom ${KEY}`, { status: 500 })],
    ["invalid json", () => new Response("{not json", { headers: { "content-type": "application/json" } })],
    ["html page", () => new Response(`<html>${KEY}</html>`, { headers: { "content-type": "text/html" } })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1/${KEY}` } })],
    ["timeout", () => new Promise<Response>(() => {}), { timeoutMs: 60 }],
    ["oversized", () => new Response("x".repeat(4096)), { maxResponseBytes: 1024 }],
  ];

  for (const [name, respond, options] of scenarios) {
    it(`${name}`, async () => {
      const lines = captureLogs();
      handler = respond;
      await withApp(options ?? {}, async (h) => {
        const res = await call(h, `/v1/notes/${NOTE}?include=transcript`);
        const text = await res.text();
        const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
        expect(text).not.toContain(KEY);
        expect(headers).not.toContain(KEY);
        expect(JSON.stringify(h.events)).not.toContain(KEY);
        expect(JSON.stringify(h.events)).not.toContain(NOTE);
      });
      const all = lines.join("\n");
      expect(all).not.toContain(KEY);
      expect(all).not.toContain(NOTE);
      expect(all).toContain("[granola-proxy]");
    });
  }

  it("a malformed, duplicated or oversized key header, or the key in the query, is refused without echo", async () => {
    const lines = captureLogs();
    await withApp({}, async (h) => {
      const answers: globalThis.Response[] = [];
      answers.push(await call(h, "/v1/notes", { headers: { [GRANOLA_KEY_HEADER]: `${KEY} ${KEY}` } }));
      answers.push(await call(h, "/v1/notes", { headers: { [GRANOLA_KEY_HEADER]: `${KEY}, ${KEY}` } }));
      answers.push(await call(h, "/v1/notes", { headers: { [GRANOLA_KEY_HEADER]: "grn_" + "a".repeat(300) } }));
      for (const res of answers) {
        expect(res.status).toBe(401);
        const text = await res.text();
        expect(text).not.toMatch(/grn_[A-Za-z0-9]{4}/);
      }
      const asParam = await call(h, `/v1/notes?${KEY}=1`);
      expect(asParam.status).toBe(400);
      expect(await asParam.text()).not.toContain(KEY);
      const asKeyHeaderInQuery = await call(h, `/v1/notes?x-granola-key=${KEY}`);
      expect(asKeyHeaderInQuery.status).toBe(400);
    });
    expect(seen).toHaveLength(0);
    expect(lines.join("\n")).not.toContain(KEY);
  });
});

describe("granola proxy: upstream outcomes map to stable answers", () => {
  const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

  it("passes a JSON error from Granola through with its status", async () => {
    handler = () => json({ code: "SUBSCRIPTION_INACTIVE", message: "inactive" }, { status: 403 });
    await withApp({}, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: "SUBSCRIPTION_INACTIVE", message: "inactive" });
    });
  });

  it("replaces a 4xx that is not a JSON object with a fixed body for the same status", async () => {
    handler = () => new Response("<h1>nope</h1>", { status: 404, headers: { "content-type": "text/html" } });
    await withApp({}, async (h) => {
      const res = await call(h, `/v1/notes/${NOTE}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ code: "NOT_FOUND", message: "Granola could not find that note" });
    });
  });

  it("429 keeps its status and Retry-After, as seconds or as a date", async () => {
    const date = "Wed, 18 Nov 2026 01:02:03 GMT";
    for (const [value, expected] of [["7", "7"], [date, date]] as const) {
      handler = () => json({ code: "RATE_LIMITED", message: "slow down" }, { status: 429, headers: { "retry-after": value } });
      await withApp({}, async (h) => {
        const res = await call(h, "/v1/notes");
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe(expected);
      });
    }
  });

  it("drops a Retry-After that is neither seconds nor a date", async () => {
    handler = () => json({ code: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": "soon; set-cookie: a=b" } });
    await withApp({}, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(429);
      expect(res.headers.has("retry-after")).toBe(false);
    });
  });

  it("5xx answers 502 with a fixed body and passes Retry-After", async () => {
    for (const status of [500, 502, 503, 504]) {
      handler = () => new Response("upstream trace: db password=hunter2", { status, headers: { "retry-after": "3" } });
      await withApp({}, async (h) => {
        const res = await call(h, "/v1/notes");
        expect(res.status).toBe(502);
        expect(res.headers.get("retry-after")).toBe("3");
        expect(await res.json()).toEqual({ code: "UPSTREAM_ERROR", message: "Granola did not respond as expected" });
      });
    }
  });

  it("a 2xx that is not a JSON object answers 502", async () => {
    for (const body of ["{not json", "[]", "null", "plain text", ""]) {
      handler = () => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      await withApp({}, async (h) => {
        const res = await call(h, "/v1/notes");
        expect(res.status).toBe(502);
        expect((await res.json()).code).toBe("UPSTREAM_INVALID_RESPONSE");
      });
    }
  });

  it("answers JSON content-type whatever Granola declared", async () => {
    handler = () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "text/html" } });
    await withApp({}, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("does not follow a redirect and answers 502 without a Location", async () => {
    handler = () => new Response(null, {
      status: 302,
      headers: { location: `http://127.0.0.1:${evilServer.port}/v1/notes`, "set-cookie": "a=b" },
    });
    await withApp({}, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(502);
      expect(res.headers.has("location")).toBe(false);
      expect(res.headers.has("set-cookie")).toBe(false);
    });
    expect(evilHits).toBe(0);
  });

  it("answers 504 when Granola is slow to answer", async () => {
    handler = () => new Promise<Response>(() => {});
    await withApp({ timeoutMs: 80 }, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({ code: "UPSTREAM_TIMEOUT", message: "Granola took too long to respond" });
    });
  });

  it("answers 504 when the body stalls part-way", async () => {
    handler = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"notes":[')); },
    }), { headers: { "content-type": "application/json" } });
    await withApp({ timeoutMs: 120 }, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(504);
    });
  });

  it("answers 502 when nothing is listening upstream", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const baseUrl = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    await withApp({ baseUrl }, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ code: "UPSTREAM_ERROR", message: "Failed to reach Granola" });
    });
  });
});

describe("granola proxy: size limits", () => {
  it("refuses a response whose declared length is over the limit, and one that streams past it", async () => {
    handler = () => new Response("y".repeat(5000), { headers: { "content-type": "application/json" } });
    await withApp({ maxResponseBytes: 1024 }, async (h) => {
      const declared = await call(h, "/v1/notes");
      expect(declared.status).toBe(502);
      expect((await declared.json()).code).toBe("UPSTREAM_TOO_LARGE");
    });
    handler = () => new Response(new ReadableStream({
      start(controller) {
        const chunk = new TextEncoder().encode("z".repeat(600));
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { headers: { "content-type": "application/json" } });
    await withApp({ maxResponseBytes: 1024 }, async (h) => {
      const streamed = await call(h, "/v1/notes");
      expect(streamed.status).toBe(502);
      expect((await streamed.json()).code).toBe("UPSTREAM_TOO_LARGE");
    });
  });

  it("serves a response exactly at the limit", async () => {
    const body = JSON.stringify({ pad: "p".repeat(100) });
    handler = () => new Response(body, { headers: { "content-type": "application/json" } });
    await withApp({ maxResponseBytes: Buffer.byteLength(body) }, async (h) => {
      const res = await call(h, "/v1/notes");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
    });
  });

  it("keeps a default limit that fits a full transcript page", () => {
    expect(GRANOLA_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("refuses an oversized key, cursor, repeated or nested parameter without calling upstream", async () => {
    await withApp({}, async (h) => {
      expect((await call(h, "/v1/notes", { headers: { [GRANOLA_KEY_HEADER]: "grn_" + "k".repeat(257) } })).status).toBe(401);
      expect((await call(h, `/v1/notes?cursor=${"c".repeat(1025)}`)).status).toBe(400);
      expect((await call(h, `/v1/notes?cursor=${"c".repeat(1024)}`)).status).toBe(200);
      expect((await call(h, "/v1/notes?cursor=a&cursor=b")).status).toBe(400);
      expect((await call(h, "/v1/notes?cursor[x]=a")).status).toBe(400);
      expect((await call(h, "/v1/notes?page_size=" + "9".repeat(129))).status).toBe(400);
      expect((await call(h, "/v1/notes?__proto__=1")).status).toBe(200);
      expect((await call(h, "/v1/notes?constructor=1")).status).toBe(400);
      expect([400, 414, 431]).toContain((await call(h, `/v1/notes?cursor=${"d".repeat(40_000)}`).catch(() => ({ status: 431 }))).status);
    });
    // Only the 1024-character cursor and the dropped __proto__ (which carries nothing) went upstream.
    expect(seen.map((s) => s.path.length)).toEqual([`/v1/notes?cursor=${"c".repeat(1024)}`.length, "/v1/notes".length]);
  });
});

describe("granola proxy: what is sent upstream and what comes back", () => {
  it("sends only authorization and accept, with the owner's key and not the session", async () => {
    handler = () => Response.json({}, {
      headers: { "set-cookie": "sid=1", "www-authenticate": "Bearer", server: "granola", "access-control-allow-origin": "*" },
    });
    await withApp({}, async (h) => {
      const session = await token(ALICE);
      const res = await fetch(`http://127.0.0.1:${h.port}${MOUNT}/v1/notes`, {
        headers: {
          authorization: `Bearer ${session}`,
          [GRANOLA_KEY_HEADER]: KEY,
          cookie: "sid=abc",
          "x-forwarded-for": "203.0.113.9",
          "x-request-id": "11111111-1111-4111-8111-111111111111",
          origin: "https://app.example",
          referer: "https://app.example/x",
        },
      });
      expect(res.status).toBe(200);
      for (const name of ["set-cookie", "www-authenticate", "server", "access-control-allow-origin"]) {
        expect(res.headers.has(name)).toBe(false);
      }
      expect(seen).toHaveLength(1);
      const sent = seen[0]!.headers;
      expect(sent.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(sent.get("authorization")).not.toContain(session);
      for (const name of ["cookie", GRANOLA_KEY_HEADER, "x-forwarded-for", "x-request-id", "origin", "referer"]) {
        expect(sent.has(name)).toBe(false);
      }
    });
  });

  it("pins the upstream path and query to what the route allows", async () => {
    await withApp({}, async (h) => {
      await call(h, "/V1/NOTES/?page_size=5");
      await call(h, `/v1/notes/${NOTE}/transcript?page_size=100&cursor=${CURSOR}&from_time=00:10:00`);
    });
    expect(seen.map((s) => s.path)).toEqual([
      "/v1/notes?page_size=5",
      `/v1/notes/${NOTE}/transcript?page_size=100&cursor=${CURSOR}&from_time=00%3A10%3A00`,
    ]);
  });
});

describe("granola proxy: paths and methods", () => {
  it("refuses path tricks without calling upstream", async () => {
    const paths = [
      "/v1/notes/..%2Fusers",
      "/v1/notes/%2e%2e/users",
      "/v1/notes/not_abc%2Fx",
      "/v1/notes/not_abc%252Fx",
      "/v1/notes/not_abc@127.0.0.1",
      "/v1/notes/not_abc%0a",
      "/v1/notes/not_abc%00",
      "/v1/notes/not_abc%0d%0ax:y",
      "/v1/notes/not_abc/transcript/extra",
      "/v1/notes//not_abc",
      "/v1/notes/http:%2F%2F127.0.0.1%2Fv1%2Fnotes",
      "//127.0.0.1/v1/notes",
      "/v1/notes;x=1/not_abc",
      "/v1/me",
      "/v1/notes/not_abc/transcripts",
      "/v2/notes",
      "/",
    ];
    await withApp({}, async (h) => {
      for (const path of paths) {
        const res = await call(h, path);
        expect([400, 404], path).toContain(res.status);
      }
    });
    expect(seen).toHaveLength(0);
    expect(evilHits).toBe(0);
  });

  it("serves GET only: every other method is 404 and never reaches upstream", async () => {
    await withApp({}, async (h) => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        for (const path of ["/v1/notes", `/v1/notes/${NOTE}`, `/v1/notes/${NOTE}/transcript`]) {
          const res = await call(h, path, { method });
          expect(res.status, `${method} ${path}`).toBe(404);
        }
      }
    });
    expect(seen).toHaveLength(0);
  });

  it("an absolute-form request target cannot choose the upstream", async () => {
    await withApp({}, async (h) => {
      const bearer = await token(ALICE);
      const reply = Promise.withResolvers<string>();
      const socket = connect(h.port, "127.0.0.1", () => {
        socket.write(
          `GET http://127.0.0.1:${evilServer.port}${MOUNT}/v1/notes HTTP/1.1\r\n`
          + `Host: 127.0.0.1:${evilServer.port}\r\nAuthorization: Bearer ${bearer}\r\n`
          + `${GRANOLA_KEY_HEADER}: ${KEY}\r\nConnection: close\r\n\r\n`,
        );
      });
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("close", () => reply.resolve(data));
      socket.on("error", () => reply.resolve(data));
      await reply.promise;
    });
    expect(evilHits).toBe(0);
    expect(seen.every((s) => s.path.startsWith("/v1/notes"))).toBe(true);
  });
});

describe("granola proxy: per-owner rate bucket", () => {
  it("counts per owner, answers 429 once the owner's bucket is spent, and never calls upstream for it", async () => {
    const limit = SESSION_LIMITS.granolaProxy;
    await withApp({}, async (h) => {
      const aliceToken = await token(ALICE);
      const get = (bearer: string, key = KEY) => fetch(`http://127.0.0.1:${h.port}${MOUNT}/v1/notes`, {
        headers: { authorization: `Bearer ${bearer}`, [GRANOLA_KEY_HEADER]: key },
      });
      for (let i = 0; i < limit; i++) {
        const res = await get(aliceToken);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      const upstreamCalls = seen.length;
      expect(upstreamCalls).toBe(limit);
      // A different Granola key does not make a new bucket for the same owner.
      const limited = await get(aliceToken, "grn_otherkey_0123456789");
      expect(limited.status).toBe(429);
      expect(limited.headers.has("retry-after") || limited.headers.has("ratelimit")).toBe(true);
      const text = await limited.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("grn_otherkey");
      expect(seen).toHaveLength(upstreamCalls);
      // Another owner is unaffected.
      const bob = await get(await token(BOB));
      expect(bob.status).toBe(200);
    });
  }, 30_000);
});

describe("granola proxy: request record", () => {
  it("ships only the fixed fields: no id, cursor, key or header values, on success and on failure", async () => {
    for (const respond of [
      () => Response.json({}),
      () => Response.json({ code: "X" }, { status: 429, headers: { "retry-after": "2" } }),
      () => new Response("boom", { status: 500 }),
    ] as UpstreamHandler[]) {
      handler = respond;
      await withApp({}, async (h) => {
        const res = await call(h, `/v1/notes/${NOTE}/transcript?cursor=${CURSOR}`, {
          headers: { cookie: "sid=secretcookie" },
        });
        await res.arrayBuffer();
        const records = h.events.filter((e) => e.event === "tinychat_request");
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(record.route).toBe(`${MOUNT}/v1/notes/:id/transcript`);
        expect(Object.keys(record).sort()).toEqual(
          ["account_hash", "duration_ms", "event", "method", "request_id", "request_id_replaced", "route", "status"]
            .filter((k) => k in record)
            .sort(),
        );
        const shipped = JSON.stringify(record);
        for (const secret of [KEY, NOTE, CURSOR, "secretcookie"]) expect(shipped).not.toContain(secret);
      });
    }
  });
});
