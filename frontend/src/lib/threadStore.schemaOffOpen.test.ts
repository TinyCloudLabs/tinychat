import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, getSettingsByPrefix, getThread, listThreads, setSetting } from "./threadStore";
import { FOREGROUND_QUIET_MS, resetLanesForTests } from "./localFirst/requestLanes";
import { __resetStorageStatusForTests, isStorageReadOnly, reportStorageWriteSucceeded, STORAGE_FULL_SAVE_MESSAGE } from "./storageStatus";

// Option 8 (home-perf data §1d): opening Home must not put a schema probe or a
// CREATE in front of the chat list and settings reads.

const SCHEMA_STATEMENT = /sqlite_master|CREATE /i;
const SCHEMA_MARKER = (did: string) => `tinychat:threads-schema:threads,messages,settings,memory,compactions:${did}`;

class SqlService {
  readonly sqlite = new Database(":memory:");
  readonly statements: string[] = [];
  /** Holds every sqlite_master probe until released. */
  probeGate: Promise<void> | null = null;
  rejectWrites = false;
  batchCalls = 0;

  query = async (sql: string, params: unknown[] = []) => {
    this.statements.push(sql);
    if (this.probeGate && /sqlite_master/i.test(sql)) await this.probeGate;
    try {
      return { ok: true as const, data: { rows: this.sqlite.query(sql).values(...(params as never[])) } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL_ERROR", message: String(error) } };
    }
  };

  execute = async (sql: string, params: unknown[] = []) => {
    this.statements.push(sql);
    this.sqlite.query(sql).run(...(params as never[]));
    return { ok: true as const, data: { changes: 1, lastInsertRowId: null } };
  };

  batch = async (operations: Array<{ sql: string; params?: unknown[] }>) => {
    this.batchCalls++;
    for (const operation of operations) this.statements.push(operation.sql);
    if (this.rejectWrites) {
      return { ok: false as const, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage quota exceeded" } };
    }
    this.sqlite.transaction(() => {
      for (const operation of operations) this.sqlite.query(operation.sql).run(...((operation.params ?? []) as never[]));
    })();
    return { ok: true as const, data: { rows: [] } };
  };

  seedSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (thread_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, position));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE compactions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, covers_through_message_id TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO threads VALUES ('t1', 'One', 'model-a', '2026-01-01', '2026-01-02');
      INSERT INTO settings VALUES ('theme', 'dark');
    `);
  }
}

let didCounter = 0;
function cloud(service: SqlService): TinyCloudWeb {
  return { did: `did:test:schema-off-open:${++didCounter}`, sql: { db: () => service } } as unknown as TinyCloudWeb;
}

const storage = new Map<string, string>();
const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  storage.clear();
  resetLanesForTests();
  jest.useFakeTimers();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  (globalThis as { window?: unknown }).window = { localStorage };
});

afterEach(async () => {
  await __resetStorageStatusForTests();
  jest.useRealTimers();
  resetLanesForTests();
  if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
  (globalThis as { window?: unknown }).window = originalWindow;
});

/** Let the foreground go quiet on the fake clock, so the background lane runs. */
async function afterForegroundQuiet(): Promise<void> {
  const flush = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  await flush();
  jest.advanceTimersByTime(FOREGROUND_QUIET_MS + 1);
  await flush();
}

describe("threads schema stays off the open's read path", () => {
  test("a warm open (marker present) issues no schema statement at all", async () => {
    const service = new SqlService();
    service.seedSchema();
    const tcw = cloud(service);
    storage.set(SCHEMA_MARKER(tcw.did!), "1");

    expect((await listThreads(tcw)).map((thread) => thread.id)).toEqual(["t1"]);
    expect(await getSetting(tcw, "theme")).toBe("dark");
    expect([...(await getSettingsByPrefix(tcw, "the")).keys()]).toEqual(["theme"]);
    expect((await getThread(tcw, "t1"))?.title).toBe("One");
    await afterForegroundQuiet();

    expect(service.statements.filter((sql) => SCHEMA_STATEMENT.test(sql))).toEqual([]);
  });

  test("a new device reads the chat list and settings without waiting on a probe, then checks the schema in the background", async () => {
    const service = new SqlService();
    service.seedSchema();
    let releaseProbe!: () => void;
    service.probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const tcw = cloud(service);

    // Both reads finish while any probe would still be held: they never waited on one.
    const [threads, theme] = await Promise.all([listThreads(tcw), getSetting(tcw, "theme")]);
    expect(threads.map((thread) => thread.id)).toEqual(["t1"]);
    expect(theme).toBe("dark");
    expect(service.statements.filter((sql) => SCHEMA_STATEMENT.test(sql))).toEqual([]);

    // After the foreground is quiet, one read-only probe confirms every table.
    await afterForegroundQuiet();
    expect(service.statements.filter((sql) => /sqlite_master/i.test(sql))).toHaveLength(1);
    releaseProbe();
    await afterForegroundQuiet();
    expect(storage.get(SCHEMA_MARKER(tcw.did!))).toBe("1");
    expect(service.statements.some((sql) => /CREATE /i.test(sql))).toBe(false);

    // The marker lets the first write skip the probe.
    const before = service.statements.length;
    await setSetting(tcw, "theme", "light");
    expect(service.statements.slice(before).filter((sql) => SCHEMA_STATEMENT.test(sql))).toEqual([]);
  });

  test("a read that finds its table missing creates the schema and is retried once", async () => {
    const service = new SqlService();
    const tcw = cloud(service);

    expect(await getSetting(tcw, "theme")).toBeNull();

    const settingsRead = "SELECT value FROM settings WHERE key = ?";
    expect(service.statements[0]).toBe(settingsRead);
    expect(service.statements[1]).toMatch(/sqlite_master/);
    expect(service.statements.filter((sql) => /CREATE TABLE IF NOT EXISTS/.test(sql))).toHaveLength(5);
    expect(service.statements.at(-1)).toBe(settingsRead);
    expect(service.statements.filter((sql) => sql === settingsRead)).toHaveLength(2);
    expect(storage.get(SCHEMA_MARKER(tcw.did!))).toBe("1");
  });

  test("a reset space (marker present, tables gone) recovers on the first read", async () => {
    const service = new SqlService();
    const tcw = cloud(service);
    storage.set(SCHEMA_MARKER(tcw.did!), "1");

    expect(await getSetting(tcw, "theme")).toBeNull();

    const settingsRead = "SELECT value FROM settings WHERE key = ?";
    expect(service.statements[0]).toBe(settingsRead);
    expect(service.statements[1]).toMatch(/sqlite_master/);
    expect(service.statements.filter((sql) => /CREATE TABLE IF NOT EXISTS/.test(sql))).toHaveLength(5);
    expect(service.statements.at(-1)).toBe(settingsRead);
    expect(storage.get(SCHEMA_MARKER(tcw.did!))).toBe("1");
    await setSetting(tcw, "theme", "dark");
    expect(await getSetting(tcw, "theme")).toBe("dark");
  });

  test("a read whose missing table cannot be created because storage is full reports storage full once", async () => {
    reportStorageWriteSucceeded();
    const service = new SqlService();
    service.rejectWrites = true;
    const tcw = cloud(service);

    await expect(getSetting(tcw, "theme")).rejects.toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      message: STORAGE_FULL_SAVE_MESSAGE,
    });
    // One read, one probe, one refused create; the read is not re-issued and no marker is stored.
    expect(service.statements.filter((sql) => sql === "SELECT value FROM settings WHERE key = ?")).toHaveLength(1);
    expect(service.batchCalls).toBe(1);
    expect(isStorageReadOnly()).toBe(true);
    expect(storage.has(SCHEMA_MARKER(tcw.did!))).toBe(false);
  });
});
