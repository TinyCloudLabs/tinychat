import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  FirefliesClient,
  FIREFLIES_MAX_RETRY_AFTER_MS,
  LIST_TRANSCRIPTS_QUERY,
  type FirefliesResult,
  type FirefliesSentence,
  type FirefliesTranscript,
  type ListNewTranscriptIdsOptions,
} from "./firefliesClient";
import type {
  ConnectorConnection,
  NormalizedMeeting,
  StoreResult,
  UpdateSyncStateInput,
} from "./connectorStore";
import {
  initialDisconnectProgress,
  runDisconnect,
  type DisconnectDeps,
} from "./connectorLifecycle";
import { runOnSpaceLane } from "../spaceWriteLane";
import { syncFireflies, type SyncClient, type SyncStore } from "./firefliesSync";

const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });

// ── Fakes ───────────────────────────────────────────────────────────────
//
// A fake store that mirrors just enough of connectorStore's real semantics
// for the sync engine: schema flag, per-source known ids, dedup on
// (source, source_id), KV transcript bodies, state row. Sequential — no
// concurrency games, mirroring the real single-writer contract.

type StoredMeeting = NormalizedMeeting;

class FakeStore implements SyncStore {
  meetings: StoredMeeting[] = [];
  bodies = new Map<string, FirefliesSentence[]>();
  state: UpdateSyncStateInput | null = null;
  stateWrites: UpdateSyncStateInput[] = [];
  connectionStatus: "connected" | "disconnected" | null = "connected";
  schemaEnsured = 0;
  rejectInsertFor: string | null = null;
  rejectBodyFor: string | null = null;
  countCalls = 0;
  updateCalls = 0;
  countThrows = false;
  rejectAttempt = false;
  /** Optional hook so a test can throw at insertMeeting boundary (per-item error). */
  insertHook: ((m: NormalizedMeeting) => void) | null = null;

  async ensureSchema(_: TinyCloudWeb): Promise<StoreResult<void>> {
    this.schemaEnsured++;
    if (this.ensureSchemaError) {
      return { ok: false, error: { code: "SCHEMA", message: this.ensureSchemaError.message } };
    }
    return ok(undefined);
  }

  async listKnownSourceIds(_: TinyCloudWeb, source: string): Promise<StoreResult<string[]>> {
    return ok(this.meetings.filter((meeting) => meeting.source === source).map((meeting) => meeting.sourceId));
  }
  async hasTranscriptBody(
    _: TinyCloudWeb,
    source: string,
    sourceId: string,
  ): Promise<StoreResult<boolean>> {
    return ok(this.bodies.has(`${source}/${sourceId}`));
  }

  async insertMeeting(_: TinyCloudWeb, meeting: NormalizedMeeting): Promise<StoreResult<boolean>> {
    try {
      this.insertHook?.(meeting);
    } catch (err) {
      return {
        ok: false,
        error: { code: "INSERT", message: err instanceof Error ? err.message : String(err) },
      };
    }
    if (this.rejectInsertFor === meeting.sourceId) {
      return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Your TinyCloud storage is full, so this change was not saved." } };
    }
    const dup = this.meetings.some((m) => m.source === meeting.source && m.sourceId === meeting.sourceId);
    if (dup) return ok(false);
    this.meetings.push(meeting);
    return ok(true);
  }

  async putTranscriptBody(
    _: TinyCloudWeb,
    source: string,
    sourceId: string,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<void>> {
    if (this.rejectBodyFor === sourceId) {
      return { ok: false, error: { code: "STORAGE_LIMIT_REACHED", message: "Write exceeds remaining storage" } };
    }
    this.bodies.set(`${source}/${sourceId}`, sentences);
    return ok(undefined);
  }

  async updateSyncState(_: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>> {
    this.updateCalls++;
    const lastSyncedAt = input.preserveLastSyncedAt
      ? this.state?.lastSyncedAt ?? null
      : input.lastSyncedAt;
    this.state = { ...input, lastSyncedAt };
    this.stateWrites.push(this.state);
    this.connectionStatus = input.status;
    return ok(undefined);
  }

  async countMeetings(_: TinyCloudWeb, source: string): Promise<StoreResult<number>> {
    this.countCalls++;
    if (this.countThrows) throw new Error("count exploded");
    return ok(this.meetings.filter((m) => m.source === source).length);
  }
  async getConnection(): Promise<StoreResult<ConnectorConnection | null>> {
    return ok(this.connectionStatus === null
      ? null
      : {
          connectorId: "fireflies",
          status: this.connectionStatus,
          lastSyncedAt: this.state?.lastSyncedAt ?? null,
          lastSyncStatus: this.state?.lastSyncStatus ?? null,
          lastSyncError: this.state?.lastSyncError ?? null,
          itemCount: this.state?.itemCount ?? this.meetings.length,
        });
  }

  async recordFirefliesAttempt(
    _tcw: TinyCloudWeb,
    input: { lastAttemptAt: string; lastAttemptStatus: "running" | "ok" | "partial" | "error" },
  ): Promise<StoreResult<void>> {
    void input;
    return this.rejectAttempt
      ? { ok: false, error: { code: "KV", message: "attempt write unavailable" } }
      : ok(undefined);
  }
}

function deferred<T = void>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

// ── Mock client ─────────────────────────────────────────────────────────
//
// Newest-first pagination + early-exit is exercised in firefliesClient.test.ts;
// here we short-circuit to a `newIds` list and record fetch calls, so tests
// focus on sync-engine orchestration (ordering, per-item error handling,
// abort, terminal error propagation).

interface MockClientOptions {
  /** IDs returned newest-first, as Fireflies listings provide them. */
  newIds: string[];
  getTranscript: (id: string) => FirefliesResult<FirefliesTranscript>;
  listError?: FirefliesResult<{ ids: string[]; complete: boolean; nextSkip: number | null }>;
  delayMs?: number;
}

function makeClient(opts: MockClientOptions): { client: SyncClient; fetches: string[] } {
  const fetches: string[] = [];
  const client: SyncClient = {
    delayMs: opts.delayMs ?? 0,
    async listNewTranscriptIds(listOptions: ListNewTranscriptIdsOptions) {
      if (opts.listError) return opts.listError;
      const cap = listOptions.detailCap ?? 50;
      return {
        ok: true,
        data: {
          ids: opts.newIds.slice(0, cap),
          complete: opts.newIds.length <= cap,
          nextSkip: opts.newIds.length <= cap ? null : cap,
        },
      };
    },
    async getTranscript(id: string) {
      fetches.push(id);
      return opts.getTranscript(id);
    },
  };
  return { client, fetches };
}

function transcript(id: string, extra: Partial<FirefliesTranscript> = {}): FirefliesTranscript {
  return {
    id,
    title: `T${id}`,
    date: 1700000000000,
    duration: 5,
    organizer_email: "org@example.com",
    speakers: [{ id: 1, name: "Ada" }],
    meeting_attendees: [{ displayName: "Ada", email: "ada@example.com" }],
    sentences: [
      { index: 0, speaker_name: "Ada", text: "hi", start_time: 0, end_time: 300 },
    ],
    summary: { keywords: [], action_items: null, overview: null, meeting_type: null },
    ...extra,
  };
}
function makeRealClient(
  idsNewestFirst: string[],
  options: {
    missing?: string[];
    onGet?: (id: string) => void;
    onList?: () => Promise<void>;
    holdGet?: Promise<void>;
    excessiveRateLimitId?: string;
    graphqlRateLimitId?: string;
  } = {},
): { client: FirefliesClient; fetches: string[]; listCalls: () => number } {
  const fetches: string[] = [];
  const retryAfter = new Date(Date.now() + 61_000).toISOString();
  let listCalls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { id?: string; limit?: number; skip?: number };
    };
    if (request.query === LIST_TRANSCRIPTS_QUERY) {
      listCalls++;
      await options.onList?.();
      const skip = request.variables?.skip ?? 0;
      const limit = request.variables?.limit ?? 25;
      return new Response(JSON.stringify({
        data: {
          transcripts: idsNewestFirst.slice(skip, skip + limit).map((id) => ({
            id, title: `T${id}`, date: "2026-10-12T12:00:00.000Z",
            duration: 5, organizer_email: null,
          })),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const id = request.variables?.id ?? "";
    fetches.push(id);
    options.onGet?.(id);
    if (id === options.excessiveRateLimitId) {
      return new Response("rate limit", { status: 429, headers: { "retry-after": "61" } });
    }
    if (id === options.graphqlRateLimitId) {
      return new Response(JSON.stringify({
        errors: [{ message: `Rate limit. Retry after ${retryAfter}` }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (options.holdGet) {
      const signal = init?.signal;
      if (!signal) {
        await options.holdGet;
      } else {
        const aborted = Promise.withResolvers<never>();
        const onAbort = () => aborted.reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        try {
          await Promise.race([options.holdGet, aborted.promise]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }
    }
    return new Response(JSON.stringify({
      data: { transcript: options.missing?.includes(id) ? null : transcript(id) },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    client: new FirefliesClient({ apiKey: "test-key", fetchImpl, delayMs: 0 }),
    fetches,
    listCalls: () => listCalls,
  };
}

function fakeTcw(): TinyCloudWeb {
  return { did: "did:test", spaceId: "space-test" } as unknown as TinyCloudWeb;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("syncFireflies — fresh sync", () => {
  test("stores every new transcript, oldest-first, updates state to ok", async () => {
    // Newest-first from the client: [c, b, a]. Oldest-first sync order: [a, b, c].
    const store = new FakeStore();
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.added).toBe(3);
    expect(res.data.skipped).toBe(0);
    expect(res.data.errors).toEqual([]);

    // Fetch order MUST be oldest-first — mid-run abort preserves a contiguous tail.
    expect(fetches).toEqual(["a", "b", "c"]);

    expect(store.schemaEnsured).toBeGreaterThan(0);
    expect(store.meetings.map((m) => m.sourceId)).toEqual(["a", "b", "c"]);
    expect(store.bodies.size).toBe(3);
    expect(store.state).not.toBeNull();
    expect(store.state?.lastSyncStatus).toBe("ok");
    expect(store.state?.lastSyncError).toBeNull();
    expect(store.state?.itemCount).toBe(3);
    expect(store.state?.status).toBe("connected");
  });
});

describe("syncFireflies — bounded catch-up", () => {
  test("keeps the newest capped slice and marks remaining backlog partial", async () => {
    const store = new FakeStore();
    const { client, fetches } = makeClient({
      newIds: ["newest", "middle", "oldest"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });
    const result = await syncFireflies({
      client,
      store,
      tcw: fakeTcw(),
      detailCap: 2,
    });

    expect(result.ok).toBe(true);
    expect(fetches).toEqual(["middle", "newest"]);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.meetings.map((meeting) => meeting.sourceId)).toEqual(["middle", "newest"]);
  });
});

describe("every Fireflies listing reconciles known-ID holes", () => {
  test("a normal Sync now run fetches unseen meetings below a known newest ID", async () => {
    const store = new FakeStore();
    const lastSuccess = "2026-10-09T02:49:00.000Z";
    store.state = {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: lastSuccess,
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 2,
    };
    const known = (id: string): NormalizedMeeting => ({
      id: `row-${id}`, source: "fireflies", sourceId: id, title: null, startedAt: null,
      durationSecs: null, organizerEmail: null, participants: [], summaryOverview: null,
      summaryActionItems: null, keywords: null, meetingType: null, metadata: {},
    });
    store.meetings.push(known("webhook-new"), known("old"));
    store.bodies.set("fireflies/webhook-new", []);
    store.bodies.set("fireflies/old", []);
    const { client, fetches } = makeRealClient(["webhook-new", "missed-hole", "old"]);

    const result = await syncFireflies({ client, store, tcw: fakeTcw() });


    expect(result.ok).toBe(true);
    expect(fetches).toContain("missed-hole");
    expect(store.meetings.some((meeting) => meeting.sourceId === "missed-hole")).toBe(true);
    expect(store.state?.lastSyncStatus).toBe("ok");
    expect(Date.parse(store.state?.lastSyncedAt ?? "")).toBeGreaterThan(Date.parse(lastSuccess));
  });
});

describe("Fireflies listing budgets apply without a watermark", () => {
  test("a NULL-watermark run bounds known-history scanning and stays partial", async () => {
    const store = new FakeStore();
    const ids = Array.from({ length: 5_000 }, (_, index) => `known-${index}`);
    store.meetings = ids.map((sourceId) => ({
      id: `row-${sourceId}`, source: "fireflies", sourceId, title: null, startedAt: null,
      durationSecs: null, organizerEmail: null, participants: [], summaryOverview: null,
      summaryActionItems: null, keywords: null, meetingType: null, metadata: {},
    }));
    for (const id of ids) store.bodies.set(`fireflies/${id}`, []);
    store.state = {
      connectorId: "fireflies", status: "connected", lastSyncedAt: null,
      lastSyncStatus: "partial", lastSyncError: "previous cap", itemCount: ids.length,
    };
    const { client, listCalls } = makeRealClient(ids);

    await syncFireflies({ client, store, tcw: fakeTcw(), detailCap: 50 });

    expect(listCalls()).toBeLessThanOrEqual(20);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.state?.preserveLastSyncedAt).toBe(true);
    expect(store.state?.lastSyncedAt).toBeNull();
  });
});

describe("all Fireflies entry points share the reconciliation watermark", () => {
  test("a partial cap never advances the shared success watermark on a later manual call", async () => {
    const store = new FakeStore();
    const lastSuccess = "2026-10-09T02:49:00.000Z";
    store.state = {
      connectorId: "fireflies", status: "connected", lastSyncedAt: lastSuccess,
      lastSyncStatus: "ok", lastSyncError: null, itemCount: 0,
    };
    const ids = Array.from({ length: 51 }, (_, index) => `meeting-${index}`);
    const { client, fetches } = makeRealClient(ids);

    const first = await syncFireflies({
      client, store, tcw: fakeTcw(), detailCap: 50,
    });
    const firstStatus = store.state?.lastSyncStatus;
    const firstWatermark = store.state?.lastSyncedAt;
    const second = await syncFireflies({ client, store, tcw: fakeTcw() });
    expect(first.ok && firstStatus).toBe("partial");
    expect(firstWatermark).toBe(lastSuccess);
    expect(second.ok && store.state?.lastSyncStatus).toBe("ok");
    expect(store.state?.lastSyncedAt).not.toBe(lastSuccess);
    expect(fetches).toHaveLength(51);
    expect(new Set(fetches).size).toBe(51);
  });
  test("a manual request joins an incomplete background flight then owns a complete reconcile", async () => {
    const store = new FakeStore();
    const lastSuccess = "2026-10-09T02:49:00.000Z";
    store.state = {
      connectorId: "fireflies", status: "connected", lastSyncedAt: lastSuccess,
      lastSyncStatus: "ok", lastSyncError: null, itemCount: 0,
    };
    const ids = Array.from({ length: 51 }, (_, index) => `meeting-${index}`);
    const listStarted = deferred();
    const releaseList = deferred();
    const { client, fetches } = makeRealClient(ids, {
      onList: async () => {
        listStarted.resolve();
        await releaseList.promise;
      },
    });
    const background = syncFireflies({
      client, store, tcw: fakeTcw(), detailCap: 50,
    });
    await listStarted.promise;
    const manual = syncFireflies({
      client, store, tcw: fakeTcw(), manualRequest: true,
    });
    releaseList.resolve();
    const [backgroundResult, manualResult] = await Promise.all([background, manual]);

    expect(backgroundResult.ok && store.stateWrites[0]?.lastSyncStatus).toBe("partial");
    expect(manualResult.ok && store.stateWrites.at(-1)?.lastSyncStatus).toBe("ok");
    expect(store.state?.lastSyncedAt).not.toBe(lastSuccess);
    expect(fetches).toHaveLength(51);
    expect(new Set(fetches).size).toBe(51);
  });
  test("Connect explicitly reactivates a retained disconnected row", async () => {
    const store = new FakeStore();
    store.state = {
      connectorId: "fireflies", status: "disconnected", lastSyncedAt: null,
      lastSyncStatus: "error", lastSyncError: null, itemCount: 0,
    };
    store.connectionStatus = "disconnected";
    const { client } = makeRealClient(["meeting"]);

    await syncFireflies({
      client, store, tcw: fakeTcw(), allowMissingConnection: true,
    });

    expect(store.state?.status).toBe("connected");
  });
});

describe("Fireflies row and transcript writes form one item unit", () => {
  test("a row whose body is missing is listed again and repaired by the real engine", async () => {
    const store = new FakeStore();
    store.meetings.push({
      id: "orphan-row", source: "fireflies", sourceId: "orphan", title: null,
      startedAt: null, durationSecs: null, organizerEmail: null, participants: [],
      summaryOverview: null, summaryActionItems: null, keywords: null, meetingType: null,
      metadata: {},
    });
    const { client, fetches } = makeRealClient(["orphan"]);

    await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(fetches).toEqual(["orphan"]);
    expect(store.bodies.has("fireflies/orphan")).toBe(true);
    expect(store.meetings).toHaveLength(1);
  });

  test("generation invalidation after row insert still finishes that row's body put", async () => {
    const store = new FakeStore();
    let current = true;
    store.insertHook = () => { current = false; };
    const { client } = makeRealClient(["meeting"]);

    await syncFireflies({
      client, store, tcw: fakeTcw(), isCurrent: () => current,
    });

    expect(store.meetings.map((row) => row.sourceId)).toEqual(["meeting"]);
    expect(store.bodies.has("fireflies/meeting")).toBe(true);
    expect(store.updateCalls).toBe(0);
  });
  test("generation invalidated while insert waits in the lane prevents that insert", async () => {
    const store = new FakeStore();
    let current = true;
    const detailStarted = deferred();
    const releaseDetail = deferred();
    const laneStarted = deferred();
    const releaseLane = deferred();
    const { client } = makeRealClient(["meeting"], {
      onGet: () => detailStarted.resolve(),
      holdGet: releaseDetail.promise,
    });
    const sync = syncFireflies({ client, store, tcw: fakeTcw(), isCurrent: () => current });
    await detailStarted.promise;
    const laneHold = runOnSpaceLane(async () => {
      laneStarted.resolve();
      await releaseLane.promise;
    }, { operation: "hold Fireflies insert lane" });
    await laneStarted.promise;
    releaseDetail.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    releaseLane.resolve();
    await Promise.all([sync, laneHold]);

    expect(store.meetings).toEqual([]);
    expect(store.bodies.size).toBe(0);
    expect(store.updateCalls).toBe(0);
  });
});

describe("syncFireflies — incremental no-op", () => {
  test("empty new-ids list → 0 added, no fetches, state still updated", async () => {
    const store = new FakeStore();
    // Pre-populate so listKnownSourceIds returns something (mimics an established connection).
    store.meetings.push({
      id: "prev-1",
      source: "fireflies",
      sourceId: "old",
      title: null,
      startedAt: null,
      durationSecs: null,
      organizerEmail: null,
      participants: [],
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: {},
    });
    const { client, fetches } = makeClient({
      newIds: [],
      getTranscript: () => {
        throw new Error("must not fetch when there are no new ids");
      },
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.added).toBe(0);
    expect(res.data.skipped).toBe(0);
    expect(res.data.errors).toEqual([]);
    expect(fetches).toEqual([]);
    // Sanity: previously-known meeting still there, itemCount reflects total.
    expect(store.state?.itemCount).toBe(1);
    expect(store.state?.lastSyncStatus).toBe("ok");
  });
});

describe("syncFireflies — single new item", () => {
  test("added=1, sentences body written to KV, meeting stored", async () => {
    const store = new FakeStore();
    const { client } = makeClient({
      newIds: ["only"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.added).toBe(1);
    expect(store.meetings.length).toBe(1);
    expect(store.meetings[0].sourceId).toBe("only");
    expect(store.bodies.get("fireflies/only")).toBeDefined();
    expect(store.state?.itemCount).toBe(1);
  });
});

describe("syncFireflies — per-item error skip", () => {
  test("one getTranscript graphql-error records partial and still fetches later items", async () => {
    const store = new FakeStore();
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"], // oldest-first fetch: a, b, c
      getTranscript: (id) => {
        if (id === "b") {
          return { ok: false, error: { kind: "graphql-error", message: "transient" } };
        }
        return { ok: true, data: transcript(id) };
      },
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.added).toBe(2);
    expect(res.data.errors.length).toBe(1);
    expect(res.data.errors[0]).toContain("b");
    // The failure did NOT abort — c was still fetched.
    expect(fetches).toEqual(["a", "b", "c"]);
    // Stored meetings are the two that succeeded, in oldest-first order.
    expect(store.meetings.map((m) => m.sourceId)).toEqual(["a", "c"]);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.state?.preserveLastSyncedAt).toBe(true);
  });
  test("real FirefliesClient not-found detail error marks incomplete run partial", async () => {
    const store = new FakeStore();
    const { client, fetches } = makeRealClient(["good", "missing"], { missing: ["missing"] });

    const result = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(result.ok).toBe(true);
    expect(fetches).toEqual(["missing", "good"]);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.state?.preserveLastSyncedAt).toBe(true);
  });

  test("insertMeeting throw is recorded and the loop continues", async () => {
    const store = new FakeStore();
    store.insertHook = (m) => {
      if (m.sourceId === "b") throw new Error("sql exploded");
    };
    const { client } = makeClient({
      newIds: ["c", "b", "a"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.added).toBe(2);
    expect(res.data.errors.some((e) => e.includes("sql exploded"))).toBe(true);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.state?.preserveLastSyncedAt).toBe(true);
  });
});

describe("syncFireflies — storage rejection abort", () => {
  test("storage-full insert records an error state without a first-success watermark", async () => {
    const store = new FakeStore();
    store.connectionStatus = null;
    store.rejectInsertFor = "a";
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });

    const result = await syncFireflies({
      client, store, tcw: fakeTcw(), allowMissingConnection: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("storage");
    expect(fetches).toEqual(["a"]);
    expect(store.countCalls).toBe(1);
    expect(store.updateCalls).toBe(1);
    expect(store.state?.lastSyncStatus).toBe("error");
    expect(store.state?.lastSyncedAt).toBeNull();
    expect(store.state?.preserveLastSyncedAt).toBe(true);
  });

  test("storage-full body put records an error after finishing the current item", async () => {
    const store = new FakeStore();
    store.connectionStatus = null;
    store.rejectBodyFor = "a";
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });

    const result = await syncFireflies({
      client, store, tcw: fakeTcw(), allowMissingConnection: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("storage");
    expect(fetches).toEqual(["a"]);
    expect(store.meetings.map((meeting) => meeting.sourceId)).toEqual(["a"]);
    expect(store.countCalls).toBe(1);
    expect(store.updateCalls).toBe(1);
    expect(store.state?.lastSyncStatus).toBe("error");
    expect(store.state?.lastSyncedAt).toBeNull();
    expect(store.state?.preserveLastSyncedAt).toBe(true);
  });

});

describe("syncFireflies — abort mid-run (graceful)", () => {
  test("real client abort between items stops the loop and preserves last success as partial", async () => {
    const store = new FakeStore();
    const controller = new AbortController();
    const { client, fetches } = makeRealClient(["c", "b", "a"], {
      onGet: (id) => { if (id === "a") controller.abort(); },
    });

    const res = await syncFireflies({
      client,
      store,
      tcw: fakeTcw(),
      signal: controller.signal,
    });

    expect(res.ok).toBe(true);
    expect(fetches).toEqual(["a"]);
    expect(store.meetings.map((meeting) => meeting.sourceId)).toEqual(["a"]);
    expect(store.state?.itemCount).toBe(1);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.state?.preserveLastSyncedAt).toBe(true);
  });
});

describe("syncFireflies — rate-limit abort (typed)", () => {
  test("rate-limited on getTranscript aborts the run with a typed SyncError", async () => {
    const store = new FakeStore();
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"], // oldest-first: a, b, c
      getTranscript: (id) => {
        if (id === "a") return { ok: true, data: transcript(id) };
        // On the SECOND fetch, rate-limit — the run must abort here.
        return {
          ok: false,
          error: { kind: "rate-limited", message: "slow down", retryAfterMs: 42_000 },
        };
      },
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.kind).toBe("rate-limited");
    expect(res.error.retryAfterMs).toBe(42_000);
    // The third id must NOT have been fetched — rate-limit is terminal.
    expect(fetches).toEqual(["a", "b"]);
    // The first successful item is still persisted; state reflects the error.
    expect(store.meetings.length).toBe(1);
    expect(store.state?.lastSyncStatus).toBe("error");
    expect(store.state?.lastSyncError).toBe("slow down");
    expect(store.state?.itemCount).toBe(1);
  });

  test("listNewTranscriptIds rate-limit surfaces immediately, no fetches", async () => {
    const store = new FakeStore();
    const { client, fetches } = makeClient({
      newIds: [],
      listError: {
        ok: false,
        error: { kind: "rate-limited", message: "throttled", retryAfterMs: 5000 },
      },
      getTranscript: () => {
        throw new Error("must not fetch when list itself was rate-limited");
      },
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.kind).toBe("rate-limited");
    expect(res.error.retryAfterMs).toBe(5000);
    expect(fetches).toEqual([]);
    expect(store.state?.lastSyncStatus).toBe("error");
    expect(store.state?.itemCount).toBe(0);
  });

  test("auth error on getTranscript aborts the run with kind=auth", async () => {
    const store = new FakeStore();
    const { client } = makeClient({
      newIds: ["only"],
      getTranscript: () => ({
        ok: false,
        error: { kind: "invalid-key", message: "key rotated" },
      }),
    });

    const res = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.kind).toBe("auth");
    expect(store.state?.lastSyncStatus).toBe("error");
    expect(store.state?.lastSyncError).toBe("key rotated");
  });
});
describe("Fireflies engine single-flight and attempt metadata", () => {
  test("Sync now joining a real catch-up client run leaves one meeting row", async () => {
    const listing = deferred();
    const listStarted = deferred();
    const store = new FakeStore();
    store.insertMeeting = async (_tcw, meeting) => {
      const existed = store.meetings.some(
        (row) => row.source === meeting.source && row.sourceId === meeting.sourceId,
      );
      await Promise.resolve();
      if (existed) return ok(false);
      store.meetings.push(meeting);
      return ok(true);
    };
    const { client, listCalls } = makeRealClient(["same-meeting"], {
      onList: () => { listStarted.resolve(); return listing.promise; },
    });
    const catchUp = syncFireflies({
      client, store, tcw: fakeTcw(), detailCap: 50,
    });
    await listStarted.promise;
    const syncNow = syncFireflies({ client, store, tcw: fakeTcw() });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    listing.resolve();
    await Promise.all([catchUp, syncNow]);

    expect(listCalls()).toBe(1);
    expect(store.meetings.map((meeting) => meeting.sourceId)).toEqual(["same-meeting"]);
  });

  test("a failed KV attempt write never changes a real-engine sync outcome", async () => {
    const store = new FakeStore();
    store.rejectAttempt = true;
    const { client, fetches } = makeRealClient(["meeting"]);

    const result = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(fetches).toEqual(["meeting"]);
    expect(result.ok).toBe(true);
    expect(store.state?.lastSyncStatus).toBe("ok");
    expect(store.meetings.map((meeting) => meeting.sourceId)).toEqual(["meeting"]);
  });
});
describe("Fireflies disconnect cancels a running client engine", () => {
  test("Disconnect during catch-up leaves no meetings or connected state after purge", async () => {
    const providerRelease = deferred();
    const providerStarted = deferred();
    const store = new FakeStore();
    const { client } = makeRealClient(["meeting"], {
      onGet: () => providerStarted.resolve(),
      holdGet: providerRelease.promise,
    });
    const tcw = fakeTcw();
    const sync = syncFireflies({ client, store, tcw });
    await providerStarted.promise;

    const deps: DisconnectDeps = {
      connectorId: "fireflies",
      source: "fireflies",
      mode: "delete-data",
      webhooks: {
        recordPurge: async () => ({ status: "ok", value: null }),
        disable: async () => ({ status: "ok", value: { status: "disabled", queueDropped: 0 } }),
        clearPurgeLedger: async () => ({ status: "ok", value: null }),
      },
      secrets: {
        isUnlocked: () => true,
        unlock: async () => ({ ok: true }),
        deleteKey: async () => ({ ok: true }),
      },
      store: {
        listKnownSourceIds: () => store.listKnownSourceIds(tcw, "fireflies"),
        purgeConnector: async () => {
          store.meetings = [];
          store.bodies.clear();
          store.state = null;
          store.connectionStatus = null;
          return ok(undefined);
        },
        getConnection: () => store.getConnection(),
        countMeetings: () => store.countMeetings(tcw, "fireflies"),
        updateSyncState: (_tcw, input) => store.updateSyncState(tcw, input),
      },
    };

    const disconnected = await runDisconnect(
      deps,
      () => {},
      initialDisconnectProgress("delete-data"),
    );
    providerRelease.resolve();
    await sync;

    expect(disconnected.done).toBe(true);
    expect(store.meetings).toEqual([]);
    expect(store.state).toBeNull();
    expect(store.connectionStatus).toBeNull();
  });
});
describe("Fireflies sync refuses disconnected non-Connect writes", () => {
  test("a non-Connect run does not list or write when the connector is disconnected", async () => {
    const store = new FakeStore();
    store.connectionStatus = "disconnected";
    const { client, fetches, listCalls } = makeRealClient(["meeting"]);

    const result = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(result.ok).toBe(false);
    expect(fetches).toEqual([]);
    expect(listCalls()).toBe(0);
    expect(store.meetings).toEqual([]);
    expect(store.stateWrites).toEqual([]);
  });

  test("COUNT failures resolve to a storage result instead of rejecting", async () => {
    const store = new FakeStore();
    store.countThrows = true;
    const { client } = makeRealClient(["meeting"]);

    const result = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("storage");
  });
});

describe("Fireflies detail cooldown stops the run", () => {
  test("first excessive HTTP or GraphQL cooldown stops the detail loop as partial", async () => {
    for (const kind of ["http", "graphql"] as const) {
      const store = new FakeStore();
      const failedId = "oldest";
      const { client, fetches } = makeRealClient(
        ["newest", "middle", failedId],
        kind === "http"
          ? { excessiveRateLimitId: failedId }
          : { graphqlRateLimitId: failedId },
      );

      const result = await syncFireflies({ client, store, tcw: fakeTcw() });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.ok).toBe(true);
      expect(fetches).toEqual([failedId]);
      expect(store.state?.lastSyncStatus).toBe("partial");
      expect(store.meetings).toEqual([]);
    }
  });
});
describe("Fireflies final state guard", () => {
  test("final state re-read does not overwrite a disconnected SQL row", async () => {
    const store = new FakeStore();
    const { client } = makeRealClient(["meeting"], {
      onGet: () => {
        store.connectionStatus = "disconnected";
        store.state = {
          connectorId: "fireflies",
          status: "disconnected",
          lastSyncedAt: "2026-10-09T02:49:00.000Z",
          lastSyncStatus: "ok",
          lastSyncError: null,
          itemCount: 1,
        };
      },
    });

    await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(store.state?.status).toBe("disconnected");
  });
});
