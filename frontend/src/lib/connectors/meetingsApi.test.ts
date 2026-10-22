// RED-first contract for W5's cohort READ API client and the merge that makes
// the cohort meetings view (backend-ingest plan §8.1 W5).
//
// This is the browser half of "the meetings are always there, even if you never
// opened the app". The rules under test are the ones the plan states literally:
//
//   1. the read API is CANONICAL for the cohort meetings view — it works on ANY
//      signed-in device, with no vault and no Fireflies key, so nothing in this
//      module touches `tcw`, `secrets`, or a connector key;
//   2. the user-space copy (W6) serves Option-C parity/offline, and the two are
//      merged by `(source, sourceId)` so a RECONCILED meeting renders ONCE;
//   3. every call resolves — a non-`ok` result is a FAILURE the caller handles,
//      never a fallback that hides one (the repo's fail-closed convention);
//   4. a 404 on the LIST is the dark/non-cohort answer and hides the surface; a
//      404 on one meeting is that meeting being gone, not the feature.

import { describe, expect, test } from "bun:test";

// `@tinyboilerplate/client` evaluates the TinyCloud web-sdk at module load,
// which references DOM globals — stubbed before the dynamic import exactly as
// webhooksApi.test.ts and billingApi.test.ts do.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.HTMLElement === "undefined") g.HTMLElement = class {};
if (typeof g.customElements === "undefined") {
  g.customElements = { define() {}, get() {} };
}
if (typeof g.window === "undefined") g.window = g;

const {
  CONNECTOR_MEETINGS_BASE_PATH,
  createConnectorMeetingsClient,
} = await import("./meetingsApi");
const {
  applyListResult,
  initialMeetingsViewState,
  mergeMeetings,
} = await import("./meetingsView");

type ConnectorMeetingMeta = import("./meetingsApi").ConnectorMeetingMeta;
type ConnectorMeetingList = import("./meetingsApi").ConnectorMeetingList;

const BACKEND = "https://backend.example";
const SOURCE = "fireflies";

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function client(
  responses: Array<Response | (() => Response | Promise<Response>)>,
  sessionOptions: { token?: string | null; expired?: boolean } = {},
) {
  const session = stubSession(sessionOptions);
  const rec = recorder(responses);
  return {
    api: createConnectorMeetingsClient(BACKEND, {
      sessionStore: session.store,
      fetchImpl: rec.fetchImpl,
    }),
    calls: rec.calls,
    clearCount: session.clearCount,
  };
}

function meta(patch: Partial<ConnectorMeetingMeta> = {}): ConnectorMeetingMeta {
  return {
    sourceId: "mtg-1",
    title: "Q3 planning sync",
    ts: "2026-08-09T09:00:00.000Z",
    sizeBytes: 1024,
    storedAt: "2026-08-09T09:05:00.000Z",
    updatedAt: "2026-08-09T09:05:00.000Z",
    hasTranscript: true,
    hasSummary: false,
    ...patch,
  };
}

function listBody(patch: Partial<ConnectorMeetingList> = {}): ConnectorMeetingList {
  return {
    source: SOURCE,
    meetings: [meta()],
    nextCursor: null,
    hasMore: false,
    ...patch,
  };
}

// ── The client ───────────────────────────────────────────────────────

describe("createConnectorMeetingsClient", () => {
  test("lists from the authenticated read API with the bearer + CSRF headers", async () => {
    const h = client([json(200, listBody())]);
    const result = await h.api.list();

    expect(result.status).toBe("ok");
    expect(h.calls[0]!.url).toBe(`${BACKEND}${CONNECTOR_MEETINGS_BASE_PATH}`);
    expect(h.calls[0]!.method).toBe("GET");
    expect(h.calls[0]!.headers.authorization).toBe("Bearer session-token");
    expect(h.calls[0]!.headers["x-requested-with"]).toBe("XMLHttpRequest");
    // A GET carries no body — the route is strictly side-effect-free and takes
    // nothing from the caller but the session.
    expect(h.calls[0]!.body).toBe(null);
  });

  test("passes limit and cursor as query parameters and nothing else", async () => {
    const h = client([json(200, listBody())]);
    await h.api.list({ limit: 25, cursor: "mtg-9" });
    const url = new URL(h.calls[0]!.url);
    expect(url.pathname).toBe(CONNECTOR_MEETINGS_BASE_PATH);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("mtg-9");
    // No address, ever: the tenant is the session and a client that can name one
    // is the first step of the cross-tenant bug §8.2 delta 1 forbids.
    expect(url.searchParams.get("address")).toBe(null);
    expect(h.calls[0]!.url).not.toContain("address");
  });

  test("sends W6's discovery filter as the two literals the route accepts", async () => {
    // Plan §5.3: reconcile discovery IS a read-API list filter. The route 400s
    // anything but `true`/`false` (`invalid_reconciled`) rather than ignoring it,
    // so the client may never send `1`, `on` or an omitted-when-false.
    const unreconciled = client([json(200, listBody())]);
    await unreconciled.api.list({ reconciled: false });
    expect(new URL(unreconciled.calls[0]!.url).searchParams.get("reconciled")).toBe(
      "false",
    );

    const reconciled = client([json(200, listBody())]);
    await reconciled.api.list({ reconciled: true });
    expect(new URL(reconciled.calls[0]!.url).searchParams.get("reconciled")).toBe(
      "true",
    );

    // Omitted = both halves, which is what the meetings view asks for.
    const both = client([json(200, listBody())]);
    await both.api.list({});
    expect(new URL(both.calls[0]!.url).searchParams.has("reconciled")).toBe(false);
  });

  test("reads one meeting and posts the reconcile-ack on the documented paths", async () => {
    const h = client([
      json(200, { source: SOURCE, sourceId: "mtg-1", meta: meta(), content: { summary: { x: 1 } } }),
      json(200, { reconciled: true, source: SOURCE, sourceId: "mtg-1" }),
    ]);
    const read = await h.api.read(SOURCE, "mtg-1");
    expect(read.status).toBe("ok");
    expect(h.calls[0]!.url).toBe(
      `${BACKEND}${CONNECTOR_MEETINGS_BASE_PATH}/${SOURCE}/mtg-1`,
    );
    expect(h.calls[0]!.method).toBe("GET");

    const ack = await h.api.markReconciled(SOURCE, "mtg-1");
    expect(ack.status).toBe("ok");
    expect(h.calls[1]!.url).toBe(
      `${BACKEND}${CONNECTOR_MEETINGS_BASE_PATH}/${SOURCE}/mtg-1/reconciled`,
    );
    expect(h.calls[1]!.method).toBe("POST");
  });

  test("a 404 on the list is DARK — the whole surface hides, nothing is retried", async () => {
    const h = client([json(404, { error: "not_found" })]);
    expect(await h.api.list()).toEqual({ status: "feature-dark" });
  });

  test("a 404 on ONE meeting is that meeting, not the feature", async () => {
    const h = client([json(404, { error: "not_found" })]);
    // Reading this as `feature-dark` would hide a working archive because one
    // meeting aged out of the retention window between the list and the click.
    expect(await h.api.read(SOURCE, "mtg-gone")).toEqual({ status: "not-found" });
    const h2 = client([json(404, { error: "not_found" })]);
    expect(await h2.api.markReconciled(SOURCE, "mtg-gone")).toEqual({
      status: "not-found",
    });
  });

  test("401 clears the session; 429/5xx are retryable; 4xx are rejected", async () => {
    const unauth = client([json(401, { error: "unauthorized" })]);
    expect(await unauth.api.list()).toEqual({ status: "unauthenticated" });
    expect(unauth.clearCount()).toBe(1);

    for (const status of [429, 500, 503]) {
      const h = client([json(status, { error: "unavailable" })]);
      const result = await h.api.list();
      expect(result.status).toBe("retryable");
    }

    const bad = client([json(400, { error: "invalid_cursor" })]);
    expect(await bad.api.list({ cursor: "nope" })).toEqual({
      status: "rejected",
      httpStatus: 400,
      code: "invalid_cursor",
    });
  });

  test("a network failure and an unreadable 2xx both resolve as failures, never as an empty archive", async () => {
    const offline = client([
      () => {
        throw new Error("network down");
      },
    ]);
    expect(await offline.api.list()).toEqual({ status: "offline" });

    const garbled = client([
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    const result = await garbled.api.list();
    expect(result.status).toBe("rejected");
  });

  test("a signed-out or expired session never reaches the network", async () => {
    const out = client([json(200, listBody())], { token: null });
    expect(await out.api.list()).toEqual({ status: "unauthenticated" });
    expect(out.calls).toEqual([]);

    const expired = client([json(200, listBody())], { expired: true });
    expect(await expired.api.list()).toEqual({ status: "unauthenticated" });
    expect(expired.calls).toEqual([]);
    expect(expired.clearCount()).toBe(1);
  });
});

// ── The merge (cohort UI precedence) ─────────────────────────────────

describe("mergeMeetings — the read API is canonical, the user-space copy is parity", () => {
  test("a reconciled meeting renders ONCE", () => {
    const merged = mergeMeetings({
      source: SOURCE,
      server: [meta({ sourceId: "mtg-1", reconciledAt: "2026-08-09T10:00:00.000Z" })],
      local: [{ source: SOURCE, sourceId: "mtg-1", title: "Q3 planning sync" }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sourceId).toBe("mtg-1");
    expect(merged[0]!.origin).toBe("both");
    expect(merged[0]!.reconciled).toBe(true);
  });

  test("the server row wins on conflict — it is the canonical copy", () => {
    const merged = mergeMeetings({
      source: SOURCE,
      server: [meta({ sourceId: "mtg-1", title: "Renamed upstream" })],
      local: [{ source: SOURCE, sourceId: "mtg-1", title: "Stale local title" }],
    });
    expect(merged[0]!.title).toBe("Renamed upstream");
  });

  test("a local-only meeting still renders — Option-C parity and offline", () => {
    const merged = mergeMeetings({
      source: SOURCE,
      server: [],
      local: [
        { source: SOURCE, sourceId: "mtg-local", title: "From my own space", startedAt: "2026-08-01T09:00:00.000Z" },
      ],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.origin).toBe("local");
    expect(merged[0]!.reconciled).toBe(false);
  });

  test("identity is (source, sourceId) — the same id under another source is a different meeting", () => {
    const merged = mergeMeetings({
      source: SOURCE,
      server: [meta({ sourceId: "mtg-1" })],
      local: [{ source: "granola", sourceId: "mtg-1", title: "A different connector" }],
    });
    expect(merged).toHaveLength(2);
  });

  test("orders newest first across both origins", () => {
    const merged = mergeMeetings({
      source: SOURCE,
      server: [
        meta({ sourceId: "mtg-mid", ts: "2026-08-05T09:00:00.000Z" }),
        meta({ sourceId: "mtg-new", ts: "2026-08-09T09:00:00.000Z" }),
      ],
      local: [
        { source: SOURCE, sourceId: "mtg-old", startedAt: "2026-08-01T09:00:00.000Z" },
      ],
    });
    expect(merged.map((m) => m.sourceId)).toEqual(["mtg-new", "mtg-mid", "mtg-old"]);
  });

  test("no local list at all is the ordinary fresh-device case, not an error", () => {
    const merged = mergeMeetings({ source: SOURCE, server: [meta()] });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.origin).toBe("server");
  });
});

// ── The view state ───────────────────────────────────────────────────

describe("applyListResult — every failure is told, never rendered as 'no meetings'", () => {
  test("ok appends the page and carries the cursor", () => {
    const first = applyListResult(initialMeetingsViewState(), {
      status: "ok",
      value: listBody({
        meetings: [meta({ sourceId: "mtg-2", ts: "2026-08-09T09:00:00.000Z" })],
        nextCursor: "mtg-2",
        hasMore: true,
      }),
    });
    expect(first.status).toBe("ready");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("mtg-2");
    expect(first.meetings.map((m) => m.sourceId)).toEqual(["mtg-2"]);

    const second = applyListResult(first, {
      status: "ok",
      value: listBody({
        meetings: [meta({ sourceId: "mtg-1", ts: "2026-08-01T09:00:00.000Z" })],
        nextCursor: null,
        hasMore: false,
      }),
    });
    // Pages accumulate, deduped by identity — a re-fetched page cannot double a row.
    expect(second.meetings.map((m) => m.sourceId)).toEqual(["mtg-2", "mtg-1"]);
    expect(second.hasMore).toBe(false);
  });

  test("feature-dark hides the surface; every other failure is a stated state", () => {
    const dark = applyListResult(initialMeetingsViewState(), { status: "feature-dark" });
    expect(dark.status).toBe("dark");

    const out = applyListResult(initialMeetingsViewState(), { status: "unauthenticated" });
    expect(out.status).toBe("signed-out");

    const down = applyListResult(initialMeetingsViewState(), {
      status: "retryable",
      httpStatus: 503,
      code: "unavailable",
    });
    expect(down.status).toBe("unavailable");
    // Never "you have no meetings": an outage that renders as an empty archive is
    // the exact lie the backend's 503 exists to avoid.
    expect(down.meetings).toEqual([]);
    expect(down.status).not.toBe("ready");

    const offline = applyListResult(initialMeetingsViewState(), { status: "offline" });
    expect(offline.status).toBe("offline");

    const rejected = applyListResult(initialMeetingsViewState(), {
      status: "rejected",
      httpStatus: 400,
      code: "invalid_cursor",
    });
    expect(rejected.status).toBe("unavailable");
  });

  test("a failure never discards the page already on screen", () => {
    const ready = applyListResult(initialMeetingsViewState(), {
      status: "ok",
      value: listBody(),
    });
    const then = applyListResult(ready, { status: "offline" });
    expect(then.meetings.map((m) => m.sourceId)).toEqual(["mtg-1"]);
    expect(then.status).toBe("offline");
  });
});

// ── No vault, no key (the whole point of the read API) ───────────────

describe("the cohort read path holds no key material", () => {
  test("neither module imports the vault, the secrets helper or a Fireflies client", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["meetingsApi.ts", "meetingsView.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source).not.toContain("connectorSecrets");
      expect(source).not.toContain("firefliesClient");
      expect(source).not.toContain("tcw.secrets");
      expect(source).not.toContain("unlock");
      // Nothing is persisted or logged from the read path either.
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("console.");
    }
  });
});
