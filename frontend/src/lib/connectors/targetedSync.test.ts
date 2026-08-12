import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type {
  FirefliesResult,
  FirefliesSentence,
  FirefliesTranscript,
} from "./firefliesClient";
import type {
  NormalizedMeeting,
  StoreResult,
  UpdateSyncStateInput,
  UpsertMeetingOutcome,
} from "./connectorStore";
import type {
  ConnectorAckRequest,
  ConnectorAckResult,
  ConnectorWebhooksResult,
} from "./webhooksApi";
import type { ConnectorDescriptor } from "./types";
import {
  ingestQueuedMeetings,
  TARGETED_ACK_BATCH_LIMIT,
  type TargetedAckClient,
  type TargetedIngestSecrets,
  type TargetedIngestStore,
  type TargetedQueueItem,
  type TargetedSyncClient,
} from "./targetedSync";

const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });

const DESCRIPTOR: ConnectorDescriptor = {
  id: "fireflies",
  name: "Fireflies",
  description: "test descriptor",
  status: "available",
  secretName: "API_KEY",
  secretScope: "fireflies",
  source: "fireflies",
};

/** The browser-only key. It must never appear in anything the backend receives. */
const API_KEY = "ff-browser-only-key";

// ── Shared call log ─────────────────────────────────────────────────────
//
// Every fake appends to ONE ordered log. That is what makes the
// storage-before-ack ordering assertions meaningful: flipping the order in
// the implementation reorders entries here.

type Log = string[];

// ── Fakes ───────────────────────────────────────────────────────────────

interface StoredRow {
  meeting: NormalizedMeeting;
  createdAt: string;
  rowId: string;
}

class FakeStore implements TargetedIngestStore {
  rows = new Map<string, StoredRow>();
  bodies = new Map<string, FirefliesSentence[]>();
  state: UpdateSyncStateInput | null = null;
  /** Fails the upsert for these source ids. */
  failUpsertFor = new Set<string>();

  constructor(private readonly log: Log) {}

  async upsertMeeting(
    _tcw: TinyCloudWeb,
    meeting: NormalizedMeeting,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<UpsertMeetingOutcome>> {
    this.log.push(`upsert:${meeting.sourceId}`);
    if (this.failUpsertFor.has(meeting.sourceId)) {
      return { ok: false, error: { code: "SQL", message: "space write refused" } };
    }
    const key = `${meeting.source}/${meeting.sourceId}`;
    const existing = this.rows.get(key);
    if (!existing) {
      const createdAt = new Date().toISOString();
      this.rows.set(key, { meeting, createdAt, rowId: meeting.id });
      this.bodies.set(key, sentences);
      return ok({ id: meeting.id, inserted: true, createdAt });
    }
    // Mirror the real merge rules closely enough to prove no duplicate row and
    // no data loss on a re-delivery: null scalars keep the stored value.
    const merged: NormalizedMeeting = {
      ...existing.meeting,
      title: meeting.title ?? existing.meeting.title,
      summaryOverview: meeting.summaryOverview ?? existing.meeting.summaryOverview,
      summaryActionItems:
        meeting.summaryActionItems ?? existing.meeting.summaryActionItems,
    };
    this.rows.set(key, { ...existing, meeting: merged });
    if (sentences.length > 0) this.bodies.set(key, sentences);
    return ok({ id: existing.rowId, inserted: false, createdAt: existing.createdAt });
  }

  async updateSyncState(
    _tcw: TinyCloudWeb,
    input: UpdateSyncStateInput,
  ): Promise<StoreResult<void>> {
    this.log.push("state");
    this.state = input;
    return ok(undefined);
  }

  async countMeetings(_tcw: TinyCloudWeb, source: string): Promise<StoreResult<number>> {
    let n = 0;
    for (const row of this.rows.values()) if (row.meeting.source === source) n += 1;
    return ok(n);
  }
}

class FakeClient implements TargetedSyncClient {
  readonly delayMs = 700;
  transcripts = new Map<string, FirefliesTranscript>();
  errors = new Map<string, FirefliesResult<FirefliesTranscript>>();

  constructor(private readonly log: Log) {}

  async getTranscript(id: string): Promise<FirefliesResult<FirefliesTranscript>> {
    this.log.push(`fetch:${id}`);
    const injected = this.errors.get(id);
    if (injected) return injected;
    const t = this.transcripts.get(id);
    if (!t) {
      return { ok: false, error: { kind: "graphql-error", message: `Transcript ${id} not found` } };
    }
    return { ok: true, data: t };
  }
}

function ackOk(request: ConnectorAckRequest, extra: Partial<ConnectorAckResult> = {}) {
  const value: ConnectorAckResult = {
    status: "acknowledged",
    acknowledged: request.items.length,
    alreadySettled: 0,
    tombstoned: 0,
    enabled: true,
    disabledAt: null,
    source: "fireflies",
    deliveriesRateLimited: false,
    count: 0,
    pending: [],
    deadCount: 0,
    dead: [],
    ...extra,
  };
  return { status: "ok" as const, value };
}

class FakeAck implements TargetedAckClient {
  requests: ConnectorAckRequest[] = [];
  /** Replies, consumed in order; the default is a full success. */
  replies: Array<
    (request: ConnectorAckRequest) => ConnectorWebhooksResult<ConnectorAckResult>
  > = [];

  constructor(private readonly log: Log) {}

  async acknowledge(
    request: ConnectorAckRequest,
  ): Promise<ConnectorWebhooksResult<ConnectorAckResult>> {
    this.log.push(`ack:${request.items.map((i) => `${i.meetingId}/${i.kind}`).join(",")}`);
    this.requests.push(request);
    const reply = this.replies.shift();
    return reply ? reply(request) : ackOk(request);
  }
}

function fakeSecrets(
  log: Log,
  options: { unlocked?: boolean; key?: string; error?: { code?: string; message?: string } } = {},
): TargetedIngestSecrets {
  return {
    isUnlocked: () => options.unlocked !== false,
    async getKey() {
      log.push("secrets:get");
      if (options.error) return { ok: false, error: options.error };
      return { ok: true, data: options.key ?? API_KEY };
    },
  };
}

/** A tcw whose secrets service EXPLODES if anything tries to unlock it. */
function fakeTcw(): TinyCloudWeb {
  return {
    secrets: {
      isUnlocked: true,
      unlock: () => {
        throw new Error("ingest must never trigger an unlock prompt");
      },
    },
  } as unknown as TinyCloudWeb;
}

function transcript(
  id: string,
  overrides: Partial<FirefliesTranscript> = {},
): FirefliesTranscript {
  return {
    id,
    title: `Meeting ${id}`,
    date: "2026-08-01T10:00:00.000Z",
    duration: 30,
    organizer_email: "organizer@example.com",
    speakers: [{ id: 1, name: "Ada" }],
    meeting_attendees: [{ displayName: "Ada", email: "ada@example.com" }],
    sentences: [
      { index: 0, speaker_name: "Ada", text: "hello", start_time: 0, end_time: 2 },
    ],
    summary: null,
    ...overrides,
  };
}

interface Harness {
  log: Log;
  store: FakeStore;
  client: FakeClient;
  webhooks: FakeAck;
  sleeps: number[];
  tcw: TinyCloudWeb;
  keysHandedToClientFactory: string[];
}

function harness(options: { secrets?: TargetedIngestSecrets } = {}) {
  const log: Log = [];
  const store = new FakeStore(log);
  const client = new FakeClient(log);
  const webhooks = new FakeAck(log);
  const sleeps: number[] = [];
  const keysHandedToClientFactory: string[] = [];
  const tcw = fakeTcw();
  const secrets = options.secrets ?? fakeSecrets(log);

  const h: Harness = { log, store, client, webhooks, sleeps, tcw, keysHandedToClientFactory };

  const run = (items: TargetedQueueItem[], extra: { signal?: AbortSignal } = {}) =>
    ingestQueuedMeetings({
      tcw,
      descriptor: DESCRIPTOR,
      items,
      webhooks,
      store,
      secrets,
      createClient: (apiKey: string) => {
        keysHandedToClientFactory.push(apiKey);
        return client;
      },
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      ...extra,
    });

  return { ...h, run };
}

const T = (meetingId: string): TargetedQueueItem => ({ meetingId, kind: "transcript" });
const S = (meetingId: string): TargetedQueueItem => ({ meetingId, kind: "summary" });

// ── Tests ───────────────────────────────────────────────────────────────

describe("ingestQueuedMeetings — targeted queued-id ingest", () => {
  test("fetches each exact queued id sequentially and stores it before acknowledging", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    h.client.transcripts.set("m2", transcript("m2"));

    const res = await h.run([T("m1"), T("m2")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stored).toBe(2);
    expect(res.data.acknowledged).toBe(2);
    expect(res.data.blocked).toBeNull();
    expect(res.data.failures).toEqual([]);

    // Exact ids, in queue order — no listing call exists on this client at all.
    expect(h.log.filter((e) => e.startsWith("fetch:"))).toEqual(["fetch:m1", "fetch:m2"]);

    // ORDERING PIN: every meeting is in the user's space before ANY ack goes
    // out. Flipping to ack-before-storage puts an "ack:" entry first and fails.
    const firstAck = h.log.findIndex((e) => e.startsWith("ack:"));
    expect(firstAck).toBeGreaterThan(-1);
    expect(h.log.lastIndexOf("upsert:m1")).toBeLessThan(firstAck);
    expect(h.log.lastIndexOf("upsert:m2")).toBeLessThan(firstAck);
  });

  test("a summary event updates the existing row instead of being skipped", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    await h.run([T("m1")]);

    h.client.transcripts.set(
      "m1",
      transcript("m1", {
        summary: {
          keywords: ["roadmap"],
          action_items: "ship it",
          overview: "we discussed the roadmap",
          meeting_type: "internal",
        },
      }),
    );
    const res = await h.run([S("m1")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stored).toBe(1);
    expect(res.data.updated).toBe(1);
    expect(res.data.inserted).toBe(0);
    expect(res.data.acknowledged).toBe(1);
    expect(h.store.rows.size).toBe(1);
    expect(h.store.rows.get("fireflies/m1")?.meeting.summaryOverview).toBe(
      "we discussed the roadmap",
    );
    expect(h.webhooks.requests.at(-1)?.items).toEqual([
      { meetingId: "m1", kind: "summary", status: "done" },
    ]);
  });

  test("paces targeted detail fetches with the client's delay", async () => {
    const h = harness();
    for (const id of ["m1", "m2", "m3"]) h.client.transcripts.set(id, transcript(id));

    await h.run([T("m1"), T("m2"), T("m3")]);

    // Between fetches only — never before the first, never after the last.
    expect(h.sleeps).toEqual([h.client.delayMs, h.client.delayMs]);
  });

  test("a partial batch acknowledges successes only and leaves failures pending", async () => {
    const h = harness();
    for (const id of ["m1", "m2", "m3"]) h.client.transcripts.set(id, transcript(id));
    h.store.failUpsertFor.add("m2");

    const res = await h.run([T("m1"), T("m2"), T("m3")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stored).toBe(2);
    expect(res.data.failures.map((f) => f.meetingId)).toEqual(["m2"]);
    expect(res.data.failures[0].stage).toBe("storage");
    const acked = h.webhooks.requests.flatMap((r) => r.items.map((i) => i.meetingId));
    expect(acked).toEqual(["m1", "m3"]);
  });

  test("never acknowledges an identity whose space write failed", async () => {
    // The tightest storage-before-ack detector: with the ONLY item failing to
    // store, an ack-before-storage implementation still calls acknowledge.
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    h.store.failUpsertFor.add("m1");

    const res = await h.run([T("m1")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.acknowledged).toBe(0);
    expect(h.webhooks.requests).toEqual([]);
    expect(h.log.some((e) => e.startsWith("ack:"))).toBe(false);
  });

  test("a fetch failure leaves the item queued and is reported per item", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    h.client.errors.set("m2", {
      ok: false,
      error: { kind: "graphql-error", message: "Transcript m2 not found" },
    });

    const res = await h.run([T("m1"), T("m2")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.failures.map((f) => [f.meetingId, f.stage])).toEqual([["m2", "fetch"]]);
    expect(h.webhooks.requests.flatMap((r) => r.items.map((i) => i.meetingId))).toEqual(["m1"]);
  });

  test("a lost acknowledgement response retries idempotently without duplicating the meeting", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    // Storage succeeds, the ack response never arrives.
    h.webhooks.replies.push(() => ({ status: "offline" }));

    const first = await h.run([T("m1")]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.stored).toBe(1);
    expect(first.data.acknowledged).toBe(0);
    expect(first.data.ackError).toBe("offline");
    expect(first.data.unacknowledged).toEqual([{ meetingId: "m1", kind: "transcript" }]);
    expect(h.store.rows.size).toBe(1);

    // The item is still queued, so the next visit re-processes it. The backend
    // reports it as already settled if the first ack DID land.
    h.webhooks.replies.push((request) =>
      ackOk(request, { acknowledged: 0, alreadySettled: request.items.length }),
    );
    const second = await h.run([T("m1")]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.alreadySettled).toBe(1);
    expect(second.data.ackError).toBeNull();
    expect(second.data.unacknowledged).toEqual([]);
    // One meeting, one row id, one transcript body — no duplicate.
    expect(h.store.rows.size).toBe(1);
    expect(h.store.bodies.size).toBe(1);
  });

  test("locked secrets are a clean no-op — no fetch, no ack, no unlock prompt", async () => {
    const log: Log = [];
    const h = harness({ secrets: fakeSecrets(log, { unlocked: false }) });
    h.client.transcripts.set("m1", transcript("m1"));

    const res = await h.run([T("m1")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe("secrets-locked");
    expect(res.data.stored).toBe(0);
    expect(h.log).toEqual([]);
    expect(h.webhooks.requests).toEqual([]);
    // fakeTcw().secrets.unlock throws — reaching it would have failed the run.
    expect(log).toEqual([]);
  });

  test("a missing key is a clean no-op, not a hidden error", async () => {
    const log: Log = [];
    const h = harness({
      secrets: fakeSecrets(log, { error: { code: "KV_NOT_FOUND", message: "not found" } }),
    });
    h.client.transcripts.set("m1", transcript("m1"));

    const res = await h.run([T("m1")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe("key-missing");
    expect(h.log.some((e) => e.startsWith("fetch:"))).toBe(false);
    expect(h.webhooks.requests).toEqual([]);
  });

  test("a real secrets failure surfaces as an error, never as a no-op", async () => {
    const log: Log = [];
    const h = harness({
      secrets: fakeSecrets(log, { error: { code: "SECRETS_BACKEND", message: "node down" } }),
    });

    const res = await h.run([T("m1")]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("storage");
  });

  test("an invalid key aborts the run but still settles what was already stored", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    h.client.errors.set("m2", {
      ok: false,
      error: { kind: "invalid-key", message: "unauthorized" },
    });

    const res = await h.run([T("m1"), T("m2"), T("m3")]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("auth");
    // m3 was never fetched, m1's write is settled.
    expect(h.log.filter((e) => e.startsWith("fetch:"))).toEqual(["fetch:m1", "fetch:m2"]);
    expect(h.webhooks.requests.flatMap((r) => r.items.map((i) => i.meetingId))).toEqual(["m1"]);
  });

  test("a rate limit aborts the run and carries retryAfterMs", async () => {
    const h = harness();
    h.client.errors.set("m1", {
      ok: false,
      error: { kind: "rate-limited", message: "too many requests", retryAfterMs: 4200 },
    });

    const res = await h.run([T("m1"), T("m2")]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("rate-limited");
    expect(res.error.retryAfterMs).toBe(4200);
    expect(h.log.filter((e) => e.startsWith("fetch:"))).toEqual(["fetch:m1"]);
  });

  test("both kinds of one meeting cost one fetch and settle both identities", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));

    const res = await h.run([T("m1"), S("m1")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.log.filter((e) => e.startsWith("fetch:"))).toEqual(["fetch:m1"]);
    expect(h.log.filter((e) => e === "upsert:m1")).toHaveLength(1);
    expect(h.webhooks.requests[0].items).toEqual([
      { meetingId: "m1", kind: "transcript", status: "done" },
      { meetingId: "m1", kind: "summary", status: "done" },
    ]);
    expect(res.data.acknowledged).toBe(2);
  });

  test("updates connector state and count before acknowledging", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    h.client.transcripts.set("m2", transcript("m2"));
    h.store.failUpsertFor.add("m2");

    await h.run([T("m1"), T("m2")]);

    expect(h.store.state).not.toBeNull();
    expect(h.store.state?.connectorId).toBe("fireflies");
    expect(h.store.state?.status).toBe("connected");
    expect(h.store.state?.itemCount).toBe(1);
    // Per-item failures are reported as a non-ok sync status, never swallowed.
    expect(h.store.state?.lastSyncStatus).toBe("error");
    expect(h.log.indexOf("state")).toBeLessThan(h.log.findIndex((e) => e.startsWith("ack:")));
  });

  test("the Fireflies key never reaches the backend client", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));

    await h.run([T("m1")]);

    expect(h.keysHandedToClientFactory).toEqual([API_KEY]);
    expect(JSON.stringify(h.webhooks.requests)).not.toContain(API_KEY);
    expect(h.webhooks.requests[0].source).toBe("fireflies");
    expect(Object.keys(h.webhooks.requests[0]).sort()).toEqual(["items", "source"]);
  });

  test("an empty queue reads no key and calls nothing", async () => {
    const log: Log = [];
    const h = harness({ secrets: fakeSecrets(log) });

    const res = await h.run([]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stored).toBe(0);
    expect(res.data.blocked).toBeNull();
    expect(log).toEqual([]);
    expect(h.log).toEqual([]);
  });

  test("acknowledgements are chunked at the backend's batch limit", async () => {
    const h = harness();
    const items: TargetedQueueItem[] = [];
    const total = TARGETED_ACK_BATCH_LIMIT + 3;
    for (let i = 0; i < total; i++) {
      const id = `m${i}`;
      h.client.transcripts.set(id, transcript(id));
      items.push(T(id));
    }

    const res = await h.run(items);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.webhooks.requests).toHaveLength(2);
    expect(h.webhooks.requests[0].items).toHaveLength(TARGETED_ACK_BATCH_LIMIT);
    expect(h.webhooks.requests[1].items).toHaveLength(3);
    expect(res.data.acknowledged).toBe(total);
  });

  test("an abort stops fetching and settles what is already stored", async () => {
    const h = harness();
    for (const id of ["m1", "m2"]) h.client.transcripts.set(id, transcript(id));
    const controller = new AbortController();
    h.store.failUpsertFor.add("__never__");

    // Abort as soon as the first meeting has been written.
    const originalUpsert = h.store.upsertMeeting.bind(h.store);
    h.store.upsertMeeting = async (tcw, meeting, sentences) => {
      const out = await originalUpsert(tcw, meeting, sentences);
      controller.abort();
      return out;
    };

    const res = await h.run([T("m1"), T("m2")], { signal: controller.signal });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.log.filter((e) => e.startsWith("fetch:"))).toEqual(["fetch:m1"]);
    expect(h.webhooks.requests.flatMap((r) => r.items.map((i) => i.meetingId))).toEqual(["m1"]);
  });

  test("a rejected acknowledgement is reported, never read as settled", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    h.webhooks.replies.push(() => ({
      status: "retryable",
      httpStatus: 503,
      code: "drain_unavailable",
    }));

    const res = await h.run([T("m1")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.acknowledged).toBe(0);
    expect(res.data.ackError).toBe("retryable");
    expect(res.data.unacknowledged).toHaveLength(1);
  });

  test("tombstoned identities are passed through, not counted as ingested", async () => {
    const h = harness();
    h.client.transcripts.set("m1", transcript("m1"));
    h.webhooks.replies.push((request) =>
      ackOk(request, { acknowledged: 0, tombstoned: request.items.length }),
    );

    const res = await h.run([T("m1")]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tombstoned).toBe(1);
    expect(res.data.acknowledged).toBe(0);
  });
});
