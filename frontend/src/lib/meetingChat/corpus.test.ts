import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  SERVER_DISCOVERY_MAX_MEETINGS,
  SERVER_DISCOVERY_PAGE_SIZE,
  SQL_DISCOVERY_MAX_MEETINGS,
  SQL_MEETING_METADATA_QUERY,
  discoverKvMeetings,
  discoverMeetingCorpus,
  discoverServerMeetings,
  discoverSqlMeetings,
  mergeMeetingCorpus,
} from "./corpus";
import { CONNECTORS_KV_PREFIX } from "../connectors/connectorStore";
import type {
  ConnectorMeetingList,
  ConnectorMeetingMeta,
  ConnectorMeetingsClient,
  ConnectorMeetingsResult,
} from "../connectors/meetingsApi";
import type { MeetingCandidate } from "./types";

type QueryResult =
  | { ok: true; data: { rows: unknown } }
  | { ok: false; error: { code: string; message: string } };

function fakeTcw(query: () => Promise<QueryResult>): TinyCloudWeb {
  return {
    sql: {
      db: () => ({ query }),
    },
  } as unknown as TinyCloudWeb;
}

const validRow = [
  "row-1",
  "fireflies",
  "meeting-1",
  "Planning",
  "2026-08-24T09:00:00.000Z",
  "owner@example.test",
  JSON.stringify([
    { name: "Avery", email: "avery@example.test" },
    { name: "Sam", email: null },
  ]),
  1,
  "2026-08-24T08:00:00.000Z",
  "2026-08-24T09:30:00.000Z",
];

const SERVER_SOURCE = "fireflies";

function serverMeta(patch: Partial<ConnectorMeetingMeta> = {}): ConnectorMeetingMeta {
  return {
    sourceId: "server-1",
    title: "Server planning",
    ts: "2026-08-24T09:00:00.000Z",
    sizeBytes: 1024,
    storedAt: "2026-08-24T09:05:00.000Z",
    updatedAt: "2026-08-24T09:10:00.000Z",
    hasTranscript: true,
    hasSummary: true,
    ...patch,
  };
}

function serverPage(patch: Partial<ConnectorMeetingList> = {}): ConnectorMeetingList {
  return {
    source: SERVER_SOURCE,
    meetings: [serverMeta()],
    nextCursor: null,
    hasMore: false,
    ...patch,
  };
}

function fakeMeetingsClient(
  list: (options?: {
    source?: string;
    limit?: number;
    cursor?: string;
    reconciled?: boolean;
  }) => Promise<ConnectorMeetingsResult<ConnectorMeetingList>>,
): Pick<ConnectorMeetingsClient, "list"> {
  return { list };
}

interface KvListReply {
  ok: true;
  data: { keys: unknown; cursor?: unknown };
}

class DiscoveryKv {
  calls: Array<{ path: string; cursor?: string; active: number }> = [];
  getCalls = 0;
  active = 0;

  constructor(
    private readonly listImpl: (options: { path: string; cursor?: string }) => Promise<
      KvListReply | { ok: false; error: { code: string; message: string } }
    >,
  ) {}

  async list(options: { path: string; cursor?: string }) {
    this.active += 1;
    this.calls.push({ ...options, active: this.active });
    try {
      return await this.listImpl(options);
    } finally {
      this.active -= 1;
    }
  }

  async get() {
    this.getCalls += 1;
    throw new Error("KV discovery must never read bodies");
  }
}

function fakeKvTcw(kv: DiscoveryKv): TinyCloudWeb {
  return { kv } as unknown as TinyCloudWeb;
}

describe("SQL meeting metadata discovery", () => {
  test("runs one strict read-only metadata query and produces content-free candidates", async () => {
    const queries: string[] = [];
    const result = await discoverSqlMeetings(fakeTcw(async () => {
      queries.push(SQL_MEETING_METADATA_QUERY);
      return { ok: true, data: { rows: [validRow] } };
    }));

    expect(queries).toEqual([SQL_MEETING_METADATA_QUERY]);
    expect(SQL_MEETING_METADATA_QUERY).toMatch(/^SELECT\b/i);
    expect(SQL_MEETING_METADATA_QUERY).not.toMatch(/\bmetadata\b/i);
    expect(SQL_MEETING_METADATA_QUERY).not.toMatch(/\btranscript\b/i);
    expect(SQL_MEETING_METADATA_QUERY).not.toMatch(/\bsummary_overview\s*,|\bsummary_action_items\s*,/i);
    expect(result.lane).toEqual({ state: "healthy" });
    expect(result.candidates).toEqual([{
      source: "fireflies",
      sourceId: "meeting-1",
      title: "Planning",
      startedAt: "2026-08-24T09:00:00.000Z",
      participantNames: ["Avery", "Sam"],
      participantEmails: ["avery@example.test"],
      organizerEmail: "owner@example.test",
      hasSqlSummary: true,
      hasLocalRecord: false,
      hasLocalTranscript: false,
      hasServerSummary: false,
      hasServerTranscript: false,
      localRowId: "row-1",
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T09:30:00.000Z",
    }]);
    const candidateKeys = Object.keys(result.candidates[0] ?? {});
    for (const forbidden of ["summary", "transcript", "metadata", "providerMetadata"]) {
      expect(candidateKeys).not.toContain(forbidden);
    }
  });

  test("classifies a missing table as an unused lane", async () => {
    const result = await discoverSqlMeetings(fakeTcw(async () => ({
      ok: false,
      error: { code: "SQL_ERROR", message: "no such table: connector_meeting" },
    })));

    expect(result).toEqual({
      candidates: [],
      lane: { state: "unused", reason: "missing-table" },
    });
  });

  test("keeps storage and transport errors distinct from an empty lane", async () => {
    const storage = await discoverSqlMeetings(fakeTcw(async () => ({
      ok: false,
      error: { code: "AUTH_UNAUTHORIZED", message: "permission denied" },
    })));
    const transport = await discoverSqlMeetings(fakeTcw(async () => {
      throw new Error("network dropped");
    }));

    expect(storage).toEqual({ candidates: [], lane: { state: "failed", reason: "storage" } });
    expect(transport).toEqual({ candidates: [], lane: { state: "failed", reason: "transport" } });
  });

  test("skips malformed rows and marks the lane partial without leaking their content", async () => {
    const malformed = [...validRow];
    malformed[6] = '{"unexpected":"provider payload"}';
    const result = await discoverSqlMeetings(fakeTcw(async () => ({
      ok: true,
      data: { rows: [validRow, malformed, ["missing", "columns"]] },
    })));

    expect(result.lane).toEqual({ state: "partial", malformedRows: 2 });
    expect(result.candidates).toHaveLength(1);
    expect(JSON.stringify(result.candidates)).not.toContain("provider payload");
  });

  test("uses one SQL overflow sentinel and marks omitted rows partial", async () => {
    const rows = Array.from({ length: SQL_DISCOVERY_MAX_MEETINGS + 1 }, (_, index) => [
      ...validRow.slice(0, 2), `meeting-${index}`, ...validRow.slice(3),
    ]);
    const result = await discoverSqlMeetings(fakeTcw(async () => ({ ok: true, data: { rows } })));
    expect(SQL_MEETING_METADATA_QUERY).toContain(`LIMIT ${SQL_DISCOVERY_MAX_MEETINGS + 1}`);
    expect(result.candidates).toHaveLength(SQL_DISCOVERY_MAX_MEETINGS);
    expect(result.lane).toEqual({ state: "partial", malformedRows: 0, truncated: true });
  });

  test("rejects unsupported SQL sources before they become candidates", async () => {
    const unsupported = [...validRow];
    unsupported[1] = "granola";
    const result = await discoverSqlMeetings(fakeTcw(async () => ({ ok: true, data: { rows: [unsupported] } })));
    expect(SQL_MEETING_METADATA_QUERY).toContain("source IN ('fireflies', 'google-meet', 'tinycloud-transcriber')");
    expect(result).toEqual({ candidates: [], lane: { state: "partial", malformedRows: 1 } });
  });
});

describe("server meeting metadata discovery", () => {
  test("pages Fireflies metadata sequentially at 200 rows without reading meeting bodies", async () => {
    const calls: Array<{ options: Record<string, unknown>; active: number }> = [];
    let active = 0;
    const client = fakeMeetingsClient(async (options) => {
      active += 1;
      calls.push({ options: { ...options }, active });
      await Promise.resolve();
      active -= 1;
      if (options?.cursor === undefined) {
        return {
          status: "ok",
          value: serverPage({
            meetings: [serverMeta({ sourceId: "server-1" })],
            nextCursor: "cursor-1",
            hasMore: true,
          }),
        };
      }
      return {
        status: "ok",
        value: serverPage({ meetings: [serverMeta({ sourceId: "server-2" })] }),
      };
    });

    const result = await discoverServerMeetings(client);

    expect(calls).toEqual([
      { options: { source: SERVER_SOURCE, limit: SERVER_DISCOVERY_PAGE_SIZE }, active: 1 },
      { options: { source: SERVER_SOURCE, limit: SERVER_DISCOVERY_PAGE_SIZE, cursor: "cursor-1" }, active: 1 },
    ]);
    expect(result.lane).toEqual({ state: "healthy" });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        source: SERVER_SOURCE,
        sourceId: "server-1",
        title: "Server planning",
        startedAt: "2026-08-24T09:00:00.000Z",
        hasServerSummary: true,
        hasServerTranscript: true,
        hasSqlSummary: false,
        hasLocalRecord: false,
        hasLocalTranscript: false,
        participantNames: [],
        participantEmails: [],
        organizerEmail: null,
        localRowId: null,
      }),
      expect.objectContaining({ sourceId: "server-2" }),
    ]);
    const serialized = JSON.stringify(result.candidates);
    for (const forbidden of ["summary", "transcript", "metadata", "providerMetadata"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("stops at the 500-meeting server bound without asking for another page", async () => {
    const calls: Array<{ cursor?: string }> = [];
    const page = (start: number, count: number) => Array.from({ length: count }, (_, index) => (
      serverMeta({ sourceId: `server-${start + index}` })
    ));
    const client = fakeMeetingsClient(async (options) => {
      calls.push({ cursor: options?.cursor });
      if (options?.cursor === undefined) {
        return { status: "ok", value: serverPage({ meetings: page(0, 200), nextCursor: "a", hasMore: true }) };
      }
      if (options.cursor === "a") {
        return { status: "ok", value: serverPage({ meetings: page(200, 200), nextCursor: "b", hasMore: true }) };
      }
      return { status: "ok", value: serverPage({ meetings: page(400, 200), nextCursor: "c", hasMore: true }) };
    });

    const result = await discoverServerMeetings(client);

    expect(calls).toEqual([{ cursor: undefined }, { cursor: "a" }, { cursor: "b" }]);
    expect(result.candidates).toHaveLength(SERVER_DISCOVERY_MAX_MEETINGS);
    expect(result.candidates.at(-1)?.sourceId).toBe("server-499");
    expect(result.lane).toEqual({ state: "partial", malformedRows: 0, truncated: true });
  });

  test("marks an oversized terminal server page truncated even without hasMore", async () => {
    const rows = Array.from({ length: SERVER_DISCOVERY_MAX_MEETINGS + 1 }, (_, index) => (
      serverMeta({ sourceId: `terminal-${index}` })
    ));
    const result = await discoverServerMeetings(fakeMeetingsClient(async () => ({
      status: "ok",
      value: serverPage({ meetings: rows, hasMore: false, nextCursor: null }),
    })));
    expect(result.candidates).toHaveLength(SERVER_DISCOVERY_MAX_MEETINGS);
    expect(result.lane).toEqual({ state: "partial", malformedRows: 0, truncated: true });
  });

  test("keeps every defined server failure as a distinct lane state", async () => {
    const cases: Array<[
      ConnectorMeetingsResult<ConnectorMeetingList>,
      unknown,
    ]> = [
      [{ status: "feature-dark" }, { state: "feature-dark" }],
      [{ status: "unauthenticated" }, { state: "signed-out" }],
      [{ status: "offline" }, { state: "offline" }],
      [{ status: "retryable", httpStatus: 503, code: "unavailable" }, { state: "retryable", httpStatus: 503 }],
      [{ status: "rejected", httpStatus: 400, code: "bad_request" }, { state: "rejected", httpStatus: 400 }],
    ];

    for (const [response, lane] of cases) {
      const result = await discoverServerMeetings(fakeMeetingsClient(async () => response));
      expect(result).toEqual({ candidates: [], lane });
    }
  });

  test("skips malformed server rows and marks the lane partial without losing valid metadata", async () => {
    const malformed = { ...serverMeta({ sourceId: "bad" }), hasSummary: "yes" };
    const result = await discoverServerMeetings(fakeMeetingsClient(async () => ({
      status: "ok",
      value: serverPage({
        meetings: [serverMeta({ sourceId: "good" }), malformed] as unknown as ConnectorMeetingMeta[],
      }),
    })));

    expect(result.lane).toEqual({ state: "partial", malformedRows: 1 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceId).toBe("good");
  });

  test("accepts bounded server participant/email metadata and rejects malformed neighbors", async () => {
    const valid = serverMeta({
      sourceId: "selectable",
      participantNames: ["Alice"],
      participantEmails: ["alice@example.test"],
      organizerEmail: "owner@example.test",
    });
    const malformed = serverMeta({ sourceId: "bad", participantNames: ["x".repeat(257)] });
    const result = await discoverServerMeetings(fakeMeetingsClient(async () => ({
      status: "ok", value: serverPage({ meetings: [malformed, valid] }),
    })));
    expect(result.lane).toEqual({ state: "partial", malformedRows: 1 });
    expect(result.candidates).toEqual([expect.objectContaining({
      sourceId: "selectable",
      participantNames: ["Alice"],
      participantEmails: ["alice@example.test"],
      organizerEmail: "owner@example.test",
    })]);
  });

  test("treats malformed page envelopes as a failure, never an empty archive", async () => {
    const result = await discoverServerMeetings(fakeMeetingsClient(async () => ({
      status: "ok",
      value: { source: SERVER_SOURCE, meetings: [], nextCursor: null, hasMore: "yes" } as unknown as ConnectorMeetingList,
    })));

    expect(result).toEqual({
      candidates: [],
      lane: { state: "failed", reason: "malformed-response" },
    });
  });

  test("fails closed on repeated cursors and empty or malformed no-progress pages", async () => {
    const repeated = await discoverServerMeetings(fakeMeetingsClient(async () => ({
      status: "ok",
      value: serverPage({ meetings: [serverMeta({ sourceId: "one" })], nextCursor: "again", hasMore: true }),
    })));
    expect(repeated.lane).toEqual({ state: "failed", reason: "malformed-response" });

    const empty = await discoverServerMeetings(fakeMeetingsClient(async () => ({
      status: "ok", value: serverPage({ meetings: [], nextCursor: "next", hasMore: true }),
    })));
    expect(empty.lane).toEqual({ state: "failed", reason: "malformed-response" });

    const malformed = await discoverServerMeetings(fakeMeetingsClient(async () => ({
      status: "ok", value: serverPage({ meetings: [{ sourceId: 4 }] as unknown as ConnectorMeetingMeta[], nextCursor: "next", hasMore: true }),
    })));
    expect(malformed.lane).toEqual({ state: "failed", reason: "malformed-response" });
  });
});

describe("reconciled KV prefix discovery", () => {
  const source = "fireflies";
  const meetingPrefix = `${CONNECTORS_KV_PREFIX}/${source}/meeting/`;
  const transcriptPrefix = `${CONNECTORS_KV_PREFIX}/${source}/transcript/`;

  test("pages both SDK-defined complete prefixes sequentially without reading values", async () => {
    const kv = new DiscoveryKv(async (options) => {
      if (options.path === meetingPrefix && options.cursor === undefined) {
        return { ok: true, data: { keys: [`${meetingPrefix}same`], cursor: "meeting-page-2" } };
      }
      if (options.path === meetingPrefix && options.cursor === "meeting-page-2") {
        return { ok: true, data: { keys: [`${meetingPrefix}record-only`] } };
      }
      if (options.path === transcriptPrefix && options.cursor === undefined) {
        return { ok: true, data: { keys: [`${transcriptPrefix}same`], cursor: "transcript-page-2" } };
      }
      if (options.path === transcriptPrefix && options.cursor === "transcript-page-2") {
        return { ok: true, data: { keys: [`${transcriptPrefix}transcript-only`] } };
      }
      throw new Error(`unexpected list ${JSON.stringify(options)}`);
    });

    const result = await discoverKvMeetings(fakeKvTcw(kv), source);

    expect(kv.calls).toEqual([
      { path: meetingPrefix, signal: undefined, active: 1 },
      { path: meetingPrefix, cursor: "meeting-page-2", signal: undefined, active: 1 },
      { path: transcriptPrefix, signal: undefined, active: 1 },
      { path: transcriptPrefix, cursor: "transcript-page-2", signal: undefined, active: 1 },
    ]);
    expect(kv.getCalls).toBe(0);
    expect(result.lane).toEqual({ state: "healthy" });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        source,
        sourceId: "record-only",
        hasLocalRecord: true,
        hasLocalTranscript: false,
        title: null,
        startedAt: null,
        participantNames: [],
        participantEmails: [],
        organizerEmail: null,
        hasSqlSummary: false,
        hasServerSummary: false,
        hasServerTranscript: false,
        localRowId: null,
      }),
      expect.objectContaining({ sourceId: "same", hasLocalRecord: true, hasLocalTranscript: true }),
      expect.objectContaining({ sourceId: "transcript-only", hasLocalRecord: false, hasLocalTranscript: true }),
    ]);
  });

  test("distinguishes an empty prefix from list failures", async () => {
    const empty = await discoverKvMeetings(fakeKvTcw(new DiscoveryKv(async () => (
      { ok: true, data: { keys: [] } }
    ))), source);
    expect(empty).toEqual({ candidates: [], lane: { state: "healthy" } });

    const storage = await discoverKvMeetings(fakeKvTcw(new DiscoveryKv(async () => (
      { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "no access" } }
    ))), source);
    expect(storage).toEqual({ candidates: [], lane: { state: "failed", reason: "storage" } });

    const transport = await discoverKvMeetings(fakeKvTcw(new DiscoveryKv(async () => {
      throw new Error("offline");
    })), source);
    expect(transport).toEqual({ candidates: [], lane: { state: "failed", reason: "transport" } });
  });

  test("marks malformed listed keys partial while retaining valid opaque identities", async () => {
    const kv = new DiscoveryKv(async (options) => {
      if (options.path === meetingPrefix) {
        return {
          ok: true,
          data: { keys: [`${meetingPrefix}valid`, `${meetingPrefix}`, 42, `${transcriptPrefix}wrong-prefix`] },
        };
      }
      return { ok: true, data: { keys: [] } };
    });

    const result = await discoverKvMeetings(fakeKvTcw(kv), source);

    expect(result.lane).toEqual({ state: "partial", malformedRows: 3 });
    expect(result.candidates).toEqual([
      expect.objectContaining({ source, sourceId: "valid", hasLocalRecord: true, hasLocalTranscript: false }),
    ]);
    expect(JSON.stringify(result.candidates)).not.toContain("wrong-prefix");
  });
});

function meetingCandidate(patch: Partial<MeetingCandidate> = {}): MeetingCandidate {
  return {
    source: "fireflies",
    sourceId: "meeting-1",
    title: "Planning",
    startedAt: "2026-08-24T09:00:00.000Z",
    participantNames: [],
    participantEmails: [],
    organizerEmail: null,
    hasSqlSummary: false,
    hasLocalRecord: false,
    hasLocalTranscript: false,
    hasServerSummary: false,
    hasServerTranscript: false,
    localRowId: null,
    createdAt: null,
    updatedAt: null,
    ...patch,
  };
}

describe("exact-identity meeting corpus merge", () => {
  test("merges only an exact source and sourceId match", () => {
    const corpus = mergeMeetingCorpus({
      sql: {
        candidates: [meetingCandidate({
          sourceId: "sql-and-kv",
          title: "Project Falcon",
          hasSqlSummary: true,
          localRowId: "row-7",
        })],
        lane: { state: "healthy" },
      },
      server: {
        candidates: [meetingCandidate({
          sourceId: "same-title-different-id",
          title: "Project Falcon",
          hasServerSummary: true,
        })],
        lane: { state: "healthy" },
      },
      kv: {
        candidates: [
          meetingCandidate({
            sourceId: "sql-and-kv",
            title: null,
            startedAt: null,
            hasLocalRecord: true,
          }),
          meetingCandidate({
            source: "other-source",
            sourceId: "sql-and-kv",
            title: null,
            startedAt: null,
            hasLocalTranscript: true,
          }),
        ],
        lane: { state: "healthy" },
      },
    });

    expect(corpus.candidates).toHaveLength(3);
    expect(corpus.candidates).toEqual([
      expect.objectContaining({
        source: "fireflies",
        sourceId: "same-title-different-id",
        title: "Project Falcon",
        hasServerSummary: true,
        hasLocalRecord: false,
      }),
      expect.objectContaining({
        source: "fireflies",
        sourceId: "sql-and-kv",
        title: "Project Falcon",
        hasSqlSummary: true,
        hasLocalRecord: true,
        localRowId: "row-7",
      }),
      expect.objectContaining({
        source: "other-source",
        sourceId: "sql-and-kv",
        title: null,
        hasLocalTranscript: true,
      }),
    ]);
  });

  test("discovers and merges transcript availability for Google Meet and Transcriber SQL identities", async () => {
    const rows = [
      [...validRow.slice(0, 1), "google-meet", "g-1", ...validRow.slice(3)],
      [...validRow.slice(0, 1), "tinycloud-transcriber", "t-1", ...validRow.slice(3)],
    ];
    const lists: string[] = [];
    const corpus = await discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => ({ ok: true, data: { rows } }) }) },
      kv: { list: async ({ path }: { path: string }) => {
        lists.push(path);
        return { ok: true, data: { keys: path.endsWith("google-meet/transcript/") ? [`${path}g-1`] : path.endsWith("tinycloud-transcriber/transcript/") ? [`${path}t-1`] : [] } };
      } },
    } as unknown as TinyCloudWeb, { list: async () => ({ status: "ok", value: serverPage({ meetings: [] }) }) });
    expect(corpus.candidates.find((candidate) => candidate.sourceId === "g-1")?.hasLocalTranscript).toBe(true);
    expect(corpus.candidates.find((candidate) => candidate.sourceId === "t-1")?.hasLocalTranscript).toBe(true);
    expect(lists).toEqual(expect.arrayContaining([
      `${CONNECTORS_KV_PREFIX}/google-meet/transcript/`,
      `${CONNECTORS_KV_PREFIX}/tinycloud-transcriber/transcript/`,
    ]));
  });

  test("does not enumerate KV prefixes for an unsupported SQL source", async () => {
    const rows = [[...validRow.slice(0, 1), "granola", "g-1", ...validRow.slice(3)]];
    const lists: string[] = [];
    const result = await discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => ({ ok: true, data: { rows } }) }) },
      kv: { list: async ({ path }: { path: string }) => {
        lists.push(path);
        return { ok: true, data: { keys: [] } };
      } },
    } as unknown as TinyCloudWeb, { list: async () => ({ status: "ok", value: serverPage({ meetings: [] }) }) });
    expect(result.candidates).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: "granola" })]));
    expect(lists.some((path) => path.includes("/granola/"))).toBe(false);
  });

  test("includes an already-selected supported source when SQL discovery fails", async () => {
    const lists: string[] = [];
    await discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED" } }) }) },
      kv: { list: async ({ path }: { path: string }) => {
        lists.push(path);
        return { ok: true, data: { keys: [] } };
      } },
    } as unknown as TinyCloudWeb, {
      list: async () => ({ status: "feature-dark", httpStatus: 404 }),
    }, undefined, undefined, { source: "google-meet", sourceId: "g-opaque" });
    expect(lists).toEqual([
      `${CONNECTORS_KV_PREFIX}/fireflies/meeting/`,
      `${CONNECTORS_KV_PREFIX}/fireflies/transcript/`,
      `${CONNECTORS_KV_PREFIX}/google-meet/meeting/`,
      `${CONNECTORS_KV_PREFIX}/google-meet/transcript/`,
    ]);
  });

  test("threads cancellation through discovery and does not begin a later lane", async () => {
    const controller = new AbortController();
    let serverCalls = 0;
    await expect(discoverMeetingCorpus({
      sql: { db: () => ({ query: async () => {
        controller.abort();
        return { ok: true, data: { rows: [] } };
      } }) },
      kv: { list: async () => ({ ok: true, data: { keys: [] } }) },
    } as unknown as TinyCloudWeb, { list: async () => {
      serverCalls += 1;
      return { status: "ok", value: serverPage({ meetings: [] }) };
    } }, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(serverCalls).toBe(0);
  });

  test("reconciles exact-match availability and metadata deterministically", () => {
    const duplicateA = meetingCandidate({
      title: "Zulu planning",
      participantNames: ["Zoe"],
      participantEmails: ["zoe@example.test"],
      hasSqlSummary: true,
      localRowId: "row-z",
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    });
    const duplicateB = meetingCandidate({
      title: "Alpha planning",
      participantNames: ["Avery"],
      participantEmails: ["avery@example.test"],
      organizerEmail: "owner@example.test",
      localRowId: "row-a",
      createdAt: "2026-08-23T08:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
    });
    const server = meetingCandidate({
      title: "Server title is lower priority",
      participantNames: ["Sam"],
      hasServerTranscript: true,
      updatedAt: "2026-08-24T11:00:00.000Z",
    });
    const kv = meetingCandidate({
      title: null,
      startedAt: null,
      hasLocalRecord: true,
      hasLocalTranscript: true,
    });
    const build = (sqlCandidates: readonly MeetingCandidate[]) => mergeMeetingCorpus({
      sql: { candidates: sqlCandidates, lane: { state: "healthy" } },
      server: { candidates: [server], lane: { state: "healthy" } },
      kv: { candidates: [kv], lane: { state: "healthy" } },
    });

    const forward = build([duplicateA, duplicateB]);
    const reversed = build([duplicateB, duplicateA]);

    expect(forward).toEqual(reversed);
    expect(forward.candidates).toEqual([expect.objectContaining({
      title: "Zulu planning",
      participantNames: ["Sam", "Zoe"],
      participantEmails: ["zoe@example.test"],
      organizerEmail: null,
      hasSqlSummary: true,
      hasLocalRecord: true,
      hasLocalTranscript: true,
      hasServerTranscript: true,
      localRowId: "row-z",
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    })]);
    expect(JSON.stringify(forward.candidates)).not.toContain("summary_overview");
    expect(JSON.stringify(forward.candidates)).not.toContain("providerMetadata");
  });

  test("unions duplicate exact-match availability without letting input order hide evidence", () => {
    const recordOnly = meetingCandidate({ hasLocalRecord: true });
    const transcriptOnly = meetingCandidate({ hasLocalTranscript: true });
    const summaryOnly = meetingCandidate({ hasServerSummary: true });
    const serverTranscriptOnly = meetingCandidate({ hasServerTranscript: true });
    const build = (serverCandidates: readonly MeetingCandidate[], kvCandidates: readonly MeetingCandidate[]) => (
      mergeMeetingCorpus({
        sql: { candidates: [], lane: { state: "healthy" } },
        server: { candidates: serverCandidates, lane: { state: "healthy" } },
        kv: { candidates: kvCandidates, lane: { state: "healthy" } },
      })
    );

    const forward = build([summaryOnly, serverTranscriptOnly], [recordOnly, transcriptOnly]);
    const reversed = build([serverTranscriptOnly, summaryOnly], [transcriptOnly, recordOnly]);

    expect(forward).toEqual(reversed);
    expect(forward.candidates).toEqual([expect.objectContaining({
      hasLocalRecord: true,
      hasLocalTranscript: true,
      hasServerSummary: true,
      hasServerTranscript: true,
    })]);
  });

  test("preserves each lane health and marks incomplete corpus discovery partial", () => {
    const incomplete = mergeMeetingCorpus({
      sql: { candidates: [], lane: { state: "unused", reason: "missing-table" } },
      server: { candidates: [], lane: { state: "partial", malformedRows: 1 } },
      kv: { candidates: [], lane: { state: "failed", reason: "storage" } },
    });
    const complete = mergeMeetingCorpus({
      sql: { candidates: [], lane: { state: "unused", reason: "missing-table" } },
      server: { candidates: [], lane: { state: "healthy" } },
      kv: { candidates: [], lane: { state: "healthy" } },
    });

    expect(incomplete).toEqual({
      candidates: [],
      lanes: {
        sql: { state: "unused", reason: "missing-table" },
        server: { state: "partial", malformedRows: 1 },
        kv: { state: "failed", reason: "storage" },
      },
      partial: true,
    });
    expect(complete.partial).toBe(false);
  });

  test("treats a feature-dark server as non-participating while retaining its diagnostic", () => {
    const result = mergeMeetingCorpus({
      sql: { candidates: [], lane: { state: "healthy" } },
      server: { candidates: [], lane: { state: "feature-dark" } },
      kv: { candidates: [], lane: { state: "healthy" } },
    });
    expect(result.partial).toBe(false);
    expect(result.lanes.server).toEqual({ state: "feature-dark" });
  });
});
