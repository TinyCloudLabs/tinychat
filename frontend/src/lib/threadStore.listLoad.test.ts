import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import {
  appendMessage,
  getThreadListLoadState,
  listThreads,
  retryThreadListLoad,
  subscribeThreadListSettled,
  ThreadListLoadError,
  SqlOpError,
} from "./threadStore";

// Regression coverage for TC-2016: a hung or failed chat-list read is retried
// and, if it still fails, surfaces as an error state, never an empty list.

const THREADS_SELECT = /FROM threads ORDER BY updated_at/;
type Behavior = "ok" | "hang" | "error";

class SqlService {
  readonly sqlite = new Database(":memory:");
  /** Scripted outcomes for successive `SELECT ... FROM threads` invokes (default ok). */
  selectScript: Behavior[] = [];
  readonly selectSignals: Array<AbortSignal | undefined> = [];
  hangBatchMatch: RegExp | null = null;
  messageBatches = 0;

  query = async (sql: string, params: unknown[] = [], options?: { signal?: AbortSignal }) => {
    if (THREADS_SELECT.test(sql)) {
      this.selectSignals.push(options?.signal);
      const behavior = this.selectScript.shift() ?? "ok";
      if (behavior === "hang") return new Promise<never>(() => {});
      if (behavior === "error") {
        return { ok: false as const, error: { code: "SQL_ERROR", message: "boom", service: "sql" } };
      }
    }
    return { ok: true as const, data: { rows: this.sqlite.query(sql).values(...(params as never[])) } };
  };

  execute = async (sql: string, params: unknown[] = []) => {
    this.sqlite.query(sql).run(...(params as never[]));
    return { ok: true as const, data: { changes: 1, lastInsertRowId: null } };
  };

  batch = async (statements: Array<{ sql: string; params?: unknown[] }>) => {
    if (statements.some((s) => s.sql.includes("INSERT INTO messages"))) {
      this.messageBatches++;
      if (this.hangBatchMatch) return new Promise<never>(() => {});
    }
    this.sqlite.transaction(() => {
      for (const s of statements) this.sqlite.query(s.sql).run(...((s.params ?? []) as never[]));
    })();
    return { ok: true as const, data: { results: [] } };
  };

  seedThread(id: string, title: string, updatedAt: string): void {
    this.sqlite.run(
      "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    this.sqlite.run(
      "CREATE TABLE IF NOT EXISTS messages (thread_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, position))",
    );
    this.sqlite.run("INSERT INTO threads VALUES (?, ?, 'm', ?, ?)", [id, title, updatedAt, updatedAt]);
  }
}

let did = 0;
function cloud(service: SqlService): TinyCloudWeb {
  return { did: `did:test:listload:${++did}`, sql: { db: () => service } } as unknown as TinyCloudWeb;
}

const storage = new Map<string, string>();
const originalWindow = (globalThis as { window?: unknown }).window;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  storage.clear();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  };
  jest.useFakeTimers();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  errorSpy.mockRestore();
  (globalThis as { window?: unknown }).window = originalWindow;
});

/** Start a listThreads call and capture its eventual outcome without leaving a rejection unhandled. */
function start(tcw: TinyCloudWeb) {
  const outcome: { value?: unknown; error?: unknown; done: boolean } = { done: false };
  void listThreads(tcw).then(
    (value) => Object.assign(outcome, { value, done: true }),
    (error) => Object.assign(outcome, { error, done: true }),
  );
  return outcome;
}

/** Advance fake time in 500ms steps, draining promise callbacks between steps. */
async function advance(ms: number): Promise<void> {
  const flush = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  await flush();
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    jest.advanceTimersByTime(Math.min(500, ms - elapsed));
    await flush();
  }
}

describe("chat-list read retry", () => {
  test("a hung read ends in the error state after 3 fresh invokes within 40s, not []", async () => {
    const service = new SqlService();
    service.seedThread("t1", "One", "2026-01-01T00:00:00.000Z");
    service.selectScript = ["hang", "hang", "hang"];
    const tcw = cloud(service);

    const outcome = start(tcw);
    await advance(39_000);
    expect(outcome.done).toBe(false);
    await advance(1_000);

    expect(outcome.done).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(ThreadListLoadError);
    expect(getThreadListLoadState()).toEqual({ status: "error", hasCache: false });
    // Three separate invokes, each with its own AbortSignal (never a re-awaited promise).
    expect(service.selectSignals).toHaveLength(3);
    expect(new Set(service.selectSignals).size).toBe(3);
    // Nothing was cached as a "success".
    expect([...storage.keys()]).toEqual([]);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain("listThreads cold load failed");
    // 1 schema probe + 3 thread selects.
    expect(logged).toContain("attempts=4");
  });

  test("a read that times out once then succeeds renders the list from a second, fresh invoke", async () => {
    const service = new SqlService();
    service.seedThread("t1", "One", "2026-01-01T00:00:00.000Z");
    service.selectScript = ["hang"];
    const tcw = cloud(service);

    const outcome = start(tcw);
    await advance(13_000);

    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect((outcome.value as Array<{ id: string }>).map((t) => t.id)).toEqual(["t1"]);
    expect(service.selectSignals).toHaveLength(2);
    expect(service.selectSignals[0]).not.toBe(service.selectSignals[1]);
    expect(getThreadListLoadState()).toEqual({ status: "ok" });
  });

  test("a non-retryable read error is not retried", async () => {
    const service = new SqlService();
    service.selectScript = ["error"];
    const outcome = start(cloud(service));
    await advance(0);

    expect(outcome.error).toBeInstanceOf(ThreadListLoadError);
    expect(service.selectSignals).toHaveLength(1);
    expect(getThreadListLoadState().status).toBe("error");
  });

  test("all attempts fail, then Try again re-runs the load and shows the list", async () => {
    const service = new SqlService();
    service.seedThread("t1", "One", "2026-01-01T00:00:00.000Z");
    service.selectScript = ["hang", "hang", "hang"];
    const tcw = cloud(service);
    const outcome = start(tcw);
    await advance(40_000);
    expect(outcome.error).toBeInstanceOf(ThreadListLoadError);
    expect([...storage.keys()]).toEqual([]);

    await retryThreadListLoad();

    expect(service.selectSignals).toHaveLength(4);
    expect(getThreadListLoadState()).toEqual({ status: "ok" });
    const cached = JSON.parse([...storage.values()][0]) as { threads: Array<{ id: string }> };
    expect(cached.threads.map((t) => t.id)).toEqual(["t1"]);
  });

  test("a failed refresh keeps the cached list (not overwritten) and flags the error", async () => {
    const service = new SqlService();
    const tcw = cloud(service);
    storage.set(
      `tinychat:index:${tcw.did}`,
      JSON.stringify({ threads: [{ id: "old", title: "Old", model: "m", updatedAt: "2026-01-01T00:00:00.000Z" }] }),
    );
    service.selectScript = ["error"];

    const outcome = start(tcw);
    await advance(0);

    expect((outcome.value as Array<{ id: string }>).map((t) => t.id)).toEqual(["old"]);
    expect(getThreadListLoadState()).toEqual({ status: "error", hasCache: true });
    expect(JSON.parse(storage.get(`tinychat:index:${tcw.did}`)!).threads.map((t: { id: string }) => t.id)).toEqual(["old"]);
  });

  test("a successful read of 0 rows is an empty list, not an error", async () => {
    const service = new SqlService();
    const outcome = start(cloud(service));
    await advance(0);

    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual([]);
    expect(getThreadListLoadState()).toEqual({ status: "ok" });
  });

  test("the settled hook fires after an errored load and after a successful one", async () => {
    let settled = 0;
    const off = subscribeThreadListSettled(() => settled++);
    try {
      const failing = new SqlService();
      failing.selectScript = ["error"];
      start(cloud(failing));
      await advance(0);
      expect(settled).toBe(1);
      start(cloud(new SqlService()));
      await advance(0);
      expect(settled).toBe(2);
    } finally {
      off();
    }
  });

  test("a hung WRITE is not retried by the read path", async () => {
    const service = new SqlService();
    service.hangBatchMatch = /./;
    const tcw = cloud(service);
    const model = OFFERED_CHAT_MODELS[0].id;
    const message = { message: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] } } as never;

    let error: unknown;
    void appendMessage(tcw, "t1", message, model).catch((e) => {
      error = e;
    });
    await advance(120_000);

    expect(error).toBeInstanceOf(SqlOpError);
    expect((error as SqlOpError).retryable).toBe(true);
    expect(service.messageBatches).toBe(1);
  });
});
