// In-memory fake of the TinyCloudWeb surfaces the connectors code touches.
// See docs/connectors-spec.md §10. Backs: sql.db(name).{execute,query,batch},
// kv.{get,put,delete}, secrets.{isUnlocked,unlock,put,get,delete}, did,
// spaceId, ensureOwnedSpaceHosted.
//
// The SQL fake understands ONLY the statement shapes connectorStore.ts
// actually issues — matched by substring — and stores rows per-table in a
// Map keyed by primary key so app-level dedup and DELETE behave correctly.
// Adding a new statement to the store means adding a matcher here.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

// ── Result shapes (mirroring the SDK) ───────────────────────────────────

type OkErr<T, E = { code: string; message: string }> =
  | { ok: true; data: T }
  | { ok: false; error: E };

type SqlResult = OkErr<{ rows: unknown[][] }>;
type KvErr = { code: string; message: string };

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

// ── SQL fake ────────────────────────────────────────────────────────────

export class FakeSqlDb {
  meetings = new Map<string, MeetingRow>();
  states = new Map<string, StateRow>();
  createdTables = new Set<string>();
  /** When set, the next CREATE TABLE call fails with this error and is consumed. */
  nextCreateError: { code: string; message: string } | null = null;

  async query(sql: string, params: unknown[] = []): Promise<SqlResult> {
    const s = sql.trim();

    // Schema-probe fallback used by ensureSchema when CREATE TABLE errors.
    const probe = s.match(/^SELECT\s+1\s+FROM\s+(\w+)\s+LIMIT\s+1/i);
    if (probe) {
      const table = probe[1];
      if (this.createdTables.has(table)) return ok([[1]]);
      return err("SQL_ERROR", `no such table: ${table}`);
    }

    if (/^SELECT\s+source_id\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const rows: unknown[][] = [];
      for (const row of this.meetings.values()) {
        if (row.source === source) rows.push([row.source_id]);
      }
      return ok(rows);
    }
    if (/^SELECT\s+id\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const sourceId = String(params[1]);
      for (const row of this.meetings.values()) {
        if (row.source === source && row.source_id === sourceId) {
          return ok([[row.id]]);
        }
      }
      return ok([]);
    }
    if (/^SELECT\s+COUNT\(\*\)\s+FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      let n = 0;
      for (const row of this.meetings.values()) if (row.source === source) n++;
      return ok([[n]]);
    }
    if (
      /^SELECT\s+connector_id[\s\S]+FROM\s+connector_state\s+WHERE\s+connector_id\s*=\s*\?/i.test(
        s,
      )
    ) {
      const id = String(params[0]);
      const row = this.states.get(id);
      if (!row) return ok([]);
      return ok([
        [
          row.connector_id,
          row.status,
          row.last_synced_at,
          row.last_sync_status,
          row.last_sync_error,
          row.item_count,
        ],
      ]);
    }
    return ok([]);
  }

  async execute(sql: string, params: unknown[] = []): Promise<SqlResult> {
    return this.applyOne(sql, params) ?? ok([]);
  }

  async batch(stmts: { sql: string; params?: unknown[] }[]): Promise<SqlResult> {
    for (const stmt of stmts) {
      const r = this.applyOne(stmt.sql, stmt.params ?? []);
      if (r && !r.ok) return r;
    }
    return ok([]);
  }

  private applyOne(sql: string, params: unknown[] = []): SqlResult | null {
    const s = sql.trim();

    const create = s.match(/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
    if (create) {
      if (this.nextCreateError) {
        const e = this.nextCreateError;
        this.nextCreateError = null;
        return { ok: false, error: e };
      }
      this.createdTables.add(create[1]);
      return ok([]);
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
      return ok([]);
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
      ] = params as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        number,
        string,
      ];
      this.states.set(connector_id, {
        connector_id,
        status,
        last_synced_at,
        last_sync_status,
        last_sync_error,
        item_count,
        updated_at,
      });
      return ok([]);
    }

    if (/^DELETE\s+FROM\s+connector_meeting\s+WHERE\s+source\s*=\s*\?/i.test(s)) {
      const source = String(params[0]);
      for (const [id, row] of this.meetings) {
        if (row.source === source) this.meetings.delete(id);
      }
      return ok([]);
    }
    if (/^DELETE\s+FROM\s+connector_state\s+WHERE\s+connector_id\s*=\s*\?/i.test(s)) {
      this.states.delete(String(params[0]));
      return ok([]);
    }

    return null;
  }
}

// ── KV fake ─────────────────────────────────────────────────────────────

export class FakeKv {
  entries = new Map<string, string>();

  async get(
    key: string,
  ): Promise<OkErr<{ data: unknown; headers: Record<string, string> }, KvErr>> {
    if (!this.entries.has(key)) {
      return { ok: false, error: { code: "KV_NOT_FOUND", message: `no key ${key}` } };
    }
    return { ok: true, data: { data: this.entries.get(key), headers: {} } };
  }

  async put(
    key: string,
    value: unknown,
  ): Promise<OkErr<{ data: void; headers: Record<string, string> }, KvErr>> {
    const stored = typeof value === "string" ? value : JSON.stringify(value);
    this.entries.set(key, stored);
    return { ok: true, data: { data: undefined as unknown as void, headers: {} } };
  }

  async delete(key: string): Promise<OkErr<void, KvErr>> {
    if (!this.entries.has(key)) {
      return { ok: false, error: { code: "KV_NOT_FOUND", message: `no key ${key}` } };
    }
    this.entries.delete(key);
    return { ok: true, data: undefined as unknown as void };
  }
}

// ── Secrets fake ────────────────────────────────────────────────────────

type SecretsErr = { code: string; message: string };

export class FakeSecrets {
  isUnlocked = false;
  /** scope → name → value. Public so drivers can assert what landed where. */
  readonly store = new Map<string, Map<string, string>>();
  /** When true, the NEXT put() fails NOT_FOUND-shaped (exercises the ensureOwnedSpaceHosted retry). */
  nextPutRejectsNotFound = false;

  async unlock(): Promise<OkErr<void, SecretsErr>> {
    this.isUnlocked = true;
    return { ok: true, data: undefined as unknown as void };
  }

  async put(
    name: string,
    value: string,
    opts: { scope: string },
  ): Promise<OkErr<void, SecretsErr>> {
    if (this.nextPutRejectsNotFound) {
      this.nextPutRejectsNotFound = false;
      return { ok: false, error: { code: "NOT_FOUND", message: "space not found" } };
    }
    const scoped = this.store.get(opts.scope) ?? new Map<string, string>();
    scoped.set(name, value);
    this.store.set(opts.scope, scoped);
    return { ok: true, data: undefined as unknown as void };
  }

  async get(
    name: string,
    opts: { scope: string },
  ): Promise<OkErr<string, SecretsErr>> {
    const v = this.store.get(opts.scope)?.get(name);
    if (v === undefined) {
      return { ok: false, error: { code: "NOT_FOUND", message: `no secret ${opts.scope}:${name}` } };
    }
    return { ok: true, data: v };
  }

  async delete(
    name: string,
    opts: { scope: string },
  ): Promise<OkErr<void, SecretsErr>> {
    this.store.get(opts.scope)?.delete(name);
    return { ok: true, data: undefined as unknown as void };
  }

  /** Test helper — did a secret land at (scope, name)? */
  has(scope: string, name: string): boolean {
    return this.store.get(scope)?.has(name) ?? false;
  }
}

// ── Assembly ────────────────────────────────────────────────────────────

export interface FakeTinyCloud {
  tcw: TinyCloudWeb;
  sql: FakeSqlDb;
  kv: FakeKv;
  secrets: FakeSecrets;
  /** Every db name the store asked for — asserts it uses the full APP_ID path. */
  dbNamesRequested: string[];
  ensureOwnedSpaceCalls: string[];
}

export interface MakeFakeOptions {
  /** did seed for the schema-memoization key. Defaults to a fixed string. */
  did?: string;
}

export function makeFakeTinyCloud(opts: MakeFakeOptions = {}): FakeTinyCloud {
  const sql = new FakeSqlDb();
  const kv = new FakeKv();
  const secrets = new FakeSecrets();
  const dbNamesRequested: string[] = [];
  const ensureOwnedSpaceCalls: string[] = [];

  const tcw = {
    did: opts.did ?? "did:example:mock-tinycloud",
    spaceId: undefined,
    sql: {
      db: (name: string) => {
        dbNamesRequested.push(name);
        return sql;
      },
    },
    kv,
    secrets,
    async ensureOwnedSpaceHosted(name: string) {
      ensureOwnedSpaceCalls.push(name);
    },
  } as unknown as TinyCloudWeb;

  return { tcw, sql, kv, secrets, dbNamesRequested, ensureOwnedSpaceCalls };
}

// ── helpers ────────────────────────────────────────────────────────────

function ok(rows: unknown[][]): SqlResult {
  return { ok: true, data: { rows } };
}

function err(code: string, message: string): SqlResult {
  return { ok: false, error: { code, message } };
}
