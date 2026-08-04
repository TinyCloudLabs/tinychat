// E2E driver: disconnect + purge. See docs/connectors-spec.md §10 driver 4.
//
// Real syncFireflies + real connectorStore + real connectorSecrets wrappers
// against fake-tinycloud and the mock Fireflies upstream over REAL HTTP.
// delayMs:0 collapses all sync-loop waits so the file runs well under the cap.
//
// What this driver covers:
//   1. Vacuity guard — SEED_COUNT > 0, and after a real initial sync the fake
//      surfaces actually hold non-zero rows (SQL meetings, KV transcripts,
//      state row) AND the fake secrets hold the connector's API key. Every
//      assertion below is meaningless if this baseline is zero.
//   2. Disconnect WITHOUT purge — deleteConnectorKey removes the secret from
//      the scoped path, but SQL meeting rows, KV transcript bodies, and the
//      connector_state row all survive byte-for-byte (data-retention promise
//      from spec §9: "Also delete… (default OFF)").
//   3. Disconnect WITH purge — deleteConnectorKey + purgeConnector wipes the
//      meetings table for that source, every KV transcript key, and the
//      connector_state row for the connector. Nothing else in the store is
//      touched (other sources — none here, but the source-scoped DELETE is
//      what protects them).
//   4. Reconnect + sync after purge — saving the key again + running
//      syncFireflies re-syncs from a truly empty state. added === SEED_COUNT,
//      the row / KV counts return to the initial-sync baseline, the state row
//      is recreated. Proves purge left no stragglers that would suppress a
//      re-sync via app-level dedup.
//
// Sanity guard on the assertion in step 2: with SEED_COUNT rows on the wire,
// "leaves SQL rows + KV bodies intact" is only meaningful because we assert
// the exact SEED_COUNT baseline first — a broken store that quietly loses
// rows during connect would still trivially pass "== 0 after" without it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { FirefliesClient } from "../../frontend/src/lib/connectors/firefliesClient";
import * as connectorStore from "../../frontend/src/lib/connectors/connectorStore";
import {
  _resetConnectorSchemaMemoForTests,
  transcriptKvKey,
} from "../../frontend/src/lib/connectors/connectorStore";
import {
  deleteConnectorKey,
  saveConnectorKey,
  unlockSecrets,
} from "../../frontend/src/lib/connectors/connectorSecrets";
import { syncFireflies } from "../../frontend/src/lib/connectors/firefliesSync";
import { CONNECTORS } from "../../frontend/src/lib/connectors/registry";
import type { ConnectorDescriptor } from "../../frontend/src/lib/connectors/types";

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

const FIREFLIES: ConnectorDescriptor = CONNECTORS.find(
  (c) => c.id === "fireflies",
)!;

const HAPPY_KEY = "sk-fire-disconnect-e2e";

let handle: Handle;

beforeAll(async () => {
  handle = (await startMockFireflies({
    mode: "happy",
    seed: buildSeed(),
  })) as unknown as Handle;
});

afterAll(async () => {
  await handle.stop();
});

describe("disconnect + purge e2e (spec §10 driver 4)", () => {
  test("vacuity guard — SEED_COUNT > 0 AND the mock serves > 0 transcripts over real HTTP", async () => {
    expect(SEED_COUNT).toBeGreaterThan(0);
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

  test("disconnect WITHOUT purge deletes the secret only — SQL rows + KV bodies + state row all survive", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();
    const fake = makeFakeTinyCloud({ did: "did:test:disconnect-no-purge" });

    // Connect: unlock + save key. Both are Result-shaped; we want a real key
    // in real fake storage before we sync — this is the disconnect precondition.
    const unlocked = await unlockSecrets(fake.tcw);
    expect(unlocked.ok).toBe(true);
    const saved = await saveConnectorKey(fake.tcw, FIREFLIES, HAPPY_KEY);
    expect(saved.ok).toBe(true);
    expect(fake.secrets.has(FIREFLIES.secretScope, FIREFLIES.secretName)).toBe(true);

    // Sync: real engine, real store, real HTTP to mock.
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });
    const first = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.added).toBe(SEED_COUNT);

    // Vacuity guard for the "survives" assertion — every surface must be
    // non-zero BEFORE the disconnect for the after-check to prove anything.
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);
    expect(fake.sql.meetings.size).toBeGreaterThan(0);
    expect(fake.kv.entries.size).toBe(SEED_COUNT);
    expect(fake.sql.states.get("fireflies")).toBeDefined();

    // Snapshot every SQL row + KV body so we can assert byte-for-byte equality.
    const meetingsBefore = new Map(
      Array.from(fake.sql.meetings.entries()).map(([k, v]) => [k, { ...v }]),
    );
    const kvBefore = new Map(fake.kv.entries);
    const stateBefore = { ...fake.sql.states.get("fireflies")! };

    // Disconnect WITHOUT purge — the full ConnectorDisconnectDialog flow when
    // the "Also delete N meetings" checkbox is OFF (the default): delete the
    // secret, then flip the state row to status=disconnected preserving the
    // lastSyncedAt so a reconnect shows the true "last synced" instead of
    // "Not synced yet". This mirrors ConnectorDialog.handleConfirm.
    const deleted = await deleteConnectorKey(fake.tcw, FIREFLIES);
    expect(deleted.ok).toBe(true);
    const existingRes = await connectorStore.getConnection(fake.tcw, "fireflies");
    expect(existingRes.ok).toBe(true);
    if (!existingRes.ok) throw new Error("unreachable");
    const existing = existingRes.data;
    expect(existing).not.toBeNull();
    const preservedSyncedAt = existing!.lastSyncedAt;
    const preservedStatus = existing!.lastSyncStatus;
    expect(preservedSyncedAt).toBeTruthy();
    const remainingCountRes = await connectorStore.countMeetings(fake.tcw, "fireflies");
    expect(remainingCountRes.ok).toBe(true);
    if (!remainingCountRes.ok) throw new Error("unreachable");
    const upd = await connectorStore.updateSyncState(fake.tcw, {
      connectorId: "fireflies",
      status: "disconnected",
      lastSyncedAt: preservedSyncedAt,
      lastSyncStatus: preservedStatus,
      lastSyncError: null,
      itemCount: remainingCountRes.data,
    });
    expect(upd.ok).toBe(true);

    // Secret is gone from the scoped path.
    expect(fake.secrets.has(FIREFLIES.secretScope, FIREFLIES.secretName)).toBe(false);

    // Meetings + KV bodies survive byte-for-byte — the "keep data" promise.
    expect(fake.sql.meetings.size).toBe(meetingsBefore.size);
    for (const [id, before] of meetingsBefore) {
      expect(fake.sql.meetings.get(id)).toEqual(before);
    }
    expect(fake.kv.entries.size).toBe(kvBefore.size);
    for (const [k, v] of kvBefore) {
      expect(fake.kv.entries.get(k)).toBe(v);
    }

    // State row: status flipped to disconnected but lastSyncedAt preserved so
    // the card shows the real "Last synced …" after reconnect instead of a
    // misleading "Not synced yet".
    const afterRes = await connectorStore.getConnection(fake.tcw, "fireflies");
    expect(afterRes.ok).toBe(true);
    if (!afterRes.ok) throw new Error("unreachable");
    const after = afterRes.data;
    expect(after).not.toBeNull();
    expect(after!.status).toBe("disconnected");
    expect(after!.lastSyncedAt).toBe(preservedSyncedAt);
    expect(after!.lastSyncStatus).toBe(preservedStatus);
    expect(after!.itemCount).toBe(stateBefore.item_count);
  });

  test("disconnect WITH purge removes meetings rows + KV transcript keys + state row", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();
    const fake = makeFakeTinyCloud({ did: "did:test:disconnect-with-purge" });

    // Connect + sync — real path.
    expect((await unlockSecrets(fake.tcw)).ok).toBe(true);
    expect((await saveConnectorKey(fake.tcw, FIREFLIES, HAPPY_KEY)).ok).toBe(true);
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });
    const synced = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });
    expect(synced.ok).toBe(true);
    if (synced.ok) expect(synced.data.added).toBe(SEED_COUNT);

    // Vacuity guard: baseline must be non-zero for "removes" to mean anything.
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);
    expect(fake.kv.entries.size).toBe(SEED_COUNT);
    expect(fake.sql.states.get("fireflies")).toBeDefined();
    expect(fake.secrets.has(FIREFLIES.secretScope, FIREFLIES.secretName)).toBe(true);

    // Grab the exact KV keys that must go away — asserts we don't leave a
    // stray transcript body behind, which would defeat the "delete synced
    // meetings from my space" UI promise.
    const transcriptKeysBefore = Array.from(fake.kv.entries.keys()).filter((k) =>
      k.startsWith(`${connectorStore.CONNECTORS_KV_PREFIX}/fireflies/transcript/`),
    );
    expect(transcriptKeysBefore.length).toBe(SEED_COUNT);

    // Disconnect WITH purge — the checkbox-checked path from spec §9.
    const deleted = await deleteConnectorKey(fake.tcw, FIREFLIES);
    expect(deleted.ok).toBe(true);
    const purged = await connectorStore.purgeConnector(fake.tcw, "fireflies");
    expect(purged.ok).toBe(true);

    // Secret gone.
    expect(fake.secrets.has(FIREFLIES.secretScope, FIREFLIES.secretName)).toBe(false);

    // Every meeting row for source=fireflies is gone.
    expect(fake.sql.meetings.size).toBe(0);
    for (const row of fake.sql.meetings.values()) {
      expect(row.source).not.toBe("fireflies");
    }

    // Every KV transcript key for fireflies is gone.
    for (const k of transcriptKeysBefore) {
      expect(fake.kv.entries.has(k)).toBe(false);
    }
    const survivorTranscriptKeys = Array.from(fake.kv.entries.keys()).filter((k) =>
      k.startsWith(`${connectorStore.CONNECTORS_KV_PREFIX}/fireflies/transcript/`),
    );
    expect(survivorTranscriptKeys.length).toBe(0);

    // State row for fireflies is gone.
    expect(fake.sql.states.get("fireflies")).toBeUndefined();

    // Post-purge invariants for reconnect: getConnection returns null and
    // countMeetings is 0, which is what the next reconnect + sync depends on.
    const connRes = await connectorStore.getConnection(fake.tcw, "fireflies");
    expect(connRes.ok && connRes.data === null).toBe(true);
    const countRes = await connectorStore.countMeetings(fake.tcw, "fireflies");
    expect(countRes.ok && countRes.data === 0).toBe(true);
    const idsRes = await connectorStore.listKnownSourceIds(fake.tcw, "fireflies");
    expect(idsRes.ok).toBe(true);
    if (idsRes.ok) expect(idsRes.data).toEqual([]);
  });

  test("reconnect + sync after purge re-syncs from scratch — added === SEED_COUNT again", async () => {
    _resetConnectorSchemaMemoForTests();
    handle.resetCounters();
    const fake = makeFakeTinyCloud({ did: "did:test:disconnect-reconnect" });

    // First cycle: connect + sync + purge to reach a truly empty state.
    expect((await unlockSecrets(fake.tcw)).ok).toBe(true);
    expect((await saveConnectorKey(fake.tcw, FIREFLIES, HAPPY_KEY)).ok).toBe(true);
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });
    const first = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.added).toBe(SEED_COUNT);
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);

    // Purge — same call the UI-with-checkbox-checked path issues.
    expect((await deleteConnectorKey(fake.tcw, FIREFLIES)).ok).toBe(true);
    expect((await connectorStore.purgeConnector(fake.tcw, "fireflies")).ok).toBe(true);

    // Vacuity guard: the store is actually empty before the reconnect.
    expect(fake.sql.meetings.size).toBe(0);
    expect(fake.kv.entries.size).toBe(0);
    expect(fake.sql.states.get("fireflies")).toBeUndefined();
    expect(fake.secrets.has(FIREFLIES.secretScope, FIREFLIES.secretName)).toBe(false);

    // Reconnect + re-sync — key put back, engine run against the SAME seed.
    expect((await saveConnectorKey(fake.tcw, FIREFLIES, HAPPY_KEY)).ok).toBe(true);
    handle.resetCounters();
    const second = await syncFireflies({
      client,
      store: connectorStore,
      tcw: fake.tcw,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      // Full re-sync from scratch — added is SEED_COUNT again, not 0. If purge
      // had left a stray known source_id behind, app-level dedup would have
      // suppressed inserts and `added` would be < SEED_COUNT.
      expect(second.data.added).toBe(SEED_COUNT);
      expect(second.data.skipped).toBe(0);
      expect(second.data.errors).toEqual([]);
    }

    // Row + KV counts back to the initial-sync baseline exactly.
    expect(fake.sql.meetings.size).toBe(SEED_COUNT);
    expect(fake.kv.entries.size).toBe(SEED_COUNT);

    // KV transcript keys are the SEED_COUNT expected keys, one per source id.
    const seed = buildSeed() as { id: string }[];
    for (const t of seed) {
      const key = transcriptKvKey("fireflies", t.id);
      expect(fake.kv.entries.has(key)).toBe(true);
    }

    // State row is recreated with the full count + ok status.
    const state = fake.sql.states.get("fireflies");
    expect(state).toBeDefined();
    expect(state!.item_count).toBe(SEED_COUNT);
    expect(state!.last_sync_status).toBe("ok");
    expect(state!.last_sync_error).toBeNull();

    // Mock actually served the full crawl again (vacuity — not a cache-hit).
    expect(handle.counts.transcript).toBe(SEED_COUNT);
    expect(handle.counts.transcripts).toBeGreaterThan(0);
  });
});
