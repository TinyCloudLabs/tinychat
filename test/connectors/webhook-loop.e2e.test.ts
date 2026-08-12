// E2E driver: the Option-C webhook loop, end to end. Task E2E1.
//
// Every layer below is the REAL one, wired together over REAL HTTP:
//
//   Fireflies              → the mock upstream (`mock-fireflies.mjs`) on an ephemeral port
//   the delivery endpoint  → the production public route + `WebhookTokenService` +
//                            `ConnectorQueue` + `ConnectorControlStore` + `ConnectorDrainWorker`,
//                            assembled by `connector-webhook-loop-harness.ts`
//   the browser's client   → `frontend/src/lib/connectors/webhooksApi.ts` (the typed companion
//                            client — every backend call in this file goes through it)
//   the browser's ingest   → `frontend/src/lib/connectors/targetedSync.ts` + the real
//                            `connectorStore` + the real `connectorSecrets`, against
//                            `fake-tinycloud`
//
// The only fakes are the two storage layers (`FakeBackendNode` for the backend's own KV,
// `fake-tinycloud` for the user's space) and session auth. Nothing here mocks the queue, the
// HMAC, the routes, the ack, or the ingest engine — those ARE the subject.
//
// What this driver covers (handoff §"Acceptance criteria", Browser processing / Provider and
// delivery / Lifecycle rows):
//   1. Vacuity guard — the mock serves the target transcript AND the companions are mounted and
//      authenticated, so nothing below can be a false green over a dead rig.
//   2. One signed delivery → 202 → queued → `GET /pending` shows it for the CORRECT user only.
//   3. Targeted ingest fetches that EXACT id (never lists), writes SQL + KV, acks AFTER the
//      write, and the queue no longer contains it.
//   4. A `meeting.summarized` event UPDATES an existing meeting's summary — the same event the
//      v1 engine (asserted here) skips forever.
//   5. Duplicate deliveries produce ONE queue identity per `(meetingId, kind)`.
//   6. Two-user isolation: A's token, secret, config, queue and acks cannot affect B.
//   7. A replay after a purge does not resurface the purged meeting — V2 and legacy shapes.
//   8. A lost ack RESPONSE converges: the retry settles idempotently and stores no duplicate.
//   9. A storage failure leaves the identity queued and sends NO ack.
//
// Determinism: no real network beyond loopback, no browser, no sleeps. The queue runs with a
// zero coalescing window (its 250 ms window is `connector-queue.test.ts`'s contract) and the
// Fireflies client with `delayMs: 0`, exactly as the other drivers do.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { SessionStore } from "@tinyboilerplate/client";

import {
  deliverWebhook,
  signDelivery,
  startWebhookLoopBackend,
  type CompanionRequestLog,
  type WebhookLoopBackend,
} from "../../backend/src/__tests__/connector-webhook-loop-harness";

import { FirefliesClient } from "../../frontend/src/lib/connectors/firefliesClient";
import * as connectorStore from "../../frontend/src/lib/connectors/connectorStore";
import {
  _resetConnectorSchemaMemoForTests,
  transcriptKvKey,
} from "../../frontend/src/lib/connectors/connectorStore";
import { syncFireflies } from "../../frontend/src/lib/connectors/firefliesSync";
import {
  saveConnectorKey,
  unlockSecrets,
} from "../../frontend/src/lib/connectors/connectorSecrets";
import { CONNECTORS } from "../../frontend/src/lib/connectors/registry";
import {
  createConnectorWebhooksClient,
  type ConnectorAckRequest,
  type ConnectorAckResult,
  type ConnectorWebhooksClient,
  type ConnectorWebhooksResult,
} from "../../frontend/src/lib/connectors/webhooksApi";
import {
  ingestQueuedMeetings,
  type TargetedQueueItem,
} from "../../frontend/src/lib/connectors/targetedSync";
import type { ConnectorDescriptor } from "../../frontend/src/lib/connectors/types";

import { makeFakeTinyCloud, type FakeTinyCloud } from "./fake-tinycloud";
import { buildSeed, startMockFireflies } from "./mock-fireflies.mjs";

interface MockHandle {
  url: string;
  port: number;
  seed: SeedTranscript[];
  counts: Record<string, number>;
  resetCounters: () => void;
  stop: () => Promise<void>;
}

interface SeedTranscript {
  id: string;
  title: string;
  summary: {
    keywords: string[];
    action_items: string;
    overview: string;
    meeting_type: string;
  } | null;
}

const FIREFLIES: ConnectorDescriptor = CONNECTORS.find((c) => c.id === "fireflies")!;

const HAPPY_KEY = "sk-fire-webhook-loop-e2e";
/** The newest seeded transcript — the v1 engine early-exits on it, which driver 4 leans on. */
const TARGET_ID = "mock-tx-030";
const OTHER_ID = "mock-tx-029";

/**
 * A FRESH address per user per test. The harness keeps one backend for the whole file (the
 * routes, the token cache and the queue are all per-instance state worth exercising across
 * tests), so isolation comes from the address — which is also the isolation the product
 * relies on.
 */
let addressSeq = 0;
function nextAddress(): string {
  addressSeq += 1;
  return `0x${addressSeq.toString(16).padStart(40, "0")}`;
}

let backend: WebhookLoopBackend;
let handle: MockHandle;
let seed: SeedTranscript[];

/** Installed per test that needs to observe the companion request stream. */
let companionProbe: ((info: CompanionRequestLog) => void) | null = null;

beforeAll(async () => {
  seed = buildSeed() as SeedTranscript[];
  handle = (await startMockFireflies({ mode: "happy", seed })) as unknown as MockHandle;
  backend = await startWebhookLoopBackend({
    onCompanionRequest: (info) => companionProbe?.(info),
  });
});

afterAll(async () => {
  companionProbe = null;
  await backend.stop();
  await handle.stop();
});

beforeEach(() => {
  companionProbe = null;
  handle.resetCounters();
  _resetConnectorSchemaMemoForTests();
});

// ── rig helpers ──────────────────────────────────────────────────────

/** A signed-in companion client for `address` — the same module the card uses. */
function signIn(address: string): ConnectorWebhooksClient {
  const token = backend.signIn(address);
  const sessionStore = {
    getToken: () => token,
    isExpired: () => false,
    clear: () => {},
  } as unknown as SessionStore;
  return createConnectorWebhooksClient(backend.baseUrl, { sessionStore });
}

interface EnabledUser {
  client: ConnectorWebhooksClient;
  url: string;
  secret: string;
}

/** Mint a routing token and keep the one-time delivery secret in local scope only. */
async function enable(address: string): Promise<EnabledUser> {
  const client = signIn(address);
  const res = await client.enable();
  expect(res.status).toBe("ok");
  if (res.status !== "ok") throw new Error("enable failed");
  expect(res.value.url).not.toBeNull();
  expect(res.value.secret).not.toBeNull();
  return { client, url: res.value.url!, secret: res.value.secret! };
}

/** A user's space, with the Fireflies key stored where only the browser can read it. */
async function browserSpace(did: string): Promise<FakeTinyCloud> {
  const fake = makeFakeTinyCloud({ did });
  const unlocked = await unlockSecrets(fake.tcw);
  expect(unlocked.ok).toBe(true);
  const saved = await saveConnectorKey(fake.tcw, FIREFLIES, HAPPY_KEY);
  expect(saved.ok).toBe(true);
  return fake;
}

/**
 * Wrap a fake space's SQL/KV surfaces so overlapping calls are observable.
 *
 * §9.3: TinyCloud DROPS concurrent responses on one space, so "writes sequentially" is a real
 * requirement and not a style note. Each wrapper increments a counter before the call and
 * decrements it in a `finally` the caller's own `await` resumes behind — so an engine that
 * issued two storage calls without awaiting the first would leave `max` at 2.
 */
function sequentialWriteProbe(fake: FakeTinyCloud): { max: number } {
  const probe = { max: 0 };
  let inFlight = 0;
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    probe.max = Math.max(probe.max, inFlight);
    return Promise.resolve()
      .then(run)
      .finally(() => {
        inFlight -= 1;
      });
  };

  const tcw = fake.tcw as unknown as {
    kv: {
      get(key: string): Promise<unknown>;
      put(key: string, value: unknown): Promise<unknown>;
      delete(key: string): Promise<unknown>;
    };
    sql: {
      db(name: string): {
        query(sql: string, params?: unknown[]): Promise<unknown>;
        execute(sql: string, params?: unknown[]): Promise<unknown>;
        batch(stmts: { sql: string; params?: unknown[] }[]): Promise<unknown>;
      };
    };
  };

  const kv = tcw.kv;
  const kvGet = kv.get.bind(kv);
  const kvPut = kv.put.bind(kv);
  const kvDelete = kv.delete.bind(kv);
  kv.get = (key) => track(() => kvGet(key));
  kv.put = (key, value) => track(() => kvPut(key, value));
  kv.delete = (key) => track(() => kvDelete(key));

  const openDb = tcw.sql.db.bind(tcw.sql);
  tcw.sql.db = (name) => {
    const db = openDb(name);
    return {
      query: (sql, params) => track(() => db.query(sql, params)),
      execute: (sql, params) => track(() => db.execute(sql, params)),
      batch: (stmts) => track(() => db.batch(stmts)),
    };
  };

  return probe;
}

async function pendingItems(
  client: ConnectorWebhooksClient,
): Promise<TargetedQueueItem[]> {
  const res = await client.getPending();
  expect(res.status).toBe("ok");
  if (res.status !== "ok") throw new Error("pending failed");
  expect(res.value.surfaceBlocked).toBeUndefined();
  return res.value.pending.map((item) => ({
    meetingId: item.meetingId,
    kind: item.kind,
  }));
}

async function pendingCount(client: ConnectorWebhooksClient): Promise<number> {
  const res = await client.getPending();
  expect(res.status).toBe("ok");
  if (res.status !== "ok") throw new Error("pending failed");
  return res.value.count;
}

/** Run the real targeted-ingest engine against the real store and the mock upstream. */
function ingest(
  fake: FakeTinyCloud,
  webhooks: { acknowledge: ConnectorWebhooksClient["acknowledge"] },
  items: TargetedQueueItem[],
) {
  return ingestQueuedMeetings({
    tcw: fake.tcw,
    descriptor: FIREFLIES,
    items,
    webhooks,
    // The key comes from the user's own vault through the real `connectorSecrets` path; the
    // client is built here only so it talks to the mock upstream with pacing collapsed.
    createClient: (apiKey) =>
      new FirefliesClient({ apiKey, apiUrl: handle.url, delayMs: 0 }),
    sleepImpl: async () => {},
  });
}

/** Deliver one V2 `meeting.transcribed`/`meeting.summarized` event and expect the 202. */
async function deliverQueued(
  user: EnabledUser,
  event: string,
  meetingId: string,
): Promise<void> {
  const res = await deliverWebhook({
    url: user.url,
    secret: user.secret,
    event,
    meetingId,
  });
  expect(res.status).toBe(202);
  expect(res.text).toBe(JSON.stringify({ status: "queued" }));
}

// ── 1. vacuity guard ─────────────────────────────────────────────────

describe("webhook loop e2e (E2E1)", () => {
  test("vacuity guard — the mock serves the target transcript AND the companions are live", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HAPPY_KEY}`,
      },
      body: JSON.stringify({
        query:
          "query GetTranscript($id: String!) { transcript(id: $id) { id title sentences { index text } } }",
        variables: { id: TARGET_ID },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { transcript?: { id?: string } } };
    expect(body.data?.transcript?.id).toBe(TARGET_ID);

    // The companion mount exists and is authenticated — a 404 here would mean "feature dark"
    // and every driver below would be asserting against a route that is not there.
    const unauth = await fetch(
      `${backend.baseUrl}/api/connectors/webhooks/config`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } },
    );
    expect(unauth.status).toBe(401);
  });

  // ── 2. delivery → 202 → queued → the CORRECT user's /pending ───────

  test("one signed delivery returns 202, queues, and surfaces to the signed-in owner only", async () => {
    const a = await enable(nextAddress());
    const b = await enable(nextAddress());

    await deliverQueued(a, "meeting.transcribed", TARGET_ID);

    const mine = await a.client.getPending();
    expect(mine.status).toBe("ok");
    if (mine.status !== "ok") throw new Error("pending failed");
    expect(mine.value.enabled).toBe(true);
    expect(mine.value.source).toBe("fireflies");
    expect(mine.value.count).toBe(1);
    expect(mine.value.pending[0].meetingId).toBe(TARGET_ID);
    expect(mine.value.pending[0].kind).toBe("transcript");
    expect(mine.value.deadCount).toBe(0);
    expect(mine.value.surfaceBlocked).toBeUndefined();

    // Routing is per-user: B enabled too, and B's queue is empty.
    expect(await pendingCount(b.client)).toBe(0);
  });

  // ── 3. targeted ingest: exact id, sequential writes, ack, queue clear ──

  test("targeted ingest fetches the exact queued id, writes SQL+KV, then acks — queue clears", async () => {
    const a = await enable(nextAddress());
    const fake = await browserSpace("did:test:webhook-loop-ingest");
    await deliverQueued(a, "meeting.transcribed", TARGET_ID);

    const items = await pendingItems(a.client);
    expect(items).toEqual([{ meetingId: TARGET_ID, kind: "transcript" }]);

    // STORAGE BEFORE ACK: snapshot the user's space at the instant `POST /ack` enters the router.
    let spaceAtAck: { rows: number; bodies: number } | null = null;
    companionProbe = (info) => {
      if (info.method === "POST" && info.path === "/ack") {
        spaceAtAck = { rows: fake.sql.meetings.size, bodies: fake.kv.entries.size };
      }
    };

    const lane = sequentialWriteProbe(fake);

    handle.resetCounters();
    const result = await ingest(fake, a.client, items);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.stored).toBe(1);
    expect(result.data.inserted).toBe(1);
    expect(result.data.acknowledged).toBe(1);
    expect(result.data.failures).toEqual([]);
    expect(result.data.unacknowledged).toEqual([]);
    expect(result.data.ackError).toBeNull();
    expect(result.data.itemCount).toBe(1);

    // EXACT id, and nothing else: one detail fetch, ZERO list calls (the v1 crawl is not reused).
    expect(handle.counts.transcript).toBe(1);
    expect(handle.counts.transcripts).toBe(0);

    // The write landed in the user's own space, under the granted paths.
    expect(fake.sql.meetings.size).toBe(1);
    const row = [...fake.sql.meetings.values()][0];
    expect(row.source_id).toBe(TARGET_ID);
    expect(fake.kv.entries.get(transcriptKvKey("fireflies", TARGET_ID))).toBeDefined();
    expect(fake.kv.unauthorized).toEqual([]);
    expect(fake.unauthorizedDbNames).toEqual([]);

    // SEQUENTIALLY (§9.3): the probe saw calls, and never two of them in flight at once.
    expect(lane.max).toBe(1);

    // The ack ran AFTER the space write, never before.
    expect(spaceAtAck).toEqual({ rows: 1, bodies: 1 });

    // And the identity is gone from the queue.
    expect(await pendingCount(a.client)).toBe(0);

    // Option C custody: the Fireflies key never reached the backend, in any form.
    expect(JSON.stringify([...backend.node.store])).not.toContain(HAPPY_KEY);
  });

  // ── 4. a summary event updates an existing meeting ──────────────────

  test("meeting.summarized updates the existing row's summary — the v1 engine skips it forever", async () => {
    const a = await enable(nextAddress());
    const fake = await browserSpace("did:test:webhook-loop-summary");

    // Store the transcript first, exactly as the queue would have.
    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    const first = await ingest(fake, a.client, await pendingItems(a.client));
    expect(first.ok).toBe(true);
    const rowId = [...fake.sql.meetings.values()][0].id;
    const originalOverview = [...fake.sql.meetings.values()][0].summary_overview;
    expect(originalOverview).not.toBeNull();

    // Fireflies finishes the summary: the upstream's stored summary changes.
    const upstream = seed.find((t) => t.id === TARGET_ID)!;
    const previousSummary = upstream.summary;
    upstream.summary = {
      keywords: ["decisions", "next-steps"],
      action_items: "Send the recap",
      overview: "The summary Fireflies produced after the transcript",
      meeting_type: "internal-sync",
    };

    try {
      await deliverQueued(a, "meeting.summarized", TARGET_ID);
      const items = await pendingItems(a.client);
      expect(items).toEqual([{ meetingId: TARGET_ID, kind: "summary" }]);

      // THE V1 CONTRAST. `syncFireflies` lists newest-first and stops at the first known id —
      // TARGET_ID is the newest — so a summary event is a permanent skip for it.
      handle.resetCounters();
      const v1 = await syncFireflies({
        client: new FirefliesClient({
          apiKey: HAPPY_KEY,
          apiUrl: handle.url,
          delayMs: 0,
        }),
        store: connectorStore,
        tcw: fake.tcw,
      });
      expect(v1.ok).toBe(true);
      if (v1.ok) expect(v1.data.added).toBe(0);
      expect(handle.counts.transcript).toBe(0);
      expect([...fake.sql.meetings.values()][0].summary_overview).toBe(originalOverview);

      // The targeted engine updates instead.
      handle.resetCounters();
      const result = await ingest(fake, a.client, items);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.data.stored).toBe(1);
      expect(result.data.updated).toBe(1);
      expect(result.data.inserted).toBe(0);
      expect(result.data.acknowledged).toBe(1);
      expect(handle.counts.transcript).toBe(1);

      // Same row — id and creation time preserved, summary replaced.
      expect(fake.sql.meetings.size).toBe(1);
      const row = [...fake.sql.meetings.values()][0];
      expect(row.id).toBe(rowId);
      expect(row.summary_overview).toBe(
        "The summary Fireflies produced after the transcript",
      );
      expect(row.summary_action_items).toBe("Send the recap");

      expect(await pendingCount(a.client)).toBe(0);
    } finally {
      upstream.summary = previousSummary;
    }
  });

  // ── 5. duplicate deliveries ────────────────────────────────────────

  test("duplicate deliveries produce ONE queue identity per (meetingId, kind)", async () => {
    const a = await enable(nextAddress());

    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    await deliverQueued(a, "meeting.summarized", TARGET_ID);
    await deliverQueued(a, "meeting.summarized", TARGET_ID);

    const items = await pendingItems(a.client);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set(["transcript", "summary"]),
    );
    for (const item of items) expect(item.meetingId).toBe(TARGET_ID);
  });

  // ── 6. two-user isolation ──────────────────────────────────────────

  test("user A's token, secret, queue and acks cannot affect user B", async () => {
    const a = await enable(nextAddress());
    const b = await enable(nextAddress());
    expect(a.url).not.toBe(b.url);
    expect(a.secret).not.toBe(b.secret);

    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    await deliverQueued(b, "meeting.transcribed", OTHER_ID);

    expect((await pendingItems(a.client)).map((i) => i.meetingId)).toEqual([TARGET_ID]);
    expect((await pendingItems(b.client)).map((i) => i.meetingId)).toEqual([OTHER_ID]);

    // A's secret does not authenticate a delivery to B's URL: the same generic 401 as any
    // unknown credential, with no hint that the token exists.
    const crossed = await deliverWebhook({
      url: b.url,
      secret: a.secret,
      event: "meeting.transcribed",
      meetingId: "cross-tenant-forgery",
    });
    expect(crossed.status).toBe(401);
    expect(crossed.text).toBe(JSON.stringify({ error: "invalid_signature" }));
    expect((await pendingItems(b.client)).map((i) => i.meetingId)).toEqual([OTHER_ID]);

    // B acknowledging A's identity settles NOTHING of A's — ownership comes from the session.
    const ack = await b.client.acknowledge({
      source: "fireflies",
      items: [{ meetingId: TARGET_ID, kind: "transcript", status: "done" }],
    });
    expect(ack.status).toBe("ok");
    if (ack.status !== "ok") throw new Error("ack failed");
    expect(ack.value.acknowledged).toBe(0);
    expect(ack.value.alreadySettled).toBe(1);
    // B's own view never contains A's meeting.
    expect(ack.value.pending.map((i) => i.meetingId)).toEqual([OTHER_ID]);
    expect((await pendingItems(a.client)).map((i) => i.meetingId)).toEqual([TARGET_ID]);

    // B tearing their own connector down does not touch A's config or queue.
    const disabled = await b.client.disable();
    expect(disabled.status).toBe("ok");
    expect(await pendingCount(b.client)).toBe(0);
    expect((await pendingItems(a.client)).map((i) => i.meetingId)).toEqual([TARGET_ID]);
    const aConfig = await a.client.getConfig();
    expect(aConfig.status).toBe("ok");
    if (aConfig.status === "ok") expect(aConfig.value.enabled).toBe(true);
  });

  // ── 7. replay after purge ──────────────────────────────────────────

  test("a replayed delivery does not resurface a purged meeting (V2 and legacy shapes)", async () => {
    const a = await enable(nextAddress());
    const fake = await browserSpace("did:test:webhook-loop-purge");

    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    const ingested = await ingest(fake, a.client, await pendingItems(a.client));
    expect(ingested.ok).toBe(true);
    expect(fake.sql.meetings.size).toBe(1);

    // The user deletes that meeting: tombstone FIRST, then the local rows (§6.2 ordering).
    const purge = await a.client.recordPurge({ source: "fireflies", ids: [TARGET_ID] });
    expect(purge.status).toBe("ok");
    const purged = await connectorStore.purgeConnector(fake.tcw, "fireflies");
    expect(purged.ok).toBe(true);
    expect(fake.sql.meetings.size).toBe(0);

    // A captured V2 delivery, replayed with a fresh stamp.
    const replay = await deliverWebhook({
      url: a.url,
      secret: a.secret,
      event: "meeting.transcribed",
      meetingId: TARGET_ID,
    });
    expect(replay.status).toBe(202);
    // The legacy timestamp-less shape, which skips the freshness window by design.
    const legacyBody = JSON.stringify({
      eventType: "Transcription completed",
      meetingId: TARGET_ID,
    });
    const legacy = await fetch(a.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": signDelivery(legacyBody, a.secret),
      },
      body: legacyBody,
    });
    expect(legacy.status).toBe(202);

    // Accepted at the door, and surfaced to NOBODY: the tombstone is the surfacing gate.
    expect(await pendingCount(a.client)).toBe(0);
    const drained = await a.client.drain();
    expect(drained.status).toBe("ok");
    if (drained.status !== "ok") throw new Error("drain failed");
    expect(drained.value.count).toBe(0);
    expect(drained.value.pending).toEqual([]);

    // And nothing re-enters the user's space, because there is nothing to ingest.
    const after = await ingest(fake, a.client, await pendingItems(a.client));
    expect(after.ok).toBe(true);
    expect(fake.sql.meetings.size).toBe(0);
  });

  // ── 8. lost ack response ───────────────────────────────────────────

  test("a lost ack RESPONSE converges: the retry settles idempotently and stores no duplicate", async () => {
    const a = await enable(nextAddress());
    const fake = await browserSpace("did:test:webhook-loop-lost-ack");
    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    const items = await pendingItems(a.client);

    // The backend SETTLES; the browser never learns. This is the accepted failure direction —
    // the inverse (ack before write) would silently drop the meeting.
    let acksSent = 0;
    const lossy = {
      async acknowledge(
        request: ConnectorAckRequest,
      ): Promise<ConnectorWebhooksResult<ConnectorAckResult>> {
        acksSent += 1;
        await a.client.acknowledge(request);
        return { status: "retryable", httpStatus: 503, code: null };
      },
    };

    const first = await ingest(fake, lossy, items);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(acksSent).toBe(1);
    expect(first.data.stored).toBe(1);
    expect(first.data.acknowledged).toBe(0);
    expect(first.data.ackError).toBe("retryable");
    expect(first.data.unacknowledged).toEqual([
      { meetingId: TARGET_ID, kind: "transcript" },
    ]);
    expect(fake.sql.meetings.size).toBe(1);
    const rowId = [...fake.sql.meetings.values()][0].id;

    // The retry re-processes the SAME identity the browser still believes is queued.
    handle.resetCounters();
    const retry = await ingest(fake, a.client, items);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.error.message);
    expect(retry.data.stored).toBe(1);
    // Same row, not a second meeting — `upsertMeeting` lands on `(source, source_id)`.
    expect(retry.data.inserted).toBe(0);
    expect(retry.data.updated).toBe(1);
    expect(fake.sql.meetings.size).toBe(1);
    expect([...fake.sql.meetings.values()][0].id).toBe(rowId);
    // The backend reports the identity as already settled rather than 4xx-ing the retry.
    expect(retry.data.acknowledged).toBe(0);
    expect(retry.data.alreadySettled).toBe(1);
    expect(retry.data.ackError).toBeNull();
    expect(await pendingCount(a.client)).toBe(0);
  });

  // ── 9. storage failure ─────────────────────────────────────────────

  test("a failed space write leaves the identity queued and sends NO ack", async () => {
    const a = await enable(nextAddress());
    const fake = await browserSpace("did:test:webhook-loop-storage-failure");
    await deliverQueued(a, "meeting.transcribed", TARGET_ID);
    const items = await pendingItems(a.client);

    let acksSent = 0;
    const counting = {
      acknowledge(request: ConnectorAckRequest) {
        acksSent += 1;
        return a.client.acknowledge(request);
      },
    };

    fake.sql.nextMeetingWriteError = {
      code: "SQL_ERROR",
      message: "space unavailable",
    };
    const result = await ingest(fake, counting, items);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.stored).toBe(0);
    expect(result.data.acknowledged).toBe(0);
    expect(result.data.failures).toHaveLength(1);
    expect(result.data.failures[0].meetingId).toBe(TARGET_ID);
    expect(result.data.failures[0].stage).toBe("storage");
    // Nothing was written, so NOTHING was acknowledged — not even an empty batch.
    expect(acksSent).toBe(0);
    expect(fake.sql.meetings.size).toBe(0);

    // The identity is still queued, so the next visit retries it.
    expect((await pendingItems(a.client)).map((i) => i.meetingId)).toEqual([TARGET_ID]);

    const retry = await ingest(fake, counting, items);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.error.message);
    expect(retry.data.stored).toBe(1);
    expect(retry.data.acknowledged).toBe(1);
    expect(acksSent).toBe(1);
    expect(await pendingCount(a.client)).toBe(0);
  });
});
