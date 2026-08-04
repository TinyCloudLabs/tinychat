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
//   3. Second sync no-op — early-exit fires on the first list page, so the
//      mock sees FEWER list calls than a full crawl (1 vs the 2 pages needed
//      for a full crawl of 30 items at batchSize 25), zero detail fetches,
//      and `added === 0`.
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
  transcriptKvKey,
} from "../../frontend/src/lib/connectors/connectorStore";
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
    expect(fake.kv.entries.size).toBe(SEED_COUNT);

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
    expect(fake.kv.entries.size).toBe(1);
  });

  test("second sync is a no-op via early-exit — 0 added, mock sees fewer list calls than a full crawl", async () => {
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
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.added).toBe(SEED_COUNT);

    // Baseline: how many list pages did the full crawl need? Vacuity guard —
    // must be > 1 for "fewer" to be a meaningful assertion.
    const fullCrawlListCalls = handle.counts.transcripts;
    expect(fullCrawlListCalls).toBeGreaterThan(1);

    // Now the no-op run — everything is known, so the paginator early-exits
    // on the very first page as soon as it hits a known id.
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

    // Mock saw fewer list calls than the full crawl (exactly one — page 1 hits
    // a known id and breaks). And zero detail fetches, because there was
    // nothing new to fetch.
    expect(handle.counts.transcripts).toBeLessThan(fullCrawlListCalls);
    expect(handle.counts.transcripts).toBe(1);
    expect(handle.counts.transcript).toBe(0);

    // Store state didn't grow.
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);
    expect(fake.kv.entries.size).toBe(SEED_COUNT);
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
      date: Date.parse("2026-08-01T10:00:00.000Z"),
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
});
