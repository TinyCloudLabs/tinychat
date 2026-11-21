import { Database } from "bun:sqlite";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";

type Method = "query" | "execute" | "batch";

/** A FeedDatabase over a real in-memory SQLite, answering in the node's shape (columns plus row arrays). */
export function sqliteFeedDatabase(): FeedDatabase {
  const sqlite = new Database(":memory:");
  const run = (sql: string, params: unknown[] = []) => sqlite.query(sql).values(...(params as never[]));
  const failure = (error: unknown) => ({ ok: false, error: { code: "SQL_ERROR", message: String(error), service: "sql" } });
  return {
    async query(sql: string, params?: unknown[]) {
      try {
        const statement = sqlite.query(sql);
        const rows = statement.values(...((params ?? []) as never[]));
        return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
      } catch (error) { return failure(error); }
    },
    async execute(sql: string, params?: unknown[]) {
      try { run(sql, params); return { ok: true, data: { changes: sqlite.query("SELECT changes()").values()[0]![0], lastInsertRowId: 0 } }; }
      catch (error) { return failure(error); }
    },
    async batch(statements: { sql: string; params?: unknown[] }[]) {
      try { sqlite.transaction(() => { for (const { sql, params } of statements) run(sql, params); })(); return { ok: true, data: { results: [] } }; }
      catch (error) { return failure(error); }
    },
  } as unknown as FeedDatabase;
}

/** One call that reached a database, by the resource the signed-in client opened. */
export interface Statement { resource: string; method: Method; sql: string[] }

/** A signed-in client over in-memory databases, one per resource (see `fakeSpace`). */
export interface FakeSpace {
  tcw: { spaceId: string; did: string; sql: { db: (resource: string) => FeedDatabase } };
  db: (resource: string) => FeedDatabase;
  /** Every call that reached any resource, in order. */
  log: Statement[];
  /** Makes calls of `method` on `resource` return a storage error until `heal`. */
  fail: (resource: string, method: Method) => void;
  heal: () => void;
  /** The calls that reached one resource, from the `since`th logged call on. */
  on: (resource: string, since?: number) => Statement[];
}

/** `log` records every call by resource; `fail` and `heal` inject storage errors. */
export function fakeSpace(spaceId: string): FakeSpace {
  const databases = new Map<string, FeedDatabase>();
  const log: Statement[] = [];
  const failing = new Set<string>();
  const db = (resource: string): FeedDatabase => {
    let database = databases.get(resource);
    if (!database) {
      const inner = sqliteFeedDatabase();
      const wrap = (method: Method) => async (...args: unknown[]) => {
        const first = args[0];
        log.push({ resource, method, sql: Array.isArray(first) ? first.map((statement: { sql: string }) => statement.sql) : [String(first)] });
        if (failing.has(`${resource}\0${method}`)) return { ok: false, error: { code: "SQL_ERROR", message: "unavailable", service: "sql" } };
        return (inner[method] as (...rest: unknown[]) => unknown)(...args);
      };
      database = { query: wrap("query"), execute: wrap("execute"), batch: wrap("batch") } as unknown as FeedDatabase;
      databases.set(resource, database);
    }
    return database;
  };
  return {
    tcw: { spaceId, did: `did:pkh:test:${spaceId}`, sql: { db } },
    db,
    log,
    fail: (resource, method) => { failing.add(`${resource}\0${method}`); },
    heal: () => failing.clear(),
    on: (resource, since = 0) => log.slice(since).filter((entry) => entry.resource === resource),
  };
}
