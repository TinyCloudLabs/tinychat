// E2E driver: initial + incremental sync. See docs/connectors-spec.md §10 driver 2.
//
// Real syncFireflies engine + real connectorStore module against fake-tinycloud
// and the mock Fireflies upstream over REAL HTTP (Bun.serve on an ephemeral port).
// FirefliesClient runs with delayMs: 0 so retries/inter-page waits collapse.
//
// What this driver covers:
//   1. Vacuity guard — SEED_COUNT > 0 and the mock serves > 0 transcripts on
//      the wire (so a broken mock can't produce false greens below).
//   2. Initial sync — every seeded meeting lands as a SQL row + KV transcript
//      body; source_id set matches the seed exactly; KV bodies equal the seed
//      sentences byte-for-byte after JSON round-trip.
//   3. Second sync no-op — the listing still scans through known rows to a
//      date boundary or true history end, while fetching zero transcript bodies.
//   4. Incremental — after mutating the mock's seed (unshift a newer id), the
//      next sync picks up exactly one meeting; row + KV body land; the count
//      grows by 1.
//   5. Duration cross-check — the seeded DURATION_MISMATCH transcript stores
//      `metadata.duration_source === "sentences"` and prefers the sentence
//      end over the raw `duration * 60`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { FirefliesClient } from "../../frontend/src/lib/connectors/firefliesClient";
import * as connectorStore from "../../frontend/src/lib/connectors/connectorStore";
import {
  _resetConnectorSchemaMemoForTests,
  firefliesAttemptKvKey,
  transcriptKvKey,
} from "../../frontend/src/lib/connectors/connectorStore";
import { initialDisconnectProgress, runDisconnect, type DisconnectDeps } from "../../frontend/src/lib/connectors/connectorLifecycle";
import { syncFireflies } from "../../frontend/src/lib/connectors/firefliesSync";
import { makeFakeTinyCloud } from "./fake-tinycloud";
import {
  DURATION_MISMATCH_INDEX,
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

interface SeedTranscript {
  id: string;
  title: string;
  date: number;
  duration: number;
  organizer_email: string;
  speakers: { id: number; name: string }[];
  meeting_attendees: { displayName: string; email: string }[];
  sentences: { index: number; speaker_name: string; text: string; start_time: number; end_time: number }[];
  summary: { keywords: string[]; action_items: string; overview: string; meeting_type: string } | null;
}

const HAPPY_KEY = "sk-fire-sync-e2e";

// The seed is shared across tests via the handle; buildSeed() is deterministic
// and the mock closes over the array by reference, so runtime mutations
// (unshift for incremental) show up on the wire without restarting the server.
let seed: SeedTranscript[];
let handle: Handle;

function makeInMemoryFireflies(seed: SeedTranscript[]) {
  const failures = new Map<string, Response[]>();
  const permanentlyFailing = new Set<string>();
  const deleted = new Set<string>();
  const permanentlyNull = new Set<string>();
  let listingOverride: SeedTranscript[] | null = null;
  const calls: { operation: "list" | "detail"; id?: string; skip?: number }[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { id?: string; limit?: number; skip?: number };
    };
    if (request.query.includes("ListTranscripts")) {
      const skip = request.variables?.skip ?? 0;
      const limit = request.variables?.limit ?? 50;
      const summaries = listingOverride ?? seed;
      calls.push({ operation: "list", skip });
      return new Response(JSON.stringify({
        data: { transcripts: summaries.slice(skip, skip + limit).map(({ sentences: _s, summary: _m, speakers: _p, meeting_attendees: _a, ...row }) => row) },
      }), { headers: { "content-type": "application/json" } });
    }
    const id = request.variables?.id ?? "";
    calls.push({ operation: "detail", id });
    if (permanentlyFailing.has(id)) {
      return new Response(JSON.stringify({ errors: [{ message: "persistently unavailable" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (permanentlyNull.has(id)) {
      return new Response(JSON.stringify({ data: { transcript: null } }), {
        headers: { "content-type": "application/json" },
      });
    }
    const queued = failures.get(id);
    if (queued?.length) return queued.shift()!;
    const transcript = deleted.has(id) ? null : seed.find((item) => item.id === id) ?? null;
    return new Response(JSON.stringify({ data: { transcript } }), {
      headers: { "content-type": "application/json" },
    });
  };
  const client = new FirefliesClient({
    apiKey: HAPPY_KEY,
    apiUrl: "https://fireflies.invalid/graphql",
    delayMs: 0,
    fetchImpl,
  });
  return {
    client,
    calls,
    failAlways(id: string) { permanentlyFailing.add(id); },
    recover(id: string) { permanentlyFailing.delete(id); },
    failNullAlways(id: string) { permanentlyNull.add(id); },
    failNext(id: string, responses: Response[]) { failures.set(id, responses); },
    deleteFromProvider(id: string) {
      deleted.add(id);
      const index = seed.findIndex((item) => item.id === id);
      if (index >= 0) seed.splice(index, 1);
    },
    setListingOverride(items: SeedTranscript[] | null) { listingOverride = items; },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function transcriptBodyKeys(fake: ReturnType<typeof makeFakeTinyCloud>): Set<string> {
  const prefix = `${connectorStore.CONNECTORS_KV_PREFIX}/fireflies/transcript/`;
  return new Set([...fake.kv.entries.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
}

function missingIds(expected: string[], stored: Set<string>): string[] {
  return expected.filter((id) => !stored.has(id));
}

function requiredSyncState(fake: ReturnType<typeof makeFakeTinyCloud>) {
  return fake.sql.states.get("fireflies")!;
}

async function runEngine(
  client: FirefliesClient,
  fake: ReturnType<typeof makeFakeTinyCloud>,
  options: Partial<Parameters<typeof syncFireflies>[0]> = {},
) {
  return syncFireflies({
    client,
    store: connectorStore,
    tcw: fake.tcw,
    allowMissingConnection: true,
    ...options,
  });
}

  test("continuation keeps its old resume point after every interrupted prefix", async () => {
    const cases = [
      {
        name: "HTTP 429",
        fail(id: string, provider: ReturnType<typeof makeInMemoryFireflies>) {
          provider.failNext(id, Array.from({ length: 5 }, () =>
            jsonResponse({ errors: [{ message: "rate limited" }] }, 429, { "retry-after": "0" }),
          ));
        },
      },
      {
        name: "Retry-After",
        fail(id: string, provider: ReturnType<typeof makeInMemoryFireflies>) {
          provider.failNext(id, [
            jsonResponse({ errors: [{ message: "rate limited" }] }, 429, { "retry-after": "61" }),
          ]);
        },
      },
      {
        name: "item error",
        fail(id: string, provider: ReturnType<typeof makeInMemoryFireflies>) {
          provider.failNext(id, [jsonResponse({ errors: [{ message: "transient item error" }] })]);
        },
      },
      {
        name: "body write failure",
        fail(_id: string, _provider: ReturnType<typeof makeInMemoryFireflies>) {},
      },
    ];

    for (const scenario of cases) {
      _resetConnectorSchemaMemoForTests();
      const items = buildSeed(120) as SeedTranscript[];
      const fake = makeFakeTinyCloud({ did: `did:test:prefix-${scenario.name}` });
      const provider = makeInMemoryFireflies(items);
      expect((await runEngine(provider.client, fake)).ok).toBe(true);
      expect(requiredSyncState(fake).last_sync_status).toBe("partial");
      expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).listing_skip).toBe(50);

      const targetId = items[80]!.id;
      scenario.fail(targetId, provider);
      if (scenario.name === "body write failure") {
        let failed = false;
        fake.kv.putHook = async (key) => {
          if (!failed && key === transcriptKvKey("fireflies", targetId)) {
            failed = true;
            throw new Error("body unavailable");
          }
        };
      }
      await runEngine(provider.client, fake);
      expect(["partial", "error"]).toContain(requiredSyncState(fake).last_sync_status);
      const interruptedAttempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
      expect(interruptedAttempt.listing_skip).toBe(
        scenario.name === "item error" || scenario.name === "body write failure" ? 100 : 50,
      );
      expect(interruptedAttempt.pending_ids).toContain(targetId);
      for (let attempt = 0; attempt < 6 && requiredSyncState(fake).last_sync_status !== "ok"; attempt++) {
        fake.kv.putHook = null;
        expect((await runEngine(provider.client, fake)).ok).toBe(true);
      }
      const expected = items.map((item) => item.id);
      expect(missingIds(expected, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
      expect(missingIds(expected, transcriptBodyKeys(fake))).toEqual([]);
      expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    }
  });

  test("Stop during a resumed detail batch retains its previous resume point and repairs all meetings", async () => {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(120) as SeedTranscript[];
    const fake = makeFakeTinyCloud({ did: "did:test:prefix-stop" });
    const provider = makeInMemoryFireflies(items);
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
    expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).listing_skip).toBe(50);
    const controller = new AbortController();
    let stopped = false;
    const result = await runEngine(provider.client, fake, {
      signal: controller.signal,
      onProgress(progress) {
        if (!stopped && progress.phase === "storing" && progress.done === 1) {
          stopped = true;
          controller.abort();
        }
      },
    });
    expect(result.ok).toBe(true);
    expect(["partial", "error"]).toContain(requiredSyncState(fake).last_sync_status);
    expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).listing_skip).toBe(50);
    for (let attempt = 0; attempt < 6 && requiredSyncState(fake).last_sync_status !== "ok"; attempt++) {
      expect((await runEngine(provider.client, fake)).ok).toBe(true);
    }
    const ids = items.map((item) => item.id);
    expect(missingIds(ids, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
    expect(missingIds(ids, transcriptBodyKeys(fake))).toEqual([]);
    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
  });

  test("anchor restart plus chain-start watermark covers a multi-day initial backfill with prepends", async () => {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(600) as SeedTranscript[];
    const fake = makeFakeTinyCloud({ did: "did:test:prefix-prepend" });
    const provider = makeInMemoryFireflies(items);
    const chainStart = Date.parse("2026-10-13T00:00:00.000Z");
    let now = chainStart;
    let result = await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() });
    expect(result.ok).toBe(true);
    for (let run = 0; run < 20 && requiredSyncState(fake).last_sync_status !== "ok"; run++) {
      now += 8 * 60 * 60 * 1000;
      if (run % 4 === 0) {
        const arrivals = buildSeed(2) as SeedTranscript[];
        arrivals.forEach((item, index) => {
          item.id = `late-${run}-${index}`;
          item.date = Math.floor((now + index) / 1000);
        });
        items.unshift(...arrivals);
      }
      result = await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() });
      expect(result.ok).toBe(true);
    }
    const ids = items.map((item) => item.id);
    if (requiredSyncState(fake).last_sync_status !== "ok") {
      throw new Error(JSON.stringify({
        status: requiredSyncState(fake).last_sync_status,
        rows: fake.sql.meetings.size,
        attempt: fake.kv.entries.get(firefliesAttemptKvKey()),
        tailCalls: provider.calls.slice(-8),
      }));
    }
    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect(now - chainStart).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000);
    expect(requiredSyncState(fake).last_synced_at).toBe(new Date(chainStart).toISOString());
    expect(missingIds(ids, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
    expect(missingIds(ids, transcriptBodyKeys(fake))).toEqual([]);
  });

  test.each([600, 1200])("bounded continuation rebases through one prepend per %i-history run", async (historySize) => {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(historySize) as SeedTranscript[];
    const fake = makeFakeTinyCloud({ did: `did:test:prepend-every-run-${historySize}` });
    const provider = makeInMemoryFireflies(items);
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    for (let run = 0; run < 40 && requiredSyncState(fake)?.last_sync_status !== "ok"; run++) {
      const arrival = buildSeed(1)[0] as SeedTranscript;
      arrival.id = `arrival-${historySize}-${run}`;
      arrival.date = Math.floor((now + 60 * 60 * 1000) / 1000);
      items.unshift(arrival);
      now += 2 * 60 * 60 * 1000;
      const result = await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() });
      expect(result.ok).toBe(true);
    }
    const ids = items.map((item) => item.id);
    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect(missingIds(ids, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
    expect(missingIds(ids, transcriptBodyKeys(fake))).toEqual([]);
  });

  test("a persistent detail failure becomes pending while the 1200-item listing progresses", async () => {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(1200) as SeedTranscript[];
    const failingId = items[10]!.id;
    const fake = makeFakeTinyCloud({ did: "did:test:pending-failure-progress" });
    const provider = makeInMemoryFireflies(items);
    provider.failAlways(failingId);
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    for (let run = 0; run < 40 && fake.sql.meetings.size < 1199; run++) {
      const result = await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() });
      expect(result.ok).toBe(true);
      expect(requiredSyncState(fake).last_sync_status).toBe("partial");
      now += 2 * 60 * 60 * 1000;
    }
    expect(fake.sql.meetings.size).toBe(1199);
    expect(transcriptBodyKeys(fake).size).toBe(1199);
    const attempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
    expect(attempt.pending_ids).toEqual([failingId]);
    expect(requiredSyncState(fake).last_synced_at).toBeNull();

    provider.recover(failingId);
    expect((await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() })).ok).toBe(true);
    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect(fake.sql.meetings.size).toBe(1200);
    expect(transcriptBodyKeys(fake).size).toBe(1200);
    expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids ?? []).toEqual([]);
  });

  test("provider top deletions invalidate the offset anchor and restart without losing known rows", async () => {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(70) as SeedTranscript[];
    const fake = makeFakeTinyCloud({ did: "did:test:prefix-delete" });
    const provider = makeInMemoryFireflies(items);
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
    items.splice(0, 10);
    for (let attempt = 0; attempt < 4 && requiredSyncState(fake).last_sync_status !== "ok"; attempt++) {
      expect((await runEngine(provider.client, fake)).ok).toBe(true);
    }
    const ids = items.map((item) => item.id);
    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect(missingIds(ids, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
    expect(missingIds(ids, transcriptBodyKeys(fake))).toEqual([]);
  });

  test("a failed attempt-record put cannot commit an unsafe cursor", async () => {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(120) as SeedTranscript[];
    const fake = makeFakeTinyCloud({ did: "did:test:prefix-attempt-put" });
    const provider = makeInMemoryFireflies(items);
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
    expect(requiredSyncState(fake).last_sync_status).toBe("partial");
    expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).listing_skip).toBe(50);
    items.unshift(...(buildSeed(3) as SeedTranscript[]).map((item, index) => ({
      ...item,
      id: `attempt-arrival-${index}`,
      date: Date.now() + index,
    })));
    let failed = false;
    fake.kv.putHook = async (key, value) => {
      if (!failed && key === firefliesAttemptKvKey() && typeof value === "string" && JSON.parse(value).last_attempt_status === "partial") {
        failed = true;
        throw new Error("attempt record unavailable");
      }
    };
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
    expect(failed).toBe(true);
    expect(requiredSyncState(fake).last_sync_status).toBe("partial");
    expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).listing_skip).toBe(50);
    fake.kv.putHook = null;
    for (let attempt = 0; attempt < 6 && requiredSyncState(fake).last_sync_status !== "ok"; attempt++) {
      expect((await runEngine(provider.client, fake)).ok).toBe(true);
    }
    const ids = items.map((item) => item.id);
    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect(missingIds(ids, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
    expect(missingIds(ids, transcriptBodyKeys(fake))).toEqual([]);
  });
test("Connect ignores an old-build cursor left beside a null or disconnected row", async () => {
  for (const status of ["missing", "disconnected"] as const) {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(4) as SeedTranscript[];
    const fake = makeFakeTinyCloud({ did: `did:test:old-cursor-${status}` });
    if (status === "disconnected") {
      expect((await connectorStore.updateSyncState(fake.tcw, {
        connectorId: "fireflies",
        status,
        lastSyncedAt: null,
        lastSyncStatus: "error",
        lastSyncError: "previous purge",
        itemCount: 0,
      })).ok).toBe(true);
    }
    fake.kv.entries.set(firefliesAttemptKvKey(), JSON.stringify({
      v: 1,
      last_attempt_at: "2026-10-12T00:00:00.000Z",
      last_attempt_status: "partial",
      listing_skip: 100,
      listing_started_at: "2026-10-10T00:00:00.000Z",
      listing_anchor: "purged-by-old-build",
    }));
    const provider = makeInMemoryFireflies(items);
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect(provider.calls.filter((call) => call.operation === "list")[0]?.skip).toBe(0);
    expect(fake.sql.meetings.size).toBe(items.length);
    expect(transcriptBodyKeys(fake).size).toBe(items.length);
  }
});

test("Connect continues when clearing an old attempt record fails", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(2) as SeedTranscript[];
  const fake = makeFakeTinyCloud({ did: "did:test:connect-clear-failure" });
  fake.kv.entries.set(firefliesAttemptKvKey(), JSON.stringify({
    v: 1,
    last_attempt_at: "2026-10-12T00:00:00.000Z",
    last_attempt_status: "partial",
    listing_skip: 50,
    listing_started_at: "2026-10-10T00:00:00.000Z",
    listing_anchor: "old",
    pending_ids: ["old-account-pending"],
  }));
  fake.kv.deleteErrors.set(firefliesAttemptKvKey(), {
    code: "KV_ERROR",
    message: "record clear unavailable",
  });

  const provider = makeInMemoryFireflies(items);
  expect((await runEngine(provider.client, fake, { allowMissingConnection: true })).ok).toBe(true);

  expect(requiredSyncState(fake).status).toBe("connected");
  expect(fake.sql.meetings.size).toBe(items.length);
  const overwritten = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
  expect(overwritten.pending_ids).toEqual([]);
  expect(overwritten.listing_skip).toBeNull();
});
test("resumed head page does not complete after the detail cap before a date cutoff", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(21) as SeedTranscript[];
  const watermark = Date.parse("2026-10-13T12:00:00.000Z");
  items.forEach((item, index) => {
    item.date = index === 20 ? watermark - 24 * 60 * 60 * 1000 - 1_000 : watermark - index * 60_000;
  });
  const fake = makeFakeTinyCloud({ did: "did:test:head-detail-cap" });
  for (const item of items.slice(0, 5)) {
    const normalized = connectorStore.normalizeFirefliesTranscript(item);
    expect((await connectorStore.insertMeeting(fake.tcw, normalized.meeting)).ok).toBe(true);
    expect((await connectorStore.putTranscriptBody(fake.tcw, "fireflies", item.id, normalized.sentences)).ok).toBe(true);
  }
  expect((await connectorStore.updateSyncState(fake.tcw, {
    connectorId: "fireflies",
    status: "connected",
    lastSyncedAt: new Date(watermark).toISOString(),
    lastSyncStatus: "partial",
    lastSyncError: "previous cap",
    itemCount: 5,
  })).ok).toBe(true);
  expect((await connectorStore.recordFirefliesAttempt(fake.tcw, {
    v: 1,
    lastAttemptAt: new Date(watermark).toISOString(),
    lastAttemptStatus: "partial",
    listingSkip: 5,
    listingStartedAt: new Date(watermark).toISOString(),
    listingAnchor: items[4]!.id,
    listingAnchorDate: items[4]!.date,
    listingPreviousNeighbor: items[3]!.id,
    pendingIds: [],
  })).ok).toBe(true);

  const provider = makeInMemoryFireflies(items);
  const result = await runEngine(provider.client, fake, { detailCap: 5 });

  expect(result.ok).toBe(true);
  expect(requiredSyncState(fake).last_sync_status).toBe("partial");
  expect(requiredSyncState(fake).last_synced_at).toBe(new Date(watermark).toISOString());
  const attempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
  expect(attempt.listing_skip).toBe(5);
  expect(missingIds(items.slice(0, 20).map((item) => item.id), new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toHaveLength(10);
});
test("pending retries leave a non-complete reduced head listing partial after contraction", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(51) as SeedTranscript[];
  const watermark = Date.parse("2026-10-13T12:00:00.000Z");
  items.forEach((item, index) => {
    item.date = index === 50 ? watermark - 24 * 60 * 60 * 1000 - 1_000 : watermark - index * 60_000;
  });
  const fake = makeFakeTinyCloud({ did: "did:test:pending-head-contraction" });
  expect((await connectorStore.updateSyncState(fake.tcw, {
    connectorId: "fireflies",
    status: "connected",
    lastSyncedAt: new Date(watermark).toISOString(),
    lastSyncStatus: "ok",
    lastSyncError: null,
    itemCount: 0,
  })).ok).toBe(true);
  const provider = makeInMemoryFireflies(items);
  for (const item of items.slice(0, 45)) {
    provider.failNext(item.id, [jsonResponse({ errors: [{ message: "temporary detail failure" }] })]);
  }
  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  const firstAttempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
  expect(firstAttempt.pending_ids).toHaveLength(45);

  const arrivals = buildSeed(10) as SeedTranscript[];
  arrivals.forEach((item, index) => {
    item.id = `contracted-arrival-${index}`;
    item.date = watermark - index * 30_000;
  });
  items.unshift(...arrivals);
  const cutoff = buildSeed(1)[0] as SeedTranscript;
  cutoff.id = "contracted-cutoff";
  cutoff.date = watermark - 24 * 60 * 60 * 1000 - 1_000;
  provider.setListingOverride([...arrivals, cutoff]);

  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  expect(requiredSyncState(fake).last_sync_status).toBe("partial");
  expect(requiredSyncState(fake).last_synced_at).toBe(new Date(watermark).toISOString());
  expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids.length).toBeGreaterThan(0);
  expect(arrivals.filter((item) => [...fake.sql.meetings.values()].some((row) => row.source_id === item.id))).toHaveLength(10);
});
test("freshly listed null, 404, and unrelated 503 not-found text remain retryable", async () => {
  const cases = [
    {
      name: "null transcript",
      response: () => jsonResponse({ data: { transcript: null } }),
    },
    {
      name: "http 404",
      response: () => new Response("transcript not found", { status: 404 }),
    },
    {
      name: "unrelated 503 body",
      response: () => new Response("upstream route not found", { status: 503 }),
    },
  ];
  for (const scenario of cases) {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(20) as SeedTranscript[];
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    items.forEach((item, index) => { item.date = now - 3 * 86_400_000 - index * 60_000; });
    const watermark = new Date(now - 5 * 86_400_000).toISOString();
    const fake = makeFakeTinyCloud({ did: `did:test:fresh-not-found-${scenario.name}` });
    expect((await connectorStore.updateSyncState(fake.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: watermark,
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 0,
    })).ok).toBe(true);
    const provider = makeInMemoryFireflies(items);
    provider.failNext(items[10]!.id, [scenario.response()]);

    expect((await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() })).ok).toBe(true);

    expect(requiredSyncState(fake).last_sync_status).toBe("partial");
    expect(requiredSyncState(fake).last_synced_at).toBe(watermark);
    expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids).toContain(items[10]!.id);
    expect(requiredSyncState(fake).last_sync_error).toContain("1 transcript(s) failed");
    for (let run = 0; run < 3 && requiredSyncState(fake).last_sync_status !== "ok"; run++) {
      expect((await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() })).ok).toBe(true);
    }

    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect(missingIds(items.map((item) => item.id), new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
    expect(missingIds(items.map((item) => item.id), transcriptBodyKeys(fake))).toEqual([]);
  }
});
test("skip-zero catch-up cannot complete while a listed null transcript is pending", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(20) as SeedTranscript[];
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  items.forEach((item, index) => { item.date = now - 3 * 86_400_000 - index * 60_000; });
  const watermark = new Date(now - 5 * 86_400_000).toISOString();
  const fake = makeFakeTinyCloud({ did: "did:test:skip-zero-listed-null" });
  expect((await connectorStore.updateSyncState(fake.tcw, {
    connectorId: "fireflies",
    status: "connected",
    lastSyncedAt: watermark,
    lastSyncStatus: "ok",
    lastSyncError: null,
    itemCount: 0,
  })).ok).toBe(true);
  const provider = makeInMemoryFireflies(items);
  provider.failNext(items[5]!.id, [jsonResponse({ data: { transcript: null } })]);

  expect((await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() })).ok).toBe(true);
  expect(requiredSyncState(fake).last_sync_status).toBe("partial");
  expect(requiredSyncState(fake).last_synced_at).toBe(watermark);
  expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids).toContain(items[5]!.id);

  for (let run = 0; run < 3 && requiredSyncState(fake).last_sync_status !== "ok"; run++) {
    expect((await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() })).ok).toBe(true);
  }

  expect(requiredSyncState(fake).last_sync_status).toBe("ok");
  expect(missingIds(items.map((item) => item.id), new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
  expect(missingIds(items.map((item) => item.id), transcriptBodyKeys(fake))).toEqual([]);
});
test("permanently null listed item stays pending while all 1199 other details progress", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(1200) as SeedTranscript[];
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  items.forEach((item, index) => { item.date = now - 3 * 86_400_000 - index * 1_000; });
  const watermark = new Date(now - 5 * 86_400_000).toISOString();
  const fake = makeFakeTinyCloud({ did: "did:test:permanent-listed-null" });
  expect((await connectorStore.updateSyncState(fake.tcw, {
    connectorId: "fireflies",
    status: "connected",
    lastSyncedAt: watermark,
    lastSyncStatus: "ok",
    lastSyncError: null,
    itemCount: 0,
  })).ok).toBe(true);
  const failedId = items[10]!.id;
  const provider = makeInMemoryFireflies(items);
  provider.failNullAlways(failedId);
  let previousSkip = 0;

  for (let run = 0; run < 50 && fake.sql.meetings.size < 1199; run++) {
    expect((await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() })).ok).toBe(true);
    const attempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
    const skip = attempt.listing_skip as number;
    expect(skip).toBeGreaterThanOrEqual(previousSkip);
    previousSkip = skip;
  }

  expect(fake.sql.meetings.size).toBe(1199);
  expect(missingIds(items.filter((item) => item.id !== failedId).map((item) => item.id), new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
  expect(missingIds(items.filter((item) => item.id !== failedId).map((item) => item.id), transcriptBodyKeys(fake))).toEqual([]);
  expect(requiredSyncState(fake).last_sync_status).toBe("partial");
  expect(requiredSyncState(fake).last_synced_at).toBe(watermark);
  expect(requiredSyncState(fake).last_sync_error).toContain("1 transcript(s) failed");
  expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids).toContain(failedId);
});
test("terminal and cooldown failures on a pending retry stop all listing and fresh details", async () => {
  const pendingFailures = [
    {
      name: "unauthorized",
      response: () => new Response("unauthorized", { status: 401 }),
      expectedOk: false,
      status: "error" as const,
    },
    {
      name: "excessive HTTP cooldown",
      response: () => jsonResponse({ errors: [{ message: "rate limited" }] }, 429, { "retry-after": "61" }),
      expectedOk: true,
      status: "partial" as const,
    },
    {
      name: "excessive GraphQL cooldown",
      response: () => jsonResponse({ errors: [{ message: "Rate limit. Retry after 61" }] }),
      expectedOk: true,
      status: "partial" as const,
    },
  ];
  for (const scenario of pendingFailures) {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(100) as SeedTranscript[];
    const fake = makeFakeTinyCloud({ did: `did:test:pending-stop-${scenario.name}` });
    const provider = makeInMemoryFireflies(items);
    const pendingId = items[0]!.id;
    provider.failNext(pendingId, [jsonResponse({ errors: [{ message: "temporary" }] })]);
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
    expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids).toContain(pendingId);
    const listCount = provider.calls.filter((call) => call.operation === "list").length;
    const detailStart = provider.calls.filter((call) => call.operation === "detail").length;

    provider.failNext(pendingId, [scenario.response()]);
    const result = await runEngine(provider.client, fake);

    expect(result.ok).toBe(scenario.expectedOk);
    expect(provider.calls.filter((call) => call.operation === "list")).toHaveLength(listCount);
    expect(provider.calls.filter((call) => call.operation === "detail").slice(detailStart).map((call) => call.id)).toEqual([pendingId]);
    expect(requiredSyncState(fake).last_sync_status).toBe(scenario.status);
  }
});
test("detailCap one still retries one pending transcript", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(4) as SeedTranscript[];
  const fake = makeFakeTinyCloud({ did: "did:test:detail-cap-one-pending" });
  const provider = makeInMemoryFireflies(items);
  const pendingId = items[0]!.id;
  provider.failNext(pendingId, [jsonResponse({ errors: [{ message: "temporary" }] })]);
  expect((await runEngine(provider.client, fake, { detailCap: 1 })).ok).toBe(true);
  expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids).toContain(pendingId);
  const detailCount = provider.calls.filter((call) => call.operation === "detail").length;

  expect((await runEngine(provider.client, fake, { detailCap: 1 })).ok).toBe(true);

  const detailCalls = provider.calls.filter((call) => call.operation === "detail");
  expect(detailCalls.slice(detailCount).map((call) => call.id)).toEqual([pendingId]);
  expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids ?? []).not.toContain(pendingId);
  expect(fake.kv.entries.has(transcriptKvKey("fireflies", pendingId))).toBe(true);
});
test("deleted pending transcript is dropped only after a complete listing proves absence", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(120) as SeedTranscript[];
  const fake = makeFakeTinyCloud({ did: "did:test:deleted-pending-rescan" });
  const provider = makeInMemoryFireflies(items);
  const deletedId = items[0]!.id;
  provider.failNext(deletedId, [jsonResponse({ errors: [{ message: "temporary" }] })]);
  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  const initialAttempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
  const chainStart = initialAttempt.listing_started_at;
  expect(initialAttempt.pending_ids).toContain(deletedId);
  provider.deleteFromProvider(deletedId);
  provider.calls.length = 0;

  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  const verifyingAttempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
  expect(provider.calls.filter((call) => call.operation === "list").some((call) => call.skip === 0)).toBe(true);
  expect(verifyingAttempt.pending_ids).toContain(deletedId);
  expect(verifyingAttempt.listing_started_at).toBe(chainStart);

  for (let run = 0; run < 10 && requiredSyncState(fake).last_sync_status !== "ok"; run++) {
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
  }

  const liveIds = items.map((item) => item.id);
  const finalAttempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
  expect(requiredSyncState(fake).last_sync_status).toBe("ok");
  expect(finalAttempt.pending_ids ?? []).not.toContain(deletedId);
  expect(missingIds(liveIds, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
  expect(missingIds(liveIds, transcriptBodyKeys(fake))).toEqual([]);
});
test("anchor rebasing validates date and previous neighbor across a shifted duplicate", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(180) as SeedTranscript[];
  const sharedDate = Date.parse("2026-10-13T12:00:00.000Z");
  items.forEach((item) => { item.date = sharedDate; });
  const fake = makeFakeTinyCloud({ did: "did:test:anchor-neighbor-boundary" });
  const provider = makeInMemoryFireflies(items);
  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  const attempt = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey())));
  expect(attempt.listing_skip).toBe(100);
  expect(attempt.listing_anchor).toBe(items[99]!.id);
  expect(attempt.listing_anchor_date).toBe(sharedDate);
  expect(attempt.listing_previous_neighbor).toBe(items[98]!.id);

  const duplicate = { ...items[99]! };
  items.splice(0, 60);
  items.splice(80, 0, duplicate);
  provider.calls.length = 0;

  for (let run = 0; run < 10 && requiredSyncState(fake).last_sync_status !== "ok"; run++) {
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
  }

  expect(provider.calls.filter((call) => call.operation === "list" && call.skip === 0).length).toBeGreaterThan(1);
  expect(requiredSyncState(fake).last_sync_status).toBe("ok");
  expect(missingIds(items.map((item) => item.id), new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
  expect(missingIds(items.map((item) => item.id), transcriptBodyKeys(fake))).toEqual([]);
});
test("rotating pending retries preserve listing budget for new arrivals", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(80) as SeedTranscript[];
  const fake = makeFakeTinyCloud({ did: "did:test:pending-rotation-arrivals" });
  const provider = makeInMemoryFireflies(items);
  for (const item of items) provider.failAlways(item.id);
  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids).toHaveLength(50);
  let now = Date.parse("2026-10-13T12:00:00.000Z");
  const arrivals: SeedTranscript[] = [];
  const firstRetryDetails = provider.calls.filter((call) => call.operation === "detail").length;

  for (let run = 0; run < 8; run++) {
    const arrival = { ...(buildSeed(1)[0] as SeedTranscript), id: `rotating-arrival-${run}` };
    arrival.date = now + 60_000;
    items.unshift(arrival);
    arrivals.push(arrival);
    now += 2 * 60 * 60 * 1000;
    const detailStart = provider.calls.filter((call) => call.operation === "detail").length;
    const pendingBefore = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids as string[];
    const result = await runEngine(provider.client, fake, { now: () => new Date(now).toISOString() });
    expect(result.ok).toBe(true);
    const detailsThisRun = provider.calls.filter((call) => call.operation === "detail").slice(detailStart);
    expect(detailsThisRun.slice(0, 25).map((call) => call.id)).toEqual(pendingBefore.slice(0, 25));
    expect(detailsThisRun.some((call) => call.id === arrival.id)).toBe(true);
    const pendingAfter = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids as string[];
    expect(pendingAfter.slice(-25)).toEqual(pendingBefore.slice(0, 25));
    expect([...fake.sql.meetings.values()].some((row) => row.source_id === arrival.id)).toBe(true);
    expect(fake.kv.entries.has(transcriptKvKey("fireflies", arrival.id))).toBe(true);
    expect(requiredSyncState(fake).last_sync_status).toBe("partial");
    expect(requiredSyncState(fake).last_synced_at).toBeNull();
  }
  const pendingOrder = JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids as string[];
  expect(pendingOrder).toHaveLength(50);
  expect(provider.calls.filter((call) => call.operation === "list").length).toBeGreaterThan(8);
  expect(arrivals.every((item) => [...fake.sql.meetings.values()].some((row) => row.source_id === item.id))).toBe(true);
});
test("invalid pending metadata restarts the engine at zero and repairs skipped holes", async () => {
  const invalidPending = [
    "corrupt",
    ["failed-1", 7],
    Array.from({ length: 51 }, (_, index) => `failed-${index}`),
  ];
  for (let index = 0; index < invalidPending.length; index++) {
    _resetConnectorSchemaMemoForTests();
    const items = buildSeed(120) as SeedTranscript[];
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    items.forEach((item, itemIndex) => { item.date = now - itemIndex * 60_000; });
    const hole = items[60]!;
    const fake = makeFakeTinyCloud({ did: `did:test:invalid-pending-${index}` });
    for (let itemIndex = 0; itemIndex < 100; itemIndex++) {
      if (itemIndex === 60) continue;
      const normalized = connectorStore.normalizeFirefliesTranscript(items[itemIndex]!);
      expect((await connectorStore.insertMeeting(fake.tcw, normalized.meeting)).ok).toBe(true);
      expect((await connectorStore.putTranscriptBody(fake.tcw, "fireflies", items[itemIndex]!.id, normalized.sentences)).ok).toBe(true);
    }
    expect((await connectorStore.updateSyncState(fake.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: new Date(now).toISOString(),
      lastSyncStatus: "partial",
      lastSyncError: "previous bounded run",
      itemCount: 99,
    })).ok).toBe(true);
    fake.kv.entries.set(firefliesAttemptKvKey(), JSON.stringify({
      v: 1,
      last_attempt_at: new Date(now).toISOString(),
      last_attempt_status: "partial",
      listing_skip: 100,
      listing_started_at: new Date(now).toISOString(),
      listing_anchor: items[99]!.id,
      pending_ids: invalidPending[index],
    }));
    const provider = makeInMemoryFireflies(items);

    for (let run = 0; run < 5 && requiredSyncState(fake).last_sync_status !== "ok"; run++) {
      expect((await runEngine(provider.client, fake)).ok).toBe(true);
    }

    expect(requiredSyncState(fake).last_sync_status).toBe("ok");
    expect([...fake.sql.meetings.values()].some((row) => row.source_id === hole.id)).toBe(true);
    expect(fake.kv.entries.has(transcriptKvKey("fireflies", hole.id))).toBe(true);
    expect(missingIds(items.map((item) => item.id), new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
    expect(missingIds(items.map((item) => item.id), transcriptBodyKeys(fake))).toEqual([]);
  }
});
test("aborting during a pending retry does not start listing work", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(100) as SeedTranscript[];
  const fake = makeFakeTinyCloud({ did: "did:test:pending-stop-abort" });
  const provider = makeInMemoryFireflies(items);
  const pendingIds = [items[0]!.id, items[1]!.id];
  for (const id of pendingIds) provider.failNext(id, [jsonResponse({ errors: [{ message: "temporary" }] })]);
  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  expect(JSON.parse(String(fake.kv.entries.get(firefliesAttemptKvKey()))).pending_ids).toEqual(expect.arrayContaining(pendingIds));
  const listCount = provider.calls.filter((call) => call.operation === "list").length;
  const detailCount = provider.calls.filter((call) => call.operation === "detail").length;
  const controller = new AbortController();

  expect((await runEngine(provider.client, fake, {
    signal: controller.signal,
    sleepImpl: async () => {
      controller.abort();
      return false;
    },
  })).ok).toBe(true);

  expect(provider.calls.filter((call) => call.operation === "list")).toHaveLength(listCount);
  expect(provider.calls.filter((call) => call.operation === "detail")).toHaveLength(detailCount + 1);
  expect(requiredSyncState(fake).last_sync_status).toBe("partial");
});

test("keep-data Disconnect clears a saved continuation before Connect resumes", async () => {
  _resetConnectorSchemaMemoForTests();
  const items = buildSeed(60) as SeedTranscript[];
  const fake = makeFakeTinyCloud({ did: "did:test:keep-disconnect-cursor" });
  const provider = makeInMemoryFireflies(items);
  expect((await runEngine(provider.client, fake)).ok).toBe(true);
  expect(fake.kv.entries.has(firefliesAttemptKvKey())).toBe(true);
  const result = await runDisconnect({
    connectorId: "fireflies",
    source: "fireflies",
    mode: "keep-data",
    featureDark: true,
    webhooks: {
      disable: async () => ({ status: "feature-dark" }),
      recordPurge: async () => ({ status: "feature-dark" }),
    },
    secrets: {
      isUnlocked: () => true,
      unlock: async () => ({ ok: true }),
      deleteKey: async () => ({ ok: true }),
    },
    store: {
      listKnownSourceIds: () => connectorStore.listKnownSourceIds(fake.tcw, "fireflies"),
      purgeConnector: () => connectorStore.purgeConnector(fake.tcw, "fireflies"),
      getConnection: () => connectorStore.getConnection(fake.tcw, "fireflies"),
      countMeetings: () => connectorStore.countMeetings(fake.tcw, "fireflies"),
      updateSyncState: (input) => connectorStore.updateSyncState(fake.tcw, input),
      clearFirefliesAttempt: () => connectorStore.clearFirefliesAttempt(fake.tcw),
    },
  }, () => {});
  expect(result.done).toBe(true);
  expect(fake.kv.entries.has(firefliesAttemptKvKey())).toBe(false);
  expect(requiredSyncState(fake).status).toBe("disconnected");
  for (let attempt = 0; attempt < 4 && requiredSyncState(fake).last_sync_status !== "ok"; attempt++) {
    expect((await runEngine(provider.client, fake)).ok).toBe(true);
  }
  const ids = items.map((item) => item.id);
  expect(requiredSyncState(fake).last_sync_status).toBe("ok");
  expect(missingIds(ids, new Set([...fake.sql.meetings.values()].map((row) => row.source_id)))).toEqual([]);
  expect(missingIds(ids, transcriptBodyKeys(fake))).toEqual([]);
});
beforeAll(async () => {
  seed = buildSeed() as SeedTranscript[];
  handle = (await startMockFireflies({ mode: "happy", seed })) as unknown as Handle;
});

afterAll(async () => {
  await handle.stop();
});

describe("sync e2e (spec §10 driver 2)", () => {
  test("vacuity guard — SEED_COUNT > 0 AND mock serves > 0 transcripts over real HTTP", async () => {
    expect(SEED_COUNT).toBeGreaterThan(0);
    expect(seed.length).toBe(SEED_COUNT);

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
    expect(Array.isArray(body.data?.transcripts)).toBe(true);
    expect((body.data?.transcripts ?? []).length).toBeGreaterThan(0);
  });

  test("initial sync stores every seeded meeting — SQL rows + KV bodies match seed exactly", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();
    const fake = makeFakeTinyCloud({ did: "did:test:sync-initial" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });

    const res = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
      allowMissingConnection: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.added).toBe(SEED_COUNT);
      expect(res.data.skipped).toBe(0);
      expect(res.data.errors).toEqual([]);
    }

    // The mock actually served each op — no false-green via zero traffic.
    expect(handle.counts.transcripts).toBeGreaterThan(0);
    expect(handle.counts.transcript).toBe(SEED_COUNT);

    // Vacuity guard on the store side.
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);
    expect(fake.sql.meetings.size).toBeGreaterThan(0);
    expect(fake.kv.entries.size).toBe(SEED_COUNT + 1);
    expect(fake.kv.entries.has(firefliesAttemptKvKey())).toBe(true);

    // Source-id set matches the seed exactly.
    const seededIds = new Set(seed.map((t) => t.id));
    const storedSourceIds = new Set(
      Array.from(fake.sql.meetings.values()).map((r) => r.source_id),
    );
    expect(storedSourceIds).toEqual(seededIds);

    // KV transcript bodies match seed sentences byte-for-byte (JSON round-trip).
    for (const t of seed) {
      const key = transcriptKvKey("fireflies", t.id);
      const stored = fake.kv.entries.get(key);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!);
      expect(parsed).toEqual(t.sentences);
    }

    // updateSyncState landed with itemCount = SEED_COUNT and ok status.
    const state = fake.sql.states.get("fireflies");
    expect(state).toBeDefined();
    expect(state!.item_count).toBe(SEED_COUNT);
    expect(state!.last_sync_status).toBe("ok");
    expect(state!.last_sync_error).toBeNull();

    // Store used the FULL APP_ID/connectors SQL path (spec §6 gotcha).
    expect(fake.dbNamesRequested.length).toBeGreaterThan(0);
    for (const name of fake.dbNamesRequested) {
      expect(name).toBe(connectorStore.CONNECTORS_SQL_DB_NAME);
      expect(name.endsWith("/connectors")).toBe(true);
    }
    expect(fake.unauthorizedDbNames).toEqual([]);

    // Same gotcha on the KV side: keys are sent verbatim too, so every one has
    // to sit under the granted `${APP_ID}/connectors/` prefix.
    for (const key of fake.kv.entries.keys()) {
      expect(key.startsWith(`${connectorStore.CONNECTORS_KV_PREFIX}/`)).toBe(true);
    }
    expect(fake.kv.unauthorized).toEqual([]);
  });

  test("the fake rejects an unprefixed KV key — the shape that 401s against a real node", async () => {
    const fake = makeFakeTinyCloud({ did: "did:test:kv-authz" });

    // This is exactly what transcriptKvKey used to build. It must not store.
    const bare = await fake.tcw.kv.put("connectors/fireflies/transcript/x", "[]");
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe("AUTH_UNAUTHORIZED");
    expect(fake.kv.entries.size).toBe(0);

    const prefixed = await fake.tcw.kv.put(
      connectorStore.transcriptKvKey("fireflies", "x"),
      "[]",
    );
    expect(prefixed.ok).toBe(true);
    const key = connectorStore.transcriptKvKey("fireflies", "x");
    const metadata = await fake.tcw.kv.head(key);
    expect(metadata.ok).toBe(false);
    if (!metadata.ok) expect(metadata.error.code).toBe("AUTH_UNAUTHORIZED");
    const listed = await fake.tcw.kv.list({
      path: `${connectorStore.CONNECTORS_KV_PREFIX}/fireflies/transcript/`,
    });
    expect(listed.ok).toBe(true);
    expect(fake.kv.unauthorized).toEqual([
      "put:connectors/fireflies/transcript/x",
      `metadata:${key}`,
    ]);
  });

  test("second sync is a no-op after a bounded date-boundary listing", async () => {
    _resetConnectorSchemaMemoForTests();
    const fake = makeFakeTinyCloud({ did: "did:test:sync-noop" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });

    // Seed everything first — real sync into a fresh fake.
    handle.resetCounters();
    const first = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
      allowMissingConnection: true,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.added).toBe(SEED_COUNT);

    // Baseline: how many list pages did the full crawl need? Vacuity guard —
    // must be > 1 for "fewer" to be a meaningful assertion.
    const fullCrawlListCalls = handle.counts.transcripts;
    expect(fullCrawlListCalls).toBeGreaterThan(1);

    // The listing scans to the SQL watermark's 24 h lag boundary; known
    // meetings with stored bodies never trigger detail requests.
    handle.resetCounters();
    const second = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.added).toBe(0);
      expect(second.data.skipped).toBe(0);
      expect(second.data.errors).toEqual([]);
    }

    // A recent watermark reaches the 24 h date boundary before the full crawl
    // ends. Known meetings never trigger detail requests.
    expect(handle.counts.transcripts).toBeLessThan(fullCrawlListCalls);
    expect(handle.counts.transcripts).toBe(1);
    expect(handle.counts.transcript).toBe(0);

    // Store state didn't grow.
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);
    expect(fake.kv.entries.size).toBe(SEED_COUNT + 1);
  });

  test("adding one transcript to the mock seed at runtime → incremental sync picks up exactly 1", async () => {
    _resetConnectorSchemaMemoForTests();
    const fake = makeFakeTinyCloud({ did: "did:test:sync-incremental" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });

    // 1) Sync the baseline seed into a fresh fake.
    handle.resetCounters();
    const first = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
      allowMissingConnection: true,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.added).toBe(SEED_COUNT);
    const baseline = fake.sql.meetings.size;
    expect(baseline).toBe(SEED_COUNT);

    // 2) Mutate the shared seed — unshift a NEW newest transcript. The mock
    // closes over `seed` by reference, so the next request sees it.
    const newTxId = "mock-tx-incremental-new";
    const newTx: SeedTranscript = {
      id: newTxId,
      title: "Incremental new meeting",
      date: Date.now(),
      duration: 20,
      organizer_email: "new@example.com",
      speakers: [{ id: 1, name: "Ada" }],
      meeting_attendees: [{ displayName: "Ada", email: "ada@example.com" }],
      sentences: [
        { index: 0, speaker_name: "Ada", text: "hello world", start_time: 0, end_time: 900 },
      ],
      summary: {
        keywords: ["new"],
        action_items: "Ship it",
        overview: "Overview new",
        meeting_type: "internal-sync",
      },
    };
    seed.unshift(newTx);

    try {
      handle.resetCounters();
      const second = await syncFireflies({
        client,
        store: connectorStore,
        tcw: fake.tcw,
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.data.added).toBe(1);
        expect(second.data.skipped).toBe(0);
        expect(second.data.errors).toEqual([]);
      }
      // Exactly one detail fetch — the one new id.
      expect(handle.counts.transcript).toBe(1);
      expect(fake.sql.meetings.size).toBe(baseline + 1);

      // Row + KV body for the new transcript are present and correct.
      const rows = Array.from(fake.sql.meetings.values()).filter(
        (r) => r.source_id === newTxId,
      );
      expect(rows.length).toBe(1);
      const kvKey = transcriptKvKey("fireflies", newTxId);
      const body = fake.kv.entries.get(kvKey);
      expect(body).toBeDefined();
      const parsed = JSON.parse(body!) as { text: string }[];
      expect(parsed[0].text).toBe("hello world");
    } finally {
      // Restore the seed so downstream tests (and reruns in the same process)
      // see the original SEED_COUNT-sized set.
      const idx = seed.findIndex((t) => t.id === newTxId);
      if (idx >= 0) seed.splice(idx, 1);
      expect(seed.length).toBe(SEED_COUNT);
    }
  });

  test("duration cross-check: the seeded mismatch stores metadata.duration_source === 'sentences'", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();
    const fake = makeFakeTinyCloud({ did: "did:test:sync-duration-check" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });

    const res = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
      allowMissingConnection: true,
    });
    expect(res.ok).toBe(true);

    const mismatchSeed = seed[DURATION_MISMATCH_INDEX];
    // Sanity re-check the seed invariant so a mock change can't produce a
    // false green here — cross-check trigger requires |dur*60 - lastEnd| > 120.
    const lastEnd = mismatchSeed.sentences[mismatchSeed.sentences.length - 1].end_time;
    expect(Math.abs(mismatchSeed.duration * 60 - lastEnd)).toBeGreaterThan(120);

    const row = Array.from(fake.sql.meetings.values()).find(
      (r) => r.source_id === mismatchSeed.id,
    );
    expect(row).toBeDefined();
    const metadata = JSON.parse(row!.metadata) as { duration_source?: string };
    expect(metadata.duration_source).toBe("sentences");
    // duration_secs preferred the sentence end (1800) over raw*60 (300).
    expect(row!.duration_secs).toBe(Math.round(lastEnd));

    // Sanity: at least one OTHER meeting has no duration_source override
    // (i.e. the raw `duration * 60` path is exercised for the majority).
    let overrideCount = 0;
    for (const r of fake.sql.meetings.values()) {
      const m = JSON.parse(r.metadata) as { duration_source?: string };
      if (m.duration_source === "sentences") overrideCount += 1;
    }
    expect(overrideCount).toBe(1);
  });
  test("failed and partial updates preserve the SQL success watermark, including first insert", async () => {
    _resetConnectorSchemaMemoForTests();
    const fake = makeFakeTinyCloud({ did: "did:test:sync-preserve-watermark" });
    const initialPartial = await connectorStore.updateSyncState(fake.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: null,
      lastSyncStatus: "partial",
      lastSyncError: "listing cap",
      itemCount: 0,
      preserveLastSyncedAt: true,
    });
    expect(initialPartial.ok).toBe(true);
    expect(fake.sql.states.get("fireflies")?.last_synced_at).toBeNull();

    const lastSuccess = "2026-10-09T02:49:00.000Z";
    const success = await connectorStore.updateSyncState(fake.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: lastSuccess,
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 1,
    });
    expect(success.ok).toBe(true);
    const laterPartial = await connectorStore.updateSyncState(fake.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: null,
      lastSyncStatus: "partial",
      lastSyncError: "item error",
      itemCount: 1,
      preserveLastSyncedAt: true,
    });

    expect(laterPartial.ok).toBe(true);
    expect(fake.sql.states.get("fireflies")?.last_synced_at).toBe(lastSuccess);
    expect(fake.sql.states.get("fireflies")?.last_sync_status).toBe("partial");
  });
  test("persisted listing continuation reconciles a 600-transcript NULL-watermark history", async () => {
    _resetConnectorSchemaMemoForTests();
    const largeSeed = buildSeed(600) as SeedTranscript[];
    const largeHandle = await startMockFireflies({ mode: "happy", seed: largeSeed }) as unknown as Handle;
    const fake = makeFakeTinyCloud({ did: "did:test:sync-600-continuation" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: largeHandle.url,
      delayMs: 0,
    });
    try {
      for (let run = 0; run < 20 && fake.sql.states.get("fireflies")?.last_sync_status !== "ok"; run++) {
        const result = await syncFireflies({
          client,
          store: connectorStore,
          tcw: fake.tcw,
          allowMissingConnection: true,
        });
        expect(result.ok).toBe(true);
      }
      expect(fake.sql.meetings.size).toBe(600);
      expect(fake.sql.states.get("fireflies")?.last_sync_status).toBe("ok");
      expect(new Set([...fake.sql.meetings.values()].map((row) => row.source_id)).size).toBe(600);
      expect(transcriptBodyKeys(fake).size).toBe(600);
    } finally {
      await largeHandle.stop();
    }
  });

  test("stale-watermark continuation reaches a hole after 500 known summaries", async () => {
    _resetConnectorSchemaMemoForTests();
    const now = Date.now();
    const staleSeed = buildSeed(800) as SeedTranscript[];
    staleSeed.forEach((item, index) => {
      item.date = Math.floor((now - index * 2 * 60_000) / 1000);
    });
    const staleHandle = await startMockFireflies({ mode: "happy", seed: staleSeed }) as unknown as Handle;
    const fake = makeFakeTinyCloud({ did: "did:test:sync-stale-continuation" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: staleHandle.url,
      delayMs: 0,
    });
    const lastSuccess = new Date(now - 30 * 60_000).toISOString();
    try {
      for (const item of staleSeed.slice(0, 510)) {
        const { meeting, sentences } = connectorStore.normalizeFirefliesTranscript(item);
        expect((await connectorStore.insertMeeting(fake.tcw, meeting)).ok).toBe(true);
        expect((await connectorStore.putTranscriptBody(fake.tcw, "fireflies", item.id, sentences)).ok).toBe(true);
      }
      expect((await connectorStore.updateSyncState(fake.tcw, {
        connectorId: "fireflies",
        status: "connected",
        lastSyncedAt: lastSuccess,
        lastSyncStatus: "ok",
        lastSyncError: null,
        itemCount: 510,
      })).ok).toBe(true);

      const first = await syncFireflies({ client, store: connectorStore, tcw: fake.tcw });
      expect(first.ok).toBe(true);
      expect(fake.sql.meetings.size).toBe(510);
      expect(fake.sql.states.get("fireflies")?.last_sync_status).toBe("partial");

      const second = await syncFireflies({ client, store: connectorStore, tcw: fake.tcw });
      expect(second.ok).toBe(true);
      expect(fake.sql.meetings.size).toBe(560);
      expect([...fake.sql.meetings.values()].some((row) => row.source_id === staleSeed[510]!.id)).toBe(true);
      for (let run = 0; run < 10 && fake.sql.states.get("fireflies")?.last_sync_status !== "ok"; run++) {
        expect((await syncFireflies({ client, store: connectorStore, tcw: fake.tcw })).ok).toBe(true);
      }
      expect(fake.sql.meetings.size).toBe(735);
      expect(fake.sql.states.get("fireflies")?.last_sync_status).toBe("ok");
      expect(transcriptBodyKeys(fake).size).toBe(735);
    } finally {
      await staleHandle.stop();
    }
  });
  test("delete-data Disconnect waits for an in-flight body put and leaves no resurrected data", async () => {
    _resetConnectorSchemaMemoForTests();
    const transcript = (buildSeed(1) as SeedTranscript[])[0]!;
    const disconnectHandle = await startMockFireflies({
      mode: "happy",
      seed: [transcript],
    }) as unknown as Handle;
    const fake = makeFakeTinyCloud({ did: "did:test:sync-disconnect-put-barrier" });
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: disconnectHandle.url,
      delayMs: 0,
    });
    const putStarted = Promise.withResolvers<void>();
    const releasePut = Promise.withResolvers<void>();
    const key = transcriptKvKey("fireflies", transcript.id);
    fake.kv.putHook = async (putKey) => {
      if (putKey !== key) return;
      putStarted.resolve();
      await releasePut.promise;
    };
    try {
      expect((await connectorStore.updateSyncState(fake.tcw, {
        connectorId: "fireflies",
        status: "connected",
        lastSyncedAt: null,
        lastSyncStatus: "ok",
        lastSyncError: null,
        itemCount: 0,
      })).ok).toBe(true);
      const sync = syncFireflies({ client, store: connectorStore, tcw: fake.tcw });
      await putStarted.promise;

      let disconnectSettled = false;
      const disconnectDeps: DisconnectDeps = {
        connectorId: "fireflies",
        source: "fireflies",
        mode: "delete-data",
        webhooks: {
          recordPurge: async () => ({ status: "ok", value: null }),
          disable: async () => ({ status: "ok", value: { status: "disabled", queueDropped: 0 } }),
        },
        secrets: {
          isUnlocked: () => true,
          unlock: async () => ({ ok: true }),
          deleteKey: async () => ({ ok: true }),
        },
        store: {
          listKnownSourceIds: () => connectorStore.listKnownSourceIds(fake.tcw, "fireflies"),
          purgeConnector: () => connectorStore.purgeConnector(fake.tcw, "fireflies"),
          getConnection: () => connectorStore.getConnection(fake.tcw, "fireflies"),
          countMeetings: () => connectorStore.countMeetings(fake.tcw, "fireflies"),
          updateSyncState: (input) => connectorStore.updateSyncState(fake.tcw, input),
        },
      };
      const disconnected = runDisconnect(
        disconnectDeps,
        () => {},
        initialDisconnectProgress("delete-data"),
      ).then((progress) => {
        disconnectSettled = true;
        return progress;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disconnectSettled).toBe(false);

      releasePut.resolve();
      const [syncResult, disconnectResult] = await Promise.all([sync, disconnected]);
      expect(syncResult.ok).toBe(true);
      expect(disconnectResult.done).toBe(true);
      expect(fake.kv.entries.has(key)).toBe(false);
      expect([...fake.sql.meetings.values()].some((row) => row.source_id === transcript.id)).toBe(false);
      expect(fake.sql.states.has("fireflies")).toBe(false);
    } finally {
      releasePut.resolve();
      await disconnectHandle.stop();
    }
  });
});
