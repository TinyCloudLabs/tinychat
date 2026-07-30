import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type {
  FirefliesResult,
  FirefliesSentence,
  FirefliesTranscript,
  ListNewTranscriptIdsOptions,
} from "./firefliesClient";
import type {
  NormalizedMeeting,
  StoreResult,
  UpdateSyncStateInput,
} from "./connectorStore";
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
  schemaEnsured = 0;
  ensureSchemaError: Error | null = null;
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
    const dup = this.meetings.some(
      (m) => m.source === meeting.source && m.sourceId === meeting.sourceId,
    );
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
    this.bodies.set(`${source}/${sourceId}`, sentences);
    return ok(undefined);
  }

  async updateSyncState(_: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>> {
    this.state = input;
    return ok(undefined);
  }

  async countMeetings(_: TinyCloudWeb, source: string): Promise<StoreResult<number>> {
    return ok(this.meetings.filter((m) => m.source === source).length);
  }
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
    expect(store.state?.lastSyncStatus).toBe("ok");
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
    expect(store.state?.lastSyncStatus).toBe("ok");
  });
});

describe("syncFireflies — abort mid-run (graceful)", () => {
  test("aborting between items stops the loop; stored items stay; state records partial", async () => {
    const store = new FakeStore();
    const controller = new AbortController();
    const { client, fetches } = makeClient({
      newIds: ["c", "b", "a"], // oldest-first: a, b, c
      getTranscript: (id) => {
        // Trigger abort *after* the first fetch completes, before the next iteration.
        if (id === "a") controller.abort();
        return { ok: true, data: transcript(id) };
      },
    });

    const res = await syncFireflies({
      client,
      store,
      tcw: fakeTcw(),
      signal: controller.signal,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    // Only "a" was fetched — the pre-item abort check prevented b and c.
    expect(fetches).toEqual(["a"]);
    expect(store.meetings.length).toBe(1);
    expect(store.meetings[0].sourceId).toBe("a");
    // State reflects the partial run — status stays "ok" (aborted, not errored).
    expect(store.state?.itemCount).toBe(1);
    expect(store.state?.lastSyncStatus).toBe("ok");
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
