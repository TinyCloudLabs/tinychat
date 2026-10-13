import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  FirefliesClient,
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
  connectionStatus: "connected" | "disconnected" | null = "connected";
  schemaEnsured = 0;
  rejectInsertFor: string | null = null;
  rejectBodyFor: string | null = null;
  countCalls = 0;
  updateCalls = 0;
  ensureSchemaError: Error | null = null;
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
    return ok(this.meetings.filter((m) => m.source === source).map((m) => m.sourceId));
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
    this.state = input;
    this.connectionStatus = input.status;
    return ok(undefined);
  }

  async countMeetings(_: TinyCloudWeb, source: string): Promise<StoreResult<number>> {
    this.countCalls++;
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
  /** Ids returned by listNewTranscriptIds, newest-first (the real client's shape). */
  newIds: string[];
  /** Return the transcript for a given id, or a FirefliesResult error. */
  getTranscript: (id: string) => FirefliesResult<FirefliesTranscript>;
  /** Force listNewTranscriptIds to return an error. */
  listError?: FirefliesResult<string[]>;
  delayMs?: number;
}

function makeClient(opts: MockClientOptions): { client: SyncClient; fetches: string[] } {
  const fetches: string[] = [];
  const client: SyncClient = {
    delayMs: opts.delayMs ?? 0,
    async listNewTranscriptIds(_lo: ListNewTranscriptIdsOptions) {
      if (opts.listError) return opts.listError;
      return { ok: true, data: opts.newIds };
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
  } = {},
): { client: FirefliesClient; fetches: string[]; listCalls: () => number } {
  const fetches: string[] = [];
  let listCalls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables?: { id?: string } };
    if (request.query === LIST_TRANSCRIPTS_QUERY) {
      listCalls++;
      await options.onList?.();
      return new Response(JSON.stringify({
        data: {
          transcripts: idsNewestFirst.map((id) => ({
            id, title: `T${id}`, date: "2026-10-12T12:00:00.000Z",
            duration: 5, organizer_email: null,
          })),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const id = request.variables?.id ?? "";
    fetches.push(id);
    options.onGet?.(id);
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
  test("keeps the oldest capped slice and marks remaining backlog partial", async () => {
    const store = new FakeStore();
    const { client, fetches } = makeClient({
      newIds: ["newest", "middle", "oldest"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });
    const result = await syncFireflies({
      client,
      store,
      tcw: fakeTcw(),
      maxNewTranscripts: 2,
    });

    expect(result.ok).toBe(true);
    expect(fetches).toEqual(["oldest", "middle"]);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.meetings.map((meeting) => meeting.sourceId)).toEqual(["oldest", "middle"]);
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
  test("one getTranscript graphql-error is skipped, others succeed, run reports ok", async () => {
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
  test("rejected meeting insert stops fetching and skips follow-up writes", async () => {
    const store = new FakeStore();
    store.rejectInsertFor = "a";
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });

    const result = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("storage");
    expect(fetches).toEqual(["a"]);
    expect(store.countCalls).toBe(0);
    expect(store.updateCalls).toBe(0);
  });

  test("rejected transcript body stops after the current meeting and skips sync-state write", async () => {
    const store = new FakeStore();
    store.rejectBodyFor = "a";
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"],
      getTranscript: (id) => ({ ok: true, data: transcript(id) }),
    });

    const result = await syncFireflies({ client, store, tcw: fakeTcw() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("storage");
    expect(fetches).toEqual(["a"]);
    expect(store.meetings.map((meeting) => meeting.sourceId)).toEqual(["a"]);
    expect(store.countCalls).toBe(0);
    expect(store.updateCalls).toBe(0);
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
      client, store, tcw: fakeTcw(), maxNewTranscripts: 50,
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
    const sync = syncFireflies({ client, store, tcw, maxNewTranscripts: 50 });
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
