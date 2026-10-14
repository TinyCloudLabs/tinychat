import { describe, expect, test } from "bun:test";

import {
  defaultFirefliesClientOptions,
  FIREFLIES_API_URL,
  FIREFLIES_DEFAULT_DELAY_MS,
  FIREFLIES_MAX_RATE_LIMIT_RETRIES,
  FirefliesClient,
  GET_TRANSCRIPT_QUERY,
  GET_USER_QUERY,
  resolveFirefliesClientDefaults,
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

describe("FirefliesClient.listNewTranscriptIds — bounded reconciliation", () => {
  test("paginates newest-first until the true end of history", async () => {
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
    if (result.ok) {
      expect(result.data.ids).toEqual(["a", "b", "c", "d", "e"]);
      expect(result.data.complete).toBe(true);
    }
    expect(calls.map((call) => call.body.variables)).toEqual([
      { limit: 3, skip: 0 },
      { limit: 3, skip: 3 },
    ]);
  });

  test("an empty provider page proves the end of history", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () => jsonResponse({ data: { transcripts: [transcriptSummary("a"), transcriptSummary("b")] } }),
        () => jsonResponse({ data: { transcripts: [] } }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({ knownIds: [], batchSize: 2 });
    expect(result.ok && result.data).toEqual({
      ids: ["a", "b"], complete: true, nextSkip: 2, nextAnchor: "b",
      nextAnchorDate: 1700000000000, nextPreviousNeighbor: "a",
    });
    expect(calls).toHaveLength(2);
  });

  test("known IDs are skipped rather than treated as a listing boundary", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [
        () => jsonResponse({ data: { transcripts: [
          transcriptSummary("new-1"), transcriptSummary("known"), transcriptSummary("new-2"),
        ] } }),
        () => jsonResponse({ data: { transcripts: [] } }),
      ],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({
      knownIds: ["known"],
      batchSize: 3,
      detailCap: 10,
      pageBudget: 2,
    });
    expect(result.ok && result.data).toEqual({
      ids: ["new-1", "new-2"], complete: true, nextSkip: 3, nextAnchor: "new-2",
      nextAnchorDate: 1700000000000, nextPreviousNeighbor: "known",
    });
    expect(calls).toHaveLength(2);
  });

  test("batch size is capped at 50", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [() => jsonResponse({ data: { transcripts: [] } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    await client.listNewTranscriptIds({ knownIds: [], batchSize: 500 });
    expect(calls[0].body.variables).toEqual({ limit: 50, skip: 0 });
  });

  test("detail cap bounds a listing and marks it incomplete", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [() => jsonResponse({ data: { transcripts: [
        transcriptSummary("a"), transcriptSummary("b"), transcriptSummary("c"),
      ] } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({
      knownIds: [], batchSize: 25, detailCap: 2,
    });
    expect(result.ok && result.data).toEqual({
      ids: ["a", "b"], complete: false, nextSkip: 2, nextAnchor: "b",
      nextAnchorDate: 1700000000000, nextPreviousNeighbor: "a",
    });
    expect(calls[0].body.variables).toEqual({ limit: 2, skip: 0 });
  });

  test("page budget applies without a SQL watermark", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [() => jsonResponse({ data: { transcripts: [
        transcriptSummary("known-0"), transcriptSummary("known-1"),
      ] } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({
      knownIds: ["known-0", "known-1"], batchSize: 2, pageBudget: 1,
    });
    expect(result.ok && result.data).toEqual({
      ids: [], complete: false, nextSkip: 2, nextAnchor: "known-1",
      nextAnchorDate: 1700000000000, nextPreviousNeighbor: "known-0",
    });
    expect(calls).toHaveLength(1);
  });

  test("date boundary completes reconciliation after inclusive-boundary meetings", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => jsonResponse({ data: { transcripts: [
        transcriptSummary("inside", { date: "2026-10-08T00:00:00.000Z" }),
        transcriptSummary("boundary", { date: "2026-10-07T00:00:00.000Z" }),
        transcriptSummary("older", { date: "2026-10-06T00:00:00.000Z" }),
      ] } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({
      knownIds: [],
      stopBeforeDate: "2026-10-07T00:00:00.000Z",
    });
    expect(result.ok && result.data).toEqual({
      ids: ["inside", "boundary"], complete: true, nextSkip: 2, nextAnchor: "boundary",
      nextAnchorDate: "2026-10-07T00:00:00.000Z", nextPreviousNeighbor: "inside",
    });
  });

  test("onProgress reports each consumed page", async () => {
    const { fetchImpl } = mockFetch({
      responses: [
        () => jsonResponse({ data: { transcripts: [transcriptSummary("a"), transcriptSummary("b")] } }),
        () => jsonResponse({ data: { transcripts: [transcriptSummary("c")] } }),
      ],
    });
    const events: Array<{ phase: string; done: number; total: number | null }> = [];
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    await client.listNewTranscriptIds({
      knownIds: [], batchSize: 2, onProgress: (progress) => events.push(progress),
    });
    expect(events).toEqual([
      { phase: "listing", done: 2, total: null },
      { phase: "listing", done: 3, total: null },
    ]);
  });

  test("a reduced full page of known IDs advances by consumed rows before later unseen IDs", async () => {
    const summaries = [
      ...Array.from({ length: 25 }, (_, index) => transcriptSummary(`new-${index}`)),
      transcriptSummary("known"),
      transcriptSummary("late-hole"),
    ];
    const { fetchImpl, calls } = mockFetch({
      responses: [async (call) => {
        const { limit = 25, skip = 0 } = call.body.variables as { limit?: number; skip?: number };
        return jsonResponse({ data: { transcripts: summaries.slice(skip, skip + limit) } });
      }],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({
      knownIds: ["known"], batchSize: 25, detailCap: 26, pageBudget: 5,
    });
    expect(result.ok && result.data.ids).toContain("late-hole");
    expect(calls.map((call) => call.body.variables)).toEqual([
      { limit: 25, skip: 0 },
      { limit: 1, skip: 25 },
      { limit: 1, skip: 26 },
    ]);
  });
  test("returns a resumable listing offset after a page-budget boundary", async () => {
    const summaries = Array.from({ length: 30 }, (_, index) => transcriptSummary(`tx-${index}`));
    const { fetchImpl, calls } = mockFetch({
      responses: [async (call) => {
        const { limit = 25, skip = 0 } = call.body.variables as { limit?: number; skip?: number };
        return jsonResponse({ data: { transcripts: summaries.slice(skip, skip + limit) } });
      }],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const first = await client.listNewTranscriptIds({
      knownIds: [], batchSize: 10, detailCap: 50, pageBudget: 1,
    });
    expect(first.ok && first.data.nextSkip).toBe(10);
    expect(first.ok && first.data.nextAnchor).toBe("tx-9");
    expect(first.ok && first.data.nextAnchorDate).toBe(1700000000000);
    if (!first.ok) throw new Error("unreachable");

    const storedIds = summaries.slice(0, 10).map((item) => item.id);
    const second = await client.listNewTranscriptIds({
      knownIds: storedIds, batchSize: 11, detailCap: 50, pageBudget: 5,
      startSkip: first.data.nextSkip,
      startAnchor: first.data.nextAnchor,
      startAnchorDate: first.data.nextAnchorDate,
      startPreviousNeighbor: first.data.nextPreviousNeighbor,
    });
    expect(second.ok && second.data.ids).toEqual(summaries.slice(10).map((item) => item.id));
    expect(second.ok && second.data.nextSkip).toBe(30);
    expect(second.ok && second.data.nextAnchor).toBe("tx-29");
    expect(second.ok && second.data.complete).toBe(true);
    expect(calls.map((call) => call.body.variables)).toEqual([
      { limit: 10, skip: 0 },
      { limit: 11, skip: 0 },
      { limit: 11, skip: 0 },
      { limit: 10, skip: 11 },
      { limit: 11, skip: 10 },
      { limit: 11, skip: 21 },
    ]);
  });
  test("a null listed date remains valid cursor evidence", async () => {
    const summaries = ["a", "b", "c"].map((id) => transcriptSummary(id, { date: null }));
    const { fetchImpl } = mockFetch({
      responses: [async (call) => {
        const { limit = 25, skip = 0 } = call.body.variables as { limit?: number; skip?: number };
        return jsonResponse({ data: { transcripts: summaries.slice(skip, skip + limit) } });
      }],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const first = await client.listNewTranscriptIds({
      knownIds: [], batchSize: 1, detailCap: 1, pageBudget: 1,
    });
    if (!first.ok) throw new Error("unreachable");
    expect(first.data.nextAnchorDate).toBeNull();
    expect(first.data.nextPreviousNeighbor).toBeNull();

    const resumed = await client.listNewTranscriptIds({
      knownIds: ["a"],
      batchSize: 1,
      detailCap: 10,
      pageBudget: 10,
      startSkip: first.data.nextSkip,
      startAnchor: first.data.nextAnchor,
      startAnchorDate: first.data.nextAnchorDate,
      startPreviousNeighbor: first.data.nextPreviousNeighbor,
    });
    expect(resumed.ok && resumed.data.complete).toBe(true);
    expect(resumed.ok && resumed.data.nextSkip).toBe(3);
    expect(resumed.ok && resumed.data.ids).toEqual(["b", "c"]);
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
  test("aborting during retry-after sleep stops before another provider request", async () => {
    const firstRequest = Promise.withResolvers<void>();
    const { fetchImpl, calls } = mockFetch({
      responses: [() => {
        firstRequest.resolve();
        return new Response("rate limit", { status: 429, headers: { "retry-after": "2" } });
      }],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 1 });
    const controller = new AbortController();
    const listing = client.listNewTranscriptIds({ knownIds: [], signal: controller.signal });
    await firstRequest.promise;
    controller.abort();

    const result = await Promise.race([
      listing,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(result).not.toBe("pending");
    expect(calls).toHaveLength(1);
    await listing;
  });

  test("Retry-After above one minute ends the run without retrying", async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [() => new Response("rate limit", { status: 429, headers: { "retry-after": "61" } })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.listNewTranscriptIds({ knownIds: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate-limited");
      expect(result.error.retryAfterMs).toBe(61_000);
    }
    expect(calls).toHaveLength(1);
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

  test("GraphQL rate-limit by message text retries when Retry-After is within one minute", async () => {
    let attempts = 0;
    const retryAfter = new Date(Date.now() + 1_000).toISOString();
    const { fetchImpl } = mockFetch({
      responses: [
        () => {
          attempts++;
          return jsonResponse({
            errors: [{ message: `You have hit the rate limit. Retry after ${retryAfter}` }],
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
    expect(calls.length).toBe(1);
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
  test("structured GraphQL object_not_found errors carry deletion evidence", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => jsonResponse({
        errors: [{
          message: "Transcript not found",
          extensions: { code: "object_not_found" },
        }],
      })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.getTranscript("deleted");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("graphql-error");
      expect(result.error.notFound).toBe(true);
    }
  });

  test("message text alone does not carry deletion evidence", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => jsonResponse({ errors: [{ message: "Transcript not found" }] })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.getTranscript("unknown");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.notFound).toBeUndefined();
  });
  test("structured GraphQL 404 status also carries deletion evidence", async () => {
    const { fetchImpl } = mockFetch({
      responses: [() => jsonResponse({
        errors: [{ message: "Unknown", extensions: { status: 404 } }],
      })],
    });
    const client = new FirefliesClient({ apiKey: "k", fetchImpl, delayMs: 0 });
    const result = await client.getTranscript("deleted");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.notFound).toBe(true);
  });
});

describe("resolveFirefliesClientDefaults", () => {
  test("unset env → production endpoint and pacing", () => {
    expect(resolveFirefliesClientDefaults({})).toEqual({
      apiUrl: FIREFLIES_API_URL,
      delayMs: FIREFLIES_DEFAULT_DELAY_MS,
    });
  });

  test("set env → mock endpoint and collapsed pacing", () => {
    expect(
      resolveFirefliesClientDefaults({
        VITE_FIREFLIES_API_URL: "http://127.0.0.1:4801/graphql",
        VITE_FIREFLIES_DELAY_MS: "0",
      }),
    ).toEqual({ apiUrl: "http://127.0.0.1:4801/graphql", delayMs: 0 });
  });

  test("blank or unparseable values fall back rather than retargeting", () => {
    expect(
      resolveFirefliesClientDefaults({
        VITE_FIREFLIES_API_URL: "   ",
        VITE_FIREFLIES_DELAY_MS: "soon",
      }),
    ).toEqual({ apiUrl: FIREFLIES_API_URL, delayMs: FIREFLIES_DEFAULT_DELAY_MS });
    // A negative delay would make the client's sleeps meaningless; reject it.
    expect(
      resolveFirefliesClientDefaults({ VITE_FIREFLIES_DELAY_MS: "-5" }).delayMs,
    ).toBe(FIREFLIES_DEFAULT_DELAY_MS);
  });

  test("the resolved pair actually drives the constructed client", () => {
    const defaults = resolveFirefliesClientDefaults({
      VITE_FIREFLIES_API_URL: "http://127.0.0.1:4801/graphql",
      VITE_FIREFLIES_DELAY_MS: "0",
    });
    const client = new FirefliesClient({ apiKey: "k", ...defaults });
    expect(client.delayMs).toBe(0);
  });
});

describe("defaultFirefliesClientOptions", () => {
  test("returns the production defaults with no Vite env injected", () => {
    expect(defaultFirefliesClientOptions()).toEqual({
      apiUrl: FIREFLIES_API_URL,
      delayMs: FIREFLIES_DEFAULT_DELAY_MS,
    });
  });
});
