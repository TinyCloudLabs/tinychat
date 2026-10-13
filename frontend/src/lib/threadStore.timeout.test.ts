import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { appendMessage, getThreadModel, setSqlCallTimeoutForTests, SqlOpError } from "./threadStore";

let restoreTimeout = () => {};
afterEach(() => {
  restoreTimeout();
  restoreTimeout = () => {};
});

type Statement = { sql: string; params?: unknown[] };

/**
 * SQLite-backed stand-in for `tcw.sql.db(...)`. `drop` makes the next matching
 * call never settle and ignore its abort signal (a dropped response from an
 * SDK that does not honour `signal`), optionally after applying the write, as
 * a server that committed before the response was lost.
 */
class SqlService {
  readonly sqlite = new Database(":memory:");
  drop: { match: RegExp; commit: boolean } | null = null;
  abortAfterCommit = false;
  messageBatches = 0;
  readonly droppedSignals: Array<AbortSignal | undefined> = [];

  private dropped(sql: string, signal: AbortSignal | undefined, apply: () => void): boolean {
    if (!this.drop || !this.drop.match.test(sql)) return false;
    if (this.drop.commit) apply();
    this.drop = null;
    this.droppedSignals.push(signal);
    return true;
  }

  query = async (sql: string, params: unknown[] = [], options?: { signal?: AbortSignal }) => {
    if (this.dropped(sql, options?.signal, () => {})) return new Promise<never>(() => {});
    return { ok: true as const, data: { rows: this.sqlite.query(sql).values(...(params as never[])) } };
  };

  execute = async (sql: string, params: unknown[] = [], options?: { signal?: AbortSignal }) => {
    const apply = () => { this.sqlite.query(sql).run(...(params as never[])); };
    if (this.dropped(sql, options?.signal, apply)) return new Promise<never>(() => {});
    apply();
    return { ok: true as const, data: { changes: 1, lastInsertRowId: null } };
  };

  batch = async (statements: Statement[], options?: { signal?: AbortSignal }) => {
    if (statements.some((statement) => statement.sql.includes("INSERT INTO messages"))) this.messageBatches++;
    const apply = () => {
      this.sqlite.transaction(() => {
        for (const statement of statements) this.sqlite.query(statement.sql).run(...((statement.params ?? []) as never[]));
      })();
    };
    if (this.dropped(statements.map((statement) => statement.sql).join("\n"), options?.signal, apply)) {
      return new Promise<never>(() => {});
    }
    apply();
    if (this.abortAfterCommit) {
      this.abortAfterCommit = false;
      return { ok: false as const, error: { code: "ABORTED", message: "Request was aborted.", service: "sql" } };
    }
    return { ok: true as const, data: { results: [] } };
  };
}

function cloud(service: SqlService): TinyCloudWeb {
  return { did: `did:test:timeout:${crypto.randomUUID()}`, sql: { db: () => service } } as unknown as TinyCloudWeb;
}

function message(id: string, role: "user" | "assistant" = "user") {
  return { message: { id, role, content: [{ type: "text", text: id }] } } as never;
}

function storedIds(service: SqlService, threadId: string): string[] {
  return service.sqlite.query("SELECT payload FROM messages WHERE thread_id = ? ORDER BY position")
    .values(threadId)
    .map((row) => JSON.parse(String(row[0])).message.id as string);
}

const MODEL = OFFERED_CHAT_MODELS[0].id;

test("a committed append aborted by graph retirement reconciles its message ID without replay", async () => {
  const service = new SqlService();
  const tcw = cloud(service);
  await appendMessage(tcw, "retired", message("first"), MODEL);
  service.abortAfterCommit = true;
  await expect(appendMessage(tcw, "retired", message("u1"), MODEL)).resolves.toBeUndefined();
  expect(storedIds(service, "retired")).toEqual(["first", "u1"]);
  expect(service.messageBatches).toBe(2);
});

test("a dropped write response times out as a retryable error, the thread's queue keeps going, and the retry reconciles by id", async () => {
  const service = new SqlService();
  const tcw = cloud(service);
  await appendMessage(tcw, "dropped", message("first"), MODEL); // schema + thread row
  restoreTimeout = setSqlCallTimeoutForTests(30);

  // The server commits u1's batch but the response never arrives.
  service.drop = { match: /INSERT INTO messages/, commit: true };
  const lost = appendMessage(tcw, "dropped", message("u1"), MODEL);
  // Queued behind the hung write on the same per-thread FIFO.
  const queued = appendMessage(tcw, "dropped", message("a1", "assistant"), MODEL);

  const error = await lost.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SqlOpError);
  expect(error).toMatchObject({ code: "TIMEOUT", retryable: true });
  // The deadline also cancels the request itself.
  expect(service.droppedSignals[0]?.aborted).toBe(true);
  await expect(queued).resolves.toBeUndefined();

  // Retrying the same message finds the committed row instead of duplicating it.
  await expect(appendMessage(tcw, "dropped", message("u1"), MODEL)).resolves.toBeUndefined();
  expect(storedIds(service, "dropped")).toEqual(["first", "u1", "a1"]);
});

test("a write whose response is dropped before commit can be retried and lands once", async () => {
  const service = new SqlService();
  const tcw = cloud(service);
  await appendMessage(tcw, "uncommitted", message("first"), MODEL);
  restoreTimeout = setSqlCallTimeoutForTests(30);

  service.drop = { match: /INSERT INTO messages/, commit: false };
  await expect(appendMessage(tcw, "uncommitted", message("u1"), MODEL)).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  await expect(appendMessage(tcw, "uncommitted", message("u1"), MODEL)).resolves.toBeUndefined();
  expect(storedIds(service, "uncommitted")).toEqual(["first", "u1"]);
});

test("a hung read inside a queued write and a hung model restore both settle", async () => {
  const service = new SqlService();
  const tcw = cloud(service);
  await appendMessage(tcw, "reads", message("first"), MODEL);
  restoreTimeout = setSqlCallTimeoutForTests(30);

  // appendMessage's reconcile SELECT is dropped: the write fails without
  // touching the table, and the next write to the thread still runs.
  service.drop = { match: /SELECT payload FROM messages/, commit: false };
  await expect(appendMessage(tcw, "reads", message("u1"), MODEL)).rejects.toMatchObject({ code: "TIMEOUT" });
  await expect(appendMessage(tcw, "reads", message("u2"), MODEL)).resolves.toBeUndefined();
  expect(storedIds(service, "reads")).toEqual(["first", "u2"]);

  // A restore read that never answers rejects (the coordinator then offers
  // "Retry loading model") instead of leaving the thread unsendable.
  service.drop = { match: /SELECT model FROM threads/, commit: false };
  await expect(getThreadModel(tcw, "reads")).rejects.toMatchObject({ code: "TIMEOUT" });
  await expect(getThreadModel(tcw, "reads")).resolves.toEqual({ status: "found", model: MODEL });
});
