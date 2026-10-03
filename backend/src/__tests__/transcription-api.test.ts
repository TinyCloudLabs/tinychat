import { describe, expect, test } from "bun:test";
import {
  computeCreateRequestHash,
  createTranscriptionApiClient,
  type CreateMeetingInput,
  type TranscriptionMeeting,
} from "../services/transcription-api.js";

const input: CreateMeetingInput = {
  meeting_url: "https://meet.google.com/abc-defg-hij",
  platform: "google_meet",
  bot_name: "Tinychat",
  metadata: { tenant: "tenant-a", occurrence: "opaque-id", nested: { b: 2, a: [1, 2] } },
};
const meeting: TranscriptionMeeting = {
  id: "mtg_recovered", status: "queued", platform: "google_meet", meeting_url: input.meeting_url,
  created_at: "2026-09-25T12:00:00Z", metadata: input.metadata,
};
// Shared vector with transcription's hashCreateRequest: catch wire-contract drift.
const requestHash = "616b587d408523cec2a11e32d77b42b9233149f31817b346390f7481b4958204";
const client = (fetchImpl: typeof fetch, requestTimeoutMs = 1000) => createTranscriptionApiClient({
  baseUrl: "https://transcription.example", apiKey: "tc_live_project", fetchImpl,
  requestTimeoutMs, sleep: async () => {},
});

describe("scheduler dispatch API seam", () => {
  test("create hashing matches upstream and ignores object key order, not changed intent", () => {
    expect(computeCreateRequestHash(input)).toBe(requestHash);
    expect(computeCreateRequestHash({ ...input, metadata: {
      nested: { a: [1, 2], b: 2 }, occurrence: "opaque-id", tenant: "tenant-a", omitted: undefined,
    } })).toBe(requestHash);
    expect(computeCreateRequestHash({ ...input, bot_name: "Another bot" })).not.toBe(requestHash);
    expect(computeCreateRequestHash({ ...input, metadata: { ...input.metadata, tenant: "tenant-b" } })).not.toBe(requestHash);
    // Metadata is hashed as transmitted: JSON converts undefined array entries to null.
    expect(computeCreateRequestHash({ ...input, metadata: { a: [undefined] } }))
      .toBe(computeCreateRequestHash({ ...input, metadata: { a: [null] } }));
  });

  test("scheduler supplies a stable key and disables every hidden transport retry", async () => {
    const calls: RequestInit[] = [];
    const api = client((async (_url, init) => {
      calls.push(init!);
      throw new Error("ECONNRESET");
    }) as typeof fetch);
    const options = { idempotencyKey: "stable-occurrence", retryTransport: false };
    await expect(api.createMeeting(input, options)).rejects.toThrow("ECONNRESET");
    expect(calls).toHaveLength(1);
    // Only the scheduler's next explicit attempt can POST again.
    await expect(api.createMeeting(input, options)).rejects.toThrow("ECONNRESET");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => new Headers(call.headers).get("Idempotency-Key")))
      .toEqual(["stable-occurrence", "stable-occurrence"]);
    expect(calls[0]!.body).toBe(calls[1]!.body);
  });

  test("lookup is a read-only GET using the header and returns meeting plus hash", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = client((async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ meeting, request_hash: requestHash });
    }) as typeof fetch);
    expect(await api.lookupMeetingByIdempotencyKey("opaque key")).toEqual({ meeting, requestHash });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://transcription.example/v1/meetings/by-idempotency-key");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Idempotency-Key")).toBe("opaque key");
    expect(headers.get("Authorization")).toBe("Bearer tc_live_project");
  });

  test("only a meeting_not_found is a lookup miss; route mismatch and invalid hashes fail closed", async () => {
    const replies = [
      Response.json({ error: { code: "meeting_not_found" } }, { status: 404 }),
      Response.json({ error: { code: "not_found" } }, { status: 404 }),
      Response.json({ meeting, request_hash: "invalid" }),
      Response.json({ request_hash: requestHash }),
    ];
    const api = client((async () => replies.shift()!) as typeof fetch);
    expect(await api.lookupMeetingByIdempotencyKey("k")).toBeNull();
    await expect(api.lookupMeetingByIdempotencyKey("k")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(api.lookupMeetingByIdempotencyKey("k")).rejects.toMatchObject({ code: "invalid_lookup_response" });
    await expect(api.lookupMeetingByIdempotencyKey("k")).rejects.toMatchObject({ code: "invalid_lookup_response" });
  });

  test("exposes the complete Retry-After, including HTTP dates, without retrying HTTP failures", async () => {
    const date = new Date(Date.now() + 3_600_000).toUTCString();
    const values = ["7200", date, "not a date"];
    const api = client((async () => Response.json({ error: { code: "capacity" } }, {
      status: 429, headers: { "Retry-After": values.shift()! },
    })) as typeof fetch);
    await expect(api.createMeeting(input)).rejects.toMatchObject({ status: 429, retryAfterMs: 7_200_000 });
    const error = await api.createMeeting(input).catch((e: unknown) => e) as { retryAfterMs: number };
    expect(error.retryAfterMs).toBeGreaterThan(3_598_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    await expect(api.createMeeting(input)).rejects.toMatchObject({ status: 429, retryAfterMs: null });
    expect(values).toHaveLength(0);
  });

  test("times out a scheduler create without a second POST, even if fetch ignores abort", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const api = client((async (_url, init) => {
      calls++;
      signal = init?.signal ?? undefined;
      return await new Promise<Response>(() => {});
    }) as typeof fetch, 10);
    await expect(api.createMeeting(input, { idempotencyKey: "frozen", retryTransport: false }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
  });

  test("timeout covers a stalled response body as well as response headers", async () => {
    let calls = 0;
    const api = client((async () => {
      calls++;
      return new Response(new ReadableStream({ start() {} }));
    }) as typeof fetch, 10);
    await expect(api.createMeeting(input, { retryTransport: false })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(1);
  });
});
