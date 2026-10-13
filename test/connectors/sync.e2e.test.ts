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
  const calls: { operation: "list" | "detail"; id?: string; skip?: number }[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { id?: string; limit?: number; skip?: number };
    };
    if (request.query.includes("ListTranscripts")) {
      const skip = request.variables?.skip ?? 0;
      const limit = request.variables?.limit ?? 50;
      calls.push({ operation: "list", skip });
      return new Response(JSON.stringify({
        data: { transcripts: seed.slice(skip, skip + limit).map(({ sentences: _s, summary: _m, speakers: _p, meeting_attendees: _a, ...row }) => row) },
      }), { headers: { "content-type": "application/json" } });
    }
    const id = request.variables?.id ?? "";
    calls.push({ operation: "detail", id });
    if (permanentlyFailing.has(id)) {
      return new Response(JSON.stringify({ errors: [{ message: "persistently unavailable" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    const queued = failures.get(id);
    if (queued?.length) return queued.shift()!;
    const transcript = seed.find((item) => item.id === id) ?? null;
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
    failNext(id: string, responses: Response[]) { failures.set(id, responses); },
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
  }));
  fake.kv.deleteErrors.set(firefliesAttemptKvKey(), {
    code: "KV_ERROR",
    message: "record clear unavailable",
  });

  const provider = makeInMemoryFireflies(items);
  expect((await runEngine(provider.client, fake)).ok).toBe(true);

  expect(requiredSyncState(fake).status).toBe("connected");
  expect(fake.sql.meetings.size).toBe(items.length);
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
