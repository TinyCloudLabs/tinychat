import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesTranscript } from "./firefliesClient";
import type { GmeetConferenceRecord, GmeetParticipant, GmeetResult, GmeetTranscript, GmeetTranscriptEntry } from "./gmeetClient";
import { _resetGmeetSyncSingleFlightForTests, syncGoogleMeet, type GmeetSyncClient, type GmeetSyncStore } from "./gmeetSync";
import {
  CONNECTORS_KV_PREFIX,
  CONNECTORS_SQL_DB_NAME,
  _resetConnectorSchemaMemoForTests,
  attachGmeetNotes,
  countMeetings,
  driveCursorKvKey,
  ensureSchema,
  findGmeetNotesAssociation,
  getConnection,
  getMeetingDatetimeStats,
  meetingKvKey,
  getDriveCursor,
  insertMeeting,
  listKnownSourceIds,
  normalizeFirefliesTranscript,
  putDriveCursor,
  purgeConnector,
  putTranscriptBody,
  removeGmeetNotes,
  transcriptKvKey,
  updateSyncState,
  upsertMeeting,
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

describe("connectorStore.insertMeeting — app-level dedup on (source, source_id)", () => {
  test("first insert returns true; second insert with same (source, source_id) returns false and does NOT duplicate", async () => {
    const f = makeFake();
    const meeting = {
      id: "row-1",
      source: "fireflies",
      sourceId: "abc",
      title: "Standup",
      startedAt: "2026-07-01T10:00:00.000Z",
      durationSecs: 1800,
      organizerEmail: "org@ex.com",
      participants: [{ name: "Ada", email: null }],
      summaryOverview: "overview",
      summaryActionItems: "actions",
      keywords: ["k1"],
      meetingType: "call",
      metadata: {},
    };

    const first = await insertMeeting(f.tcw, meeting);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data).toBe(true);

    // A second call with a DIFFERENT `id` but the same (source, source_id)
    // must be skipped — dedup key is (source, source_id), not id.
    const second = await insertMeeting(f.tcw, { ...meeting, id: "row-2" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data).toBe(false);

    const known = await listKnownSourceIds(f.tcw, "fireflies");
    expect(known.ok).toBe(true);
    if (known.ok) expect(known.data).toEqual(["abc"]);
    const count = await countMeetings(f.tcw, "fireflies");
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.data).toBe(1);
  });
});

describe("connectorStore.purgeConnector", () => {
  test("deletes every listed KV-only meeting/transcript record, cursor, SQL rows, and state sequentially", async () => {
    const f = makeFake();
    await insertMeeting(f.tcw, {
      id: "r1",
      source: "fireflies",
      sourceId: "aaa",
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
    await insertMeeting(f.tcw, {
      id: "r2",
      source: "fireflies",
      sourceId: "bbb",
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
    await putTranscriptBody(f.tcw, "fireflies", "aaa", []);
    await putTranscriptBody(f.tcw, "fireflies", "bbb", []);
    await f.kv.put(meetingKvKey("fireflies", "kv-only"), "reconciled record");
    await f.kv.put(transcriptKvKey("fireflies", "kv-only"), "reconciled transcript");
    await f.kv.put(driveCursorKvKey("fireflies"), "drive-cursor");
    await updateSyncState(f.tcw, {
      connectorId: "fireflies",
      status: "connected",
      lastSyncedAt: "2026-07-01T00:00:00.000Z",
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 2,
    });

    // Sanity — non-zero baseline
    const baselineCount = await countMeetings(f.tcw, "fireflies");
    expect(baselineCount.ok && baselineCount.data === 2).toBe(true);
    expect(f.kv.entries.has(transcriptKvKey("fireflies", "aaa"))).toBe(true);
    expect(f.kv.entries.has(transcriptKvKey("fireflies", "bbb"))).toBe(true);
    expect(f.kv.entries.has(meetingKvKey("fireflies", "kv-only"))).toBe(true);
    const baselineConn = await getConnection(f.tcw, "fireflies");
    expect(baselineConn.ok && baselineConn.data !== null).toBe(true);

    const purged = await purgeConnector(f.tcw, "fireflies");
    expect(purged.ok).toBe(true);

    const afterCount = await countMeetings(f.tcw, "fireflies");
    expect(afterCount.ok && afterCount.data === 0).toBe(true);
    expect(f.kv.entries.size).toBe(0);
    const afterConn = await getConnection(f.tcw, "fireflies");
    expect(afterConn.ok && afterConn.data === null).toBe(true);
    expect(f.kv.listCalls).toEqual([
      { path: `${CONNECTORS_KV_PREFIX}/fireflies/meeting/` },
      { path: `${CONNECTORS_KV_PREFIX}/fireflies/transcript/` },
    ]);
    expect(f.tracker.maxInFlight).toBe(1);
  });

  test("KV_NOT_FOUND during purge is tolerated (already-gone key)", async () => {
    const f = makeFake();
    await insertMeeting(f.tcw, {
      id: "r1",
      source: "fireflies",
      sourceId: "aaa",
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
    await putTranscriptBody(f.tcw, "fireflies", "aaa", []);
    f.kv.deleteErrors.set(transcriptKvKey("fireflies", "aaa"), {
      code: "KV_NOT_FOUND",
      message: "already gone",
    });
    const purged = await purgeConnector(f.tcw, "fireflies");
    expect(purged.ok).toBe(true);
    const afterCount = await countMeetings(f.tcw, "fireflies");
    expect(afterCount.ok && afterCount.data === 0).toBe(true);
  });

  test("fails closed when prefix enumeration fails before any purge mutation", async () => {
    const f = makeFake();
    await insertMeeting(f.tcw, {
      id: "r1", source: "fireflies", sourceId: "aaa", title: null, startedAt: null,
      durationSecs: null, organizerEmail: null, participants: [], summaryOverview: null,
      summaryActionItems: null, keywords: null, meetingType: null, metadata: {},
    });
    await putTranscriptBody(f.tcw, "fireflies", "aaa", []);
    f.kv.nextListError = { code: "KV_ERROR", message: "cannot enumerate" };

    const purged = await purgeConnector(f.tcw, "fireflies");

    expect(purged).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "KV_ERROR", message: expect.stringContaining("list:") }),
    });
    expect(f.kv.entries.has(transcriptKvKey("fireflies", "aaa"))).toBe(true);
    const afterCount = await countMeetings(f.tcw, "fireflies");
    expect(afterCount.ok && afterCount.data === 1).toBe(true);
  });

  test("fails closed on rejected, malformed, non-string, or out-of-prefix list data before deleting", async () => {
    const cases: Array<unknown> = [
      new Error("rejected"),
      { ok: true, data: {} },
      { ok: true, data: { keys: [42] } },
      { ok: true, data: { keys: ["unrelated/private-key"] } },
      { ok: true, data: { keys: [], cursor: "more" } },
    ];
    for (const reply of cases) {
      const f = makeFake();
      await f.kv.put(meetingKvKey("fireflies", "kv-only"), "record");
      f.kv.list = (async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      }) as never;
      const result = await purgeConnector(f.tcw, "fireflies");
      expect(result.ok).toBe(false);
      expect(f.kv.entries.has(meetingKvKey("fireflies", "kv-only"))).toBe(true);
    }
  });

  test("fails closed when deleting a listed KV key fails", async () => {
    const f = makeFake();
    await insertMeeting(f.tcw, {
      id: "r1", source: "fireflies", sourceId: "aaa", title: null, startedAt: null,
      durationSecs: null, organizerEmail: null, participants: [], summaryOverview: null,
      summaryActionItems: null, keywords: null, meetingType: null, metadata: {},
    });
    await f.kv.put(meetingKvKey("fireflies", "kv-only"), "record");
    f.kv.deleteErrors.set(meetingKvKey("fireflies", "kv-only"), {
      code: "KV_ERROR",
      message: "cannot delete",
    });

    const purged = await purgeConnector(f.tcw, "fireflies");

    expect(purged).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "KV_ERROR", message: expect.stringContaining("kv:") }),
    });
    expect(f.kv.entries.has(meetingKvKey("fireflies", "kv-only"))).toBe(true);
    const afterCount = await countMeetings(f.tcw, "fireflies");
    expect(afterCount.ok && afterCount.data === 1).toBe(true);
    expect(f.tracker.maxInFlight).toBe(1);
  });
});

function realGmeetStore(): GmeetSyncStore {
  return {
    getConnection,
    putTranscriptBody,
    upsertMeeting,
    updateSyncState,
    countMeetings,
    getDriveCursor,
    putDriveCursor,
    findGmeetNotesAssociation,
    attachGmeetNotes,
    removeGmeetNotes,
  };
}

function driveChangeClient(
  fileId: string,
  document: Record<string, unknown>,
  newStartPageToken: string,
  fileName = "Notes by Gemini — updated",
): GmeetSyncClient {
  return {
    delayMs: 0,
    async pace() {},
    async listConferenceRecords() { return { ok: true as const, data: [] }; },
    async listParticipants() { return { ok: true as const, data: [] }; },
    async listTranscripts() { return { ok: true as const, data: [] }; },
    async listTranscriptEntries() { return { ok: true as const, data: [] }; },
    async getDriveStartPageToken() { throw new Error("incremental sync must not snapshot"); },
    async listDriveFiles() { throw new Error("incremental sync must not snapshot"); },
    async listDriveChangesPage() {
      return { ok: true as const, data: {
        changes: [{ fileId, file: { id: fileId, name: fileName, mimeType: "application/vnd.google-apps.document" } }],
        nextPageToken: null,
        newStartPageToken,
      } };
    },
    async getDriveDocument() { return { ok: true as const, data: document }; },
  };
}

function conferenceFixture(id: string, startTime: string, texts: string[]): {
  record: GmeetConferenceRecord;
  participants: GmeetParticipant[];
  transcripts: GmeetTranscript[];
  entries: Record<string, GmeetTranscriptEntry[]>;
} {
  const name = `conferenceRecords/${id}`;
  const transcriptName = `${name}/transcripts/t1`;
  const participantName = `${name}/participants/alice`;
  return {
    record: { name, startTime, endTime: "2026-08-17T09:30:00.000Z", space: "spaces/atlas" },
    participants: [{ name: participantName, signedinUser: { user: "people/alice", displayName: "Alice" } }],
    transcripts: [{ name: transcriptName, state: "ENDED" }],
    entries: {
      [transcriptName]: texts.map((text, index) => ({
        name: `${transcriptName}/entries/${index}`,
        participant: participantName,
        text,
        startTime: `2026-08-17T09:0${index}:00.000Z`,
        endTime: `2026-08-17T09:0${index}:00.000Z`,
      })),
    },
  };
}

describe("connectorStore Drive Notes lifecycle", () => {
  const validNotesDocument = (title = "Meet with Alice — Aug 17") => ({ body: { content: [
    { paragraph: { paragraphStyle: { namedStyleType: "TITLE" }, elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
    { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: `${title}\n` } }] } },
    { paragraph: { elements: [{ textRun: { content: "August 17, 2026, 9:00 AM UTC – 9:30 AM\n" } }] } },
    { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
    { paragraph: { elements: [{ textRun: { content: "The pilot is approved.\n" } }] } },
    { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Next steps\n" } }] } },
    { paragraph: { elements: [{ textRun: { content: "Publish the checklist.\n" } }] } },
  ] } });

  const invalidNotesDocument = (kind: "sections-deleted" | "marker-removed") => ({ body: { content: kind === "sections-deleted"
    ? [
      { paragraph: { paragraphStyle: { namedStyleType: "TITLE" }, elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Meet with Alice — Aug 17\n" } }] } },
      { paragraph: { elements: [{ textRun: { content: "The notes were deleted.\n" } }] } },
    ]
    : [
      { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Meeting recap\n" } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
      { paragraph: { elements: [{ textRun: { content: "The old marker was removed.\n" } }] } },
    ],
  } });

  test("datetime source aggregation accepts already-decoded metadata cells", async () => {
    const f = makeFake();
    f.sql.decodeMetadataCells = true;
    const fixtures: NormalizedMeeting[] = [
      {
        id: "meet-row", source: "google-meet", sourceId: "conference-1", title: null,
        startedAt: "2026-08-17T09:00:00.000Z", durationSecs: null, organizerEmail: null,
        participants: [], summaryOverview: null, summaryActionItems: null, keywords: null,
        meetingType: null, metadata: {
          datetime_source: "meet_conference_start", datetime_exact: true,
          datetime_resolution_version: 1,
        },
      },
      {
        id: "docs-row", source: "google-meet", sourceId: "notes-exact", title: null,
        startedAt: "2026-08-18T09:00:00.000Z", durationSecs: null, organizerEmail: null,
        participants: [], summaryOverview: null, summaryActionItems: null, keywords: null,
        meetingType: null, metadata: {
          datetime_source: "docs_content", datetime_exact: true,
          datetime_resolution_version: 1,
        },
      },
      {
        id: "drive-row", source: "google-meet", sourceId: "notes-approx", title: null,
        startedAt: "2026-08-19T08:55:04.123Z", durationSecs: null, organizerEmail: null,
        participants: [], summaryOverview: null, summaryActionItems: null, keywords: null,
        meetingType: null, metadata: {
          datetime_source: "drive_created_time", datetime_exact: false,
          datetime_resolution_version: 1,
        },
      },
    ];
    for (const fixture of fixtures) expect((await insertMeeting(f.tcw, fixture)).ok).toBe(true);

    const stats = await getMeetingDatetimeStats(f.tcw, "google-meet");

    expect(stats).toEqual({ ok: true, data: {
      rows: 3, dated: 3, sourceMeet: 1, sourceDocs: 1,
      sourceDriveCreatedApprox: 1, sourceUnavailable: 0,
      invalidAmbiguous: 0, duplicates: 0,
    } });
  });

  test("association reads Drive ownership from already-decoded metadata cells", async () => {
    const f = makeFake();
    f.sql.decodeMetadataCells = true;
    await insertMeeting(f.tcw, {
      id: "conference-row", source: "google-meet", sourceId: "conference-1", title: null,
      startedAt: null, durationSecs: null, organizerEmail: null, participants: [],
      summaryOverview: null, summaryActionItems: null, keywords: null, meetingType: null,
      metadata: { drive_file_id: "notes-1", notes_association: "conference" },
    });

    const found = await findGmeetNotesAssociation(f.tcw, "google-meet", "notes-1", null, null);

    expect(found.ok && found.data?.sourceId).toBe("conference-1");
  });

  test("associates, removes, and purges Drive Notes using the real SQL and KV primitives", async () => {
    const f = makeFake();
    const conference: NormalizedMeeting = {
      id: "conference-row",
      source: "google-meet",
      sourceId: "conference-1",
      title: "Atlas planning",
      startedAt: "2026-08-17T09:00:00.000Z",
      durationSecs: null,
      organizerEmail: null,
      participants: [],
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: { docs_export_uris: ["https://docs.google.com/document/d/notes-1/edit"] },
    };
    const standalone: NormalizedMeeting = {
      ...conference,
      id: "notes-row",
      sourceId: "notes-2",
      metadata: {
        drive_file_id: "notes-2",
        drive_modified_time: "2026-08-17T10:00:00.000Z",
        notes_association: "standalone",
      },
    };
    expect((await insertMeeting(f.tcw, conference)).ok).toBe(true);
    expect((await putTranscriptBody(f.tcw, "google-meet", "conference-1", [
      { index: 0, speaker_name: "Alice", text: "real transcript", start_time: 0, end_time: 1 },
    ])).ok).toBe(true);

    const found = await findGmeetNotesAssociation(f.tcw, "google-meet", "notes-1", "Atlas planning", conference.startedAt);
    expect(found.ok && found.data?.sourceId).toBe("conference-1");
    if (!found.ok || !found.data) return;
    expect((await attachGmeetNotes(f.tcw, found.data, {
      summaryOverview: "Gemini summary",
      summaryActionItems: "Follow up",
      metadata: {
        drive_file_id: "notes-1",
        drive_modified_time: "2026-08-17T10:00:00.000Z",
        notes_kind: "gemini",
        notes_owned_fields: ["summary_overview", "summary_action_items"],
      },
    })).ok).toBe(true);
    expect(f.sql.meetings.get("conference-row")?.summary_overview).toBe("Gemini summary");
    expect(f.kv.entries.get(transcriptKvKey("google-meet", "conference-1"))).toContain("real transcript");

    const cleared = await removeGmeetNotes(f.tcw, "google-meet", "notes-1");
    expect(cleared).toEqual({ ok: true, data: "cleared" });
    expect(f.sql.meetings.get("conference-row")?.summary_overview).toBeNull();
    expect(f.kv.entries.get(transcriptKvKey("google-meet", "conference-1"))).toContain("real transcript");

    expect((await insertMeeting(f.tcw, standalone)).ok).toBe(true);
    expect((await putTranscriptBody(f.tcw, "google-meet", "notes-2", [
      { index: 0, speaker_name: "Gemini", text: "notes body", start_time: 0, end_time: 1 },
    ])).ok).toBe(true);
    const deleted = await removeGmeetNotes(f.tcw, "google-meet", "notes-2");
    expect(deleted).toEqual({ ok: true, data: "deleted" });
    expect(f.sql.meetings.has("notes-row")).toBe(false);
    expect(f.kv.entries.has(transcriptKvKey("google-meet", "notes-2"))).toBe(false);

    expect((await putDriveCursor(f.tcw, "google-meet", "drive-cursor")).ok).toBe(true);
    expect((await getDriveCursor(f.tcw, "google-meet")).data).toBe("drive-cursor");
    expect((await purgeConnector(f.tcw, "google-meet")).ok).toBe(true);
    expect(f.kv.entries.has(driveCursorKvKey("google-meet"))).toBe(false);
  });

  test("attachment fills an undated target only from exact Docs provenance", async () => {
    const f = makeFake();
    await insertMeeting(f.tcw, {
      id: "conference-row", source: "google-meet", sourceId: "conference-1", title: "Atlas planning",
      startedAt: null, durationSecs: null, organizerEmail: null, participants: [],
      summaryOverview: null, summaryActionItems: null, keywords: null, meetingType: null,
      metadata: {
        docs_export_uris: ["https://docs.google.com/document/d/notes-1/edit"],
        datetime_source: "unavailable", datetime_exact: false, datetime_resolution_version: 1,
      },
    });
    const found = await findGmeetNotesAssociation(f.tcw, "google-meet", "notes-1", null, null);
    expect(found.ok && found.data).not.toBeNull();
    if (!found.ok || !found.data) return;

    const attached = await attachGmeetNotes(f.tcw, found.data, {
      startedAt: "2026-08-17T13:00:00.000Z",
      summaryOverview: "Gemini summary",
      summaryActionItems: null,
      metadata: {
        drive_file_id: "notes-1", datetime_source: "docs_content",
        datetime_exact: true, datetime_resolution_version: 1,
      },
    });

    expect(attached.ok).toBe(true);
    const row = f.sql.meetings.get("conference-row");
    expect(row?.started_at).toBe("2026-08-17T13:00:00.000Z");
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
      datetime_source: "docs_content", datetime_exact: true, datetime_resolution_version: 1,
    });

    const refreshed = await findGmeetNotesAssociation(f.tcw, "google-meet", "notes-1", null, null);
    if (!refreshed.ok || !refreshed.data) return;
    const approximate = await attachGmeetNotes(f.tcw, refreshed.data, {
      startedAt: "2026-08-17T12:55:04.123Z",
      summaryOverview: "Updated Gemini summary",
      summaryActionItems: null,
      metadata: {
        drive_file_id: "notes-1", datetime_source: "drive_created_time",
        datetime_exact: false, datetime_resolution_version: 1,
      },
    });
    expect(approximate.ok).toBe(true);
    const afterApproximate = f.sql.meetings.get("conference-row");
    expect(afterApproximate?.summary_overview).toBe("Updated Gemini summary");
    expect(afterApproximate?.started_at).toBe("2026-08-17T13:00:00.000Z");
    expect(JSON.parse(afterApproximate?.metadata ?? "{}")).toMatchObject({
      datetime_source: "docs_content", datetime_exact: true,
    });
  });

  test("sync engine applies an associated Drive change then its removal through the real store", async () => {
    const f = makeFake();
    const source = "google-meet";
    await insertMeeting(f.tcw, {
      id: "conference-row",
      source,
      sourceId: "conference-1",
      title: "Project Atlas",
      startedAt: "2026-08-17T09:00:00.000Z",
      durationSecs: null,
      organizerEmail: null,
      participants: [],
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: { docs_export_uris: ["https://docs.google.com/document/d/notes-1/edit"] },
    });
    await putTranscriptBody(f.tcw, source, "conference-1", [
      { index: 0, speaker_name: "Alice", text: "Meet transcript survives", start_time: 0, end_time: 1 },
    ]);
    await putDriveCursor(f.tcw, source, "cursor-0");
    const preflightAssociation = await findGmeetNotesAssociation(f.tcw, source, "notes-1", null, null);
    expect(preflightAssociation.ok && preflightAssociation.data?.sourceId).toBe("conference-1");

    let removal = false;
    const client: GmeetSyncClient = {
      delayMs: 0,
      async pace() {},
      async listConferenceRecords(): Promise<GmeetResult<[]>> { return { ok: true, data: [] }; },
      async listParticipants() { return { ok: true as const, data: [] }; },
      async listTranscripts() { return { ok: true as const, data: [] }; },
      async listTranscriptEntries() { return { ok: true as const, data: [] }; },
      async getDriveStartPageToken() { throw new Error("incremental sync must not snapshot"); },
      async listDriveFiles() { throw new Error("incremental sync must not list files"); },
      async listDriveChangesPage() {
        return { ok: true as const, data: {
          changes: removal
            ? [{ fileId: "notes-1", removed: true }]
            : [{ fileId: "notes-1", file: {
              id: "notes-1", name: "Notes by Gemini — Project Atlas", mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-08-17T10:00:00.000Z",
            } }],
          nextPageToken: null,
          newStartPageToken: removal ? "cursor-2" : "cursor-1",
        } };
      },
      async getDriveDocument() {
        if (removal) throw new Error("removed Docs must not be read");
        return { ok: true as const, data: { body: { content: [
          { paragraph: { paragraphStyle: { namedStyleType: "TITLE" }, elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Project Atlas\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "August 17, 2026, 9:00 AM – 9:30 AM\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "The pilot is approved.\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Next steps\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "• Publish the checklist.\n" } }] } },
        ] } } };
      },
    };
    const store: GmeetSyncStore = {
      getConnection,
      putTranscriptBody,
      upsertMeeting,
      updateSyncState,
      countMeetings,
      getDriveCursor,
      putDriveCursor,
      findGmeetNotesAssociation,
      attachGmeetNotes,
      removeGmeetNotes,
    };

    const first = await syncGoogleMeet({ client, store, tcw: f.tcw, now: () => Date.parse("2026-08-17T12:00:00.000Z") });
    expect(first.ok).toBe(true);
    expect(f.sql.meetings.get("conference-row")?.summary_overview).toBe("The pilot is approved.");
    expect(f.kv.entries.get(transcriptKvKey(source, "conference-1"))).toContain("Meet transcript survives");
    expect((await getDriveCursor(f.tcw, source)).data).toBe("cursor-1");

    removal = true;
    _resetGmeetSyncSingleFlightForTests();
    const second = await syncGoogleMeet({ client, store, tcw: f.tcw, now: () => Date.parse("2026-08-17T12:01:00.000Z") });
    expect(second.ok).toBe(true);
    expect(f.sql.meetings.get("conference-row")?.summary_overview).toBeNull();
    expect(f.kv.entries.get(transcriptKvKey(source, "conference-1"))).toContain("Meet transcript survives");
    expect((await getDriveCursor(f.tcw, source)).data).toBe("cursor-2");
  });

  test.each(["sections-deleted", "marker-removed"] as const)("a successfully read %s Doc removes only its standalone Notes row before advancing the cursor", async (kind) => {
    const f = makeFake();
    const source = "google-meet";
    const fileId = `standalone-${kind}`;
    await insertMeeting(f.tcw, {
      id: "notes-row", source, sourceId: fileId, title: "Meet with Alice — Aug 17",
      startedAt: "2026-08-17T09:00:00.000Z", durationSecs: null, organizerEmail: null,
      participants: [], summaryOverview: "Old Gemini summary", summaryActionItems: "Old Gemini action",
      keywords: null, meetingType: null,
      metadata: {
        drive_file_id: fileId, drive_modified_time: "2026-08-17T10:00:00.000Z",
        notes_kind: "gemini", notes_association: "standalone",
        notes_owned_fields: ["summary_overview", "summary_action_items"],
      },
    });
    await putTranscriptBody(f.tcw, source, fileId, [{ index: 0, speaker_name: "Notes by Gemini", text: "Old Gemini summary", start_time: 0, end_time: 0 }]);
    await putDriveCursor(f.tcw, source, "cursor-0");

    const client = driveChangeClient(
      fileId,
      invalidNotesDocument(kind),
      "cursor-1",
      kind === "marker-removed" ? "Renamed associated document" : undefined,
    );
    const result = await syncGoogleMeet({ client, store: realGmeetStore(), tcw: f.tcw, now: () => Date.parse("2026-08-17T12:00:00.000Z") });

    expect(result.ok).toBe(true);
    expect(f.sql.meetings.has("notes-row")).toBe(false);
    expect(f.kv.entries.has(transcriptKvKey(source, fileId))).toBe(false);
    expect((await getDriveCursor(f.tcw, source)).data).toBe("cursor-1");
  });

  test.each(["sections-deleted", "marker-removed"] as const)("a successfully read %s Doc clears only its associated Notes fields and preserves the Meet transcript", async (kind) => {
    const f = makeFake();
    const source = "google-meet";
    const fileId = `associated-${kind}`;
    await insertMeeting(f.tcw, {
      id: "conference-row", source, sourceId: "conference-1", title: "Meet with Alice — Aug 17",
      startedAt: "2026-08-17T09:00:00.000Z", durationSecs: null, organizerEmail: null,
      participants: [], summaryOverview: "Old Gemini summary", summaryActionItems: "Old Gemini action",
      keywords: null, meetingType: null,
      metadata: {
        drive_file_id: fileId, drive_modified_time: "2026-08-17T10:00:00.000Z",
        notes_kind: "gemini", notes_association: "conference",
        notes_owned_fields: ["summary_overview", "summary_action_items"],
      },
    });
    await putTranscriptBody(f.tcw, source, "conference-1", [{ index: 0, speaker_name: "Alice", text: "Meet transcript survives", start_time: 0, end_time: 1 }]);
    await putDriveCursor(f.tcw, source, "cursor-0");

    const client = driveChangeClient(
      fileId,
      invalidNotesDocument(kind),
      "cursor-1",
      kind === "marker-removed" ? "Renamed associated document" : undefined,
    );
    const result = await syncGoogleMeet({ client, store: realGmeetStore(), tcw: f.tcw, now: () => Date.parse("2026-08-17T12:00:00.000Z") });

    expect(result.ok).toBe(true);
    const conference = f.sql.meetings.get("conference-row");
    expect(conference?.summary_overview).toBeNull();
    expect(conference?.summary_action_items).toBeNull();
    expect(JSON.parse(conference?.metadata ?? "{}")).not.toHaveProperty("drive_file_id");
    expect(f.kv.entries.get(transcriptKvKey(source, "conference-1"))).toContain("Meet transcript survives");
    expect((await getDriveCursor(f.tcw, source)).data).toBe("cursor-1");
  });

  test("reconciles a Notes-first standalone row on a later Meet-only run when Drive Changes is empty", async () => {
    const f = makeFake();
    const source = "google-meet";
    let run = 0;
    const laterConference = conferenceFixture("conference-later", "2026-08-17T09:00:00.000Z", ["Meet transcript survives"]);
    const client: GmeetSyncClient = {
      delayMs: 0,
      async pace() {},
      async listConferenceRecords() { return { ok: true as const, data: run === 0 ? [] : [laterConference.record] }; },
      async listParticipants(recordName) { return { ok: true as const, data: recordName === laterConference.record.name ? laterConference.participants : [] }; },
      async listTranscripts(recordName) { return { ok: true as const, data: recordName === laterConference.record.name ? laterConference.transcripts : [] }; },
      async listTranscriptEntries(transcriptName) { return { ok: true as const, data: laterConference.entries[transcriptName] ?? [] }; },
      async getDriveStartPageToken() { return { ok: true as const, data: "cursor-1" }; },
      async listDriveFiles() { return { ok: true as const, data: [{ id: "notes-1", name: "Notes by Gemini — Meet with Alice", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-08-17T10:00:00.000Z" }] }; },
      async listDriveChangesPage() { return { ok: true as const, data: { changes: [], nextPageToken: null, newStartPageToken: "cursor-2" } }; },
      async getDriveDocument() { return { ok: true as const, data: validNotesDocument() }; },
    };
    const store = realGmeetStore();

    const first = await syncGoogleMeet({ client, store, tcw: f.tcw, now: () => Date.parse("2026-08-17T12:00:00.000Z") });
    expect(first.ok).toBe(true);
    expect([...f.sql.meetings.values()].map((row) => row.source_id)).toEqual(["notes-1"]);
    expect(f.kv.entries.get(transcriptKvKey(source, "notes-1"))).toContain("The pilot is approved.");

    run = 1;
    _resetGmeetSyncSingleFlightForTests();
    const second = await syncGoogleMeet({ client, store, tcw: f.tcw, now: () => Date.parse("2026-08-17T12:01:00.000Z") });

    expect(second.ok).toBe(true);
    const rows = [...f.sql.meetings.values()];
    expect(rows.map((row) => row.source_id)).toEqual(["conference-later"]);
    expect(rows[0]?.summary_overview).toBe("The pilot is approved.");
    expect(rows[0]?.summary_action_items).toBe("Publish the checklist.");
    expect(f.kv.entries.has(transcriptKvKey(source, "notes-1"))).toBe(false);
    expect(f.kv.entries.get(transcriptKvKey(source, "conference-later"))).toContain("Meet transcript survives");
    expect((await getDriveCursor(f.tcw, source)).data).toBe("cursor-2");
  });
});

// ── updateSyncState + getConnection ─────────────────────────────────────

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

describe("connectorStore.putTranscriptBody / transcriptKvKey", () => {
  test("KV key carries the full APP_ID path the manifest grant resolves to", async () => {
    const f = makeFake();
    const key = transcriptKvKey("fireflies", "abc");
    expect(key).toBe("xyz.tinycloud.tinychat/connectors/fireflies/transcript/abc");
    // The KV service sends the key verbatim, so it has to start inside the
    // granted `${APP_ID}/connectors/` prefix or the node returns 401.
    expect(key.startsWith(`${CONNECTORS_KV_PREFIX}/`)).toBe(true);
    expect(CONNECTORS_KV_PREFIX).toBe(CONNECTORS_SQL_DB_NAME);
    const put = await putTranscriptBody(f.tcw, "fireflies", "abc", [
      { index: 0, speaker_name: "Ada", text: "hi", start_time: 0, end_time: 1 },
    ]);
    expect(put.ok).toBe(true);
    const stored = f.kv.entries.get(key);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].text).toBe("hi");
  });
});

// ── Normalization ───────────────────────────────────────────────────────

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

describe("connectorStore.upsertMeeting — insert path", () => {
  test("inserts a genuinely new (source, source_id) and writes the transcript KV body", async () => {
    const f = makeFake();
    const res = await upsertMeeting(f.tcw, meetingFixture(), [S("hello")]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.inserted).toBe(true);
    expect(res.data.id).toBe("row-new");
    expect(typeof res.data.createdAt).toBe("string");

    const count = await countMeetings(f.tcw, "fireflies");
    expect(count.ok && count.data === 1).toBe(true);

    // KV key is the full verbatim resolved path — no bare `connectors/...`.
    const key = transcriptKvKey("fireflies", "mtg-1");
    expect(key).toBe(`${CONNECTORS_KV_PREFIX}/fireflies/transcript/mtg-1`);
    expect(key.startsWith("xyz.tinycloud.tinychat/")).toBe(true);
    expect(JSON.parse(f.kv.entries.get(key) ?? "[]")).toHaveLength(1);
  });

  test("all storage calls are sequential — never two in flight on one space", async () => {
    const f = makeFake();
    const res = await upsertMeeting(f.tcw, meetingFixture(), [S("hello")]);
    expect(res.ok).toBe(true);
    expect(f.tracker.maxInFlight).toBe(1);
    // And again on the update path.
    const res2 = await upsertMeeting(f.tcw, meetingFixture({ id: "ignored" }), [S("hi")]);
    expect(res2.ok).toBe(true);
    expect(f.tracker.maxInFlight).toBe(1);
  });
});

describe("connectorStore.upsertMeeting — update path (the meeting.summarized case)", () => {
  test("preserves the existing row id and created_at while updating metadata + summary", async () => {
    const f = makeFake();
    const first = await upsertMeeting(f.tcw, meetingFixture({ id: "row-original" }), [S("a")]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalCreatedAt = first.data.createdAt;
    const originalUpdatedAt = f.sql.meetings.get("row-original")?.updated_at;
    // Ensure a later ISO timestamp is observable.
    await new Promise((r) => setTimeout(r, 2));

    // A `meeting.summarized` delivery: SAME (source, source_id), fresh row id
    // from normalize(), now carrying the summary fields.
    const second = await upsertMeeting(
      f.tcw,
      meetingFixture({
        id: "row-from-normalize",
        title: "Standup (final)",
        durationSecs: 1900,
        summaryOverview: "we shipped it",
        summaryActionItems: "ship more",
        keywords: ["ship"],
        meetingType: "standup",
      }),
      [S("a"), S("b")],
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.inserted).toBe(false);
    expect(second.data.id).toBe("row-original");
    expect(second.data.createdAt).toBe(originalCreatedAt);

    // No duplicate row, and the throwaway normalize id was NOT stored.
    const count = await countMeetings(f.tcw, "fireflies");
    expect(count.ok && count.data === 1).toBe(true);
    expect(f.sql.meetings.has("row-from-normalize")).toBe(false);

    const row = f.sql.meetings.get("row-original");
    expect(row?.created_at).toBe(originalCreatedAt);
    expect(row?.updated_at).not.toBe(originalUpdatedAt);
    expect(row?.title).toBe("Standup (final)");
    expect(row?.duration_secs).toBe(1900);
    expect(row?.summary_overview).toBe("we shipped it");
    expect(row?.summary_action_items).toBe("ship more");
    expect(JSON.parse(row?.keywords ?? "null")).toEqual(["ship"]);
    expect(row?.meeting_type).toBe("standup");

    // Transcript body refreshed with the newer sentences.
    const key = transcriptKvKey("fireflies", "mtg-1");
    expect(JSON.parse(f.kv.entries.get(key) ?? "[]")).toHaveLength(2);
  });

  test("a later null field does NOT erase an already-stored value (summaries lag transcripts)", async () => {
    const f = makeFake();
    await upsertMeeting(
      f.tcw,
      meetingFixture({
        summaryOverview: "overview",
        summaryActionItems: "actions",
        keywords: ["k1"],
        meetingType: "call",
      }),
      [S("a")],
    );
    // A re-delivery of `meeting.transcribed` whose payload has no summary yet.
    const res = await upsertMeeting(
      f.tcw,
      meetingFixture({
        id: "row-2",
        title: null,
        summaryOverview: null,
        summaryActionItems: null,
        keywords: null,
        meetingType: null,
      }),
      [S("a")],
    );
    expect(res.ok).toBe(true);
    const row = f.sql.meetings.get("row-new");
    expect(row?.title).toBe("Standup");
    expect(row?.summary_overview).toBe("overview");
    expect(row?.summary_action_items).toBe("actions");
    expect(JSON.parse(row?.keywords ?? "null")).toEqual(["k1"]);
    expect(row?.meeting_type).toBe("call");
  });

  test("a later standalone Notes by Gemini revision clears a deleted section while retaining its current section", async () => {
    const f = makeFake();
    const original = meetingFixture({
      source: "google-meet",
      sourceId: "notes-drive-1",
      summaryOverview: "This summary was deleted from the Doc.",
      summaryActionItems: "Publish the draft.",
      metadata: {
        drive_file_id: "notes-drive-1",
        drive_modified_time: "2026-08-17T10:00:00.000Z",
        notes_kind: "gemini",
        notes_association: "standalone",
        notes_owned_fields: ["summary_overview", "summary_action_items"],
      },
    });
    expect((await upsertMeeting(f.tcw, original, [S("This summary was deleted from the Doc."), S("Publish the draft.")])).ok).toBe(true);

    const revised = await upsertMeeting(f.tcw, {
      ...original,
      id: "row-from-revised-doc",
      summaryOverview: null,
      summaryActionItems: "Publish the revised draft.",
      metadata: {
        ...original.metadata,
        drive_modified_time: "2026-08-17T11:00:00.000Z",
      },
    }, [S("Publish the revised draft.")]);

    expect(revised.ok).toBe(true);
    const row = f.sql.meetings.get("row-new");
    expect(row?.summary_overview).toBeNull();
    expect(row?.summary_action_items).toBe("Publish the revised draft.");
    expect(f.kv.entries.get(transcriptKvKey("google-meet", "notes-drive-1"))).toContain("Publish the revised draft.");
    expect(f.kv.entries.get(transcriptKvKey("google-meet", "notes-drive-1"))).not.toContain("This summary was deleted from the Doc.");
  });

  test("participants are kept when the update carries none, and metadata merges (new wins)", async () => {
    const f = makeFake();
    await upsertMeeting(
      f.tcw,
      meetingFixture({
        participants: [{ name: "Ada", email: "ada@ex.com" }],
        metadata: { duration_source: "sentences", seen: 1 },
      }),
      [S("a")],
    );
    const res = await upsertMeeting(
      f.tcw,
      meetingFixture({ id: "row-2", participants: [], metadata: { seen: 2 } }),
      [S("a")],
    );
    expect(res.ok).toBe(true);
    const row = f.sql.meetings.get("row-new");
    expect(JSON.parse(row?.participants ?? "[]")).toEqual([{ name: "Ada", email: "ada@ex.com" }]);
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({ duration_source: "sentences", seen: 2 });
  });

  test("an approximate Notes update cannot overwrite exact provenance returned as decoded metadata", async () => {
    const f = makeFake();
    f.sql.decodeMetadataCells = true;
    const exact = meetingFixture({
      source: "google-meet",
      sourceId: "conference-1",
      startedAt: "2026-08-17T09:00:00.000Z",
      metadata: {
        datetime_source: "meet_conference_start",
        datetime_exact: true,
        datetime_resolution_version: 1,
      },
    });
    await upsertMeeting(f.tcw, exact, [S("Meet transcript")]);

    const update = await upsertMeeting(f.tcw, {
      ...exact,
      id: "throwaway",
      startedAt: "2026-08-17T08:55:04.123Z",
      metadata: {
        drive_file_id: "notes-1",
        datetime_source: "drive_created_time",
        datetime_exact: false,
        datetime_resolution_version: 1,
      },
    }, []);

    expect(update.ok).toBe(true);
    const row = f.sql.meetings.get("row-new");
    expect(row?.started_at).toBe("2026-08-17T09:00:00.000Z");
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
      drive_file_id: "notes-1",
      datetime_source: "meet_conference_start",
      datetime_exact: true,
      datetime_resolution_version: 1,
    });
  });

  test("an empty sentence list on update does not wipe the stored transcript body", async () => {
    const f = makeFake();
    await upsertMeeting(f.tcw, meetingFixture(), [S("a"), S("b")]);
    const key = transcriptKvKey("fireflies", "mtg-1");
    const res = await upsertMeeting(f.tcw, meetingFixture({ id: "row-2" }), []);
    expect(res.ok).toBe(true);
    expect(JSON.parse(f.kv.entries.get(key) ?? "[]")).toHaveLength(2);
  });
});

describe("connectorStore.upsertMeeting — fail-closed Result handling", () => {
  test("a resolved { ok: false } from the lookup SELECT is a FAILURE, not a silent insert", async () => {
    const f = makeFake();
    await ensureSchema(f.tcw); // schema DDL out of the way
    f.sql.nextQueryError = { code: "SQL_ERROR", message: "boom-select" };
    const res = await upsertMeeting(f.tcw, meetingFixture(), [S("a")]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("boom-select");
    expect(f.sql.meetings.size).toBe(0);
    expect(f.kv.entries.size).toBe(0);
  });

  test("a resolved { ok: false } from the row write surfaces and no KV body is written", async () => {
    const f = makeFake();
    await ensureSchema(f.tcw);
    f.sql.nextExecuteError = { code: "SQL_ERROR", message: "boom-write" };
    const res = await upsertMeeting(f.tcw, meetingFixture(), [S("a")]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("boom-write");
    expect(f.kv.entries.size).toBe(0);
  });

  test("a resolved { ok: false } from the KV put surfaces (no silent fallback)", async () => {
    const f = makeFake();
    f.kv.nextPutError = { code: "KV_ERROR", message: "boom-kv" };
    const res = await upsertMeeting(f.tcw, meetingFixture(), [S("a")]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("boom-kv");
  });

  test("an ensureSchema failure short-circuits before any row or KV write", async () => {
    const f = makeFake();
    f.sql.nextCreateError = { code: "AUTH_UNAUTHORIZED", message: "denied for policy X" };
    const res = await upsertMeeting(f.tcw, meetingFixture(), [S("a")]);
    expect(res.ok).toBe(false);
    expect(f.sql.meetings.size).toBe(0);
    expect(f.kv.entries.size).toBe(0);
  });
});

describe("connectorStore.insertMeeting — unchanged v1 skip behaviour", () => {
  test("still SKIPS an existing (source, source_id) — upsert did not change v1 sync semantics", async () => {
    const f = makeFake();
    const m = meetingFixture({ summaryOverview: null });
    const first = await insertMeeting(f.tcw, m);
    expect(first.ok && first.data === true).toBe(true);
    const second = await insertMeeting(f.tcw, { ...m, id: "row-2", summaryOverview: "late summary" });
    expect(second.ok && second.data === false).toBe(true);
    expect(f.sql.meetings.get("row-new")?.summary_overview).toBe(null);
  });
});
