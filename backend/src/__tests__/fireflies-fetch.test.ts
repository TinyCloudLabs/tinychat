import { describe, expect, it } from "bun:test";
import { connectorMeetingId } from "@tinyboilerplate/core";
import {
  fetchFirefliesMeeting,
  FIREFLIES_GRAPHQL_URL,
  normalizeFirefliesTranscript,
  stripExpiringLinks,
} from "../services/fireflies-fetch.js";

const FAKE_API_KEY = "ff_secret_test_key_do_not_leak_987654321";

function sampleTranscript(id = "ff-meeting-001") {
  return {
    id,
    title: "Quarterly Architecture Review",
    date: Date.UTC(2026, 10, 20, 15, 0, 0),
    duration: 45,
    organizer_email: "organizer@example.com",
    speakers: [
      { id: 1, name: "Host One" },
      { id: 2, name: "Guest Two" },
    ],
    meeting_attendees: [
      { displayName: "Host One", email: "host@example.com" },
      { displayName: "Attendee Three", email: "three@example.com" },
    ],
    sentences: [
      { index: 0, speaker_name: "Host One", text: "Welcome to the review.", start_time: 1.5, end_time: 5.2 },
      { index: 1, speaker_name: "Guest Two", text: "Let us inspect the storage layout.", start_time: 6.0, end_time: 2690 },
    ],
    summary: {
      keywords: ["storage", "delegation"],
      action_items: "Ship PR-2 behind the flag.",
      overview: "Reviewed delegation-based import.",
      meeting_type: "engineering",
    },
    audio_url: "https://cdn.fireflies.ai/signed/audio.mp3?token=expiring",
  };
}

describe("stateless fireflies-fetch", () => {
  it("fetches one meeting by id with Bearer key, strips expiring links and normalizes to TC-1192 shapes", async () => {
    let seenUrl = "";
    let seenRedirect: RequestRedirect | undefined;
    let seenAuth = "";
    let seenBody = "";

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenRedirect = init?.redirect;
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization") ?? "";
      seenBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ data: { transcript: sampleTranscript("m-123") } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchFirefliesMeeting(
      { meetingId: "m-123", apiKey: FAKE_API_KEY },
      { fetchImpl: mockFetch, now: () => Date.UTC(2026, 10, 22, 17, 0, 0) },
    );

    expect(seenUrl).toBe(FIREFLIES_GRAPHQL_URL);
    expect(seenRedirect).toBe("manual");
    expect(seenAuth).toBe(`Bearer ${FAKE_API_KEY}`);
    expect(JSON.parse(seenBody).variables).toEqual({ id: "m-123" });

    if (!result.ok) throw new Error(`Expected ok fetch, got ${result.code}`);
    expect(result.data.meeting.id).toBe(await connectorMeetingId("fireflies", "m-123"));
    expect(result.data.meeting.source).toBe("fireflies");
    expect(result.data.meeting.sourceId).toBe("m-123");
    expect(result.data.meeting.title).toBe("Quarterly Architecture Review");
    expect(result.data.meeting.durationSecs).toBe(2700);
    expect(result.data.meeting.participants).toEqual([
      { name: "Host One", email: "host@example.com" },
      { name: "Attendee Three", email: "three@example.com" },
      { name: "Guest Two", email: null },
    ]);
    expect(result.data.meetingRecord.origin).toBe("fireflies-delegation-import");
    expect(result.data.meetingRecord.hasTranscript).toBe(true);
    expect(result.data.meetingRecord.hasSummary).toBe(true);
    expect(JSON.parse(result.data.transcriptBody)).toHaveLength(2);
    expect(JSON.stringify(result.data)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(result.data)).not.toContain("expiring");
  });

  it("strips expiring links and falls back to sentence end on duration mismatch", async () => {
    const stripped = stripExpiringLinks({
      audio_url: "https://cdn.fireflies.ai/a.mp3?sig=123",
      nested: [{ transcript_url: "http://example.com/t" }],
      text: "Normal sentence text",
    }) as Record<string, unknown>;
    expect(stripped.audio_url).toBe("[link-removed]");
    expect((stripped.nested as Array<Record<string, unknown>>)[0]!.transcript_url).toBe("[link-removed]");
    expect(stripped.text).toBe("Normal sentence text");

    const normalized = await normalizeFirefliesTranscript({
      id: "m-dur",
      duration: 1, // 60s vs last sentence end_time 1800s -> mismatch
      sentences: [{ index: 0, speaker_name: "A", text: "Hi", start_time: 0, end_time: 1800 }],
    });
    expect(normalized.meeting.durationSecs).toBe(1800);
    expect(normalized.meeting.metadata.duration_source).toBe("sentences");
  });

  it("refuses non-HTTPS, foreign-host or credential-bearing URLs without calling fetch", async () => {
    let called = 0;
    const spyFetch = (async () => {
      called++;
      return new Response("{}");
    }) as typeof fetch;

    for (const badUrl of [
      "http://api.fireflies.ai/graphql",
      "https://evil.example.com/graphql",
      "https://user:pass@api.fireflies.ai/graphql",
      "https://api.fireflies.ai:8443/graphql",
      "not-a-url",
    ]) {
      const res = await fetchFirefliesMeeting(
        { meetingId: "m-1", apiKey: FAKE_API_KEY },
        { apiUrl: badUrl, fetchImpl: spyFetch },
      );
      expect(res).toEqual({ ok: false, code: "invalid_url" });
    }
    expect(called).toBe(0);
  });

  it("refuses 3xx redirects so Bearer keys and queries never redirect off-host", async () => {
    for (const status of [301, 302, 307, 308]) {
      const mockFetch = (async () =>
        new Response(null, { status, headers: { location: "https://evil.example.com/steal" } })) as typeof fetch;
      const res = await fetchFirefliesMeeting(
        { meetingId: "m-redir", apiKey: FAKE_API_KEY },
        { fetchImpl: mockFetch },
      );
      expect(res).toEqual({ ok: false, code: "redirect_refused" });
    }
  });

  it("refuses oversized responses both via Content-Length and via streaming chunks", async () => {
    const headerOversize = (async () =>
      new Response("{}", { status: 200, headers: { "content-length": "4096" } })) as typeof fetch;
    expect(
      await fetchFirefliesMeeting(
        { meetingId: "m-big-1", apiKey: FAKE_API_KEY },
        { fetchImpl: headerOversize, maxBytes: 1024 },
      ),
    ).toEqual({ ok: false, code: "response_too_large" });

    const streamOversize = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(600));
          controller.enqueue(new Uint8Array(600));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    expect(
      await fetchFirefliesMeeting(
        { meetingId: "m-big-2", apiKey: FAKE_API_KEY },
        { fetchImpl: streamOversize, maxBytes: 1024 },
      ),
    ).toEqual({ ok: false, code: "response_too_large" });
  });

  it("enforces timeout cap and maps upstream HTTP/GraphQL errors to closed codes without leaking key or text", async () => {
    const slowFetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as typeof fetch;
    expect(
      await fetchFirefliesMeeting(
        { meetingId: "m-slow", apiKey: FAKE_API_KEY },
        { fetchImpl: slowFetch, timeoutMs: 25 },
      ),
    ).toEqual({ ok: false, code: "timeout" });

    const authLeakFetch = (async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: `Invalid API key ${FAKE_API_KEY} for secret title` }],
        }),
        { status: 200 },
      )) as typeof fetch;
    const authRes = await fetchFirefliesMeeting(
      { meetingId: "m-auth", apiKey: FAKE_API_KEY },
      { fetchImpl: authLeakFetch },
    );
    expect(authRes).toEqual({ ok: false, code: "unauthorized" });
    expect(JSON.stringify(authRes)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(authRes)).not.toContain("secret title");

    const rateLimitFetch = (async () =>
      new Response("too many", { status: 429, headers: { "retry-after": "15" } })) as typeof fetch;
    expect(
      await fetchFirefliesMeeting(
        { meetingId: "m-429", apiKey: FAKE_API_KEY },
        { fetchImpl: rateLimitFetch },
      ),
    ).toEqual({ ok: false, code: "rate_limited", retryAfterMs: 15_000 });

    const wrongIdFetch = (async () =>
      new Response(JSON.stringify({ data: { transcript: sampleTranscript("different-id") } }), {
        status: 200,
      })) as typeof fetch;
    expect(
      await fetchFirefliesMeeting(
        { meetingId: "m-expected", apiKey: FAKE_API_KEY },
        { fetchImpl: wrongIdFetch },
      ),
    ).toEqual({ ok: false, code: "invalid_response" });
  });

  it("aborts and returns timeout when response headers arrive promptly but the body stalls", async () => {
    let streamCancelled = false;
    const stalledBodyFetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":{"transcript":'));
        },
        pull() {
          // Never resolves: simulates a stalled upstream body after 200 headers.
          return new Promise<void>(() => {});
        },
        cancel() {
          streamCancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchFirefliesMeeting(
      { meetingId: "m-stalled-body", apiKey: FAKE_API_KEY },
      { fetchImpl: stalledBodyFetch, timeoutMs: 30 },
    );
    expect(result).toEqual({ ok: false, code: "timeout" });
    expect(streamCancelled).toBe(true);
  });
});
