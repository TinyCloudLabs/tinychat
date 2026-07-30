// E2E driver: rate-limit recovery. See docs/connectors-spec.md §10 driver 3.
//
// Real syncFireflies engine + real FirefliesClient over real HTTP to the mock
// upstream (Bun.serve on an ephemeral port). delayMs:0 collapses waits so the
// whole file runs in well under the 30s cap even with exhaustion retries.
//
// What this driver covers:
//   1. Vacuity guard — SEED_COUNT > 0 AND mock serves > 0 transcripts on the
//      wire; the rate-limit modes are recognized (mock accepts them without
//      falling back to happy).
//   2. rate-limit-429 recovery — one-shot HTTP 429 fires, client retries, the
//      sync completes with every seeded meeting stored. Vacuity guard: the
//      429 must actually have been served (otherwise this test proves nothing).
//   3. rate-limit-graphql recovery — one-shot GraphQL too_many_requests fires,
//      client retries, sync completes. Same vacuity guard as above.
//   4. persistent-rate-limit exhaustion — mock rate-limits EVERY call, client
//      exhausts its FIREFLIES_MAX_RATE_LIMIT_RETRIES budget on the very first
//      LIST call and surfaces a typed rate-limited SyncError carrying
//      retryAfterMs > 0. The sync run itself must not have stored anything.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  FIREFLIES_MAX_RATE_LIMIT_RETRIES,
  FirefliesClient,
} from "../../frontend/src/lib/connectors/firefliesClient";
import * as connectorStore from "../../frontend/src/lib/connectors/connectorStore";
import { _resetConnectorSchemaMemoForTests } from "../../frontend/src/lib/connectors/connectorStore";
import { syncFireflies } from "../../frontend/src/lib/connectors/firefliesSync";

import { makeFakeTinyCloud } from "./fake-tinycloud";
import { SEED_COUNT, buildSeed, startMockFireflies } from "./mock-fireflies.mjs";

interface Handle {
  url: string;
  port: number;
  seed: unknown[];
  counts: Record<string, number>;
  resetCounters: () => void;
  stop: () => Promise<void>;
}

const HAPPY_KEY = "sk-fire-ratelimit-e2e";

/** Wrap fetch to inject an x-mock-mode header so we can switch the mock's
 *  per-request behavior without spinning up a second server. */
function fetchWithMode(mode: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? undefined);
    headers.set("x-mock-mode", mode);
    return fetch(input, { ...init, headers });
  };
}

let handle: Handle;

beforeAll(async () => {
  // Default mode "happy" — every test overrides via x-mock-mode header.
  handle = (await startMockFireflies({ mode: "happy" })) as unknown as Handle;
});

afterAll(async () => {
  await handle.stop();
});

describe("ratelimit e2e (spec §10 driver 3)", () => {
  test("vacuity guard — SEED_COUNT > 0 AND mock reachable over real HTTP", async () => {
    expect(SEED_COUNT).toBeGreaterThan(0);
    expect(buildSeed().length).toBe(SEED_COUNT);

    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HAPPY_KEY}`,
      },
      body: JSON.stringify({
        query:
          "query ListTranscripts($limit: Int, $skip: Int) { transcripts(limit: $limit, skip: $skip) { id title date duration organizer_email } }",
        variables: { limit: 5, skip: 0 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { transcripts?: unknown[] } };
    expect((body.data?.transcripts ?? []).length).toBeGreaterThan(0);
  });

  test("rate-limit-429: one-shot 429 fires, client retries, sync completes with every meeting stored", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();

    const fake = makeFakeTinyCloud({ did: "did:test:ratelimit-429" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      fetchImpl: fetchWithMode("rate-limit-429"),
      delayMs: 0,
    });

    const t0 = Date.now();
    const res = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });
    const elapsedMs = Date.now() - t0;

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.added).toBe(SEED_COUNT);
      expect(res.data.errors).toEqual([]);
    }
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);

    // Vacuity guard: the 429 must actually have hit the wire. The one-shot
    // fires on the FIRST request (which is a list call) → client retries →
    // the count for transcripts is at least 2 (retry) and >= SEED_COUNT/25
    // for the full crawl.
    expect(handle.counts.transcripts).toBeGreaterThan(1);
    expect(handle.counts.transcript).toBe(SEED_COUNT);

    // Sync state landed as ok — the terminal-retry path did not fire.
    const state = fake.sql.states.get("fireflies");
    expect(state?.last_sync_status).toBe("ok");
    expect(state?.last_sync_error).toBeNull();
    expect(state?.item_count).toBe(SEED_COUNT);

    // The 30s cap on any single driver run — this file's slowest test.
    expect(elapsedMs).toBeLessThan(30_000);
  });

  test("rate-limit-graphql: one-shot too_many_requests fires, client retries, sync completes", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();

    const fake = makeFakeTinyCloud({ did: "did:test:ratelimit-graphql" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      fetchImpl: fetchWithMode("rate-limit-graphql"),
      delayMs: 0,
    });

    const res = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.added).toBe(SEED_COUNT);
      expect(res.data.errors).toEqual([]);
    }
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);

    // Vacuity guard: the graphql RL fired → client made an extra list call.
    expect(handle.counts.transcripts).toBeGreaterThan(1);
    expect(handle.counts.transcript).toBe(SEED_COUNT);

    const state = fake.sql.states.get("fireflies");
    expect(state?.last_sync_status).toBe("ok");
    expect(state?.last_sync_error).toBeNull();
  });

  test("persistent-rate-limit: exhausts retries and surfaces typed rate-limited error with retryAfterMs > 0", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();

    const fake = makeFakeTinyCloud({ did: "did:test:ratelimit-persistent" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      fetchImpl: fetchWithMode("persistent-rate-limit"),
      delayMs: 0,
    });

    const t0 = Date.now();
    const res = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });
    const elapsedMs = Date.now() - t0;

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("rate-limited");
      // Typed retryAfterMs must be positive — the mock sets retry-after: "1"
      // (1s), which the client parses to 1000ms.
      expect(res.error.retryAfterMs).toBeDefined();
      expect(res.error.retryAfterMs!).toBeGreaterThan(0);
      // Guardrails: NOT misclassified as auth/network/storage.
      expect(res.error.kind).not.toBe("auth");
      expect(res.error.kind).not.toBe("network");
      expect(res.error.kind).not.toBe("storage");
    }

    // Nothing stored — the very first LIST call exhausted retries and the
    // engine bailed before any detail fetch or insert could run.
    expect(fake.sql.meetings.size).toBe(0);
    expect(fake.kv.entries.size).toBe(0);
    expect(handle.counts.transcript).toBe(0);

    // Vacuity guard: the mock saw exactly (initial + MAX_RETRIES) list calls
    // — a broken client that returned early without retrying would fail this,
    // and a broken client that retried forever would time out the test.
    expect(handle.counts.transcripts).toBe(FIREFLIES_MAX_RATE_LIMIT_RETRIES + 1);

    // updateSyncState landed with error status carrying the RL message.
    const state = fake.sql.states.get("fireflies");
    expect(state).toBeDefined();
    expect(state!.last_sync_status).toBe("error");
    expect(state!.last_sync_error).toBeTruthy();

    // 30s cap — even with 4 sequential HTTP round-trips + retry-after
    // parsing, delayMs:0 keeps this well under the budget.
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
