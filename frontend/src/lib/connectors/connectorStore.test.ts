import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesTranscript } from "./firefliesClient";
import {
  CONNECTORS_KV_PREFIX,
  CONNECTORS_SQL_DB_NAME,
  _resetConnectorSchemaMemoForTests,
  countMeetings,
  ensureSchema,
  getConnection,
  insertMeeting,
  listKnownSourceIds,
  normalizeFirefliesTranscript,
  purgeConnector,
  putTranscriptBody,
  transcriptKvKey,
  updateSyncState,
} from "./connectorStore";

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

class FakeSqlDb {
  meetings = new Map<string, MeetingRow>();
  states = new Map<string, StateRow>();
  createdTables = new Set<string>();
  /** When set, the NEXT CREATE TABLE call fails with the given error. Consumed on use. */
  nextCreateError: SqlError | null = null;

  async query(sql: string, params: unknown[] = []): Promise<SqlResult> {
    const s = sql.trim();
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
    if (/^DELETE\s+FROM\s+connector_meeting\s+WHERE\s+source\s*=\s*\?/i.test(s)) {
      const source = String(params[0]);
      for (const [id, row] of this.meetings) {
        if (row.source === source) this.meetings.delete(id);
      }
      return { ok: true, data: { rows: [] } };
    }
    if (/^DELETE\s+FROM\s+connector_state\s+WHERE\s+connector_id\s*=\s*\?/i.test(s)) {
      this.states.delete(String(params[0]));
      return { ok: true, data: { rows: [] } };
    }
    return null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<SqlResult> {
    const res = this.applyOne(sql, params);
    return res ?? { ok: true, data: { rows: [] } };
  }

  async batch(stmts: { sql: string; params?: unknown[] }[]): Promise<SqlResult> {
    for (const stmt of stmts) {
      const r = this.applyOne(stmt.sql, stmt.params ?? []);
      if (r && !r.ok) return r;
    }
    return { ok: true, data: { rows: [] } };
  }
}

interface KvErr {
  code: string;
  message: string;
}

class FakeKv {
  entries = new Map<string, string>();

  async get(key: string): Promise<{ ok: true; data: { data: unknown; headers: Record<string, string> } } | { ok: false; error: KvErr }> {
    if (!this.entries.has(key)) {
      return { ok: false, error: { code: "KV_NOT_FOUND", message: `no key ${key}` } };
    }
    return { ok: true, data: { data: this.entries.get(key), headers: {} } };
  }

  async put(key: string, value: unknown): Promise<{ ok: true; data: { data: void; headers: Record<string, string> } } | { ok: false; error: KvErr }> {
    const stored = typeof value === "string" ? value : JSON.stringify(value);
    this.entries.set(key, stored);
    return { ok: true, data: { data: undefined as unknown as void, headers: {} } };
  }

  async delete(key: string): Promise<{ ok: true; data: void } | { ok: false; error: KvErr }> {
    if (!this.entries.has(key)) {
      return { ok: false, error: { code: "KV_NOT_FOUND", message: `no key ${key}` } };
    }
    this.entries.delete(key);
    return { ok: true, data: undefined as unknown as void };
  }
}

interface Fake {
  tcw: TinyCloudWeb;
  sql: FakeSqlDb;
  kv: FakeKv;
  dbNamesRequested: string[];
}

function makeFake(): Fake {
  const sql = new FakeSqlDb();
  const kv = new FakeKv();
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
  return { tcw, sql, kv, dbNamesRequested };
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
  test("deletes meeting rows, KV transcript bodies, and the state row", async () => {
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
    const baselineConn = await getConnection(f.tcw, "fireflies");
    expect(baselineConn.ok && baselineConn.data !== null).toBe(true);

    const purged = await purgeConnector(f.tcw, "fireflies");
    expect(purged.ok).toBe(true);

    const afterCount = await countMeetings(f.tcw, "fireflies");
    expect(afterCount.ok && afterCount.data === 0).toBe(true);
    expect(f.kv.entries.size).toBe(0);
    const afterConn = await getConnection(f.tcw, "fireflies");
    expect(afterConn.ok && afterConn.data === null).toBe(true);
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
    // NO putTranscriptBody — the SQL row references a KV key that doesn't
    // exist. Purge must not surface an error on KV_NOT_FOUND.
    const purged = await purgeConnector(f.tcw, "fireflies");
    expect(purged.ok).toBe(true);
    const afterCount = await countMeetings(f.tcw, "fireflies");
    expect(afterCount.ok && afterCount.data === 0).toBe(true);
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
