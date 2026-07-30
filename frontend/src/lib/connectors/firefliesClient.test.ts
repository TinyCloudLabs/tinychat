import { describe, expect, test } from "bun:test";

import {
  FIREFLIES_API_URL,
  FIREFLIES_MAX_RATE_LIMIT_RETRIES,
  FirefliesClient,
  GET_TRANSCRIPT_QUERY,
  GET_USER_QUERY,
  LIST_TRANSCRIPTS_QUERY,
} from "./firefliesClient";

type FetchCall = {
  url: string;
  body: { query: string; variables?: Record<string, unknown> };
  headers: Record<string, string>;
};

interface MockOptions {
  responses: Array<(call: FetchCall) => Response | Promise<Response>>;
}

/** Build a mock fetch that dispatches to `responses` in order. */
function mockFetch(opts: MockOptions): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = rawBody ? JSON.parse(rawBody) : { query: "" };
    const call: FetchCall = { url, body, headers };
    calls.push(call);
    const responder = opts.responses[Math.min(i, opts.responses.length - 1)];
    i++;
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

function transcriptSummary(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Meeting ${id}`,
    date: 1700000000000,
    duration: 30,
    organizer_email: "user@example.com",
    ...extra,
  };
}

describe("FirefliesClient — constructor + endpoint defaults", () => {
  test("uses default API URL and bearer auth when not overridden", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [() => jsonResponse({ data: { user: { name: "x", email: "y" } } })],
    });
    const client = new FirefliesClient({ apiKey: "sekret", fetchImpl, delayMs: 0 });
    await client.validateKey();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(FIREFLIES_API_URL);
    expect(calls[0].headers["authorization"]).toBe("Bearer sekret");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].body.query).toBe(GET_USER_QUERY);
  });

  test("apiUrl override is honored", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [() => jsonResponse({ data: { user: { name: "n", email: "e" } } })],
    });
    const client = new FirefliesClient({
      apiKey: "k",
      apiUrl: "http://mock.local/graphql",
      fetchImpl,
      delayMs: 0,
    });
    await client.validateKey();
    expect(calls[0].url).toBe("http://mock.local/graphql");
  });
});

describe("FirefliesClient.validateKey", () => {
  test("happy path returns user", async () => {
    const { fetchImpl } = mockFetch({
      responses: [
        () => jsonResponse({ data: { user: { name: "Ada", email: "ada@example.com" } } }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("Ada");
      expect(result.data.email).toBe("ada@example.com");
    }
  });

  test("401 → invalid-key", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => new Response("nope", { status: 401 })],
    });
    const client = new FirefliesClient({ apiKey: "bad", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-key");
  });

  test("403 → invalid-key", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => new Response("no", { status: 403 })],
    });
    const client = new FirefliesClient({ apiKey: "bad", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-key");
  });

  test("GraphQL auth error → invalid-key", async () => {
    const { fetchImpl } = mockFetch({
      responses: [
        () =>
          jsonResponse({
            errors: [{ message: "Unauthorized: invalid API key", extensions: { code: "UNAUTHENTICATED" } }],
          }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "bad", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-key");
  });

  test("fetch throws → network-error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network-error");
      expect(result.error.message).toContain("ECONNREFUSED");
    }
  });

  test("data.user null → invalid-key", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => jsonResponse({ data: { user: null } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-key");
  });
});

describe("FirefliesClient.listNewTranscriptIds — pagination + early-exit", () => {
  test("paginates until page smaller than batch, returning ids newest-first", async () => {
    const page1 = [transcriptSummary("a"), transcriptSummary("b"), transcriptSummary("c")];
    const page2 = [transcriptSummary("d"), transcriptSummary("e")];
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () => jsonResponse({ data: { transcripts: page1 } }),
        () => jsonResponse({ data: { transcripts: page2 } }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({ knownIds: [], batchSize: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(["a", "b", "c", "d", "e"]);

    // Two paginated calls, both with the ListTranscripts query.
    expect(calls.length).toBe(2);
    expect(calls[0].body.query).toBe(LIST_TRANSCRIPTS_QUERY);
    expect(calls[0].body.variables).toEqual({ limit: 3, skip: 0 });
    expect(calls[1].body.variables).toEqual({ limit: 3, skip: 3 });
  });

  test("stops on empty page", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () => jsonResponse({ data: { transcripts: [transcriptSummary("a"), transcriptSummary("b")] } }),
        () => jsonResponse({ data: { transcripts: [] } }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({ knownIds: [], batchSize: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(["a", "b"]);
    expect(calls.length).toBe(2);
  });

  test("early-exit: collects new ids from the page, then stops", async () => {
    // Page: [x, y, KNOWN, z] — x and y are new, KNOWN triggers stop; z is NOT collected.
    const page = [
      transcriptSummary("x"),
      transcriptSummary("y"),
      transcriptSummary("KNOWN"),
      transcriptSummary("z"),
    ];
    const { fetchImpl, calls } = mockFetch({
      responses: [() => jsonResponse({ data: { transcripts: page } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({
      knownIds: new Set(["KNOWN"]),
      batchSize: 25,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(["x", "y"]);
    expect(calls.length).toBe(1);
  });

  test("early-exit across pages: second page contains a known id", async () => {
    const page1 = [transcriptSummary("a"), transcriptSummary("b")];
    const page2 = [transcriptSummary("c"), transcriptSummary("KNOWN")];
    const shouldNotHit = () => {
      throw new Error("must not fetch a 3rd page after early-exit");
    };
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () => jsonResponse({ data: { transcripts: page1 } }),
        () => jsonResponse({ data: { transcripts: page2 } }),
        shouldNotHit,
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({
      knownIds: ["KNOWN"],
      batchSize: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(["a", "b", "c"]);
    expect(calls.length).toBe(2);
  });

  test("batchSize is capped at 50", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [() => jsonResponse({ data: { transcripts: [] } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    await client.listNewTranscriptIds({ knownIds: [], batchSize: 500 });
    expect(calls[0].body.variables).toEqual({ limit: 50, skip: 0 });
  });

  test("onProgress fires after each page with phase=listing", async () => {
    const page1 = [transcriptSummary("a"), transcriptSummary("b")];
    const page2 = [transcriptSummary("c")];
    const { fetchImpl } = mockFetch({
      responses: [
        () => jsonResponse({ data: { transcripts: page1 } }),
        () => jsonResponse({ data: { transcripts: page2 } }),
      ],
    });
    const events: Array<{ phase: string; done: number; total: number | null }> = [];
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    await client.listNewTranscriptIds({
      knownIds: [],
      batchSize: 2,
      onProgress: (p) => events.push(p),
    });
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ phase: "listing", done: 2, total: null });
    expect(events[1]).toEqual({ phase: "listing", done: 3, total: null });
  });
});

describe("FirefliesClient — HTTP 429 rate limit recovery", () => {
  test("retries once after 429 with retry-after header, then succeeds", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () => {
          attempts++;
          return new Response("rate limit", {
            status: 429,
            headers: { "retry-after": "1" },
          });
        },
        () => {
          attempts++;
          return jsonResponse({ data: { user: { name: "Ada", email: "ada@x.com" } } });
        },
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  test("HTTP 429 exhaustion → rate-limited error with retryAfterMs", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () =>
          new Response("nope", {
            status: 429,
            headers: { "retry-after": "5" },
          }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate-limited");
      expect(result.error.retryAfterMs).toBe(5_000);
    }
    // 1 initial attempt + FIREFLIES_MAX_RATE_LIMIT_RETRIES retries.
    expect(calls.length).toBe(1 + FIREFLIES_MAX_RATE_LIMIT_RETRIES);
  });

  test("429 without retry-after falls back to 60s", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => new Response("nope", { status: 429 })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "rate-limited") {
      expect(result.error.retryAfterMs).toBe(60_000);
    }
  });
});

describe("FirefliesClient — GraphQL rate limit recovery", () => {
  test("GraphQL too_many_requests then success", async () => {
    let attempts = 0;
    const { fetchImpl } = mockFetch({
      responses: [
        () => {
          attempts++;
          return jsonResponse({
            errors: [
              {
                message: "Please try later",
                extensions: { code: "too_many_requests" },
              },
            ],
          });
        },
        () => {
          attempts++;
          return jsonResponse({
            data: { transcript: { id: "t1", title: "T1", date: 0, duration: 5, organizer_email: null, speakers: [], meeting_attendees: [], sentences: [], summary: null } },
          });
        },
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.getTranscript("t1");
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("GraphQL rate-limit by message text (no extensions.code)", async () => {
    let attempts = 0;
    const { fetchImpl } = mockFetch({
      responses: [
        () => {
          attempts++;
          return jsonResponse({
            errors: [{ message: "You have hit the rate limit. Retry after 2027-01-01T00:00:00Z" }],
          });
        },
        () => {
          attempts++;
          return jsonResponse({ data: { user: { name: "n", email: "e" } } });
        },
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("GraphQL rate-limit exhaustion → rate-limited error carrying retryAfterMs from message", async () => {
    // Use a fixed far-future date so parseRetryAfterFromMessage returns a positive delta.
    const future = "2099-01-01T00:00:00Z";
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () =>
          jsonResponse({
            errors: [
              {
                message: `Too many requests. Retry after ${future}`,
                extensions: { code: "too_many_requests" },
              },
            ],
          }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate-limited");
      expect(result.error.retryAfterMs).toBeGreaterThan(0);
    }
    expect(calls.length).toBe(1 + FIREFLIES_MAX_RATE_LIMIT_RETRIES);
  });

  test("GraphQL rate-limit with unparseable message falls back to 60s", async () => {
    const { fetchImpl } = mockFetch({
      responses: [
        () =>
          jsonResponse({
            errors: [{ message: "rate limit hit — try later", extensions: { code: "too_many_requests" } }],
          }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.validateKey();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "rate-limited") {
      expect(result.error.retryAfterMs).toBe(60_000);
    }
  });
});

describe("FirefliesClient.getTranscript", () => {
  test("issues GetTranscript query with id variable", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () =>
          jsonResponse({
            data: {
              transcript: {
                id: "abc",
                title: "hi",
                date: 0,
                duration: 10,
                organizer_email: null,
                speakers: [],
                meeting_attendees: [],
                sentences: [],
                summary: null,
              },
            },
          }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.getTranscript("abc");
    expect(result.ok).toBe(true);
    expect(calls[0].body.query).toBe(GET_TRANSCRIPT_QUERY);
    expect(calls[0].body.variables).toEqual({ id: "abc" });
  });

  test("null transcript → graphql-error", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => jsonResponse({ data: { transcript: null } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.getTranscript("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("graphql-error");
  });
});
