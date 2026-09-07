import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import {
  appendMessage,
  createThread,
  getThreadModel,
  listThreads,
  setThreadModel,
} from "./threadStore";

type Gate = { promise: Promise<void>; release: () => void };
function gate(): Gate {
  let release!: () => void;
  return { promise: new Promise((resolve) => { release = resolve; }), release };
}

const originalWindow = globalThis.window;
afterEach(() => {
  if (originalWindow) globalThis.window = originalWindow;
  else delete (globalThis as { window?: Window }).window;
});

function localStorageWindow() {
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
  return values;
}

class SqlService {
  readonly sqlite = new Database(":memory:");
  beforeBatch: (() => Promise<void>) | null = null;
  beforeExecute: (() => Promise<void>) | null = null;
  uncertainExecute = false;
  uncertainBatch = false;

  query = async (sql: string, params: unknown[] = []) => {
    try {
      return { ok: true as const, data: { rows: this.sqlite.query(sql).values(...params) } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL", message: String(error) } };
    }
  };

  execute = async (sql: string, params: unknown[] = []) => {
    try {
      if (this.beforeExecute) await this.beforeExecute();
      this.sqlite.query(sql).run(...params);
      if (this.uncertainExecute) {
        this.uncertainExecute = false;
        return { ok: false as const, error: { code: "LOST_RESPONSE", message: "response lost" } };
      }
      return { ok: true as const, data: { rows: [] } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL", message: String(error) } };
    }
  };

  batch = async (operations: Array<{ sql: string; params?: unknown[] }>) => {
    try {
      if (this.beforeBatch) await this.beforeBatch();
      this.sqlite.run("BEGIN");
      try {
        for (const operation of operations) {
          this.sqlite.query(operation.sql).run(...(operation.params ?? []));
        }
        this.sqlite.run("COMMIT");
      } catch (error) {
        this.sqlite.run("ROLLBACK");
        throw error;
      }
      if (this.uncertainBatch) {
        this.uncertainBatch = false;
        return { ok: false as const, error: { code: "LOST_RESPONSE", message: "response lost" } };
      }
      return { ok: true as const, data: { rows: [] } };
    } catch (error) {
      return { ok: false as const, error: { code: "SQL", message: String(error) } };
    }
  };
}

function tcw(service: SqlService): TinyCloudWeb {
  return {
    did: `did:test:${crypto.randomUUID()}`,
    sql: { db: () => service },
  } as unknown as TinyCloudWeb;
}

function message(id: string, role: "user" | "assistant" = "user") {
  return {
    message: { id, role, content: [{ type: "text", text: id }] },
  } as never;
}

async function model(service: SqlService, id: string): Promise<string | null> {
  const rows = service.sqlite.query("SELECT model FROM threads WHERE id = ?").values(id);
  return rows.length ? String(rows[0]![0]) : null;
}

describe("per-thread model persistence FIFO", () => {
  test("unused chats never create a SQL row", async () => {
    const service = new SqlService();
    const cloud = tcw(service);
    await createThread(cloud, "unused", OFFERED_CHAT_MODELS[0].id);
    // Force schema creation without inserting the unused thread.
    await listThreads(cloud);
    expect(service.sqlite.query("SELECT COUNT(*) FROM threads").values()[0]![0]).toBe(0);
  });

  test("rapid picks resolve FIFO and leave SQL plus summary cache at the latest choice", async () => {
    const cache = localStorageWindow();
    const service = new SqlService();
    const cloud = tcw(service);
    await appendMessage(cloud, "rapid", message("u1"), OFFERED_CHAT_MODELS[0].id);
    await listThreads(cloud);
    const first = setThreadModel(cloud, "rapid", OFFERED_CHAT_MODELS[1].id);
    const second = setThreadModel(cloud, "rapid", OFFERED_CHAT_MODELS[2].id);
    await Promise.all([first, second]);
    expect(await model(service, "rapid")).toBe(OFFERED_CHAT_MODELS[2].id);
    const index = JSON.parse(cache.get(`tinychat:index:${cloud.did}`) ?? "null");
    expect(index.threads.find((thread: { id: string }) => thread.id === "rapid").model).toBe(OFFERED_CHAT_MODELS[2].id);
  });

  test("a pick during first insertion queues behind the insert and later appends preserve it", async () => {
    const service = new SqlService();
    const cloud = tcw(service);
    await listThreads(cloud); // Delay the INSERT batch, not schema creation.
    const held = gate();
    const entered = gate();
    let delayed = true;
    service.beforeBatch = async () => {
      if (delayed) {
        delayed = false;
        entered.release();
        await held.promise;
      }
    };
    const insertion = appendMessage(cloud, "insert-race", message("u1"), OFFERED_CHAT_MODELS[0].id);
    await entered.promise;
    const pick = setThreadModel(cloud, "insert-race", OFFERED_CHAT_MODELS[1].id);
    held.release();
    await Promise.all([insertion, pick]);
    await appendMessage(cloud, "insert-race", message("a1", "assistant"), OFFERED_CHAT_MODELS[0].id);
    expect(await model(service, "insert-race")).toBe(OFFERED_CHAT_MODELS[1].id);
  });

  test("a committed model write with a lost response is reconciled as saved", async () => {
    const service = new SqlService();
    const cloud = tcw(service);
    await appendMessage(cloud, "uncertain-model", message("u1"), OFFERED_CHAT_MODELS[0].id);
    service.uncertainExecute = true;
    await expect(setThreadModel(cloud, "uncertain-model", OFFERED_CHAT_MODELS[2].id)).resolves.toBeUndefined();
    expect(await getThreadModel(cloud, "uncertain-model")).toEqual({
      status: "found",
      model: OFFERED_CHAT_MODELS[2].id,
    });
  });

  test("an uncertain first append retries by message id without duplication", async () => {
    const service = new SqlService();
    const cloud = tcw(service);
    const cache = localStorageWindow();
    await listThreads(cloud); // The response loss must affect the INSERT, not schema.
    service.uncertainBatch = true;
    const item = message("stable-message-id");
    await expect(appendMessage(cloud, "uncertain-append", item, OFFERED_CHAT_MODELS[1].id)).rejects.toThrow();
    expect(service.sqlite.query("SELECT COUNT(*) FROM messages").values()[0]![0]).toBe(1);
    await expect(appendMessage(cloud, "uncertain-append", item, OFFERED_CHAT_MODELS[1].id)).resolves.toBeUndefined();
    expect(service.sqlite.query("SELECT COUNT(*) FROM messages WHERE thread_id = ?").values("uncertain-append")[0]![0]).toBe(1);
    expect(await model(service, "uncertain-append")).toBe(OFFERED_CHAT_MODELS[1].id);
    const index = JSON.parse(cache.get(`tinychat:index:${cloud.did}`) ?? "null");
    expect(index.threads.find((thread: { id: string }) => thread.id === "uncertain-append").model).toBe(OFFERED_CHAT_MODELS[1].id);
  });

  test("a model update against a missing row fails instead of claiming durability", async () => {
    const service = new SqlService();
    const cloud = tcw(service);
    await expect(setThreadModel(cloud, "missing", OFFERED_CHAT_MODELS[0].id)).rejects.toThrow("does not exist");
    expect(await getThreadModel(cloud, "missing")).toEqual({ status: "missing" });
  });
});

// Real SQL and the production coordinator together: these are not controller
// mirrors. The browser suite separately mounts assistant-ui and the composer.
import { ModelSelectionCoordinator, TurnCancelledError } from "../chat/modelSelection";

function coordinator(cloud: TinyCloudWeb) {
  return new ModelSelectionCoordinator({
    tcw: cloud, backendUrl: "https://unused.test",
    sessionStore: { getToken: () => "test" } as never,
    onView: () => {},
  });
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(2);
  expect(check()).toBe(true);
}

test("read failure retries only on request and releases the original queued send", async () => {
  const service = new SqlService();
  const cloud = tcw(service);
  await appendMessage(cloud, "restore", message("old"), OFFERED_CHAT_MODELS[2].id);
  const query = service.query;
  let reads = 0;
  service.query = async (sql, params) => {
    if (sql === "SELECT model FROM threads WHERE id = ?" && ++reads === 1) {
      return { ok: false, error: { code: "READ", message: "read failed" } };
    }
    return query(sql, params);
  };
  const selection = coordinator(cloud);
  selection.activate("restore", "existing");
  const turn = selection.beginTurn("restore", "queued");
  await until(() => selection.getView().phase === "needs-manual-choice");
  selection.activate("restore", "existing");
  await Bun.sleep(10);
  expect(reads).toBe(1);
  selection.retry();
  expect((await turn).model).toBe(OFFERED_CHAT_MODELS[2].id);
  expect(reads).toBe(2);
  selection.dispose();
});

test("failed save blocks sends, rapid revisions settle SQL and view at the latest pick", async () => {
  const service = new SqlService();
  const cloud = tcw(service);
  await appendMessage(cloud, "save", message("old"), OFFERED_CHAT_MODELS[0].id);
  const selection = coordinator(cloud);
  selection.activate("save", "existing");
  await until(() => selection.getView().canSend);
  service.beforeExecute = async () => { throw new Error("write unavailable"); };
  selection.pick(OFFERED_CHAT_MODELS[1].id);
  await until(() => selection.getView().saveFailed);
  expect(selection.getView().canSend).toBe(false);
  service.beforeExecute = null;
  selection.pick(OFFERED_CHAT_MODELS[2].id);
  selection.pick(OFFERED_CHAT_MODELS[1].id);
  await until(() => selection.getView().canSend);
  expect((await selection.beginTurn("save", "next")).model).toBe(OFFERED_CHAT_MODELS[1].id);
  expect(await model(service, "save")).toBe(selection.getView().model);
  selection.dispose();
});

test("late callbacks cannot reactivate an old thread and cancelled saves remain usable on return", async () => {
  const service = new SqlService();
  const cloud = tcw(service);
  for (const id of ["a", "b"]) await appendMessage(cloud, id, message(id), OFFERED_CHAT_MODELS[0].id);
  const selection = coordinator(cloud);
  selection.activate("a", "existing");
  await until(() => selection.getView().canSend);
  const held = gate();
  service.beforeExecute = () => held.promise;
  selection.pick(OFFERED_CHAT_MODELS[1].id);
  const oldTurn = selection.beginTurn("a", "obsolete").catch((error) => error);
  selection.activate("b", "existing");
  expect(await oldTurn).toBeInstanceOf(TurnCancelledError);
  await expect(selection.beginTurn("a", "late")).rejects.toBeInstanceOf(TurnCancelledError);
  held.release();
  await Bun.sleep(10);
  expect(selection.getView().threadId).toBe("b");
  selection.activate("a", "existing");
  expect((await selection.beginTurn("a", "fresh")).model).toBe(OFFERED_CHAT_MODELS[1].id);
  selection.dispose();
});

test("client deadline includes a nonsettling body parser and never accepts its late result", async () => {
  const previousFetch = globalThis.fetch;
  let release!: (body: unknown) => void;
  let signal: AbortSignal;
  globalThis.fetch = (async (_input, init) => {
    signal = init!.signal!;
    return { ok: true, status: 200, json: () => new Promise((resolve) => { release = resolve; }) };
  }) as typeof fetch;
  const selection = coordinator(tcw(new SqlService()));
  try {
    const started = performance.now();
    selection.activate("new", "new");
    const origin = await selection.beginTurn("new", "queued");
    expect(performance.now() - started).toBeLessThan(3600);
    expect(signal!.aborted).toBe(true);
    expect(origin.model).toBe(OFFERED_CHAT_MODELS[0].id);
    expect(selection.getView().reason).toBe("health-unverified");
    release({ model: OFFERED_CHAT_MODELS[1].id, reason: "healthy" });
    await Bun.sleep(10);
    expect(selection.getView().model).toBe(OFFERED_CHAT_MODELS[0].id);
  } finally {
    selection.dispose();
    globalThis.fetch = previousFetch;
  }
});

test("client malformed and 5xx results become unverified; authentication blocks manual override", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const [body, status] of [[{}, 200], [{ model: "retired", reason: "healthy" }, 200], [{}, 503], [{}, 401], [{}, 403]] as const) {
      globalThis.fetch = (async () => Response.json(body, { status })) as typeof fetch;
      const selection = coordinator(tcw(new SqlService()));
      selection.activate("new", "new");
      await until(() => selection.getView().phase !== "choosing");
      if (status === 401 || status === 403) {
        expect(selection.getView().canSend).toBe(false);
        selection.pick(OFFERED_CHAT_MODELS[1].id);
        expect(selection.getView().canPick).toBe(false);
        expect(selection.getView().model).toBeNull();
      } else {
        expect(selection.getView().reason).toBe("health-unverified");
        expect(selection.getView().model).toBe(OFFERED_CHAT_MODELS[0].id);
      }
      selection.dispose();
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("a manual pick supersedes a resolved choice before its send continuation runs", async () => {
  const service = new SqlService();
  const cloud = tcw(service);
  await appendMessage(cloud, "revision", message("old"), OFFERED_CHAT_MODELS[0].id);
  const selection = coordinator(cloud);
  selection.activate("revision", "existing");
  await until(() => selection.getView().canSend);
  const turn = selection.beginTurn("revision", "new-turn");
  selection.pick(OFFERED_CHAT_MODELS[1].id);
  expect((await turn).model).toBe(OFFERED_CHAT_MODELS[1].id);
  expect(await model(service, "revision")).toBe(OFFERED_CHAT_MODELS[1].id);
  selection.dispose();
});
