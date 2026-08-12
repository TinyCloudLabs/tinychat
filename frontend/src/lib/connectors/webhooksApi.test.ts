import { describe, expect, test } from "bun:test";

// `@tinyboilerplate/client` (imported for the header-parity test below) evaluates
// the TinyCloud web-sdk at module load, which references DOM globals. Stub them
// BEFORE the dynamic imports so this file loads standalone as well as inside the
// full `bun test` run — same treatment billingApi.test.ts gives them.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.HTMLElement === "undefined") g.HTMLElement = class {};
if (typeof g.customElements === "undefined") {
  g.customElements = { define() {}, get() {} };
}
if (typeof g.window === "undefined") g.window = g;

const {
  createConnectorWebhooksClient,
  readSurfaceBlocked,
  CONNECTOR_WEBHOOKS_BASE_PATH,
} = await import("./webhooksApi");
const { createApiClient } = await import("@tinyboilerplate/client");

// ── Harness ──────────────────────────────────────────────────────────

const BACKEND = "https://backend.example";
const SECRET = "whsec-never-persist-me";
const URL_VALUE = `${BACKEND}/api/connectors/webhooks/fireflies/tok_abc`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function stubSession(options: { token?: string | null; expired?: boolean } = {}) {
  const token = options.token === undefined ? "session-token" : options.token;
  const cleared: number[] = [];
  const store = {
    getToken: () => token,
    isExpired: () => options.expired === true,
    clear: () => {
      cleared.push(1);
    },
  };
  return { store: store as never, clearCount: () => cleared.length };
}

function recorder(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next === undefined) return json(200, {});
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(
  responses: Array<Response | (() => Response | Promise<Response>)>,
  sessionOptions: { token?: string | null; expired?: boolean } = {},
) {
  const session = stubSession(sessionOptions);
  const { fetchImpl, calls } = recorder(responses);
  return {
    api: createConnectorWebhooksClient(BACKEND, {
      sessionStore: session.store,
      fetchImpl,
    }),
    calls,
    session,
  };
}

const CONFIG_BODY = {
  enabled: true,
  disabledAt: null,
  source: "fireflies",
  url: URL_VALUE,
  secret: null,
  hasSecret: true,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const PENDING_BODY = {
  enabled: true,
  disabledAt: null,
  source: "fireflies",
  deliveriesRateLimited: false,
  count: 1,
  pending: [
    {
      meetingId: "MEET1",
      kind: "transcript",
      receivedAt: "2026-08-05T10:00:00.000Z",
      attempts: 0,
      nextAttemptAt: "2026-08-05T10:00:00.000Z",
    },
  ],
  deadCount: 0,
  dead: [],
};

// ── Routes and shapes (mirrors of the backend contract) ──────────────

describe("route wiring — every companion, one segment deep", () => {
  test("GET /config", async () => {
    const { api, calls } = client([json(200, CONFIG_BODY)]);
    const result = await api.getConfig();
    expect(result.status).toBe("ok");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/config`);
  });

  test("POST /config carries source + rotate", async () => {
    const { api, calls } = client([
      json(200, { status: "enabled", rotated: true, ...CONFIG_BODY, secret: SECRET }),
    ]);
    const result = await api.enable({ source: "fireflies", rotate: true });
    expect(result.status).toBe("ok");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/config`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      source: "fireflies",
      rotate: true,
    });
  });

  test("DELETE /config returns the teardown count", async () => {
    const { api, calls } = client([json(200, { status: "disabled", queueDropped: 3 })]);
    const result = await api.disable();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/config`);
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value).toEqual({ status: "disabled", queueDropped: 3 });
  });

  test("GET /pending", async () => {
    const { api, calls } = client([json(200, PENDING_BODY)]);
    const result = await api.getPending();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/pending`);
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.pending[0]?.meetingId).toBe("MEET1");
    expect(result.value.pending[0]?.kind).toBe("transcript");
    expect(result.value.deadCount).toBe(0);
    expect(result.value.deliveriesRateLimited).toBe(false);
  });

  test("POST /drain returns the queue snapshot", async () => {
    const { api, calls } = client([json(200, PENDING_BODY)]);
    const result = await api.drain();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/drain`);
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.count).toBe(1);
  });

  test("POST /ack sends the exact identities and reads the settlement counts", async () => {
    const { api, calls } = client([
      json(200, {
        ...PENDING_BODY,
        count: 0,
        pending: [],
        status: "acknowledged",
        acknowledged: 1,
        alreadySettled: 2,
        tombstoned: 3,
      }),
    ]);
    const result = await api.acknowledge({
      source: "fireflies",
      items: [{ meetingId: "MEET1", kind: "transcript", status: "done" }],
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/ack`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      source: "fireflies",
      items: [{ meetingId: "MEET1", kind: "transcript", status: "done" }],
    });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.acknowledged).toBe(1);
    expect(result.value.alreadySettled).toBe(2);
    expect(result.value.tombstoned).toBe(3);
    // The ack response IS a queue snapshot — the card renders it without a second GET.
    expect(result.value.count).toBe(0);
  });

  test("POST /purged — 204 is the ordinary recorded case, value null", async () => {
    const { api, calls } = client([new Response(null, { status: 204 })]);
    const result = await api.recordPurge({ source: "fireflies", ids: ["MEET1"] });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/purged`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      source: "fireflies",
      ids: ["MEET1"],
    });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value).toBeNull();
  });

  test("POST /purged — a 200 reports the recentIds overflow, never silence", async () => {
    const { api } = client([json(200, { status: "accepted", stored: 200, dropped: 12 })]);
    const result = await api.recordPurge({
      source: "fireflies",
      ids: ["MEET1"],
      purgedThrough: "2026-08-05T10:00:00.000Z",
    });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value).toEqual({ status: "accepted", stored: 200, dropped: 12 });
  });

  test("DELETE /purged sends the required {source} body", async () => {
    // createApiClient's `del()` sends no body; this route 400s without one.
    const { api, calls } = client([new Response(null, { status: 204 })]);
    const result = await api.clearPurgeLedger("fireflies");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BACKEND}${CONNECTOR_WEBHOOKS_BASE_PATH}/purged`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ source: "fireflies" });
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(result.status).toBe("ok");
  });
});

// ── Status classes ───────────────────────────────────────────────────

describe("status classes are distinguished, never collapsed", () => {
  test("404 is FEATURE DARK — a defined state, not an error, and not a signed-out session", async () => {
    const { api, session } = client([json(404, { error: "Not Found" })]);
    const result = await api.getConfig();
    expect(result.status).toBe("feature-dark");
    // The route being unmounted says nothing about the session.
    expect(session.clearCount()).toBe(0);
  });

  test("every route reports feature-dark on 404", async () => {
    for (const call of [
      (a: ReturnType<typeof client>["api"]) => a.getConfig(),
      (a: ReturnType<typeof client>["api"]) => a.enable(),
      (a: ReturnType<typeof client>["api"]) => a.disable(),
      (a: ReturnType<typeof client>["api"]) => a.getPending(),
      (a: ReturnType<typeof client>["api"]) => a.drain(),
      (a: ReturnType<typeof client>["api"]) =>
        a.acknowledge({ items: [{ meetingId: "MEET1", kind: "transcript" }] }),
      (a: ReturnType<typeof client>["api"]) =>
        a.recordPurge({ source: "fireflies", ids: [] }),
      (a: ReturnType<typeof client>["api"]) => a.clearPurgeLedger("fireflies"),
    ]) {
      const { api } = client([json(404, { error: "Not Found" })]);
      expect((await call(api)).status).toBe("feature-dark");
    }
  });

  test("401 is unauthenticated AND clears the session, exactly as createApiClient does", async () => {
    const { api, session } = client([json(401, { error: "unauthenticated" })]);
    const result = await api.getPending();
    expect(result.status).toBe("unauthenticated");
    expect(session.clearCount()).toBe(1);
  });

  test("no token is unauthenticated without ever reaching the network", async () => {
    const { api, calls } = client([json(200, CONFIG_BODY)], { token: null });
    expect((await api.getConfig()).status).toBe("unauthenticated");
    expect(calls.length).toBe(0);
  });

  test("an expired session is unauthenticated, cleared, and never sent", async () => {
    const { api, calls, session } = client([json(200, CONFIG_BODY)], { expired: true });
    expect((await api.getConfig()).status).toBe("unauthenticated");
    expect(calls.length).toBe(0);
    expect(session.clearCount()).toBe(1);
  });

  test("503 is RETRYABLE and carries the backend's error code", async () => {
    const { api } = client([json(503, { error: "drain_unavailable" })]);
    const result = await api.drain();
    if (result.status !== "retryable") {
      throw new Error(`expected retryable, got ${result.status}`);
    }
    expect(result.httpStatus).toBe(503);
    expect(result.code).toBe("drain_unavailable");
  });

  test("a 503 teardown_incomplete is retryable — the SAME idempotent call", async () => {
    const { api } = client([json(503, { error: "teardown_incomplete" })]);
    const result = await api.disable();
    if (result.status !== "retryable") {
      throw new Error(`expected retryable, got ${result.status}`);
    }
    expect(result.code).toBe("teardown_incomplete");
  });

  test("429 is retryable too", async () => {
    const { api } = client([json(429, { error: "rate_limited" })]);
    const result = await api.getPending();
    expect(result.status).toBe("retryable");
  });

  test("400 is REJECTED — retrying the same body cannot fix it", async () => {
    const { api } = client([json(400, { error: "invalid_meeting_id" })]);
    const result = await api.acknowledge({
      items: [{ meetingId: "MEET1", kind: "transcript" }],
    });
    if (result.status !== "rejected") {
      throw new Error(`expected rejected, got ${result.status}`);
    }
    expect(result.httpStatus).toBe(400);
    expect(result.code).toBe("invalid_meeting_id");
  });

  test("a non-JSON error body still classifies by status", async () => {
    const { api } = client([new Response("<html>502</html>", { status: 502 })]);
    const result = await api.getPending();
    if (result.status !== "retryable") {
      throw new Error(`expected retryable, got ${result.status}`);
    }
    expect(result.code).toBeNull();
  });

  test("a transport failure is offline, never a thrown error", async () => {
    const { api } = client([
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]);
    expect((await api.getPending()).status).toBe("offline");
  });

  test("an unreadable 200 body is a failure, never a silently-empty snapshot", async () => {
    const { api } = client([
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const result = await api.getPending();
    expect(result.status).not.toBe("ok");
  });
});

// ── Fail-closed surfacing ────────────────────────────────────────────

describe("surfaceBlocked is a card state, never an empty queue", () => {
  const blocked = (reason: string) => ({
    ...PENDING_BODY,
    count: 0,
    pending: [],
    deadCount: 0,
    dead: [],
    surfaceBlocked: reason,
  });

  for (const reason of [
    "revoked",
    "ledger_unavailable",
    "delegation_unusable",
    "drain_aborted",
    "drain_unreported",
  ]) {
    test(`${reason} surfaces as blocked`, async () => {
      const { api } = client([json(200, blocked(reason))]);
      const result = await api.drain();
      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.value.surfaceBlocked).toBe(reason as never);
      const read = readSurfaceBlocked(result.value);
      expect(read.blocked).toBe(true);
      if (!read.blocked) throw new Error("unreachable");
      expect(read.reason).toBe(reason as never);
    });
  }

  test("an UNKNOWN reason still reads as blocked — fail closed, not fall through", async () => {
    const { api } = client([json(200, blocked("some_future_reason"))]);
    const result = await api.drain();
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const read = readSurfaceBlocked(result.value);
    expect(read.blocked).toBe(true);
    if (!read.blocked) throw new Error("unreachable");
    expect(read.reason).toBe("unknown");
  });

  test("an ordinary empty queue is NOT blocked", async () => {
    const { api } = client([json(200, { ...PENDING_BODY, count: 0, pending: [] })]);
    const result = await api.getPending();
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.surfaceBlocked).toBeUndefined();
    expect(readSurfaceBlocked(result.value).blocked).toBe(false);
  });

  test("a tripped delivery bucket is its own state, distinct from an empty queue", async () => {
    const { api } = client([
      json(200, { ...PENDING_BODY, count: 0, pending: [], deliveriesRateLimited: true }),
    ]);
    const result = await api.getPending();
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.deliveriesRateLimited).toBe(true);
    expect(readSurfaceBlocked(result.value).blocked).toBe(false);
  });

  test("an ack that settled nothing still reports why", async () => {
    const { api } = client([
      json(200, {
        ...blocked("ledger_unavailable"),
        status: "acknowledged",
        acknowledged: 0,
        alreadySettled: 0,
        tombstoned: 0,
      }),
    ]);
    const result = await api.acknowledge({
      items: [{ meetingId: "MEET1", kind: "transcript" }],
    });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.acknowledged).toBe(0);
    expect(readSurfaceBlocked(result.value).blocked).toBe(true);
  });
});

// ── The one-time secret ──────────────────────────────────────────────

describe("the delivery secret is one-time and never persisted", () => {
  test("mint/rotate is the ONLY response that carries a secret", async () => {
    const { api } = client([
      json(200, { status: "enabled", rotated: true, ...CONFIG_BODY, secret: SECRET }),
    ]);
    const result = await api.enable({ rotate: true });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.secret).toBe(SECRET);
    expect(result.value.rotated).toBe(true);
    expect(result.value.url).toBe(URL_VALUE);
    expect(result.value.hasSecret).toBe(true);
  });

  test("GET /config never returns a secret — hasSecret is what the card reads", async () => {
    const { api } = client([json(200, CONFIG_BODY)]);
    const result = await api.getConfig();
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.secret).toBeNull();
    expect(result.value.hasSecret).toBe(true);
  });

  test("a secret leaking into a poll body is DROPPED by the client", async () => {
    const { api } = client([json(200, { ...CONFIG_BODY, secret: SECRET })]);
    const result = await api.getConfig();
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.value.secret).toBeNull();
  });

  test("a no-op POST /config carries no secret, and the client caches none from the mint", async () => {
    const { api } = client([
      json(200, { status: "enabled", rotated: true, ...CONFIG_BODY, secret: SECRET }),
      json(200, { status: "enabled", rotated: false, ...CONFIG_BODY }),
    ]);
    const minted = await api.enable({ rotate: true });
    if (minted.status !== "ok") throw new Error("expected ok");
    expect(minted.value.secret).toBe(SECRET);

    const polled = await api.enable();
    if (polled.status !== "ok") throw new Error("expected ok");
    // No module- or client-level memo: the value the caller does not hold is gone.
    expect(polled.value.secret).toBeNull();
    expect(polled.value.rotated).toBe(false);
  });

  test("neither the URL nor the secret is written to storage or the console", async () => {
    const stored: string[] = [];
    const logged: string[] = [];
    const originalStorage = g.localStorage;
    const originalSession = g.sessionStorage;
    const store = {
      setItem: (k: string, v: string) => {
        stored.push(`${k}=${v}`);
      },
      getItem: () => null,
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    g.localStorage = store;
    g.sessionStorage = store;
    const console_ = console as unknown as Record<string, (...args: unknown[]) => void>;
    const originals = { log: console_.log, warn: console_.warn, error: console_.error, info: console_.info, debug: console_.debug };
    for (const level of ["log", "warn", "error", "info", "debug"] as const) {
      console_[level] = (...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(" "));
      };
    }
    try {
      const { api } = client([
        json(200, { status: "enabled", rotated: true, ...CONFIG_BODY, secret: SECRET }),
        json(503, { error: "unavailable" }),
      ]);
      const minted = await api.enable({ rotate: true });
      if (minted.status !== "ok") throw new Error("expected ok");
      // The error path must not narrate the connector's identifiers either.
      await api.getPending();
      expect(stored).toEqual([]);
      expect(logged.join("\n")).not.toContain(SECRET);
      expect(logged.join("\n")).not.toContain(URL_VALUE);
      expect(logged.join("\n")).not.toContain("tok_abc");
    } finally {
      for (const level of ["log", "warn", "error", "info", "debug"] as const) {
        console_[level] = originals[level];
      }
      if (originalStorage === undefined) delete g.localStorage;
      else g.localStorage = originalStorage;
      if (originalSession === undefined) delete g.sessionStorage;
      else g.sessionStorage = originalSession;
    }
  });
});

// ── Bearer / CSRF parity with createApiClient ────────────────────────

describe("bearer + CSRF construction matches createApiClient exactly", () => {
  /** Capture what `createApiClient` puts on the wire for the same session. */
  async function referenceHeaders(method: "GET" | "POST" | "DELETE") {
    const session = stubSession();
    let captured: Call | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      captured = {
        url: typeof input === "string" ? input : String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : null,
      };
      return json(200, {});
    }) as unknown as typeof fetch;
    try {
      const reference = createApiClient(BACKEND, { sessionStore: session.store });
      if (method === "GET") await reference.get("/api/x");
      else if (method === "POST") await reference.post("/api/x", { a: 1 });
      else await reference.del("/api/x");
    } finally {
      globalThis.fetch = originalFetch;
    }
    if (captured === null) throw new Error("reference client made no request");
    return captured as Call;
  }

  test("GET headers are identical", async () => {
    const reference = await referenceHeaders("GET");
    const { api, calls } = client([json(200, CONFIG_BODY)]);
    await api.getConfig();
    expect(calls[0]?.headers).toEqual(reference.headers);
  });

  test("POST headers (incl. Content-Type) are identical", async () => {
    const reference = await referenceHeaders("POST");
    const { api, calls } = client([json(200, PENDING_BODY)]);
    await api.drain();
    expect(calls[0]?.headers).toEqual(reference.headers);
  });

  test("DELETE carries the same bearer + CSRF headers", async () => {
    const reference = await referenceHeaders("DELETE");
    const { api, calls } = client([json(200, { status: "disabled", queueDropped: 0 })]);
    await api.disable();
    for (const [key, value] of Object.entries(reference.headers)) {
      expect(calls[0]?.headers[key]).toBe(value);
    }
  });

  test("the CSRF header is present on every companion call", async () => {
    const { api, calls } = client([json(200, PENDING_BODY)]);
    await api.getPending();
    expect(calls[0]?.headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(calls[0]?.headers.authorization).toBe("Bearer session-token");
  });
});
