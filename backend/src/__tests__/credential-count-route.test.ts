// TC-1964: the optional authenticated credential row count. Off unless a long-enough admin key is
// set; bare 401 otherwise; number-or-fixed-code only; the key is compared first, then a hard failure bucket or a hard success bucket.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { issueSessionToken } from "@tinyboilerplate/server";
import {
  applyRateLimiters,
  bucketFor,
  CREDENTIAL_COUNT_FAILURE_LIMIT,
  CREDENTIAL_COUNT_SUCCESS_LIMIT,
  CREDENTIAL_COUNT_PATHS,
  CREDENTIAL_COUNT_WINDOW_MS,
} from "../rate-limits.js";
import {
  adminKeyMatches,
  CREDENTIAL_COUNT_ADMIN_KEY_ENV,
  CREDENTIAL_COUNT_ROUTE_PATH,
  CREDENTIAL_COUNT_SHORT_KEY_LOG,
  mountCredentialCountRoute,
  resolveCredentialCountAdminKey,
} from "../routes/credential-count.js";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { type CredentialRowCounter, CredentialRowCountError } from "../services/credential-row-count.js";
import { KvCredentialRowStore } from "../services/credential-store.js";

// Never touch a real home.
const tmpHome = mkdtempSync("/var/tmp/TC-1964.");
const savedHome = process.env.HOME;
const savedCache = process.env.BUN_INSTALL_CACHE_DIR;
process.env.HOME = tmpHome;
process.env.BUN_INSTALL_CACHE_DIR = tmpHome;
if (!process.env.HOME.startsWith("/var/tmp/TC-1964.")) throw new Error("unsafe HOME");
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
  else process.env.BUN_INSTALL_CACHE_DIR = savedCache;
  rmSync(tmpHome, { recursive: true, force: true });
});

const KEY = "synthetic-admin-key-0123456789ab"; // 32 chars, synthetic
const SESSION_KEY = "synthetic-session-signing-key";
const ADDRESS = "0x" + "ab".repeat(20);
const CURSOR = "cursor-secret-token-xyz";
const realFetch = globalThis.fetch;

/** index.ts's order: app limiters first, then the optional mount. */
function makeApp(env: Record<string, string | undefined>, makeStore: () => CredentialRowCounter) {
  const app = express();
  applyRateLimiters(app, { sessionKey: SESSION_KEY });
  const logged: string[] = [];
  const mounted = mountCredentialCountRoute(app, env, makeStore, (line) => logged.push(line));
  return { app, mounted, logged };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<Server>((resolveServer) => {
    const instance = app.listen(0, () => resolveServer(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const URL_PATH = `${CREDENTIAL_COUNT_ROUTE_PATH}?source=fireflies`;
const get = (base: string, path: string, key?: string, extra: Record<string, string> = {}) =>
  realFetch(`${base}${path}`, { headers: { ...(key === undefined ? {} : { "x-admin-key": key }), ...extra } });

const fakeCounter = (count: number | (() => number)): CredentialRowCounter & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async countRows(source: string) {
      calls.push(source);
      return typeof count === "function" ? count() : count;
    },
  };
};

// Everything the process prints while a test runs, so "never logged" is observed, not assumed.
let captured: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  captured = [];
  const record = (...args: unknown[]) => captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(record as never));
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("mount rule", () => {
  test("not registered (404, store never built) when the key is unset, empty, blank or too short", async () => {
    for (const value of [undefined, "", "   \n", "short", "x".repeat(31), `  ${"x".repeat(31)}  `]) {
      let built = 0;
      const { app, mounted } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: value }, () => {
        built += 1;
        return fakeCounter(1);
      });
      expect(mounted).toBe(false);
      await withServer(app, async (base) => {
        const response = await get(base, URL_PATH, value ?? KEY);
        expect(response.status).toBe(404);
        expect(response.headers.get("www-authenticate")).toBeNull();
      });
      expect(built).toBe(0);
    }
  });

  test("a too-short key logs ONE fixed line without the value; unset and empty log nothing", () => {
    const short = "s3cret-but-too-short";
    const lines: string[] = [];
    expect(mountCredentialCountRoute(express(), { [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: short }, () => fakeCounter(0), (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual([CREDENTIAL_COUNT_SHORT_KEY_LOG]);
    expect(lines.join("\n")).not.toContain(short);
    for (const value of [undefined, "", "  "]) {
      const quiet: string[] = [];
      mountCredentialCountRoute(express(), { [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: value }, () => fakeCounter(0), (l) => quiet.push(l));
      expect(quiet).toEqual([]);
    }
  });

  test("a key of at least 32 characters mounts; the key is trimmed", () => {
    expect(resolveCredentialCountAdminKey({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: "x".repeat(32) })).toEqual({ state: "on", key: "x".repeat(32) });
    expect(resolveCredentialCountAdminKey({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: `\n${"x".repeat(32)}\n` })).toEqual({ state: "on", key: "x".repeat(32) });
    expect(resolveCredentialCountAdminKey({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: "x".repeat(31) })).toEqual({ state: "short" });
    expect(KEY.length).toBe(32);
  });

  test("index.ts mounts it through mountCredentialCountRoute with the shared KV row store and lane", () => {
    const index = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    const mount = /if \(process\.env\[CREDENTIAL_COUNT_ADMIN_KEY_ENV\]\?\.trim\(\)\) \{\s*mountCredentialCountRoute\(\s*app,\s*process\.env,\s*\(\) => new KvCredentialRowStore\(node, transcriberStorageLane, \{ priority: "background" \}\),\s*\);\s*\}/;
    expect(index).toMatch(mount);
    // after the app limiters, so the path is already classified out of the global bucket
    expect(index.indexOf("applyRateLimiters(app")).toBeLessThan(index.indexOf("mountCredentialCountRoute(\n"));
  });

  test("the route path matches the limiter's path", () => {
    expect(CREDENTIAL_COUNT_PATHS[0]).toBe(CREDENTIAL_COUNT_ROUTE_PATH);
    expect(CREDENTIAL_COUNT_ROUTE_PATH).toBe("/api/internal/credential-row-count");
    for (const path of [CREDENTIAL_COUNT_ROUTE_PATH, `${CREDENTIAL_COUNT_ROUTE_PATH}/`, CREDENTIAL_COUNT_ROUTE_PATH.toUpperCase()]) {
      expect(bucketFor("GET", path)).toBe("credentialCount");
    }
    expect(bucketFor("GET", "/api/internal/other")).toBe("global");
    expect(bucketFor("GET", "/api/chat/models")).toBe("global");
  });
});

describe("authentication", () => {
  test("wrong, missing, empty and wrong-length keys are a bare 401 with no-store and never reach the store", async () => {
    let built = 0;
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => {
      built += 1;
      return fakeCounter(7);
    });
    await withServer(app, async (base) => {
      const attempts: Array<string | undefined> = [undefined, "", "x".repeat(32), KEY.slice(0, -1), `${KEY}x`, KEY.toUpperCase(), "x".repeat(4096)];
      // Each failed attempt counts against the 5/hour failure bucket; stay under the cap in this test.
      for (const key of attempts.slice(0, CREDENTIAL_COUNT_FAILURE_LIMIT)) {
        const response = await get(base, URL_PATH, key);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe("");
      }
    });
    expect(built).toBe(0);
  });

  test("a wrong length and a same-length wrong key are indistinguishable", async () => {
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(7));
    await withServer(app, async (base) => {
      const a = await get(base, URL_PATH, "x".repeat(KEY.length));
      const b = await get(base, URL_PATH, "x");
      expect([a.status, await a.text(), a.headers.get("content-type")]).toEqual([b.status, await b.text(), b.headers.get("content-type")]);
    });
  });

  test("the key is compared with the constant-time helper over digests", () => {
    expect(adminKeyMatches(KEY, KEY)).toBe(true);
    expect(adminKeyMatches("x".repeat(32), KEY)).toBe(false);
    expect(adminKeyMatches(KEY.slice(0, -1), KEY)).toBe(false);
    expect(adminKeyMatches(`${KEY}x`, KEY)).toBe(false);
    expect(adminKeyMatches("x".repeat(1 << 16), KEY)).toBe(false);
    expect(adminKeyMatches("", KEY)).toBe(false);
    expect(adminKeyMatches(undefined, KEY)).toBe(false);
    const source = readFileSync(resolve(import.meta.dir, "../routes/credential-count.ts"), "utf8");
    expect(source).toMatch(/timingSafeEqual\(\s*createHash\("sha256"\)\.update\(presented\)\.digest\(\),\s*createHash\("sha256"\)\.update\(expected\)\.digest\(\),?\s*\)/);
    // the only comparison against the secret is the helper; no plain equality on the header or key
    expect(source).not.toMatch(/[!=]==?\s*(adminKey|expected)\b|\b(adminKey|expected)\s*[!=]==?/);
    expect(source).not.toMatch(/\.get\(CREDENTIAL_COUNT_ADMIN_KEY_HEADER\)\s*[!=]==?/);
  });

  test("a request that proves a session is still just an admin-key request", async () => {
    const { token } = await issueSessionToken(ADDRESS, SESSION_KEY);
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(7));
    await withServer(app, async (base) => {
      const bearer = { authorization: `Bearer ${token}` };
      expect((await get(base, URL_PATH, undefined, bearer)).status).toBe(401);
      expect((await get(base, URL_PATH, KEY)).status).toBe(200);
    });
  });
});

describe("the count", () => {
  test("a right key returns exactly {source,count} with no-store", async () => {
    const counter = fakeCounter(42);
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => counter);
    await withServer(app, async (base) => {
      const response = await get(base, URL_PATH, KEY);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ source: "fireflies", count: 42 });
    });
    expect(counter.calls).toEqual(["fireflies"]);
  });

  test("zero is a number, not unavailable", async () => {
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(0));
    await withServer(app, async (base) => {
      expect(await (await get(base, URL_PATH, KEY)).json()).toEqual({ source: "fireflies", count: 0 });
    });
  });

  test("the store is built lazily, once, and only after a valid key", async () => {
    let built = 0;
    const counter = fakeCounter(3);
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => {
      built += 1;
      return counter;
    });
    await withServer(app, async (base) => {
      await get(base, URL_PATH, "x".repeat(32));
      expect(built).toBe(0);
      await get(base, URL_PATH, KEY);
      await get(base, URL_PATH, KEY);
      expect(built).toBe(1);
    });
  });

  test("the real row store: pages are summed; truncation is LIST_TRUNCATED, a failed list is LIST_FAILED", async () => {
    type Page = { keys: string[]; truncated?: boolean; nextCursor?: string };
    const nodeFor = (pages: (cursor: string) => Page | undefined) => {
      const forbidden = () => {
        throw new Error("forbidden KV call");
      };
      return {
        kv: {
          async list(options: { prefix: string; cursor?: string }) {
            expect(options.prefix).toBe("credentials/fireflies/");
            const page = pages(options.cursor ?? "");
            return page ? { ok: true, data: page } : { ok: false, error: { code: "KV_ERROR", message: `leaky ${ADDRESS} ${CURSOR}` } };
          },
          get: forbidden,
          put: forbidden,
          delete: forbidden,
        },
      } as unknown as TinyCloudNode;
    };
    const rowKeys = (n: number) => Array.from({ length: n }, (_, i) => `credentials/fireflies/${ADDRESS.slice(0, -2)}${i.toString(16).padStart(2, "0")}`);
    const cases: Array<[string, (cursor: string) => Page | undefined, unknown]> = [
      ["pages", (c) => ({ "": { keys: rowKeys(3), truncated: true, nextCursor: CURSOR }, [CURSOR]: { keys: rowKeys(2) } })[c], { source: "fireflies", count: 5 }],
      ["truncated, no cursor", () => ({ keys: rowKeys(5), truncated: true }), { source: "fireflies", count: null, code: "LIST_TRUNCATED" }],
      ["repeated cursor", () => ({ keys: rowKeys(1), truncated: true, nextCursor: CURSOR }), { source: "fireflies", count: null, code: "LIST_TRUNCATED" }],
      ["list error", () => undefined, { source: "fireflies", count: null, code: "LIST_FAILED" }],
    ];
    for (const [label, pages, expected] of cases) {
      const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => new KvCredentialRowStore(nodeFor(pages), new BackendStorageLane()));
      await withServer(app, async (base) => {
        const response = await get(base, URL_PATH, KEY);
        expect([label, response.status, response.headers.get("cache-control")]).toEqual([label, 200, "no-store"]);
        const text = await response.text();
        expect([label, JSON.parse(text)]).toEqual([label, expected]);
        for (const secret of [ADDRESS, CURSOR, "credentials/", "leaky", KEY]) expect(text).not.toContain(secret);
      });
    }
    for (const line of captured) for (const secret of [ADDRESS, CURSOR, KEY, "leaky"]) expect(line).not.toContain(secret);
  });

  test("a store that cannot be built or throws is LIST_FAILED with no message", async () => {
    for (const makeStore of [
      () => {
        throw new Error(`boom ${ADDRESS}`);
      },
      () => ({ countRows: async () => Promise.reject(new Error(`boom ${ADDRESS} ${KEY}`)) }),
      () => ({ countRows: async () => Number.NaN }),
      () => ({ countRows: async () => -1 }),
    ] as Array<() => CredentialRowCounter>) {
      const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, makeStore);
      await withServer(app, async (base) => {
        const text = await (await get(base, URL_PATH, KEY)).text();
        expect(JSON.parse(text)).toEqual({ source: "fireflies", count: null, code: "LIST_FAILED" });
        expect(text).not.toContain(ADDRESS);
      });
    }
  });

  test("a store's own INVALID_SOURCE/LIST_TRUNCATED codes pass through unchanged", async () => {
    for (const code of ["LIST_TRUNCATED", "INVALID_SOURCE"] as const) {
      const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => ({
        countRows: async () => {
          throw new CredentialRowCountError(code);
        },
      }));
      await withServer(app, async (base) => {
        const body = (await (await get(base, URL_PATH, KEY)).json()) as Record<string, unknown>;
        expect(body.count).toBeNull();
        expect(body.code).toBe(code);
      });
    }
  });

  test("missing, repeated, oversized and malformed sources are 200 INVALID_SOURCE without echoing the input", async () => {
    const forbidden = () => {
      throw new Error("forbidden KV call");
    };
    const node = { kv: { list: forbidden, get: forbidden, put: forbidden, delete: forbidden } } as unknown as TinyCloudNode;
    const attempts = [
      "", // no source
      "?source=",
      "?source=fireflies&source=other",
      "?source[a]=1",
      "?source=Fire%20Flies",
      `?source=${"a".repeat(500)}`,
      "?source=..%2Fsecret",
      `?source=${ADDRESS}`,
    ];
    for (const query of attempts) {
      const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => new KvCredentialRowStore(node, new BackendStorageLane()));
      await withServer(app, async (base) => {
        const response = await get(base, `${CREDENTIAL_COUNT_ROUTE_PATH}${query}`, KEY);
        expect([query, response.status, response.headers.get("cache-control")]).toEqual([query, 200, "no-store"]);
        const text = await response.text();
        expect([query, JSON.parse(text)]).toEqual([query, { source: "invalid", count: null, code: "INVALID_SOURCE" }]);
        expect(text).not.toContain("secret");
        expect(text).not.toContain(ADDRESS);
      });
    }
  });

  test("only GET (and its implied HEAD) is served; writes are 404", async () => {
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(1));
    await withServer(app, async (base) => {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const response = await realFetch(`${base}${URL_PATH}`, { method, headers: { "x-admin-key": KEY } });
        expect(response.status).toBe(404);
      }
    });
  });

  test("nothing is logged per request and the key never appears in captured output", async () => {
    const { app, logged } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(9));
    const stdout = spyOn(process.stdout, "write");
    const stderr = spyOn(process.stderr, "write");
    try {
      await withServer(app, async (base) => {
        await get(base, URL_PATH, KEY);
        await get(base, URL_PATH, "wrong-key-value-that-must-not-be-logged-0123");
        await get(base, `${CREDENTIAL_COUNT_ROUTE_PATH}?source=bad!`, KEY);
      });
      const written = [...stdout.mock.calls, ...stderr.mock.calls].map((c) => String(c[0]));
      for (const text of [...captured, ...logged, ...written]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain("wrong-key-value-that-must-not-be-logged-0123");
      }
      expect(logged).toEqual([]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("hard rate limits: a failure bucket and a success bucket", () => {
  const WRONG = "x".repeat(32);

  test("caps: 5 failures and 10 correct-key requests per hour", () => {
    expect(CREDENTIAL_COUNT_FAILURE_LIMIT).toBe(5);
    expect(CREDENTIAL_COUNT_SUCCESS_LIMIT).toBe(10);
    expect(CREDENTIAL_COUNT_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  test("wrong keys cannot lock out the right key: 5+ wrong requests, then the right key is 200", async () => {
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(11));
    await withServer(app, async (base) => {
      for (let i = 0; i < CREDENTIAL_COUNT_FAILURE_LIMIT + 5; i += 1) await get(base, URL_PATH, WRONG);
      const response = await get(base, URL_PATH, KEY);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ source: "fireflies", count: 11 });
    });
  });

  test("the 6th wrong or missing key is a bare 429 with no-store, and it stays 429", async () => {
    let built = 0;
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => {
      built += 1;
      return fakeCounter(1);
    });
    await withServer(app, async (base) => {
      for (let i = 0; i < CREDENTIAL_COUNT_FAILURE_LIMIT; i += 1) {
        const response = await get(base, URL_PATH, i % 2 === 0 ? WRONG : undefined);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      for (const key of [WRONG, undefined, "", `${KEY}x`, KEY.slice(1), WRONG]) {
        const response = await get(base, URL_PATH, key);
        expect(response.status).toBe(429);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("ratelimit")).toBeNull();
        expect(response.headers.get("retry-after")).toBeNull();
        expect(await response.text()).toBe("");
      }
    });
    expect(built).toBe(0);
  });

  test("the correct key is still 200 after the failure bucket is exhausted, and never spends it", async () => {
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(4));
    await withServer(app, async (base) => {
      for (let i = 0; i < CREDENTIAL_COUNT_FAILURE_LIMIT + 1; i += 1) await get(base, URL_PATH, WRONG);
      expect((await get(base, URL_PATH, WRONG)).status).toBe(429);
      for (let i = 0; i < 3; i += 1) {
        const response = await get(base, URL_PATH, KEY);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ source: "fireflies", count: 4 });
      }
      // right-key traffic did not move the failure bucket: it is still exhausted for wrong keys
      expect((await get(base, URL_PATH, WRONG)).status).toBe(429);
    });
  });

  test("the correct-key bucket caps at 10: the 11th is a bare 429 with no-store, wrong keys unaffected", async () => {
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(1));
    await withServer(app, async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < CREDENTIAL_COUNT_SUCCESS_LIMIT; i += 1) statuses.push((await get(base, URL_PATH, KEY)).status);
      expect(statuses).toEqual(Array(CREDENTIAL_COUNT_SUCCESS_LIMIT).fill(200));
      for (let i = 0; i < 2; i += 1) {
        const response = await get(base, URL_PATH, KEY);
        expect(response.status).toBe(429);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("ratelimit")).toBeNull();
        expect(await response.text()).toBe("");
      }
      // the failure bucket is separate: a wrong key is still a plain 401
      expect((await get(base, URL_PATH, WRONG)).status).toBe(401);
    });
  });

  test("one shared bucket each: neither a bearer session nor a forged X-Forwarded-For buys more tries", async () => {
    const { token } = await issueSessionToken(ADDRESS, SESSION_KEY);
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(1));
    await withServer(app, async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < CREDENTIAL_COUNT_FAILURE_LIMIT + 2; i += 1) {
        const extra: Record<string, string> = i % 2 === 0 ? { authorization: `Bearer ${token}` } : { "x-forwarded-for": `203.0.113.${i}` };
        statuses.push((await get(base, URL_PATH, WRONG, extra)).status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    });
  });

  test("the count route is outside the global bucket and does not spend it", async () => {
    const { app } = makeApp({ [CREDENTIAL_COUNT_ADMIN_KEY_ENV]: KEY }, () => fakeCounter(1));
    app.get("/api/server-info", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (base) => {
      for (let i = 0; i < CREDENTIAL_COUNT_FAILURE_LIMIT + 1; i += 1) await get(base, URL_PATH, WRONG);
      expect((await realFetch(`${base}/api/server-info`)).status).toBe(200);
    });
  });

  test("the key is compared before any bucket is charged (source pin)", () => {
    const source = readFileSync(resolve(import.meta.dir, "../routes/credential-count.ts"), "utf8");
    const compare = source.indexOf("adminKeyMatches(req.get(");
    expect(compare).toBeGreaterThan(0);
    expect(source.indexOf("limiters.failure(")).toBeGreaterThan(compare);
    expect(source.indexOf("limiters.success(")).toBeGreaterThan(compare);
  });
});
