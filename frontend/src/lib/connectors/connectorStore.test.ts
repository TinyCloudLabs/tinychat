import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesTranscript } from "./firefliesClient";
import type { GmeetConferenceRecord, GmeetParticipant, GmeetResult, GmeetTranscript, GmeetTranscriptEntry } from "./gmeetClient";
import { _resetGmeetSyncSingleFlightForTests, syncGoogleMeet, type GmeetSyncClient, type GmeetSyncStore } from "./gmeetSync";
import {
  CONNECTORS_KV_PREFIX,
  CONNECTORS_SQL_DB_NAME,
  _resetConnectorSchemaMemoForTests,
  countMeetings,
  driveCursorKvKey,
  ensureSchema,
  findGmeetNotesAssociation,
  getConnection,
  getMeetingDatetimeStats,
  meetingKvKey,
  getDriveCursor,
  listKnownSourceIds,
  normalizeFirefliesTranscript,
  putDriveCursor,
  purgeConnector,
  removeGmeetNotes,
  transcriptKvKey,
  updateSyncState,
} from "./connectorStore";
import type { NormalizedMeeting } from "./connectorStore";

// ── Minimal in-memory fakes for TinyCloud sql/kv ────────────────────────
//
// The fakes interpret only the shapes the store actually issues (CREATE
// TABLE, INSERT/UPDATE/DELETE, SELECT id / source_id / COUNT(*)), by
// substring match on the statement text. Rows are stored per-table in a
// Map keyed by primary key so dedup and DELETE behave.

type SqlError = { code: string; message: string };
type SqlResult<T = { rows: unknown[][] }> =
  | { ok: true; data: T }
  | { ok: false; error: SqlError };

interface MeetingRow {
  id: string;
  source: string;
  source_id: string;
  title: string | null;
  started_at: string | null;
  duration_secs: number | null;
  organizer_email: string | null;
  participants: string;
  summary_overview: string | null;
  summary_action_items: string | null;
  keywords: string | null;
  meeting_type: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface StateRow {
  connector_id: string;
  status: string;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  item_count: number;
  updated_at: string;
}

/**
 * Records how many storage calls are in flight at once. TinyCloud drops
 * concurrent responses on one space, so the store must never fan out
 * (no Promise.all) — `maxInFlight` proves that for the paths under test.
 * Every op yields a macrotask so genuine concurrency would be observable.
 */
class OpTracker {
  inFlight = 0;
  maxInFlight = 0;
  order: string[] = [];

  async run<T>(label: string, fn: () => T): Promise<T> {
    this.inFlight += 1;
    if (this.inFlight > this.maxInFlight) this.maxInFlight = this.inFlight;
    this.order.push(label);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}

class FakeSqlDb {
  meetings = new Map<string, MeetingRow>();
  states = new Map<string, StateRow>();
  createdTables = new Set<string>();
  tracker = new OpTracker();
  /** When set, the NEXT CREATE TABLE call fails with the given error. Consumed on use. */
  nextCreateError: SqlError | null = null;
  /** When set, the NEXT non-DDL execute() fails with the given error. Consumed on use. */
  nextExecuteError: SqlError | null = null;
  /** When set, the NEXT query() fails with the given error. Consumed on use. */
  nextQueryError: SqlError | null = null;
  /** Mirror TinyCloud rows that return JSON-valued TEXT cells already decoded. */
  decodeMetadataCells = false;

  private metadataCell(raw: string): unknown {
    if (!this.decodeMetadataCells) return raw;
    return JSON.parse(raw) as unknown;
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlResult> {
    return this.tracker.run("sql.query", () => this.queryImpl(sql, params));
  }

  private queryImpl(sql: string, params: unknown[] = []): SqlResult {
    const s = sql.trim();
    if (this.nextQueryError) {
      const err = this.nextQueryError;
      this.nextQueryError = null;
      return { ok: false, error: err };
    }
    // Targeted upsert lookup: full column set for (source, source_id).
    if (/^SELECT\s+id,\s*created_at[\s\S]*FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const sourceId = String(params[1]);
      for (const row of this.meetings.values()) {
        if (row.source === source && row.source_id === sourceId) {
          return {
            ok: true,
            data: {
              rows: [
                [
                  row.id,
                  row.created_at,
                  row.title,
                  row.started_at,
                  row.duration_secs,
                  row.organizer_email,
                  row.participants,
                  row.summary_overview,
                  row.summary_action_items,
                  row.keywords,
                  row.meeting_type,
                  this.metadataCell(row.metadata),
                ],
              ],
            },
          };
        }
      }
      return { ok: true, data: { rows: [] } };
    }
    // Schema-probe fallback: `SELECT 1 FROM <table> LIMIT 1`
    const m = s.match(/^SELECT\s+1\s+FROM\s+(\w+)\s+LIMIT\s+1/i);
    if (m) {
      const table = m[1];
      if (this.createdTables.has(table)) {
        return { ok: true, data: { rows: [[1]] } };
      }
      return { ok: false, error: { code: "SQL_ERROR", message: `no such table: ${table}` } };
    }
    if (/^SELECT\s+source_id\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const rows: unknown[][] = [];
      for (const row of this.meetings.values()) {
        if (row.source === source) rows.push([row.source_id]);
      }
      return { ok: true, data: { rows } };
    }
    if (/^SELECT\s+source_id,\s*started_at,\s*metadata\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const rows: unknown[][] = [];
      for (const row of this.meetings.values()) {
        if (row.source === source) rows.push([row.source_id, row.started_at, this.metadataCell(row.metadata)]);
      }
      return { ok: true, data: { rows } };
    }
    if (/^SELECT\s+id,\s*source_id,\s*title,\s*started_at,\s*summary_overview,\s*summary_action_items,\s*metadata\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const rows: unknown[][] = [];
      for (const row of this.meetings.values()) {
        if (row.source === source) {
          rows.push([row.id, row.source_id, row.title, row.started_at, row.summary_overview, row.summary_action_items, this.metadataCell(row.metadata)]);
        }
      }
      return { ok: true, data: { rows } };
    }
    if (/^SELECT\s+id\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const sourceId = String(params[1]);
      for (const row of this.meetings.values()) {
        if (row.source === source && row.source_id === sourceId) {
          return { ok: true, data: { rows: [[row.id]] } };
        }
      }
      return { ok: true, data: { rows: [] } };
    }
    if (/^SELECT\s+COUNT\(\*\)\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      let n = 0;
      for (const row of this.meetings.values()) if (row.source === source) n++;
      return { ok: true, data: { rows: [[n]] } };
    }
    if (/^SELECT\s+connector_id[\s\S]+FROM\s+connector_state\s+WHERE\s+connector_id\s*=\s*\?/i.test(s)) {
      const id = String(params[0]);
      const row = this.states.get(id);
      if (!row) return { ok: true, data: { rows: [] } };
      return {
        ok: true,
        data: {
          rows: [
            [
              row.connector_id,
              row.status,
              row.last_synced_at,
              row.last_sync_status,
              row.last_sync_error,
              row.item_count,
            ],
          ],
        },
      };
    }
    return { ok: true, data: { rows: [] } };
  }

  private applyOne(sql: string, params: unknown[] = []): SqlResult | null {
    const s = sql.trim();
    const createMatch = s.match(/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
    if (createMatch) {
      if (this.nextCreateError) {
        const err = this.nextCreateError;
        this.nextCreateError = null;
        return { ok: false, error: err };
      }
      this.createdTables.add(createMatch[1]);
      return { ok: true, data: { rows: [] } };
    }
    if (/^INSERT\s+INTO\s+connector_meeting/i.test(s)) {
      const [
        id,
        source,
        source_id,
        title,
        started_at,
        duration_secs,
        organizer_email,
        participants,
        summary_overview,
        summary_action_items,
        keywords,
        meeting_type,
        metadata,
        created_at,
        updated_at,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
      ];
      this.meetings.set(id, {
        id,
        source,
        source_id,
        title,
        started_at,
        duration_secs,
        organizer_email,
        participants,
        summary_overview,
        summary_action_items,
        keywords,
        meeting_type,
        metadata,
        created_at,
        updated_at,
      });
      return { ok: true, data: { rows: [] } };
    }
    if (/^INSERT\s+INTO\s+connector_state/i.test(s)) {
      const [
        connector_id,
        status,
        last_synced_at,
        last_sync_status,
        last_sync_error,
        item_count,
        updated_at,
      ] = params as [string, string, string | null, string | null, string | null, number, string];
      this.states.set(connector_id, {
        connector_id,
        status,
        last_synced_at,
        last_sync_status,
        last_sync_error,
        item_count,
        updated_at,
      });
      return { ok: true, data: { rows: [] } };
    }
    if (/^UPDATE\s+connector_meeting\s+SET\s+summary_overview\s*=\s*NULL,\s*summary_action_items\s*=\s*NULL,\s*metadata\s*=\s*\?,\s*updated_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?/i.test(s)) {
      const [metadata, updated_at, id] = params as [string, string, string];
      const existing = this.meetings.get(id);
      if (!existing) return { ok: true, data: { rows: [] } };
      this.meetings.set(id, { ...existing, summary_overview: null, summary_action_items: null, metadata, updated_at });
      return { ok: true, data: { rows: [] } };
    }
    if (/^UPDATE\s+connector_meeting\s+SET\s+summary_overview\s*=\s*\?,\s*summary_action_items\s*=\s*\?,\s*started_at\s*=\s*\?,\s*metadata\s*=\s*\?,\s*updated_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?/i.test(s)) {
      const [summary_overview, summary_action_items, started_at, metadata, updated_at, id] = params as [string | null, string | null, string | null, string, string, string];
      const existing = this.meetings.get(id);
      if (!existing) return { ok: true, data: { rows: [] } };
      this.meetings.set(id, { ...existing, summary_overview, summary_action_items, started_at, metadata, updated_at });
      return { ok: true, data: { rows: [] } };
    }
    if (/^UPDATE\s+connector_meeting\s+SET/i.test(s)) {
      const [
        title,
        started_at,
        duration_secs,
        organizer_email,
        participants,
        summary_overview,
        summary_action_items,
        keywords,
        meeting_type,
        metadata,
        updated_at,
        id,
      ] = params as [
        string | null,
        string | null,
        number | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
      ];
      const existing = this.meetings.get(id);
      if (!existing) return { ok: true, data: { rows: [] } };
      // created_at / id / source / source_id are deliberately untouched.
      this.meetings.set(id, {
        ...existing,
        title,
        started_at,
        duration_secs,
        organizer_email,
        participants,
        summary_overview,
        summary_action_items,
        keywords,
        meeting_type,
        metadata,
        updated_at,
      });
      return { ok: true, data: { rows: [] } };
    }
    if (/^DELETE\s+FROM\s+connector_meeting\s+WHERE\s+source\s*=\s*\?/i.test(s)) {
      const source = String(params[0]);
      for (const [id, row] of this.meetings) {
        if (row.source === source) this.meetings.delete(id);
      }
      return { ok: true, data: { rows: [] } };
    }
    if (/^DELETE\s+FROM\s+connector_meeting\s+WHERE\s+id\s*=\s*\?/i.test(s)) {
      this.meetings.delete(String(params[0]));
      return { ok: true, data: { rows: [] } };
    }
    if (/^DELETE\s+FROM\s+connector_state\s+WHERE\s+connector_id\s*=\s*\?/i.test(s)) {
      this.states.delete(String(params[0]));
      return { ok: true, data: { rows: [] } };
    }
    return null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<SqlResult> {
    return this.tracker.run("sql.execute", () => {
      if (this.nextExecuteError && !/^CREATE\s+TABLE/i.test(sql.trim())) {
        const err = this.nextExecuteError;
        this.nextExecuteError = null;
        return { ok: false, error: err } as SqlResult;
      }
      const res = this.applyOne(sql, params);
      return res ?? ({ ok: true, data: { rows: [] } } as SqlResult);
    });
  }

  async batch(stmts: { sql: string; params?: unknown[] }[]): Promise<SqlResult> {
    return this.tracker.run("sql.batch", () => {
      for (const stmt of stmts) {
        const r = this.applyOne(stmt.sql, stmt.params ?? []);
        if (r && !r.ok) return r;
      }
      return { ok: true, data: { rows: [] } } as SqlResult;
    });
  }
}

interface KvErr {
  code: string;
  message: string;
}

class FakeKv {
  entries = new Map<string, string>();
  putKeys: string[] = [];
  tracker = new OpTracker();
  listCalls: { path: string; cursor?: string }[] = [];
  /** Split each matching prefix listing into deterministic pages when set. */
  listPageSize: number | null = null;
  /** When set, the NEXT put() fails with the given error. Consumed on use. */
  nextPutError: KvErr | null = null;
  /** When set, the NEXT list() fails with the given error. Consumed on use. */
  nextListError: KvErr | null = null;
  /** Per-key delete failures, retained so one key can fail deterministically. */
  deleteErrors = new Map<string, KvErr>();

  async get(key: string): Promise<{ ok: true; data: { data: unknown; headers: Record<string, string> } } | { ok: false; error: KvErr }> {
    return this.tracker.run("kv.get", () => {
      if (!this.entries.has(key)) {
        return { ok: false, error: { code: "KV_NOT_FOUND", message: `no key ${key}` } } as const;
      }
      return { ok: true, data: { data: this.entries.get(key), headers: {} } } as const;
    });
  }

  async put(key: string, value: unknown): Promise<{ ok: true; data: { data: void; headers: Record<string, string> } } | { ok: false; error: KvErr }> {
    return this.tracker.run("kv.put", () => {
      if (this.nextPutError) {
        const err = this.nextPutError;
        this.nextPutError = null;
        return { ok: false, error: err } as const;
      }
      const stored = typeof value === "string" ? value : JSON.stringify(value);
      this.entries.set(key, stored);
      this.putKeys.push(key);
      return { ok: true, data: { data: undefined as unknown as void, headers: {} } } as const;
    });
  }

  async list(options: { path: string; cursor?: string }): Promise<
    | { ok: true; data: { keys: string[]; cursor?: string } }
    | { ok: false; error: KvErr }
  > {
    return this.tracker.run(`kv.list:${options.path}:${options.cursor ?? ""}`, () => {
      this.listCalls.push(options);
      if (this.nextListError) {
        const err = this.nextListError;
        this.nextListError = null;
        return { ok: false, error: err } as const;
      }
      const all = [...this.entries.keys()].filter((key) => key.startsWith(options.path)).sort();
      const start = Number.parseInt(options.cursor ?? "0", 10);
      const offset = Number.isSafeInteger(start) && start >= 0 ? start : 0;
      const size = this.listPageSize ?? all.length;
      const keys = all.slice(offset, offset + size);
      const next = offset + keys.length;
      return {
        ok: true,
        data: next < all.length ? { keys, cursor: String(next) } : { keys },
      } as const;
    });
  }

  async delete(key: string): Promise<{ ok: true; data: void } | { ok: false; error: KvErr }> {
    return this.tracker.run("kv.delete", () => {
      const forcedError = this.deleteErrors.get(key);
      if (forcedError) return { ok: false, error: forcedError } as const;
      if (!this.entries.has(key)) {
        return { ok: false, error: { code: "KV_NOT_FOUND", message: `no key ${key}` } } as const;
      }
      this.entries.delete(key);
      return { ok: true, data: undefined as unknown as void } as const;
    });
  }
}

interface Fake {
  tcw: TinyCloudWeb;
  sql: FakeSqlDb;
  kv: FakeKv;
  dbNamesRequested: string[];
  /** Shared by sql + kv — one space, so overlap of ANY two ops is a defect. */
  tracker: OpTracker;
}

function makeFake(): Fake {
  const sql = new FakeSqlDb();
  const kv = new FakeKv();
  const tracker = new OpTracker();
  sql.tracker = tracker;
  kv.tracker = tracker;
  const dbNamesRequested: string[] = [];
  const tcw = {
    // no did/spaceId → memo is disabled, every call re-runs ensureSchema
    // against the fake and each case sees a fresh flow.
    did: undefined,
    spaceId: undefined,
    sql: {
      db: (name: string) => {
        dbNamesRequested.push(name);
        return sql;
      },
    },
    kv,
  } as unknown as TinyCloudWeb;
  return { tcw, sql, kv, dbNamesRequested, tracker };
}

beforeEach(() => {
  _resetConnectorSchemaMemoForTests();
});

// ── Schema bootstrap ────────────────────────────────────────────────────

describe("connectorStore.ensureSchema", () => {
  test("uses the full APP_ID-prefixed db path (verbatim, not app-prefixed by SQL)", async () => {
    const f = makeFake();
    const res = await ensureSchema(f.tcw);
    expect(res.ok).toBe(true);
    expect(f.dbNamesRequested.length).toBeGreaterThan(0);
    expect(f.dbNamesRequested[0]).toBe(CONNECTORS_SQL_DB_NAME);
    expect(CONNECTORS_SQL_DB_NAME).toBe("xyz.tinycloud.tinychat/connectors");
  });

  test("schema fallback probe: 'not authorized' on CREATE TABLE is accepted when SELECT 1 succeeds", async () => {
    const f = makeFake();
    // Pretend both tables already exist (some other process created them),
    // and the authorizer refuses the redundant CREATE. The probe must recover.
    f.sql.createdTables.add("connector_state");
    f.sql.createdTables.add("connector_meeting");
    f.sql.nextCreateError = { code: "AUTH_UNAUTHORIZED", message: "not authorized" };
    const res = await ensureSchema(f.tcw);
    expect(res.ok).toBe(true);
    // A subsequent operation must succeed too — schema is treated as ready.
    const rows = await listKnownSourceIds(f.tcw, "fireflies");
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.data).toEqual([]);
  });

  test("schema failure that is NOT 'not authorized' surfaces as { ok: false, error }", async () => {
    const f = makeFake();
    f.sql.nextCreateError = { code: "AUTH_UNAUTHORIZED", message: "denied for policy X" };
    // No fallback creation, so probe will also fail — the original error surfaces.
    const res = await ensureSchema(f.tcw);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("AUTH_UNAUTHORIZED");
      expect(res.error.message).toContain("denied for policy X");
    }
  });
});

// ── Meetings: dedup + purge ─────────────────────────────────────────────

describe("connectorStore.updateSyncState / getConnection", () => {
  test("updateSyncState upserts and getConnection returns the row", async () => {
    const f = makeFake();
    const initial = await getConnection(f.tcw, "fireflies");
    expect(initial.ok && initial.data === null).toBe(true);

    const up1 = await updateSyncState(f.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: "2026-07-01T00:00:00.000Z",
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 42,
    });
    expect(up1.ok).toBe(true);
    const c = await getConnection(f.tcw, "fireflies");
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.data).toEqual({
        connectorId: "fireflies",
        status: "connected",
        lastSyncedAt: "2026-07-01T00:00:00.000Z",
        lastSyncStatus: "ok",
        lastSyncError: null,
        itemCount: 42,
      });
    }

    // Upsert semantics — a second call overwrites.
    const up2 = await updateSyncState(f.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: "2026-07-02T00:00:00.000Z",
      lastSyncStatus: "error",
      lastSyncError: "boom",
      itemCount: 42,
    });
    expect(up2.ok).toBe(true);
    const c2 = await getConnection(f.tcw, "fireflies");
    expect(c2.ok).toBe(true);
    if (c2.ok) {
      expect(c2.data?.lastSyncStatus).toBe("error");
      expect(c2.data?.lastSyncError).toBe("boom");
      expect(c2.data?.lastSyncedAt).toBe("2026-07-02T00:00:00.000Z");
    }
  });
});

// ── KV key format ───────────────────────────────────────────────────────

function baseTranscript(overrides: Partial<FirefliesTranscript> = {}): FirefliesTranscript {
  return {
    id: "t1",
    title: "Weekly sync",
    date: 1700000000000,
    duration: 30,
    organizer_email: "org@example.com",
    speakers: [
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ],
    meeting_attendees: [
      { displayName: "Ada", email: "ada@example.com" },
      { displayName: "Bob", email: "bob@example.com" },
    ],
    sentences: [
      { index: 0, speaker_name: "Ada", text: "hello", start_time: 0, end_time: 5 },
      { index: 1, speaker_name: "Grace", text: "world", start_time: 5, end_time: 1750 },
    ],
    summary: {
      keywords: ["kickoff", "roadmap"],
      action_items: "Do the thing",
      overview: "We discussed things",
      meeting_type: "internal-sync",
    },
    ...overrides,
  };
}

describe("normalizeFirefliesTranscript", () => {
  test("duration in MINUTES is converted to seconds and passes cross-check when close", async () => {
    // 30 min → 1800s, last end 1750s → diff 50 < max(120, 875), keep computed
    const { meeting } = normalizeFirefliesTranscript(baseTranscript());
    expect(meeting.durationSecs).toBe(1800);
    expect(meeting.metadata.duration_source).toBeUndefined();
  });

  test("duration cross-check swaps to sentence end_time when mismatched", async () => {
    // 5 min → 300s, last end 1800s → diff 1500 > max(120, 900), prefer 1800.
    const raw = baseTranscript({
      duration: 5,
      sentences: [
        { index: 0, speaker_name: "Ada", text: "hi", start_time: 0, end_time: 1800 },
      ],
    });
    const { meeting } = normalizeFirefliesTranscript(raw);
    expect(meeting.durationSecs).toBe(1800);
    expect(meeting.metadata.duration_source).toBe("sentences");
  });

  test("null summary → all summary fields are null, meeting still valid", async () => {
    const { meeting } = normalizeFirefliesTranscript(baseTranscript({ summary: null }));
    expect(meeting.summaryOverview).toBeNull();
    expect(meeting.summaryActionItems).toBeNull();
    expect(meeting.keywords).toBeNull();
    expect(meeting.meetingType).toBeNull();
    // Other fields still populated
    expect(meeting.title).toBe("Weekly sync");
    expect(meeting.sourceId).toBe("t1");
  });

  test("participants dedupe by name, first occurrence wins; email best-effort null", async () => {
    // Attendees: Ada (with email), Bob (with email).
    // Speakers: Ada (name only), Grace (name only).
    // Result: Ada with email (from attendees; first occurrence wins), Bob with email, Grace with null.
    const { meeting } = normalizeFirefliesTranscript(baseTranscript());
    expect(meeting.participants).toEqual([
      { name: "Ada", email: "ada@example.com" },
      { name: "Bob", email: "bob@example.com" },
      { name: "Grace", email: null },
    ]);
  });

  test("startedAt derived from raw.date epoch ms as ISO", async () => {
    const { meeting } = normalizeFirefliesTranscript(baseTranscript({ date: 0 }));
    expect(meeting.startedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  test("sentences are returned separately for KV storage", async () => {
    const { meeting, sentences } = normalizeFirefliesTranscript(baseTranscript());
    expect(sentences.length).toBe(2);
    expect(sentences[0].text).toBe("hello");
    // The meeting object doesn't smuggle sentences.
    expect((meeting as unknown as { sentences?: unknown }).sentences).toBeUndefined();
  });
});

// ── Targeted upsert (webhook queued-id ingest) ──────────────────────────
//
// The v1 sync only INSERTS new ids and skips existing rows, so a
// `meeting.summarized` webhook for an already-stored meeting would be
// permanently dropped. `upsertMeeting` is the targeted path: keyed on
// (source, source_id), it preserves the row id + created_at and refreshes
// meeting metadata, summary fields, and the transcript KV body.

function meetingFixture(over: Partial<NormalizedMeeting> = {}): NormalizedMeeting {
  return {
    id: "row-new",
    source: "fireflies",
    sourceId: "mtg-1",
    title: "Standup",
    startedAt: "2026-07-01T10:00:00.000Z",
    durationSecs: 1800,
    organizerEmail: "org@ex.com",
    participants: [{ name: "Ada", email: "ada@ex.com" }],
    summaryOverview: null,
    summaryActionItems: null,
    keywords: null,
    meetingType: null,
    metadata: {},
    ...over,
  };
}

const S = (text: string) => ({ index: 0, speaker_name: "Ada", text, start_time: 0, end_time: 1 });
