import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CredentialSecret } from "../services/credential-store.js";
import {
  FIREFLIES_GRAPHQL_URL,
  FIREFLIES_TRANSCRIPT_QUERY,
  FirefliesMeetingFetcher,
  parseRetryAfterMs,
} from "../services/fireflies-fetch.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";

/**
 * W3's upstream half (backend-ingest plan §8.1 W3; §8.2 delta items 4, 7, 8).
 *
 * The worker owns pacing, retries and fail-closed storage; THIS module owns exactly one thing:
 * turning `(meetingId, credential)` into content or into a SHORT, FIXED error code. Two rules it
 * exists to keep:
 *
 *  - **Refetch by id.** The request carries an id and nothing else — no stored URL, no
 *    provider-minted link, nothing that can expire between the webhook and the fetch.
 *  - **The provider's words never escape.** A Fireflies error message can quote the query, the
 *    meeting, or the token that failed. Callers get a code from a closed set; nothing else.
 */

const ORIGINAL_ENV = { ...process.env };
const SALT = Buffer.from("fetch-salt-fetch-salt-fetch-1234").toString("base64");

const SECRET: CredentialSecret = {
  kind: "oauth",
  accessToken: "ff-access-token-SECRETSECRETSECRET",
};
const API_KEY_SECRET: CredentialSecret = {
  kind: "api_key",
  apiKey: "ff-api-key-SECRETSECRETSECRET",
};

beforeEach(() => {
  _resetWebhookTokenState();
  process.env.LOG_HASH_SALT = SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
});

interface Recorded {
  url: string;
  init: RequestInit;
}

function fetcherWith(
  responder: (recorded: Recorded) => Promise<Response> | Response,
): { fetcher: FirefliesMeetingFetcher; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const recorded = { url, init };
    calls.push(recorded);
    return responder(recorded);
  }) as unknown as typeof fetch;
  return {
    fetcher: new FirefliesMeetingFetcher({ fetchImpl }),
    calls,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function request(meetingId = "mtg1", secret: CredentialSecret = SECRET) {
  return {
    source: "fireflies",
    meetingId,
    kind: "transcript" as const,
    secret,
    signal: new AbortController().signal,
  };
}

const TRANSCRIPT = {
  id: "mtg1",
  title: "Weekly sync",
  date: "2026-08-10T11:00:00.000Z",
  duration: 1800,
  sentences: [{ index: 0, speaker_name: "Ada", text: "hello", start_time: 0 }],
  summary: { overview: "we synced" },
};

describe("Fireflies fetcher — the request (delta 7)", () => {
  test("normalizes bounded content-free participant and organizer metadata", async () => {
    const { fetcher } = fetcherWith(() => json({ data: { transcript: {
      ...TRANSCRIPT,
      organizer_email: " Owner@Example.Test ",
      meeting_attendees: [
        { displayName: " Alice  Smith ", email: "ALICE@Example.Test" },
        { displayName: "alice smith", email: "alice@example.test" },
        { displayName: "", email: "not-an-email" },
      ],
    } } }));
    const result = await fetcher.fetchMeeting(request());
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      content: expect.objectContaining({
        organizerEmail: "owner@example.test",
        participantNames: ["Alice Smith"],
        participantEmails: ["alice@example.test"],
      }),
    }));
  });

  test("[delta-07] the request is BY ID: a GraphQL id variable, no URL from any stored record", async () => {
    const { fetcher, calls } = fetcherWith(() =>
      json({ data: { transcript: TRANSCRIPT } }),
    );

    const result = await fetcher.fetchMeeting(request("mtg1"));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(FIREFLIES_GRAPHQL_URL);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.query).toBe(FIREFLIES_TRANSCRIPT_QUERY);
    expect(body.variables).toEqual({ id: "mtg1" });
    // The whole request mentions exactly one meeting identifier and no link.
    expect(String(calls[0]!.init.body)).not.toContain("http");
  });

  test("[delta-07] the credential rides the Authorization header for both custody branches", async () => {
    const oauth = fetcherWith(() => json({ data: { transcript: TRANSCRIPT } }));
    await oauth.fetcher.fetchMeeting(request("mtg1", SECRET));
    const oauthHeaders = new Headers(oauth.calls[0]!.init.headers);
    expect(oauthHeaders.get("authorization")).toBe(
      `Bearer ${SECRET.accessToken}`,
    );

    const apiKey = fetcherWith(() => json({ data: { transcript: TRANSCRIPT } }));
    await apiKey.fetcher.fetchMeeting(request("mtg1", API_KEY_SECRET));
    const apiKeyHeaders = new Headers(apiKey.calls[0]!.init.headers);
    expect(apiKeyHeaders.get("authorization")).toBe(
      `Bearer ${API_KEY_SECRET.apiKey}`,
    );
  });

  test("[delta-07] the worker's abort signal is passed through, so the 30 s timeout can cancel", async () => {
    const { fetcher, calls } = fetcherWith(() =>
      json({ data: { transcript: TRANSCRIPT } }),
    );
    const controller = new AbortController();
    await fetcher.fetchMeeting({ ...request(), signal: controller.signal });
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  test("[delta-07] a successful fetch returns the provider id and the content, and no link survives", async () => {
    const { fetcher } = fetcherWith(() =>
      json({
        data: {
          transcript: {
            ...TRANSCRIPT,
            audio_url: "https://cdn.fireflies.ai/a.mp3?X-Amz-Signature=abc",
          },
        },
      }),
    );

    const result = await fetcher.fetchMeeting(request("mtg1"));

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");
    expect(result.content.sourceId).toBe("mtg1");
    expect(result.content.title).toBe("Weekly sync");
    expect(result.content.ts).toBe("2026-08-10T11:00:00.000Z");
    // The worker strips links too; the fetcher does not hand one over in the first place.
    expect(JSON.stringify(result.content)).not.toContain("X-Amz-Signature");
  });
});

describe("Fireflies fetcher — failure classification (delta 4, 8)", () => {
  test("[delta-08] a 429 is rate_limited and carries the Retry-After it was given", async () => {
    const { fetcher } = fetcherWith(() =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    );

    const result = await fetcher.fetchMeeting(request());

    expect(result).toEqual({
      ok: false,
      error: { code: "rate_limited", retryAfterMs: 120_000 },
    });
  });

  test("[delta-08] Retry-After parses seconds and HTTP-dates, and refuses anything else", () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    expect(parseRetryAfterMs("30", now)).toBe(30_000);
    expect(parseRetryAfterMs("0", now)).toBeUndefined();
    expect(parseRetryAfterMs("-5", now)).toBeUndefined();
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs("Mon, 10 Aug 2026 12:02:00 GMT", now)).toBe(
      120_000,
    );
    // A date in the past is not a wait.
    expect(parseRetryAfterMs("Mon, 10 Aug 2026 11:00:00 GMT", now)).toBeUndefined();
  });

  test("[delta-04] HTTP statuses map to a CLOSED set of short codes", async () => {
    const cases: Array<[number, string, boolean]> = [
      [401, "unauthorized", false],
      [403, "unauthorized", false],
      [404, "not_found", true],
      [500, "upstream_error", false],
      [503, "upstream_error", false],
      [418, "upstream_error", false],
    ];
    for (const [status, code, terminal] of cases) {
      const { fetcher } = fetcherWith(
        () => new Response("body text with ff-access-token", { status }),
      );
      const result = await fetcher.fetchMeeting(request());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe(code);
      expect(result.error.terminal ?? false).toBe(terminal);
      // The body never becomes the code.
      expect(JSON.stringify(result.error)).not.toContain("ff-access-token");
    }
  });

  test("[delta-04] a GraphQL error is classified by CLASS, never by quoting the message", async () => {
    const cases: Array<[string, string]> = [
      ["Transcript not found for id mtg1", "not_found"],
      ["Too many requests, slow down", "rate_limited"],
      ["Unauthorized: invalid api key ff-access-token-SECRET", "unauthorized"],
      ["Something exploded in the resolver", "upstream_error"],
    ];
    for (const [message, code] of cases) {
      const { fetcher } = fetcherWith(() => json({ errors: [{ message }] }));
      const result = await fetcher.fetchMeeting(request());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe(code);
      expect(JSON.stringify(result.error)).not.toContain("ff-access-token");
      expect(JSON.stringify(result.error)).not.toContain("resolver");
    }
  });

  test("[delta-04] a null transcript is not_found and terminal — an id the provider does not have", async () => {
    const { fetcher } = fetcherWith(() => json({ data: { transcript: null } }));
    const result = await fetcher.fetchMeeting(request());
    expect(result).toEqual({
      ok: false,
      error: { code: "not_found", terminal: true },
    });
  });

  test("[delta-04] an id mismatch is invalid_response — the worker turns that into quarantine", async () => {
    const { fetcher } = fetcherWith(() =>
      json({ data: { transcript: { ...TRANSCRIPT, id: "somebody-else" } } }),
    );
    const result = await fetcher.fetchMeeting(request("mtg1"));
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_response" },
    });
  });

  test("[delta-04] unparseable or non-JSON bodies are invalid_response, not a crash", async () => {
    const { fetcher } = fetcherWith(
      () => new Response("<html>maintenance</html>", { status: 200 }),
    );
    const result = await fetcher.fetchMeeting(request());
    expect(result).toEqual({ ok: false, error: { code: "invalid_response" } });
  });

  test("[delta-04] a transport failure is network_error and never surfaces the thrown message", async () => {
    const { fetcher } = fetcherWith(() => {
      throw new Error("ECONNRESET talking to https://api.fireflies.ai");
    });
    const result = await fetcher.fetchMeeting(request());
    expect(result).toEqual({ ok: false, error: { code: "network_error" } });
  });

  test("the credential never reaches a log line, on any path", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const record = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
      for (const responder of [
        () => new Response("nope", { status: 401 }),
        () => json({ errors: [{ message: "boom" }] }),
        () => json({ data: { transcript: TRANSCRIPT } }),
      ]) {
        const { fetcher } = fetcherWith(responder);
        await fetcher.fetchMeeting(request());
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
    for (const line of lines) {
      expect(line).not.toContain(SECRET.accessToken);
      expect(line).not.toContain("mtg1");
    }
  });
});
