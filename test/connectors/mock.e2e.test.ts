// Smoke test for test/connectors/mock-fireflies.mjs. Asserts the mock is
// reachable over real HTTP on an ephemeral port and serves seeded data in
// every mode (spec §10). Vacuity guard: seeded count > 0 in every mode.
//
// This test is intentionally minimal — the deep e2e drivers (sync, ratelimit,
// disconnect, connect) live in sibling *.e2e.test.ts files and reuse this
// mock through the same start/stop helpers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  DURATION_MISMATCH_INDEX,
  NULL_SUMMARY_INDEX,
  SEED_COUNT,
  buildSeed,
  startMockFireflies,
} from "./mock-fireflies.mjs";

interface Handle {
  url: string;
  port: number;
  seed: unknown[];
  counts: Record<string, number>;
  resetCounters: () => void;
  stop: () => Promise<void>;
}

let handle: Handle;

beforeAll(async () => {
  handle = (await startMockFireflies({ mode: "happy" })) as unknown as Handle;
});

afterAll(async () => {
  await handle.stop();
});

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;
  return { status: res.status, headers: res.headers, body: parsed };
}

const AUTH = { authorization: "Bearer key-abc" };

describe("mock-fireflies (spec §10)", () => {
  test("seed shape: ~30 transcripts, includes duration-mismatch and null-summary rows", () => {
    const seed = buildSeed();
    expect(seed.length).toBe(SEED_COUNT);
    // Vacuity guard for downstream drivers.
    expect(seed.length).toBeGreaterThan(0);

    const mismatch = seed[DURATION_MISMATCH_INDEX] as {
      duration: number;
      sentences: { end_time: number }[];
    };
    // duration is minutes; last sentence end is seconds. 5*60=300 vs 1800.
    const lastEnd = mismatch.sentences[mismatch.sentences.length - 1].end_time;
    expect(Math.abs(mismatch.duration * 60 - lastEnd)).toBeGreaterThan(120);

    const nullSummary = seed[NULL_SUMMARY_INDEX] as { summary: unknown };
    expect(nullSummary.summary).toBeNull();
  });

  test("mock is reachable on an ephemeral port", () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("happy mode: GetUser + ListTranscripts return seeded data (count > 0)", async () => {
    handle.resetCounters();
    const user = await post(handle.url, AUTH, { query: "query GetUser { user { name email } }" });
    expect(user.status).toBe(200);
    expect(user.body?.data?.user?.email).toBeTruthy();

    const list = await post(handle.url, AUTH, {
      query:
        "query ListTranscripts($limit: Int, $skip: Int) { transcripts(limit: $limit, skip: $skip) { id title date duration organizer_email } }",
      variables: { limit: 50, skip: 0 },
    });
    expect(list.status).toBe(200);
    const transcripts = list.body?.data?.transcripts;
    expect(Array.isArray(transcripts)).toBe(true);
    expect(transcripts.length).toBe(SEED_COUNT);
    expect(transcripts.length).toBeGreaterThan(0);
    // Newest-first ordering — date descends.
    expect(transcripts[0].date).toBeGreaterThan(transcripts[1].date);
  });

  test("invalid-key mode (per-request header): rejects bearer with 401 + unauthenticated code", async () => {
    handle.resetCounters();
    const res = await post(
      handle.url,
      { ...AUTH, "x-mock-mode": "invalid-key" },
      { query: "query GetUser { user { name email } }" },
    );
    expect(res.status).toBe(401);
    expect(res.body?.errors?.[0]?.extensions?.code).toBe("unauthenticated");
  });

  test("rate-limit-429 mode: first request 429 with retry-after, next request succeeds", async () => {
    handle.resetCounters();
    const first = await post(
      handle.url,
      { ...AUTH, "x-mock-mode": "rate-limit-429" },
      { query: "query GetUser { user { name email } }" },
    );
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("0");

    // The one-shot RL is used up — subsequent requests succeed with data.
    const second = await post(
      handle.url,
      { ...AUTH, "x-mock-mode": "rate-limit-429" },
      { query: "query GetUser { user { name email } }" },
    );
    expect(second.status).toBe(200);
    expect(second.body?.data?.user?.email).toBeTruthy();

    // And the mock still returns seeded data (count > 0) for a list call.
    const list = await post(
      handle.url,
      { ...AUTH, "x-mock-mode": "rate-limit-429" },
      {
        query:
          "query ListTranscripts($limit: Int, $skip: Int) { transcripts(limit: $limit, skip: $skip) { id title date duration organizer_email } }",
        variables: { limit: 5, skip: 0 },
      },
    );
    expect(list.status).toBe(200);
    expect(list.body?.data?.transcripts?.length).toBeGreaterThan(0);
  });

  test("rate-limit-graphql mode: first request emits too_many_requests, next request succeeds", async () => {
    handle.resetCounters();
    const first = await post(
      handle.url,
      { ...AUTH, "x-mock-mode": "rate-limit-graphql" },
      { query: "query GetUser { user { name email } }" },
    );
    expect(first.status).toBe(200);
    expect(first.body?.errors?.[0]?.extensions?.code).toBe("too_many_requests");

    const second = await post(
      handle.url,
      { ...AUTH, "x-mock-mode": "rate-limit-graphql" },
      { query: "query GetUser { user { name email } }" },
    );
    expect(second.status).toBe(200);
    expect(second.body?.data?.user?.email).toBeTruthy();

    const list = await post(
      handle.url,
      { ...AUTH, "x-mock-mode": "rate-limit-graphql" },
      {
        query:
          "query ListTranscripts($limit: Int, $skip: Int) { transcripts(limit: $limit, skip: $skip) { id title date duration organizer_email } }",
        variables: { limit: 5, skip: 0 },
      },
    );
    expect(list.status).toBe(200);
    expect(list.body?.data?.transcripts?.length).toBeGreaterThan(0);
  });

  test("GetTranscript: returns the seeded full detail including sentences and speakers", async () => {
    handle.resetCounters();
    const first = (handle.seed[0] as { id: string }).id;
    const res = await post(handle.url, AUTH, {
      query: `query GetTranscript($id: String!) {
        transcript(id: $id) {
          id title date duration organizer_email
          speakers { id name }
          meeting_attendees { displayName email }
          sentences { index speaker_name text start_time end_time }
          summary { keywords action_items overview meeting_type }
        }
      }`,
      variables: { id: first },
    });
    expect(res.status).toBe(200);
    const t = res.body?.data?.transcript;
    expect(t?.id).toBe(first);
    expect(Array.isArray(t?.sentences)).toBe(true);
    expect(t.sentences.length).toBeGreaterThan(0);
    expect(Array.isArray(t?.speakers)).toBe(true);
  });
});
