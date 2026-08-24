// In-memory fake of the TinyCloudWeb surfaces the connectors code touches.
// See docs/connectors-spec.md §10. Backs: sql.db(name).{execute,query,batch},
// kv.{get,put,list,delete}, secrets.{isUnlocked,unlock,put,get,delete}, did,
// spaceId, ensureOwnedSpaceHosted.
//
// The SQL fake understands ONLY the statement shapes connectorStore.ts
// actually issues — matched by substring — and stores rows per-table in a
// Map keyed by primary key so app-level dedup and DELETE behave correctly.
// Adding a new statement to the store means adding a matcher here.

import { readFileSync } from "node:fs";

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

// ── Authorization (mirrors what the node actually enforces) ─────────────
//
// SQL db names and KV keys are sent VERBATIM as the invoke path, and the node
// checks that path against the session's manifest-resolved capabilities. The
// manifest resolves each permission path by prepending `prefix` (which defaults
// to `app_id`); a granted path ending in "/" is a prefix match, otherwise it is
// an exact match.
//
// Without this check the fake authorized everything, so 24 green drivers sat on
// top of unprefixed KV keys that fail AUTH_UNAUTHORIZED against a real node.
// Grants are read from the real manifest.json — the expected paths are not
// spelled out a second time here.

interface ManifestShape {
  app_id: string;
  prefix?: string;
  permissions?: { service: string; path: string }[];
}

const MANIFEST = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
) as ManifestShape;

const MANIFEST_PREFIX = MANIFEST.prefix ?? MANIFEST.app_id;

/** Resolve a manifest permission path the way `applyPrefix` in sdk-core does. */
function resolveManifestPath(path: string): string {
  if (MANIFEST_PREFIX === "") return path;
  return path.startsWith("/")
    ? `${MANIFEST_PREFIX}${path}`
    : `${MANIFEST_PREFIX}/${path}`;
}

function grantedPaths(service: string): string[] {
  return (MANIFEST.permissions ?? [])
    .filter((p) => p.service === service)
    .map((p) => resolveManifestPath(p.path));
}

/** Path containment per spec: trailing "/" grants a prefix match, else exact. */
function pathContains(granted: string, requested: string): boolean {
  if (granted === "" || granted === "/") return true;
  if (granted.endsWith("/")) return requested.startsWith(granted);
  return requested === granted;
}

/**
 * The AUTH_UNAUTHORIZED error the node returns for an unmatched path, or null
 * when the request is covered by a grant.
 */
function authorize(
  service: string,
  requested: string,
): { code: string; message: string } | null {
  const granted = grantedPaths(service);
  if (granted.some((g) => pathContains(g, requested))) return null;
  return {
    code: "AUTH_UNAUTHORIZED",
    message:
      `Unauthorized Action: ${requested} / ${service}` +
      ` — no grant matches (manifest grants: ${granted.join(", ") || "none"})`,
  };
}

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
  /**
   * When set, the next `connector_meeting` INSERT/UPDATE fails with this error and is consumed —
   * the "the user's space write failed" case the webhook loop's storage-before-ack rule turns on.
   * Scoped to meeting writes so `connector_state` bookkeeping still behaves normally.
   */
  nextMeetingWriteError: { code: string; message: string } | null = null;

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
    // `upsertMeeting`'s lookup — a WIDE select (UPSERT_LOOKUP_COLUMNS), so the update arm can
    // keep the row id, the creation time and every column the new payload leaves null. Distinct
    // from the narrow `SELECT id` below, and matched first because that one's pattern is a
    // prefix of nothing here (`id,` vs `id FROM`).
    if (/^SELECT\s+id,\s*created_at[\s\S]*FROM\s+connector_meeting/i.test(s)) {
      const source = String(params[0]);
      const sourceId = String(params[1]);
      for (const row of this.meetings.values()) {
        if (row.source === source && row.source_id === sourceId) {
          return ok([
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
              row.metadata,
            ],
          ]);
        }
      }
      return ok([]);
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

  async batch(
    stmts: { sql: string; params?: unknown[] }[],
  ): Promise<SqlResult> {
    for (const stmt of stmts) {
      const r = this.applyOne(stmt.sql, stmt.params ?? []);
      if (r && !r.ok) return r;
    }
    return ok([]);
  }

  /** Consume a one-shot injected meeting-write failure, if one is armed. */
  private takeMeetingWriteError(): SqlResult | null {
    if (this.nextMeetingWriteError === null) return null;
    const e = this.nextMeetingWriteError;
    this.nextMeetingWriteError = null;
    return { ok: false, error: e };
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
      const injected = this.takeMeetingWriteError();
      if (injected) return injected;
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

    // `upsertMeeting`'s update arm: the row id is the last param and every other column is
    // replaced in UPSERT column order. Nothing is created here — an UPDATE against a missing id
    // is a no-op, exactly as SQLite would treat it.
    if (/^UPDATE\s+connector_meeting\s+SET/i.test(s)) {
      const injected = this.takeMeetingWriteError();
      if (injected) return injected;
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
      if (!existing) return ok([]);
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

    if (
      /^DELETE\s+FROM\s+connector_meeting\s+WHERE\s+source\s*=\s*\?/i.test(s)
    ) {
      const source = String(params[0]);
      for (const [id, row] of this.meetings) {
        if (row.source === source) this.meetings.delete(id);
      }
      return ok([]);
    }
    if (
      /^DELETE\s+FROM\s+connector_state\s+WHERE\s+connector_id\s*=\s*\?/i.test(
        s,
      )
    ) {
      this.states.delete(String(params[0]));
      return ok([]);
    }

    return null;
  }
}

// ── KV fake ─────────────────────────────────────────────────────────────

export class FakeKv {
  entries = new Map<string, string>();
  /** Every key rejected by the authorizer — drivers can assert on the shape. */
  readonly unauthorized: string[] = [];

  /** Authorization runs before any storage effect, exactly like the node. */
  private deny(key: string): KvErr | null {
    const error = authorize("tinycloud.kv", key);
    if (error) this.unauthorized.push(key);
    return error;
  }

  async get(
    key: string,
  ): Promise<OkErr<{ data: unknown; headers: Record<string, string> }, KvErr>> {
    const denied = this.deny(key);
    if (denied) return { ok: false, error: denied };
    if (!this.entries.has(key)) {
      return {
        ok: false,
        error: { code: "KV_NOT_FOUND", message: `no key ${key}` },
      };
    }
    return { ok: true, data: { data: this.entries.get(key), headers: {} } };
  }

  async put(
    key: string,
    value: unknown,
  ): Promise<OkErr<{ data: void; headers: Record<string, string> }, KvErr>> {
    const denied = this.deny(key);
    if (denied) return { ok: false, error: denied };
    const stored = typeof value === "string" ? value : JSON.stringify(value);
    this.entries.set(key, stored);
    return {
      ok: true,
      data: { data: undefined as unknown as void, headers: {} },
    };
  }

  /**
   * Mirror the SDK's prefix listing used by connector data purge. The real
   * node may paginate, but this compact fake returns its deterministic full
   * matching set as one page.
   */
  async list(
    options: { path: string; cursor?: string },
  ): Promise<OkErr<{ keys: string[]; cursor?: string }, KvErr>> {
    const denied = this.deny(options.path);
    if (denied) return { ok: false, error: denied };
    return {
      ok: true,
      data: {
        keys: [...this.entries.keys()]
          .filter((key) => key.startsWith(options.path))
          .sort(),
      },
    };
  }

  async delete(key: string): Promise<OkErr<void, KvErr>> {
    const denied = this.deny(key);
    if (denied) return { ok: false, error: denied };
    if (!this.entries.has(key)) {
      return {
        ok: false,
        error: { code: "KV_NOT_FOUND", message: `no key ${key}` },
      };
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
    opts?: { scope?: string },
  ): Promise<OkErr<void, SecretsErr>> {
    if (this.nextPutRejectsNotFound) {
      this.nextPutRejectsNotFound = false;
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "space not found" },
      };
    }
    const scope = opts?.scope ?? "";
    const scoped = this.store.get(scope) ?? new Map<string, string>();
    scoped.set(name, value);
    this.store.set(scope, scoped);
    return { ok: true, data: undefined as unknown as void };
  }

  async get(
    name: string,
    opts?: { scope?: string },
  ): Promise<OkErr<string, SecretsErr>> {
    const scope = opts?.scope ?? "";
    const v = this.store.get(scope)?.get(name);
    if (v === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `no secret ${scope}:${name}`,
        },
      };
    }
    return { ok: true, data: v };
  }

  async delete(
    name: string,
    opts?: { scope?: string },
  ): Promise<OkErr<void, SecretsErr>> {
    this.store.get(opts?.scope ?? "")?.delete(name);
    return { ok: true, data: undefined as unknown as void };
  }

  /** Test helper — did a secret land at (scope, name)? */
  has(scope: string | undefined, name: string): boolean {
    return this.store.get(scope ?? "")?.has(name) ?? false;
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
  /** Db names the authorizer rejected (no manifest grant covers them). */
  unauthorizedDbNames: string[];
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
  const unauthorizedDbNames: string[] = [];
  const ensureOwnedSpaceCalls: string[] = [];

  const tcw = {
    did: opts.did ?? "did:example:mock-tinycloud",
    spaceId: undefined,
    sql: {
      db: (name: string) => {
        dbNamesRequested.push(name);
        const denied = authorize("tinycloud.sql", name);
        if (denied) {
          unauthorizedDbNames.push(name);
          return unauthorizedDb(denied);
        }
        return sql;
      },
    },
    kv,
    secrets,
    async ensureOwnedSpaceHosted(name: string) {
      ensureOwnedSpaceCalls.push(name);
    },
  } as unknown as TinyCloudWeb;

  return {
    tcw,
    sql,
    kv,
    secrets,
    dbNamesRequested,
    unauthorizedDbNames,
    ensureOwnedSpaceCalls,
  };
}

// ── helpers ────────────────────────────────────────────────────────────

/** A db handle for an unauthorized name: every statement fails, nothing stores. */
function unauthorizedDb(error: { code: string; message: string }): FakeSqlDb {
  const denied: SqlResult = { ok: false, error };
  return {
    async query() {
      return denied;
    },
    async execute() {
      return denied;
    },
    async batch() {
      return denied;
    },
  } as unknown as FakeSqlDb;
}

function ok(rows: unknown[][]): SqlResult {
  return { ok: true, data: { rows } };
}

function err(code: string, message: string): SqlResult {
  return { ok: false, error: { code, message } };
}
